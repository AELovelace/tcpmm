import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { config as loadEnv } from 'dotenv'
import express from 'express'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
loadEnv({ path: path.join(root, '.env'), quiet: true })

const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'))
const dbPath = path.join(dataDir, 'tcpmm.sqlite')
const chatDbPath = path.resolve(process.env.CHAT_DB_PATH || path.join(dataDir, 'tcpmm-chat.sqlite'))
const submissionsDbPath = path.resolve(process.env.SUBMISSIONS_DB_PATH || path.join(dataDir, 'tcpmm-submissions.sqlite'))
if (chatDbPath.toLowerCase() === dbPath.toLowerCase()) throw new Error('CHAT_DB_PATH must be different from the site database path')
if ([dbPath, chatDbPath].some((databasePath) => submissionsDbPath.toLowerCase() === databasePath.toLowerCase())) throw new Error('SUBMISSIONS_DB_PATH must be different from the site and chat database paths')
const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '127.0.0.1'
const production = process.env.NODE_ENV === 'production'
const musicDir = path.resolve(process.env.MUSIC_DIR || path.join(root, 'music'))

const mediaExtensions = new Set(['.aac', '.aiff', '.alac', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav', '.wma'])
const findMedia = (directory) => {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const item = path.join(directory, entry.name)
    return entry.isDirectory() ? findMedia(item) : mediaExtensions.has(path.extname(entry.name).toLowerCase()) ? [item] : []
  })
}
const shuffled = (items) => {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = crypto.randomInt(index + 1)
    ;[result[index], result[target]] = [result[target], result[index]]
  }
  return result
}

class IcyRadio {
  constructor(directory) {
    this.directory = directory
    this.listeners = new Set()
    this.playlist = []
    this.process = null
    this.retryTimer = null
    this.title = 'NO SIGNAL'
    this.trackCount = 0
    this.online = false
    this.stopping = false
  }

  start() {
    fs.mkdirSync(this.directory, { recursive: true })
    this.playNext()
  }

  refillPlaylist() {
    const files = findMedia(this.directory)
    this.trackCount = files.length
    this.playlist = shuffled(files)
  }

  playNext() {
    if (this.stopping) return
    if (!this.playlist.length) this.refillPlaylist()
    const file = this.playlist.shift()
    if (!file) {
      this.online = false
      this.title = 'ADD TRACKS TO /MUSIC'
      this.retryTimer = setTimeout(() => this.playNext(), 5000)
      return
    }

    this.title = path.basename(file, path.extname(file)).replaceAll('_', ' ')
    const ffmpeg = spawn(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-fflags', '+genpts', '-re', '-i', file, '-vn',
      '-af', 'asetpts=N/SR/TB',
      '-map_metadata', '-1', '-ac', '2', '-ar', '44100', '-codec:a', 'libmp3lame',
      '-b:a', '128k', '-f', 'mp3', 'pipe:1'
    ], { windowsHide: true })
    this.process = ffmpeg
    this.online = true
    ffmpeg.stdout.on('data', (chunk) => this.broadcast(chunk))
    ffmpeg.stderr.on('data', (chunk) => console.error(`FFmpeg radio: ${String(chunk).trim()}`))
    ffmpeg.on('error', (error) => console.error(`Unable to start FFmpeg radio: ${error.message}`))
    ffmpeg.on('close', () => {
      if (this.process === ffmpeg) this.process = null
      this.online = false
      if (!this.stopping) this.retryTimer = setTimeout(() => this.playNext(), 250)
    })
  }

  addListener(response, includeMetadata) {
    const listener = { response, includeMetadata, remaining: 16000 }
    this.listeners.add(listener)
    response.on('close', () => this.listeners.delete(listener))
  }

  metadataBlock() {
    const escapedTitle = this.title.replaceAll("'", '’').slice(0, 240)
    const metadata = Buffer.from(`StreamTitle='${escapedTitle}';`, 'latin1')
    const blocks = Math.ceil(metadata.length / 16)
    const result = Buffer.alloc(1 + blocks * 16)
    result[0] = blocks
    metadata.copy(result, 1)
    return result
  }

  broadcast(chunk) {
    for (const listener of this.listeners) {
      const { response } = listener
      if (response.destroyed || response.writableEnded || response.writableLength > 1024 * 1024) {
        response.destroy()
        this.listeners.delete(listener)
        continue
      }
      if (!listener.includeMetadata) {
        response.write(chunk)
        continue
      }
      let offset = 0
      while (offset < chunk.length) {
        const length = Math.min(listener.remaining, chunk.length - offset)
        response.write(chunk.subarray(offset, offset + length))
        offset += length
        listener.remaining -= length
        if (listener.remaining === 0) {
          response.write(this.metadataBlock())
          listener.remaining = 16000
        }
      }
    }
  }

  stop() {
    this.stopping = true
    clearTimeout(this.retryTimer)
    this.process?.kill()
    for (const { response } of this.listeners) response.end()
  }
}

fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
fs.mkdirSync(path.dirname(chatDbPath), { recursive: true, mode: 0o700 })
fs.mkdirSync(path.dirname(submissionsDbPath), { recursive: true, mode: 0o700 })
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 5000')

const chatDb = new Database(chatDbPath)
chatDb.pragma('journal_mode = WAL')
chatDb.pragma('busy_timeout = 5000')
chatDb.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0,1)),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_created_at ON messages(created_at);
`)
if (chatDb.prepare('SELECT COUNT(*) AS count FROM messages').get().count === 0) {
  chatDb.prepare('INSERT INTO messages (name, text, system, created_at) VALUES (?, ?, 1, ?)')
    .run('SYSTEM', 'Live community chat connected. Keep it kind.', Date.now())
}

const submissionsDb = new Database(submissionsDbPath)
submissionsDb.pragma('journal_mode = WAL')
submissionsDb.pragma('busy_timeout = 5000')
submissionsDb.exec(`
  CREATE TABLE IF NOT EXISTS show_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_date TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    venue TEXT NOT NULL,
    city TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL,
    lineup TEXT NOT NULL,
    genre TEXT NOT NULL DEFAULT 'other' CHECK (genre IN ('punk','metal','hardcore','other')),
    price TEXT NOT NULL DEFAULT '',
    doors TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',
    reviewed INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0,1)),
    published_event_id INTEGER,
    published_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS show_submissions_reviewed_created
    ON show_submissions(reviewed, created_at DESC);
`)
const submissionColumns = new Set(submissionsDb.prepare('PRAGMA table_info(show_submissions)').all().map((column) => column.name))
const submissionMigrations = {
  title: "TEXT NOT NULL DEFAULT ''", city: "TEXT NOT NULL DEFAULT ''", genre: "TEXT NOT NULL DEFAULT 'other'",
  price: "TEXT NOT NULL DEFAULT ''", doors: "TEXT NOT NULL DEFAULT ''", contact: "TEXT NOT NULL DEFAULT ''",
  published_event_id: 'INTEGER', published_at: 'TEXT'
}
for (const [column, definition] of Object.entries(submissionMigrations)) {
  if (!submissionColumns.has(column)) submissionsDb.exec(`ALTER TABLE show_submissions ADD COLUMN ${column} ${definition}`)
}

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_date TEXT NOT NULL,
    title TEXT NOT NULL,
    venue TEXT NOT NULL,
    city TEXT NOT NULL,
    lineup TEXT NOT NULL,
    genre TEXT NOT NULL CHECK (genre IN ('punk','metal','hardcore','other')),
    price TEXT NOT NULL DEFAULT '',
    doors TEXT NOT NULL DEFAULT '',
    featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
    published INTEGER NOT NULL DEFAULT 1 CHECK (published IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '#',
    featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
    published INTEGER NOT NULL DEFAULT 1 CHECK (published IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`)

