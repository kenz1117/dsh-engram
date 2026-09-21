import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateProjectDb, migrationWarning, readMigrationPointer, resolveProjectIdentity } from '../src/project/identity.ts'

const roots: string[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'engram-policy-'))
  roots.push(dir)
  const a = resolveProjectIdentity(join(dir, 'workspace-a'))
  const b = resolveProjectIdentity(join(dir, 'workspace-b'))
  expect(a.legacyDbName).toBe(b.legacyDbName)
  expect(a.dbName).not.toBe(b.dbName)
  const legacy = join(dir, a.legacyDbName)
  const db = new DatabaseSync(legacy)
  // Synthetic schema isolates file migration; no row-level ownership is inferred.
  db.exec("CREATE TABLE evidence (content TEXT); INSERT INTO evidence VALUES ('A synthetic'), ('B synthetic')")
  db.close()
  return { dir, a, b, legacy, before: readFileSync(legacy) }
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('legacy migration policy against the real module and SQLite files', () => {
  for (const reverse of [false, true]) {
    it(`eager preserves data and exposes the first claim (${reverse ? 'B then A' : 'A then B'})`, () => {
      const { dir, a, b, legacy, before } = fixture()
      const [first, second] = reverse ? [b, a] : [a, b]
      expect(migrateProjectDb(dir, first)).toBe('renamed')
      expect(existsSync(legacy)).toBe(false)
      expect(readFileSync(join(dir, first.dbName))).toEqual(before)
      const pointerBytes = readFileSync(`${legacy}.migrated-to`)
      const pointer = readMigrationPointer(dir, second)!
      expect(pointer.migratedTo).toBe(first.dbName)
      expect(pointer.claimedByCwd).toBe(first.cwd)
      expect(new Date(pointer.claimedAt).toISOString()).toBe(pointer.claimedAt)
      expect(migrateProjectDb(dir, second)).toBe('already-migrated')
      const warning = migrationWarning(dir, second, 'already-migrated')!
      for (const name of [first.dbName, second.dbName, second.legacyDbName, first.cwd, 'engram_export']) expect(warning).toContain(name)
      expect(existsSync(join(dir, second.dbName))).toBe(false)
      expect(migrateProjectDb(dir, first)).toBe('none')
      expect(readFileSync(`${legacy}.migrated-to`)).toEqual(pointerBytes)
      const db = new DatabaseSync(join(dir, first.dbName), { readOnly: true })
      try { expect(db.prepare('SELECT content FROM evidence ORDER BY content').all()).toEqual([{ content: 'A synthetic' }, { content: 'B synthetic' }]) } finally { db.close() }
    })

    it(`conservative leaves unresolved data unassigned (${reverse ? 'B then A' : 'A then B'})`, () => {
      const { dir, a, b, legacy, before } = fixture()
      for (const identity of reverse ? [b, a] : [a, b]) {
        expect(migrateProjectDb(dir, identity, 'conservative')).toBe('deferred')
        expect(readFileSync(legacy)).toEqual(before)
        expect(existsSync(join(dir, identity.dbName))).toBe(false)
        expect(existsSync(`${legacy}.migrated-to`)).toBe(false)
        const warning = migrationWarning(dir, identity, 'deferred')!
        expect(warning).toContain(identity.dbName)
        expect(warning).toContain(identity.legacyDbName)
        expect(warning).toContain('请勿直接覆盖')
        // Model what the caller does after deferral: open/write its own new database.
        const db = new DatabaseSync(join(dir, identity.dbName))
        db.exec("CREATE TABLE fresh (content TEXT); INSERT INTO fresh VALUES ('new session memory')")
        db.close()
        const fresh = readFileSync(join(dir, identity.dbName))
        for (const policy of ['conservative', 'eager'] as const) {
          expect(migrateProjectDb(dir, identity, policy)).toBe('kept-both')
          expect(readFileSync(join(dir, identity.dbName))).toEqual(fresh)
          expect(readFileSync(legacy)).toEqual(before)
        }
      }
    })
  }

  it('does not overwrite an earlier claim when a legacy backup reappears', () => {
    const { dir, a, b, legacy, before } = fixture()
    migrateProjectDb(dir, a)
    const pointer = readFileSync(`${legacy}.migrated-to`)
    writeFileSync(legacy, before)
    expect(migrateProjectDb(dir, b)).toBe('already-migrated')
    expect(readFileSync(legacy)).toEqual(before)
    expect(readFileSync(`${legacy}.migrated-to`)).toEqual(pointer)
  })

  it.each(['not json', '{}', '{"migratedTo":"../other.db","claimedByCwd":"/tmp/x","claimedAt":"2026-09-21T00:00:00Z"}'])(
    'invalid pointer stops migration without altering the old file: %s', (contents) => {
      const { dir, a, legacy, before } = fixture()
      writeFileSync(`${legacy}.migrated-to`, contents)
      expect(() => migrateProjectDb(dir, a)).toThrow()
      expect(readFileSync(legacy)).toEqual(before)
      expect(existsSync(join(dir, a.dbName))).toBe(false)
    },
  )

  it('same-origin workspaces keep sharing the same new database', () => {
    const { dir, a, b } = fixture()
    // The identity resolver's origin normalization already has dedicated coverage.
    const sameOrigin = { ...b, dbName: a.dbName, source: 'origin' as const }
    migrateProjectDb(dir, a)
    expect(migrateProjectDb(dir, sameOrigin)).toBe('none')
  })
})
