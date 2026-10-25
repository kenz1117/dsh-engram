/**
 * Реестр привязок: служебное умолчание пакета (`default`).
 *
 * Умолчание — язык, который пакет считает своим. Оно складывается слоями, как и
 * строки привязок, и главнее системной локали, но не главнее настройки плагина.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isLanguageCode, pickLanguage, systemLanguage } from '../src/i18n/language.ts'
import { resolveBaseTarget, resolveLocalModel } from '../src/embedder/select.ts'
import type { ResolvedEmbedderConfig } from '../src/config.ts'
import { bindingLabel, parseBindings, parseModels } from '../src/registry/models.ts'
import type { LoadedRegistry } from '../src/registry/registry-file.ts'
import { loadRegistry } from '../src/registry/registry-file.ts'
import { packageRoot } from '../src/registry/root.ts'

const MODELS = JSON.stringify({
  formatVersion: 1,
  models: [{ id: 'm-zh', pooling: 'mean', dtype: 'q8', dimensions: 512 }],
})

/** Каталог поставки (`<root>/registry/*.json`) и каталог данных пользователя. */
async function makeRoots(bindings: string, userBindings?: string): Promise<{ packageRoot: string; dbDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'engram-models-'))
  const dbDir = await mkdtemp(join(tmpdir(), 'engram-models-db-'))
  await mkdir(join(root, 'registry'), { recursive: true })
  await writeFile(join(root, 'registry', 'models.json'), MODELS)
  await writeFile(join(root, 'registry', 'bindings.json'), bindings)
  if (userBindings !== undefined) {
    await mkdir(join(dbDir, 'registry'), { recursive: true })
    await writeFile(join(dbDir, 'registry', 'bindings.json'), userBindings)
  }
  return { packageRoot: root, dbDir }
}

describe('умолчание пакета в разборе привязок', () => {
  it('читается корневым полем; подстановка звёздочкой умолчанием быть не может', () => {
    const declared = parseBindings('{"default":"ru","bindings":[{"language":"*","model":"m-zh"}]}')
    expect(declared.default).toBe('ru')
    expect(declared.issues).toEqual([])
    const star = parseBindings('{"default":"*","bindings":[]}')
    expect(star.default).toBeUndefined()
    expect(star.issues.map(issue => issue.kind)).toEqual(['badField'])
    const wrongType = parseBindings('{"default":7,"bindings":[]}')
    expect(wrongType.default).toBeUndefined()
    expect(wrongType.issues.map(issue => issue.kind)).toEqual(['badField'])
  })

  it('отсутствие строк привязок не отменяет объявленное умолчание', () => {
    const parsed = parseBindings('{"default":"ru"}')
    expect(parsed.default).toBe('ru')
    expect(parsed.issues.map(issue => issue.kind)).toEqual(['badShape'])
  })
})

describe('loadRegistry: умолчание складывается слоями', () => {
  it('поставка задаёт, пользовательский слой перекрывает', async () => {
    const roots = await makeRoots('{"default":"ru","bindings":[{"language":"*","model":"m-zh"}]}', '{"default":"en","bindings":[]}')
    const loaded = loadRegistry(roots)
    expect(loaded.defaultLanguage).toBe('en')
    expect(loaded.problems).toEqual([])
  })

  it('умолчание без словаря — претензия, а не тихое неисполнение', async () => {
    const roots = await makeRoots('{"default":"de","bindings":[{"language":"*","model":"m-zh"}]}')
    const loaded = loadRegistry(roots)
    expect(loaded.defaultLanguage).toBe('de')
    expect(loaded.problems.map(problem => problem.kind)).toEqual(['unknownLanguage'])
  })

  it('поставка объявляет умолчание, для которого у плагина есть словарь', async () => {
    const dbDir = await mkdtemp(join(tmpdir(), 'engram-models-db-'))
    const loaded = loadRegistry({ packageRoot: packageRoot(), dbDir })
    expect(loaded.defaultLanguage).toBeDefined()
    expect(isLanguageCode(loaded.defaultLanguage ?? '')).toBe(true)
    expect(loaded.problems).toEqual([])
  })
})