if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'show_submissions'").get()) {
  const legacySubmissions = db.prepare('SELECT id, event_date, venue, address, lineup, description, reviewed, created_at FROM show_submissions ORDER BY id').all()
  const migrateSubmission = submissionsDb.prepare(`INSERT OR IGNORE INTO show_submissions
    (id, event_date, venue, address, lineup, description, reviewed, created_at)
    VALUES (@id, @event_date, @venue, @address, @lineup, @description, @reviewed, @created_at)`)
  submissionsDb.transaction((rows) => rows.forEach((row) => migrateSubmission.run(row)))(legacySubmissions)
  db.exec('DROP TABLE show_submissions')
  if (legacySubmissions.length) console.log(`Migrated ${legacySubmissions.length} show submission(s) to the submissions database`)
}

const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex')
const initialPassword = process.env.ADMIN_INITIAL_PASSWORD
if (db.prepare('SELECT COUNT(*) AS count FROM admins').get().count === 0) {
  if (!initialPassword || initialPassword.length < 12) {
    console.error('First start requires ADMIN_INITIAL_PASSWORD with at least 12 characters.')
    process.exit(1)
  }
  const salt = crypto.randomBytes(24).toString('hex')
  db.prepare('INSERT INTO admins (username, password_hash, password_salt) VALUES (?, ?, ?)')
    .run(process.env.ADMIN_USERNAME || 'admin', hashPassword(initialPassword, salt), salt)
  console.log(`Created initial administrator: ${process.env.ADMIN_USERNAME || 'admin'}`)
}

