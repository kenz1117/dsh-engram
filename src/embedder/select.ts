/**
 * 嵌入器组装：按解析后的配置在本地离线模型与远程 OpenAI 兼容端点之间选择。
 *
 * 选择点只有一处：否则「当前用的是哪个嵌入器」就不再是可检验的部署属性，
 * 而变成每个调用点各自的属性。
 *
 * Местная модель выбирается не настройкой, а реестром: язык → модель берётся из
 * привязок, модель → её свойства — из каталога (см. src/registry). Настройка
 * `embedder.localModel` остаётся явным переопределением поверх реестра: она
 * названа пользователем сознательно и потому главнее умолчания поставки.
 * @module @kenz1117/dsh-engram/embedder/select
 */

import type { ResolvedEmbedderConfig, ResolvedEngramConfig } from '../config.ts'
import { message } from '../i18n/messages.ts'
import type { BaseTarget } from '../registry/base-state.ts'
import { bindingLabel } from '../registry/models.ts'
import type { LoadedRegistry } from '../registry/registry-file.ts'
import { EngramError } from '../types.ts'
import type { EngramEmbedder } from './interface.ts'
import { createLocalEmbedder } from './local.ts'
import type { LocalModelSpec, ModelDtype, PoolingMode } from './local.ts'
import { createRemoteEmbedder } from './remote.ts'

/**
 * Свойства модели, которой нет в каталоге.
 *
 * Такую модель может назвать только явное переопределение в настройках: о ней
 * не известно ничего, кроме идентификатора. Берём исторические значения автора,
 * mean и q8 — ровно то поведение, что было до появления реестра, поэтому
 * переопределение ничего не ломает. Размерность такой модели не объявлена и
 * узнаётся по первому вектору.
 */
const UNKNOWN_MODEL_POOLING: PoolingMode = 'mean'
const UNKNOWN_MODEL_DTYPE: ModelDtype = 'q8'

/** Откуда взялась выбранная модель: чем человек её назвал. */
export type ModelSource = 'override' | 'binding' | 'fallback'

/**
 * Выбранная локальная модель вместе с ответом на вопрос «почему именно она».
 *
 * Ответ нужен не ядру, а обслуживанию: когда модель у базы и модель в конфиге
 * разные, разбираться приходится человеку, и первое, что он должен увидеть, —
 * какая из двух победила и по какому правилу. Расширяет `LocalModelSpec`, а не
 * заменяет его: ядро по-прежнему получает то, чем строится эмбеддер.
 */
export interface LocalModelChoice extends LocalModelSpec {
  /**
   * Метка базы: код языка и имя модели, `ru-minilm-l12`; у модели вне каталога
   * метки нет — её имени неоткуда взять (см. `bindingLabel`).
   */
  readonly label: string | undefined
  readonly source: ModelSource
}

/**
 * Строка локальной модели: привязка языка, затем умолчание `*`, затем явное
 * переопределение из настроек.
 * @param registry - прочитанные каталог моделей и привязки.
 * @param language - язык вывода плагина.
 * @param modelOverride - `embedder.localModel`, если задан.
 * @param poolingOverride - `embedder.localPooling`, если задан.
 * @returns строка каталога либо undefined, если модель выбрать нечем.
 */
export function resolveLocalModel(
  registry: LoadedRegistry,
  language: string,
  modelOverride: string | undefined,
  poolingOverride: PoolingMode | undefined,
): LocalModelChoice | undefined {
  const byOverride = modelOverride !== undefined && modelOverride !== ''
  const byLanguage = registry.bindings.get(language)
  const id = byOverride ? modelOverride : (byLanguage ?? registry.bindings.get('*'))
  if (id === undefined || id === '') return undefined
  const source: ModelSource = byOverride ? 'override' : byLanguage !== undefined ? 'binding' : 'fallback'
  const row = registry.models.get(id)
  if (row === undefined) {
    return {
      id,
      label: undefined,
      source,
      pooling: poolingOverride ?? UNKNOWN_MODEL_POOLING,
      dtype: UNKNOWN_MODEL_DTYPE,
    }
  }
  return {
    id: row.id,
    // Строка каталога без метки — это модель, которую нечем назвать в записи о базе.
    // Подставлять вместо имени `undefined` нельзя: метка уезжает в чужую базу.
    label: row.label === undefined ? undefined : bindingLabel(language, row.label),
    source,
    pooling: poolingOverride ?? row.pooling,
    dtype: row.dtype,
  }
}

/**
 * Целевая модель базы — всегда та, которая реально пишет векторы.
 * Remote не использует локальные привязки: без строки каталога его измерение и метка
 * остаются неизвестными, а не заимствуются у локальной модели.
 */
export function resolveBaseTarget(
  registry: LoadedRegistry,
  language: string,
  embedder: ResolvedEmbedderConfig,
): BaseTarget {
  const remote = embedder.remote
  if (remote !== undefined) {
    const record = registry.models.get(remote.model)
    return {
      label: record?.label === undefined ? undefined : bindingLabel(language, record.label),
      model: { id: remote.model, label: record?.label, dimensions: record?.dimensions },
    }
  }
  const model = resolveLocalModel(registry, language, embedder.localModel, embedder.localPooling)
  const record = model === undefined ? undefined : registry.models.get(model.id)
  return {
    label: model?.label,
    model: model === undefined ? undefined : { id: model.id, label: record?.label, dimensions: record?.dimensions },
  }
}

/**
 * Построить эмбеддер по конфигурации и реестру.
 * @param config - разрешённая конфигурация плагина.
 * @param registry - прочитанные каталог моделей и привязки.
 * @param languageOverride - язык выбора локальной модели вместо `config.language`
 *   (issue #39: метка существующей базы главнее системной локали — locale читается
 *   не на всех платформах, а промах уводит готовую базу на чужую размерность).
 * @returns готовый EngramEmbedder.
 * @throws EngramError EMBEDDER_MODEL_UNRESOLVED — язык не привязан ни к одной модели; EMBEDDER_DOWNLOAD_FAILED / EMBEDDER_REMOTE_FAILED — бэкенд не поднялся.
 */
export function createEmbedder(config: ResolvedEngramConfig, registry: LoadedRegistry, languageOverride?: string): Promise<EngramEmbedder> {
  const embedder = config.embedder
  const remote = embedder.remote
  if (remote !== undefined) {
    return createRemoteEmbedder({
      model: remote.model,
      baseUrl: remote.baseUrl,
      // 环境变量优先于配置里的密钥：这样密钥可以完全不落在文件里。
      // 变量名整名交给嵌入器，由它在每次请求时读取——换密钥不必重启插件。
      apiKey: remote.apiKey,
      apiKeyEnv: remote.apiKeyEnv,
      batchSize: remote.batchSize,
      timeoutMs: remote.timeoutMs,
    })
  }
  const spec = resolveLocalModel(registry, languageOverride ?? config.language, embedder.localModel, embedder.localPooling)
  if (spec === undefined) {
    return Promise.reject(new EngramError('EMBEDDER_MODEL_UNRESOLVED', message('store.embedderModelUnresolved')))
  }
  return createLocalEmbedder(config.modelCacheDir, config.hfEndpoint, spec)
}
