import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadVectorSchema } from '../src/registry/vector-schema.ts'

/** Написать schema.json в каталог-корень пакета и вернуть его. */
async function withSchema(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'engram-vecschema-'))
  await mkdir(join(dir, 'registry'), { recursive: true })
  await writeFile(join(dir, 'registry', 'schema.json'), body, 'utf8')
  return dir
}

const USER_OBS = {
  nodes: {
    role: 'user',
    properties: { vector: { text: 'content', where: "status = 'active'" } },
    fields: { id: 'TEXT', content: 'TEXT', status: 'TEXT', embedding: 'BLOB' },
  },
  observations: {
    role: 'user',
    properties: { vector: { text: 'belief', where: null } },
    fields: { id: 'TEXT', belief: 'TEXT', embedding: 'BLOB' },
  },
}

describe('loadVectorSchema — классификация role', () => {
  it('возвращает только user-таблицы; служебные (role: service) пропускает', async () => {
    const dir = await withSchema(JSON.stringify({
      formatVersion: 1,
      schemaVersion: 13,
      tables: {
        ...USER_OBS,
        nodes_fts: { role: 'service' },
        nodes_fts_content: { role: 'service' },
      },
    }))
    const loaded = loadVectorSchema({ dbDir: join(dir, 'data'), packageRoot: dir })
    const names = loaded.specs.map(s => s.table).sort()
    expect(names).toEqual(['nodes', 'observations'])
    expect(loaded.problems).toEqual([])
    expect(loaded.schemaVersion).toBe(13)
  })

  it('таблица без role и без properties.vector — тоже пропуск', async () => {
    const dir = await withSchema(JSON.stringify({
      formatVersion: 1,
      schemaVersion: 13,
      tables: { nodes: USER_OBS.nodes, op_log: { fields: { id: 'TEXT' } } },
    }))
    const loaded = loadVectorSchema({ dbDir: join(dir, 'data'), packageRoot: dir })
    expect(loaded.specs.map(s => s.table)).toEqual(['nodes'])
    expect(loaded.problems).toEqual([])
  })

  it('role: user без properties.vector — претензия, а не молчаливый пропуск', async () => {
    const dir = await withSchema(JSON.stringify({
      formatVersion: 1,
      schemaVersion: 13,
      tables: { broken: { role: 'user', fields: { id: 'TEXT' } } },
    }))
    const loaded = loadVectorSchema({ dbDir: join(dir, 'data'), packageRoot: dir })
    expect(loaded.specs).toEqual([])
    expect(loaded.problems.map(p => p.kind)).toEqual(['badField'])
  })

  it('role: service на таблице с properties.vector — это противоречие, она всё равно не обрабатывается', async () => {
    const dir = await withSchema(JSON.stringify({
      formatVersion: 1,
      schemaVersion: 13,
      tables: { nodes: { ...USER_OBS.nodes, role: 'service' } },
    }))
    const loaded = loadVectorSchema({ dbDir: join(dir, 'data'), packageRoot: dir })
    expect(loaded.specs).toEqual([])
    expect(loaded.problems).toEqual([])
  })
})