const seed = db.transaction(() => {
  if (db.prepare('SELECT COUNT(*) AS count FROM events').get().count === 0) {
    const insert = db.prepare(`INSERT INTO events
      (event_date, title, venue, city, lineup, genre, price, doors, featured) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    insert.run('2026-08-23', 'RIVER RAT RIOT', 'The Hideaway', 'Kennewick', 'Motel Saints / Cheap Teeth / Bad Static', 'punk', '$10', '7 PM', 1)
    insert.run('2026-08-29', 'HEAVY WEATHER', 'The Vault', 'Pasco', 'Grave Signal / Black Lung / Maw', 'metal', '$15', '6 PM', 0)
    insert.run('2026-09-05', 'NO BARRIERS', 'DIY Space', 'Richland', 'Exit Wound / Cold Comfort / Loose Ends', 'hardcore', '$8', '7 PM', 0)
    insert.run('2026-09-13', 'FREAK FREQUENCIES', 'Uptown Room', 'Richland', 'Ghost Bloom / Static TV / DJ Rat King', 'other', '$12', '8 PM', 0)
  }
  if (db.prepare('SELECT COUNT(*) AS count FROM news').get().count === 0) {
    const insert = db.prepare('INSERT INTO news (label, title, summary, link, featured) VALUES (?, ?, ?, ?, ?)')
    insert.run('SCENE REPORT', "DIY IS NOT A GENRE. IT'S HOW WE SURVIVE.", 'A starter guide to booking a room, making a bill, and keeping the door open for the next band.', '#submit', 1)
    insert.run('CALL FOR SUBMISSIONS', 'Send us your flyers, demos, photos, and dispatches.', '', '#submit', 0)
    insert.run('VENUE WATCH', 'Four rooms keeping original music on the calendar.', '', '#shows', 0)
    insert.run('NEW RELEASE', 'Three local records for your next late-night drive.', '', '#radio', 0)
  }
  const defaults = {
    hero_title: 'MAKE|YOUR OWN|NOISE.',
    hero_text: "Your independent wire for loud rooms, weird sounds, DIY culture, and everything happening after dark in Washington's Tri-Cities.",
    radio_status: 'OFFLINE',
    radio_title: 'NO SIGNAL',
    radio_message: 'Radio system reserved for phase two.'
  }
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  Object.entries(defaults).forEach(([key, value]) => insertSetting.run(key, value))
})
seed()

db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now())

const app = express()
const radio = new IcyRadio(musicDir)
radio.start()
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use(express.json({ limit: '64kb' }))
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'")
  next()
})

const parseCookies = (header = '') => Object.fromEntries(header.split(';').map((item) => item.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2))
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex')
const safeEqual = (a, b) => {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

const requireAuth = (req, res, next) => {
  const token = parseCookies(req.headers.cookie).tcpmm_session
  if (!token) return res.status(401).json({ error: 'Authentication required' })
  const session = db.prepare(`SELECT sessions.*, admins.username FROM sessions
    JOIN admins ON admins.id = sessions.admin_id WHERE token_hash = ? AND expires_at > ?`).get(tokenHash(token), Date.now())
  if (!session) return res.status(401).json({ error: 'Session expired' })
  req.session = session
  next()
}

const requireCsrf = (req, res, next) => {
  if (req.get('X-CSRF-Token') !== req.session.csrf_token) return res.status(403).json({ error: 'Invalid CSRF token' })
  next()
}

const loginAttempts = new Map()
app.post('/api/admin/login', (req, res) => {
  const key = req.ip
  const attempt = loginAttempts.get(key) || { count: 0, reset: Date.now() + 15 * 60_000 }
  if (Date.now() > attempt.reset) { attempt.count = 0; attempt.reset = Date.now() + 15 * 60_000 }
  if (attempt.count >= 8) return res.status(429).json({ error: 'Too many attempts; try again later' })
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username)
  if (!admin || !safeEqual(hashPassword(password, admin.password_salt), admin.password_hash)) {
    attempt.count += 1
    loginAttempts.set(key, attempt)
    return res.status(401).json({ error: 'Invalid credentials' })
  }
  loginAttempts.delete(key)
  const token = crypto.randomBytes(32).toString('base64url')
  const csrf = crypto.randomBytes(24).toString('base64url')
  const expires = Date.now() + 12 * 60 * 60_000
  db.prepare('INSERT INTO sessions (token_hash, admin_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash(token), admin.id, csrf, expires)
  const secure = req.secure || req.get('x-forwarded-proto') === 'https'
  res.setHeader('Set-Cookie', `tcpmm_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`)
  res.json({ username: admin.username, csrfToken: csrf })
})

app.get('/api/admin/session', requireAuth, (req, res) => res.json({ id: req.session.admin_id, username: req.session.username, csrfToken: req.session.csrf_token }))
app.post('/api/admin/logout', requireAuth, requireCsrf, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.session.token_hash)
  res.setHeader('Set-Cookie', 'tcpmm_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
  res.status(204).end()
})

const adminFields = (body, passwordRequired = true) => {
  const username = String(body?.username || '').trim()
  const password = String(body?.password || '')
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw new Error('Username must be 3–32 letters, numbers, dots, dashes, or underscores')
  if ((passwordRequired || password) && (password.length < 12 || password.length > 128)) throw new Error('Password must be 12–128 characters')
  return { username, password }
}

app.post('/api/admin/users', requireAuth, requireCsrf, (req, res) => {
  try {
    const { username, password } = adminFields(req.body)
    const salt = crypto.randomBytes(24).toString('hex')
    const result = db.prepare('INSERT INTO admins (username, password_hash, password_salt) VALUES (?, ?, ?)')
      .run(username, hashPassword(password, salt), salt)
    res.status(201).json({ id: result.lastInsertRowid })
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Username already exists' })
    res.status(400).json({ error: error.message })
  }
})

app.put('/api/admin/users/:id', requireAuth, requireCsrf, (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid administrator ID' })
    const { username, password } = adminFields(req.body, false)
    const updateAdmin = db.transaction(() => {
      const admin = db.prepare('SELECT id FROM admins WHERE id = ?').get(id)
      if (!admin) return false
      if (password) {
        const salt = crypto.randomBytes(24).toString('hex')
        db.prepare('UPDATE admins SET username = ?, password_hash = ?, password_salt = ? WHERE id = ?')
          .run(username, hashPassword(password, salt), salt, id)
        if (id === req.session.admin_id) db.prepare('DELETE FROM sessions WHERE admin_id = ? AND token_hash <> ?').run(id, req.session.token_hash)
        else db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(id)
      } else {
        db.prepare('UPDATE admins SET username = ? WHERE id = ?').run(username, id)
      }
      return true
    })
    if (!updateAdmin()) return res.status(404).json({ error: 'Administrator not found' })
    res.status(204).end()
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Username already exists' })
    res.status(400).json({ error: error.message })
  }
})

app.delete('/api/admin/users/:id', requireAuth, requireCsrf, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid administrator ID' })
  if (id === req.session.admin_id) return res.status(400).json({ error: 'You cannot delete your own account' })
  const deleteAdmin = db.transaction(() => {
    if (db.prepare('SELECT COUNT(*) AS count FROM admins').get().count <= 1) return 'last'
    return db.prepare('DELETE FROM admins WHERE id = ?').run(id).changes ? 'deleted' : 'missing'
  })
  const result = deleteAdmin()
  if (result === 'last') return res.status(400).json({ error: 'The last administrator cannot be deleted' })
  if (result === 'missing') return res.status(404).json({ error: 'Administrator not found' })
  res.status(204).end()
})

const eventFields = (body) => {
  const item = {
    event_date: String(body.event_date || ''), title: String(body.title || '').trim(), venue: String(body.venue || '').trim(),
    city: String(body.city || '').trim(), lineup: String(body.lineup || '').trim(), genre: String(body.genre || ''),
    price: String(body.price || '').trim(), doors: String(body.doors || '').trim(), featured: body.featured ? 1 : 0,
    published: body.published === false ? 0 : 1
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.event_date) || !item.title || !item.venue || !item.city || !item.lineup || !['punk','metal','hardcore','other'].includes(item.genre)) throw new Error('Complete all required event fields')
  return item
}

app.get('/api/content', (_req, res) => {
  const events = db.prepare('SELECT * FROM events WHERE published = 1 ORDER BY event_date, id').all()
  const news = db.prepare('SELECT * FROM news WHERE published = 1 ORDER BY featured DESC, id').all()
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(({ key, value }) => [key, value]))
  res.setHeader('Cache-Control', 'public, max-age=30')
  res.json({ events, news, settings })
})

const submissionAttempts = new Map()
const submissionTokens = new Map()
const submissionText = (value, maximum) => (typeof value === 'string' ? value : '').normalize('NFKC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, maximum)
const submissionFields = (body) => {
  const item = {
    event_date: submissionText(body?.event_date, 10),
    title: submissionText(body?.title, 100),
    venue: submissionText(body?.venue, 100),
    city: submissionText(body?.city, 60),
    address: submissionText(body?.address, 200),
    lineup: submissionText(body?.lineup, 300),
    genre: submissionText(body?.genre, 20),
    price: submissionText(body?.price, 30),
    doors: submissionText(body?.doors, 30),
    description: submissionText(body?.description, 2000),
    contact: submissionText(body?.contact, 300)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.event_date) || !item.title || !item.venue || !item.city || !item.address || !item.lineup || !['punk','metal','hardcore','other'].includes(item.genre) || !item.description || !item.contact) throw new Error('Complete every required show submission field')
  const date = new Date(`${item.event_date}T12:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== item.event_date) throw new Error('Enter a valid show date')
  return item
}

app.get('/api/show-submissions/form-token', (req, res) => {
  const now = Date.now()
  for (const [token, record] of submissionTokens) if (record.expires < now) submissionTokens.delete(token)
  const token = crypto.randomBytes(24).toString('base64url')
  submissionTokens.set(token, { ip: req.ip, created: now, expires: now + 30 * 60_000 })
  res.setHeader('Cache-Control', 'no-store')
  res.json({ token })
})

app.post('/api/show-submissions', (req, res) => {
  if (req.body?.website) return res.status(201).json({ received: true })
  const now = Date.now()
  const key = req.ip
  const token = typeof req.body?.form_token === 'string' ? req.body.form_token : ''
  const tokenRecord = submissionTokens.get(token)
  submissionTokens.delete(token)
  if (!tokenRecord || tokenRecord.ip !== key || tokenRecord.expires < now || now - tokenRecord.created < 1500) {
    return res.status(403).json({ error: 'Open the submission page and try again' })
  }
  const recent = (submissionAttempts.get(key) || []).filter((time) => now - time < 60 * 60_000)
  if (recent.length >= 5) {
    submissionAttempts.set(key, recent)
    res.setHeader('Retry-After', '3600')
    return res.status(429).json({ error: 'Too many submissions; try again later' })
  }
  try {
    const item = submissionFields(req.body)
    submissionsDb.prepare(`INSERT INTO show_submissions
      (event_date, title, venue, city, address, lineup, genre, price, doors, description, contact)
      VALUES (@event_date, @title, @venue, @city, @address, @lineup, @genre, @price, @doors, @description, @contact)`).run(item)
  } catch (error) { return res.status(400).json({ error: error.message }) }
  recent.push(now)
  submissionAttempts.set(key, recent)
  res.status(201).json({ received: true })
})

const chatAttempts = new Map()
const chatListeners = new Set()
const chatRow = (row) => ({ id: row.id, name: row.name, text: row.text, system: Boolean(row.system), createdAt: row.created_at })
const chatText = (value, maximum) => (typeof value === 'string' ? value : '').normalize('NFKC').replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim().slice(0, maximum)

app.get('/api/chat/messages', (req, res) => {
  const after = Number(req.query.after || 0)
  if (!Number.isSafeInteger(after) || after < 0) return res.status(400).json({ error: 'Invalid message cursor' })
  const rows = after
    ? chatDb.prepare('SELECT id, name, text, system, created_at FROM messages WHERE id > ? ORDER BY id LIMIT 100').all(after)
    : chatDb.prepare('SELECT id, name, text, system, created_at FROM (SELECT id, name, text, system, created_at FROM messages ORDER BY id DESC LIMIT 50) ORDER BY id').all()
  res.setHeader('Cache-Control', 'no-store')
  res.json({ messages: rows.map(chatRow) })
})

app.get('/api/chat/events', (req, res) => {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive'
  })
  res.flushHeaders()
  res.write(': connected\n\n')
  chatListeners.add(res)
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000)
  req.on('close', () => { clearInterval(heartbeat); chatListeners.delete(res) })
})

