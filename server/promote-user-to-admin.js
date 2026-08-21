import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { config as loadEnv } from 'dotenv'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
loadEnv({ path: path.join(root, '.env'), quiet: true })

const argumentsList = process.argv.slice(2)
const databaseOption = argumentsList.indexOf('--database')
const username = String(argumentsList.find((value, index) => !value.startsWith('--') && index !== databaseOption + 1) || '').trim()
const configuredDatabase = databaseOption >= 0 ? argumentsList[databaseOption + 1] : ''

if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
  console.error('Usage: npm run promote:admin -- <username> [--database <tcpmm.sqlite path>]')
  process.exit(1)
}
if (databaseOption >= 0 && !configuredDatabase) {
  console.error('--database requires the path to tcpmm.sqlite')
  process.exit(1)
}

const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(root, 'data'))
const databasePath = path.resolve(configuredDatabase || path.join(dataDirectory, 'tcpmm.sqlite'))
if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) {
  console.error(`Site database not found: ${databasePath}`)
  process.exit(1)
}

const database = new Database(databasePath, { fileMustExist: true }) // Refuses to create an empty database when the operator supplies the wrong location.
database.pragma('foreign_keys = ON')
database.pragma('busy_timeout = 5000')

try {
  const columns = new Set(database.prepare('PRAGMA table_info(admins)').all().map((column) => column.name))
  if (!columns.has('username') || !columns.has('role')) throw new Error('The database does not contain the current operator-role schema; deploy and start the updated application first')

  let account = database.prepare('SELECT id, username, role FROM admins WHERE username = ?').get(username)
  if (!account) {
    const matches = database.prepare('SELECT id, username, role FROM admins WHERE username = ? COLLATE NOCASE ORDER BY id').all(username)
    if (matches.length > 1) throw new Error(`More than one account matches "${username}" without case sensitivity; rerun with the exact capitalization`)
    account = matches[0]
  }
  if (!account) throw new Error(`Operator account not found: ${username}`)
  if (account.role === 'admin') {
    console.log(`${account.username} is already a full administrator; no database changes were made.`)
    process.exit(0)
  }

  const backupDirectory = path.join(path.dirname(databasePath), 'recovery-backups')
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(backupDirectory, `tcpmm-before-role-recovery-${timestamp}.sqlite`)
  await database.backup(backupPath)
  fs.chmodSync(backupPath, 0o600)

  const promoteAccount = database.transaction(() => {
    const current = database.prepare('SELECT role FROM admins WHERE id = ?').get(account.id)
    if (!current) throw new Error('The account disappeared before it could be promoted')
    database.prepare("UPDATE admins SET role = 'admin' WHERE id = ?").run(account.id)
    return database.prepare('DELETE FROM sessions WHERE admin_id = ?').run(account.id).changes
  }) // Changes the role and invalidates existing sessions as one atomic recovery operation.
  const revokedSessions = promoteAccount()

  console.log(`Promoted ${account.username} from organizer to admin.`)
  console.log(`Revoked ${revokedSessions} existing session(s); sign in again to refresh access.`)
  console.log(`Recovery backup: ${backupPath}`)
} catch (error) {
  console.error(`Promotion failed: ${error.message}`)
  process.exitCode = 1
} finally {
  database.close()
}