describe('pickLanguage', () => {
  it('настройка главнее умолчания, и явный auto — это выбор пользователя', () => {
    expect(pickLanguage('zh', 'ru')).toBe('zh')
    expect(pickLanguage('ru', undefined)).toBe('ru')
    expect(pickLanguage('auto', 'ru')).toBe(systemLanguage())
  })

  it('умолчание пакета главнее системной локали', () => {
    expect(pickLanguage(undefined, 'ru')).toBe('ru')
    expect(pickLanguage(undefined, 'zh')).toBe('zh')
  })

  it('умолчание без словаря не принимается; ничего не объявлено — язык системы', () => {
    const system = systemLanguage()
    expect(pickLanguage(undefined, 'de')).toBe(system)
    expect(pickLanguage(undefined, undefined)).toBe(system)
  })
})

describe('метка модели в каталоге', () => {
  it('короткая метка читается, длинная и с косой чертой — претензия и пропуск строки', () => {
    const ok = parseModels(JSON.stringify({
      formatVersion: 1,
      models: [{ id: 'Xenova/m', label: 'minilm-l12', pooling: 'mean', dtype: 'q8', dimensions: 384 }],
    }))
    expect(ok.issues).toEqual([])
    expect(ok.models.get('Xenova/m')?.label).toBe('minilm-l12')

    const idInLabel = parseModels(JSON.stringify({
      formatVersion: 1,
      models: [{ id: 'Xenova/m', label: 'Xenova/m', pooling: 'mean', dtype: 'q8' }],
    }))
    expect(idInLabel.models.size).toBe(0)
    expect(idInLabel.issues.map(issue => issue.kind)).toEqual(['badField'])

    const long = parseModels(JSON.stringify({
      formatVersion: 1,
      models: [{ id: 'Xenova/m', label: 'a'.repeat(25), pooling: 'mean', dtype: 'q8' }],
    }))
    expect(long.models.size).toBe(0)
    expect(long.issues.map(issue => issue.kind)).toEqual(['badField'])
  })

  it('без метки строка принимается: метка необязательна', () => {
    const parsed = parseModels(JSON.stringify({
      formatVersion: 1,
      models: [{ id: 'Xenova/m', pooling: 'mean', dtype: 'q8' }],
    }))
    expect(parsed.issues).toEqual([])
    expect(parsed.models.get('Xenova/m')?.label).toBeUndefined()
  })

  it('повтор метки — претензия: по метке база находит модель, и две одинаковые её обманут', () => {
    const parsed = parseModels(JSON.stringify({
      formatVersion: 1,
      models: [
        { id: 'Xenova/a', label: 'same', pooling: 'mean', dtype: 'q8' },
        { id: 'Xenova/b', label: 'same', pooling: 'mean', dtype: 'q8' },
      ],
    }))
    expect(parsed.models.size).toBe(1)
    expect(parsed.issues.map(issue => issue.kind)).toEqual(['duplicateLabel'])
  })
})