app.post('/api/chat/messages', (req, res) => {
  const key = req.ip
  const now = Date.now()
  const recent = (chatAttempts.get(key) || []).filter((time) => now - time < 30_000)
  if (recent.length >= 6 || (recent.length && now - recent.at(-1) < 750)) {
    chatAttempts.set(key, recent)
    res.setHeader('Retry-After', '2')
    return res.status(429).json({ error: 'Slow down before posting again' })
  }

  const name = chatText(req.body?.name, 18)
  const text = chatText(req.body?.text, 120)
  if (name.length < 2 || text.length < 1) return res.status(400).json({ error: 'Enter a name and message' })
  recent.push(now)
  chatAttempts.set(key, recent)
  const result = chatDb.prepare('INSERT INTO messages (name, text, created_at) VALUES (?, ?, ?)').run(name, text, now)
  const message = chatDb.prepare('SELECT id, name, text, system, created_at FROM messages WHERE id = ?').get(result.lastInsertRowid)
  const output = chatRow(message)
  for (const listener of chatListeners) listener.write(`data: ${JSON.stringify(output)}\n\n`)
  res.status(201).json({ message: output })
})

app.get('/api/radio/status', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({ online: radio.online, title: radio.title, trackCount: radio.trackCount, listeners: radio.listeners.size })
})

