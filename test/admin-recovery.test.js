import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('promotes exactly one organizer, revokes sessions, and creates a backup', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcpmm-admin-recovery-'))
  const databasePath = path.join(temporaryDirectory, 'tcpmm.sqlite')
  const database = new Database(databasePath)
  database.exec(`
    CREATE TABLE admins (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, admin_id INTEGER NOT NULL);
    INSERT INTO admins (id, username, role) VALUES (1, 'doll', 'organizer');
    INSERT INTO sessions (token_hash, admin_id) VALUES ('active-session', 1);
  `)
  database.close()

  try {
    const result = spawnSync(process.execPath, ['server/promote-user-to-admin.js', 'doll', '--database', databasePath], {
      cwd: root, encoding: 'utf8', windowsHide: true
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Promoted doll from organizer to admin/)

    const verified = new Database(databasePath, { readonly: true, fileMustExist: true })
    assert.equal(verified.prepare("SELECT role FROM admins WHERE username = 'doll'").get().role, 'admin')
    assert.equal(verified.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0)
    verified.close()
    assert.equal(fs.readdirSync(path.join(temporaryDirectory, 'recovery-backups')).filter((file) => file.endsWith('.sqlite')).length, 1)

    const repeated = spawnSync(process.execPath, ['server/promote-user-to-admin.js', 'doll', '--database', databasePath], {
      cwd: root, encoding: 'utf8', windowsHide: true
    })
    assert.equal(repeated.status, 0, repeated.stderr)
    assert.match(repeated.stdout, /already a full administrator/)
    assert.equal(fs.readdirSync(path.join(temporaryDirectory, 'recovery-backups')).filter((file) => file.endsWith('.sqlite')).length, 1)
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}) // Exercises the recovery tool against disposable SQLite data and verifies that repeat runs make no changes.