describe('каталог поставки: метки уникальны и по форме', () => {
  it('обе поставляемые модели названы коротко', async () => {
    const dbDir = await mkdtemp(join(tmpdir(), 'engram-models-db-'))
    const loaded = loadRegistry({ packageRoot: packageRoot(), dbDir })
    const labels = [...loaded.models.values()].map(row => row.label)
    expect(loaded.problems).toEqual([])
    expect(labels.every(label => label !== undefined && label.length <= 24)).toBe(true)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('метка базы: язык и имя модели', () => {
  /** Реестр из одной многоязычной модели, привязанной подстановкой `*`. */
  function starRegistry(): LoadedRegistry {
    return {
      models: new Map([[
        'Xenova/m',
        { id: 'Xenova/m', label: 'minilm-l12', pooling: 'mean', dtype: 'q8', dimensions: 384, languages: [] },
      ]]),
      bindings: new Map([['*', 'Xenova/m']]),
      defaultLanguage: 'ru',
      languages: [
        { code: 'ru', label: 'Русский', builtin: false },
        { code: 'en', label: 'English', builtin: true },
        { code: 'zh', label: '中文', builtin: true },
      ],
      problems: [],
      files: [],
    }
  }

  it('одна модель — разные метки у разных языков: язык берётся из привязки, а не из модели', () => {
    const registry = starRegistry()
    expect(resolveLocalModel(registry, 'ru', undefined, undefined)?.label).toBe('ru-minilm-l12')
    expect(resolveLocalModel(registry, 'en', undefined, undefined)?.label).toBe('en-minilm-l12')
    expect(resolveLocalModel(registry, 'zh', undefined, undefined)?.label).toBe('zh-minilm-l12')
  })

  it('у модели вне каталога метки нет: имени неоткуда взять', () => {
    const registry = starRegistry()
    expect(resolveLocalModel(registry, 'ru', 'Xenova/unknown', undefined)?.label).toBeUndefined()
  })

  function remoteConfig(model: string): ResolvedEmbedderConfig {
    return {
      kind: 'remote',
      localModel: undefined,
      localPooling: undefined,
      remote: { model, baseUrl: 'http://127.0.0.1:1', apiKey: undefined, apiKeyEnv: undefined, batchSize: 32, timeoutMs: 30000 },
    }
  }

  it('remote выбирает свою строку каталога, а не локальную привязку', () => {
    const local = starRegistry()
    const registry: LoadedRegistry = {
      ...local,
      models: new Map([...local.models, ['remote/embed', {
        id: 'remote/embed', label: 'remote-embed', pooling: 'mean' as const, dtype: 'q8' as const, dimensions: 1536, languages: [],
      }]]),
    }
    expect(resolveBaseTarget(registry, 'ru', remoteConfig('remote/embed'))).toEqual({
      label: 'ru-remote-embed',
      model: { id: 'remote/embed', label: 'remote-embed', dimensions: 1536 },
    })
  })

  it('remote вне каталога остаётся неизвестным и не наследует локальную модель', () => {
    expect(resolveBaseTarget(starRegistry(), 'ru', remoteConfig('remote/unknown'))).toEqual({
      label: undefined,
      model: { id: 'remote/unknown', label: undefined, dimensions: undefined },
    })
  })

  it('собирается одной строкой', () => {
    expect(bindingLabel('zh', 'bge-small-zh')).toBe('zh-bge-small-zh')
  })
})

describe('реестр языков: слой пользователя рядом с данными', () => {
  /** Корни с объявленным списком языков в поставке и, если дан, в слое пользователя. */
  async function makeLanguageRoots(delivery: string, user?: string): Promise<{ packageRoot: string; dbDir: string }> {
    const roots = await makeRoots('{"default":"ru","bindings":[{"language":"*","model":"m-zh"}]}')
    await writeFile(join(roots.packageRoot, 'registry', 'languages.json'), delivery)
    if (user !== undefined) {
      await mkdir(join(roots.dbDir, 'registry'), { recursive: true })
      await writeFile(join(roots.dbDir, 'registry', 'languages.json'), user)
    }
    return roots
  }

  it('язык из слоя пользователя появляется в списке рядом с поставкой', async () => {
    // Новый язык приходит файлом словаря в тот же каталог данных; без строки в реестре
    // сервер знал бы код, а список выбора дворца и интерфейса — нет.
    const roots = await makeLanguageRoots(
      JSON.stringify({ languages: [{ code: 'zh', label: '中文', builtin: true }, { code: 'ru', label: 'Русский', builtin: false }] }),
      JSON.stringify({ languages: [{ code: 'fr', label: 'Français', builtin: false }] }),
    )
    const loaded = loadRegistry(roots)
    expect(loaded.languages.map(row => row.code)).toEqual(['zh', 'ru', 'fr'])
    expect(loaded.languages[2]).toMatchObject({ label: 'Français', builtin: false })
    expect(loaded.problems).toEqual([])
  })

  it('строка пользователя заменяет строку с тем же кодом, а не удваивает её', async () => {
    const roots = await makeLanguageRoots(
      JSON.stringify({ languages: [{ code: 'ru', label: 'ru', builtin: false }] }),
      JSON.stringify({ languages: [{ code: 'ru', label: 'Русский', builtin: false }] }),
    )
    const loaded = loadRegistry(roots)
    expect(loaded.languages).toEqual([{ code: 'ru', label: 'Русский', builtin: false }])
  })

  it('испорченный файл пользователя не отменяет список поставки', async () => {
    const roots = await makeLanguageRoots(
      JSON.stringify({ languages: [{ code: 'zh', label: '中文', builtin: true }] }),
      '{"languages": "не массив"}',
    )
    const loaded = loadRegistry(roots)
    expect(loaded.languages.map(row => row.code)).toEqual(['zh'])
    expect(loaded.problems.map(problem => problem.kind)).toContain('badShape')
  })
})