app.get('/radio/stream', (req, res) => {
  if (!radio.trackCount) return res.status(503).json({ error: 'No media files are available' })
  const includeMetadata = req.get('Icy-MetaData') === '1'
  res.status(200)
  res.set({
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Accept-Ranges': 'none',
    'icy-name': 'TCPM&M Radio',
    'icy-description': 'Tri-Cities punk, metal and more',
    'icy-genre': 'Punk Metal Hardcore',
    'icy-br': '128',
    ...(includeMetadata ? { 'icy-metaint': '16000' } : {})
  })
  res.flushHeaders()
  radio.addListener(res, includeMetadata)
})

app.get('/api/admin/content', requireAuth, (_req, res) => {
  res.json({
    events: db.prepare('SELECT * FROM events ORDER BY event_date, id').all(),
    news: db.prepare('SELECT * FROM news ORDER BY featured DESC, id').all(),
    submissions: submissionsDb.prepare('SELECT * FROM show_submissions ORDER BY reviewed, created_at DESC, id DESC').all(),
    admins: db.prepare('SELECT id, username, created_at FROM admins ORDER BY username COLLATE NOCASE, id').all(),
    settings: Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(({ key, value }) => [key, value]))
  })
})

app.get('/api/admin/submissions', requireAuth, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({
    submissions: submissionsDb.prepare('SELECT * FROM show_submissions ORDER BY reviewed, created_at DESC, id DESC').all()
  })
})

app.post('/api/admin/events', requireAuth, requireCsrf, (req, res) => {
  try {
    const item = eventFields(req.body)
    const result = db.prepare(`INSERT INTO events (event_date,title,venue,city,lineup,genre,price,doors,featured,published)
      VALUES (@event_date,@title,@venue,@city,@lineup,@genre,@price,@doors,@featured,@published)`).run(item)
    res.status(201).json({ id: result.lastInsertRowid })
  } catch (error) { res.status(400).json({ error: error.message }) }
})
app.put('/api/admin/events/:id', requireAuth, requireCsrf, (req, res) => {
  try {
    const item = { ...eventFields(req.body), id: Number(req.params.id) }
    const result = db.prepare(`UPDATE events SET event_date=@event_date,title=@title,venue=@venue,city=@city,lineup=@lineup,
      genre=@genre,price=@price,doors=@doors,featured=@featured,published=@published,updated_at=CURRENT_TIMESTAMP WHERE id=@id`).run(item)
    if (!result.changes) return res.status(404).json({ error: 'Event not found' })
    res.status(204).end()
  } catch (error) { res.status(400).json({ error: error.message }) }
})
app.delete('/api/admin/events/:id', requireAuth, requireCsrf, (req, res) => {
  db.prepare('DELETE FROM events WHERE id = ?').run(Number(req.params.id)); res.status(204).end()
})

const newsFields = (body) => {
  const item = { label: String(body.label || '').trim(), title: String(body.title || '').trim(), summary: String(body.summary || '').trim(), link: String(body.link || '#').trim(), featured: body.featured ? 1 : 0, published: body.published === false ? 0 : 1 }
  if (!item.label || !item.title || (!item.link.startsWith('#') && !/^\/(?!\/)/.test(item.link))) throw new Error('News requires a label, title, and local link')
  return item
}
app.post('/api/admin/news', requireAuth, requireCsrf, (req, res) => {
  try { const item = newsFields(req.body); const result = db.prepare('INSERT INTO news (label,title,summary,link,featured,published) VALUES (@label,@title,@summary,@link,@featured,@published)').run(item); res.status(201).json({ id: result.lastInsertRowid }) }
  catch (error) { res.status(400).json({ error: error.message }) }
})
app.put('/api/admin/news/:id', requireAuth, requireCsrf, (req, res) => {
  try { const item = { ...newsFields(req.body), id: Number(req.params.id) }; const result = db.prepare('UPDATE news SET label=@label,title=@title,summary=@summary,link=@link,featured=@featured,published=@published,updated_at=CURRENT_TIMESTAMP WHERE id=@id').run(item); if (!result.changes) return res.status(404).json({ error: 'Story not found' }); res.status(204).end() }
  catch (error) { res.status(400).json({ error: error.message }) }
})
app.delete('/api/admin/news/:id', requireAuth, requireCsrf, (req, res) => { db.prepare('DELETE FROM news WHERE id = ?').run(Number(req.params.id)); res.status(204).end() })

app.put('/api/admin/submissions/:id/reviewed', requireAuth, requireCsrf, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid submission ID' })
  const result = submissionsDb.prepare('UPDATE show_submissions SET reviewed = ? WHERE id = ?').run(req.body?.reviewed === false ? 0 : 1, id)
  if (!result.changes) return res.status(404).json({ error: 'Submission not found' })
  res.status(204).end()
})
app.put('/api/admin/submissions/:id', requireAuth, requireCsrf, (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid submission ID' })
    const item = { ...submissionFields(req.body), id, reviewed: req.body?.reviewed ? 1 : 0 }
    const result = submissionsDb.prepare(`UPDATE show_submissions SET event_date=@event_date, title=@title, venue=@venue,
      city=@city, address=@address, lineup=@lineup, genre=@genre, price=@price, doors=@doors,
      description=@description, contact=@contact, reviewed=@reviewed WHERE id=@id`).run(item)
    if (!result.changes) return res.status(404).json({ error: 'Submission not found' })
    res.status(204).end()
  } catch (error) { res.status(400).json({ error: error.message }) }
})
app.post('/api/admin/submissions/:id/promote', requireAuth, requireCsrf, (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid submission ID' })
    const submission = submissionsDb.prepare('SELECT * FROM show_submissions WHERE id = ?').get(id)
    if (!submission) return res.status(404).json({ error: 'Submission not found' })
    if (submission.published_event_id) return res.status(409).json({ error: 'Submission has already been published' })
    const item = eventFields({ ...submission, featured: false, published: true })
    const result = db.prepare(`INSERT INTO events (event_date,title,venue,city,lineup,genre,price,doors,featured,published)
      VALUES (@event_date,@title,@venue,@city,@lineup,@genre,@price,@doors,@featured,@published)`).run(item)
    try { submissionsDb.prepare('UPDATE show_submissions SET reviewed = 1, published_event_id = ?, published_at = CURRENT_TIMESTAMP WHERE id = ?').run(result.lastInsertRowid, id) }
    catch (error) { db.prepare('DELETE FROM events WHERE id = ?').run(result.lastInsertRowid); throw error }
    res.status(201).json({ id: result.lastInsertRowid })
  } catch (error) { res.status(400).json({ error: error.message }) }
})
app.delete('/api/admin/submissions/:id', requireAuth, requireCsrf, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid submission ID' })
  const result = submissionsDb.prepare('DELETE FROM show_submissions WHERE id = ?').run(id)
  if (!result.changes) return res.status(404).json({ error: 'Submission not found' })
  res.status(204).end()
})

app.put('/api/admin/settings', requireAuth, requireCsrf, (req, res) => {
  const allowed = ['hero_title','hero_text','radio_status','radio_title','radio_message']
  const update = db.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`)
  const transaction = db.transaction((settings) => allowed.forEach((key) => { if (key in settings) update.run(key, String(settings[key]).slice(0, 1000)) }))
  transaction(req.body || {})
  res.status(204).end()
})

app.use(express.static(path.join(root, 'dist'), { index: false, maxAge: production ? '1h' : 0 }))
app.get('/admin', (_req, res) => res.sendFile(path.join(root, 'dist', 'admin', 'index.html')))
app.get(['/submit', '/submit/'], (_req, res) => res.sendFile(path.join(root, 'dist', 'submit', 'index.html')))
app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')))

app.use((error, _req, res, _next) => {
  console.error(error)
  res.status(500).json({ error: 'Internal server error' })
})

const server = app.listen(port, host, () => console.log(`TCPM&M listening on http://${host}:${port}`))
const shutdown = () => { radio.stop(); for (const listener of chatListeners) listener.end(); server.close(() => { submissionsDb.close(); chatDb.close(); db.close(); process.exit(0) }) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
