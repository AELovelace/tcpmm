import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { config as loadEnv } from 'dotenv'
import express from 'express'
import sanitizeHtml from 'sanitize-html'
import { createPublicApi } from './public-api.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
loadEnv({ path: path.join(root, '.env'), quiet: true })

const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'))
const dbPath = path.join(dataDir, 'tcpmm.sqlite')
const chatDbPath = path.resolve(process.env.CHAT_DB_PATH || path.join(dataDir, 'tcpmm-chat.sqlite'))
const submissionsDbPath = path.resolve(process.env.SUBMISSIONS_DB_PATH || path.join(dataDir, 'tcpmm-submissions.sqlite'))
const articleDir = path.join(dataDir, 'articles')
const venueImageDir = path.join(dataDir, 'venue-images')
if (chatDbPath.toLowerCase() === dbPath.toLowerCase()) throw new Error('CHAT_DB_PATH must be different from the site database path')
if ([dbPath, chatDbPath].some((databasePath) => submissionsDbPath.toLowerCase() === databasePath.toLowerCase())) throw new Error('SUBMISSIONS_DB_PATH must be different from the site and chat database paths')
const port = Number(process.env.PORT || 3030)
const host = process.env.HOST || '127.0.0.1'
const production = process.env.NODE_ENV === 'production'
const musicDir = path.resolve(process.env.MUSIC_DIR || path.join(root, 'music'))
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe'
const genres = Object.freeze(['punk', 'metal', 'hardcore', 'rock', 'alternative', 'edm', 'rap', 'other'])
const genreSqlList = genres.map((genre) => `'${genre}'`).join(',')
const isGenre = (value) => genres.includes(value) // Keeps API validation aligned with every genre offered by the forms.

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

const cleanMetadata = (value) => typeof value === 'string' ? value.trim().slice(0, 200) : '' // Normalizes untrusted media tags before they reach the public status API.
const readTrackMetadata = (file, directory) => {
  const titleFallback = path.basename(file, path.extname(file)).replaceAll('_', ' ').trim()
  const folders = path.relative(directory, path.dirname(file)).split(path.sep).filter((folder) => folder && folder !== '.')
  const artistFallback = folders[0] || ''
  const albumFallback = folders.length > 1 ? folders.slice(1).join(' / ') : ''
  try {
    const probe = spawnSync(ffprobePath, [
      '-v', 'quiet', '-show_entries', 'format_tags=title,artist,album', '-of', 'json', file
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 })
    const tags = probe.status === 0 ? JSON.parse(probe.stdout || '{}')?.format?.tags ?? {} : {}
    const normalizedTags = Object.fromEntries(Object.entries(tags).map(([key, value]) => [key.toLowerCase(), value]))
    return {
      title: cleanMetadata(normalizedTags.title) || titleFallback,
      artist: cleanMetadata(normalizedTags.artist) || artistFallback,
      album: cleanMetadata(normalizedTags.album) || albumFallback
    }
  } catch {
    return { title: titleFallback, artist: artistFallback, album: albumFallback }
  }
} // Reads embedded tags for the current song and falls back to the music/Artist/Album folder convention.

class IcyRadio {
  constructor(directory) {
    this.directory = directory
    this.listeners = new Set()
    this.playlist = []
    this.process = null
    this.retryTimer = null
    this.title = 'NO SIGNAL'
    this.artist = ''
    this.album = ''
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
      this.artist = ''
      this.album = ''
      this.retryTimer = setTimeout(() => this.playNext(), 5000)
      return
    }

    const metadata = readTrackMetadata(file, this.directory)
    this.title = metadata.title
    this.artist = metadata.artist
    this.album = metadata.album
    const ffmpeg = spawn(ffmpegPath, [
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
    const trackLabel = [this.artist, this.title].filter(Boolean).join(' - ')
    const escapedTitle = trackLabel.replaceAll("'", '’').slice(0, 240)
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
fs.mkdirSync(articleDir, { recursive: true, mode: 0o700 })
fs.mkdirSync(venueImageDir, { recursive: true, mode: 0o700 })
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
    genre TEXT NOT NULL DEFAULT 'other' CHECK (genre IN (${genreSqlList})),
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

const submissionGenreSchema = submissionsDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'show_submissions'").get()?.sql || ''
if (!genres.every((genre) => submissionGenreSchema.includes(`'${genre}'`))) {
  submissionsDb.transaction(() => {
    submissionsDb.exec(`
      DROP INDEX IF EXISTS show_submissions_reviewed_created;
      ALTER TABLE show_submissions RENAME TO show_submissions_legacy_genres;
      CREATE TABLE show_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_date TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        venue TEXT NOT NULL,
        city TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL,
        lineup TEXT NOT NULL,
        genre TEXT NOT NULL DEFAULT 'other' CHECK (genre IN (${genreSqlList})),
        price TEXT NOT NULL DEFAULT '',
        doors TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL,
        contact TEXT NOT NULL DEFAULT '',
        reviewed INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0,1)),
        published_event_id INTEGER,
        published_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO show_submissions
        (id, event_date, title, venue, city, address, lineup, genre, price, doors, description, contact, reviewed, published_event_id, published_at, created_at)
        SELECT id, event_date, title, venue, city, address, lineup, genre, price, doors, description, contact, reviewed, published_event_id, published_at, created_at
        FROM show_submissions_legacy_genres;
      DROP TABLE show_submissions_legacy_genres;
      CREATE INDEX show_submissions_reviewed_created ON show_submissions(reviewed, created_at DESC);
    `)
  })() // Rebuilds the constrained table atomically so existing submissions retain every field.
}

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('organizer','admin')),
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
    genre TEXT NOT NULL CHECK (genre IN (${genreSqlList})),
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
    slug TEXT NOT NULL DEFAULT '',
    body_html TEXT NOT NULL DEFAULT '',
    featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
    published INTEGER NOT NULL DEFAULT 1 CHECK (published IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS venues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    city TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    image_path TEXT NOT NULL DEFAULT '',
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
  CREATE TABLE IF NOT EXISTS show_api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT,
    request_count INTEGER NOT NULL DEFAULT 0,
    revoked_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS show_api_keys_active_name
    ON show_api_keys(name COLLATE NOCASE) WHERE revoked_at IS NULL;
  CREATE TABLE IF NOT EXISTS show_api_requests (
    api_key_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    event_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (api_key_id, idempotency_key)
  );
`)

const adminColumns = new Set(db.prepare('PRAGMA table_info(admins)').all().map((column) => column.name))
if (!adminColumns.has('role')) db.exec("ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('organizer','admin'))") // Promotes every legacy account to full admin while adding the organizer tier safely.

const eventGenreSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'").get()?.sql || ''
if (!genres.every((genre) => eventGenreSchema.includes(`'${genre}'`))) {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE events RENAME TO events_legacy_genres;
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_date TEXT NOT NULL,
        title TEXT NOT NULL,
        venue TEXT NOT NULL,
        city TEXT NOT NULL,
        lineup TEXT NOT NULL,
        genre TEXT NOT NULL CHECK (genre IN (${genreSqlList})),
        price TEXT NOT NULL DEFAULT '',
        doors TEXT NOT NULL DEFAULT '',
        featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
        published INTEGER NOT NULL DEFAULT 1 CHECK (published IN (0,1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO events
        (id, event_date, title, venue, city, lineup, genre, price, doors, featured, published, created_at, updated_at)
        SELECT id, event_date, title, venue, city, lineup, genre, price, doors, featured, published, created_at, updated_at
        FROM events_legacy_genres;
      DROP TABLE events_legacy_genres;
    `)
  })() // Expands the SQLite CHECK constraint without discarding existing event records.
}

const newsColumns = new Set(db.prepare('PRAGMA table_info(news)').all().map((column) => column.name))
if (!newsColumns.has('slug')) db.exec("ALTER TABLE news ADD COLUMN slug TEXT NOT NULL DEFAULT ''")
if (!newsColumns.has('body_html')) db.exec("ALTER TABLE news ADD COLUMN body_html TEXT NOT NULL DEFAULT ''")
const slugify = (value) => String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
const rowsMissingSlugs = db.prepare("SELECT id, title FROM news WHERE slug = '' ORDER BY id").all()
const setInitialSlug = db.prepare('UPDATE news SET slug = ? WHERE id = ?')
for (const row of rowsMissingSlugs) setInitialSlug.run(`${slugify(row.title) || 'story'}-${row.id}`, row.id)
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS news_slug_unique ON news(slug)')

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
    const insert = db.prepare('INSERT INTO news (label, title, summary, link, slug, featured) VALUES (?, ?, ?, ?, ?, ?)')
    insert.run('SCENE REPORT', "DIY IS NOT A GENRE. IT'S HOW WE SURVIVE.", 'A starter guide to booking a room, making a bill, and keeping the door open for the next band.', '#submit', 'diy-is-not-a-genre', 1)
    insert.run('CALL FOR SUBMISSIONS', 'Send us your flyers, demos, photos, and dispatches.', '', '#submit', 'call-for-submissions', 0)
    insert.run('VENUE WATCH', 'Four rooms keeping original music on the calendar.', '', '#shows', 'venue-watch', 0)
    insert.run('NEW RELEASE', 'Three local records for your next late-night drive.', '', '#radio', 'new-release', 0)
  }
  const defaults = {
    hero_title: 'MAKE|YOUR OWN|NOISE.',
    hero_text: "Your independent wire for loud rooms, weird sounds, DIY culture, and everything happening after dark in Washington's Tri-Cities.",
    radio_status: 'OFFLINE',
    radio_title: 'NO SIGNAL',
    radio_message: ''
  }
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  Object.entries(defaults).forEach(([key, value]) => insertSetting.run(key, value))
  db.prepare("UPDATE settings SET value = '' WHERE key = 'radio_message' AND value = 'Radio system reserved for phase two.'").run()
})
seed()

const escapeMarkup = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
const sanitizeArticleHtml = (value) => sanitizeHtml(String(value || '').slice(0, 60_000), {
  allowedTags: ['p', 'br', 'h2', 'h3', 'h4', 'strong', 'em', 'u', 's', 'blockquote', 'ul', 'ol', 'li', 'a', 'hr'],
  allowedAttributes: { a: ['href', 'title', 'target', 'rel'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    a: (_tagName, attributes) => ({ tagName: 'a', attribs: {
      ...attributes,
      ...(attributes.target === '_blank' ? { rel: 'noopener noreferrer' } : {})
    } })
  }
})
const articlePath = (slug) => path.join(articleDir, `${slug}.html`)
const removeArticlePage = (slug) => { if (slug && /^[a-z0-9-]+$/.test(slug)) fs.rmSync(articlePath(slug), { force: true }) }
const writeArticlePage = (article) => {
  removeArticlePage(article.slug)
  if (!article.published || !article.body_html) return
  const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content="${escapeMarkup(article.summary)}" />
  <meta name="theme-color" content="#050607" />
  <title>${escapeMarkup(article.title)} // TCPM&amp;M</title>
  <link rel="stylesheet" href="/article.css" />
</head>
<body>
  <a class="skip-link" href="#article">Skip to article</a>
  <header class="masthead"><a href="/">TCPM&amp;M <span>// TRANSMISSIONS</span></a><a href="/#news">BACK TO NEWS ↙</a></header>
  <main id="article" class="article-shell">
    <header class="article-header"><span class="label">${escapeMarkup(article.label)}</span><h1>${escapeMarkup(article.title)}</h1>${article.summary ? `<p>${escapeMarkup(article.summary)}</p>` : ''}<div class="rule"><i></i><span>TRI-CITIES, WA · ${escapeMarkup(article.updated_at.slice(0, 10))}</span></div></header>
    <article class="article-body">${article.body_html}</article>
    <footer><a href="/#news">← MORE TRANSMISSIONS</a><strong>509 UNDERGROUND</strong></footer>
  </main>
</body>
</html>`
  const temporary = `${articlePath(article.slug)}.tmp`
  fs.writeFileSync(temporary, page, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, articlePath(article.slug))
}
for (const file of fs.readdirSync(articleDir)) if (file.endsWith('.html') || file.endsWith('.tmp')) fs.rmSync(path.join(articleDir, file), { force: true })
for (const article of db.prepare("SELECT * FROM news WHERE published = 1 AND body_html <> ''").all()) writeArticlePage(article)

db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now())

const app = express()
const radio = new IcyRadio(musicDir)
radio.start()
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use(express.json({ limit: '96kb' }))
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

const environmentShowApiKeys = String(process.env.SHOW_API_KEYS || '').split(',').filter(Boolean).map((entry) => {
  const separator = entry.indexOf(':')
  const id = entry.slice(0, separator).trim()
  const hash = entry.slice(separator + 1).trim().toLowerCase()
  if (separator < 1 || !/^[A-Za-z0-9_-]{1,32}$/.test(id) || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('SHOW_API_KEYS must contain comma-separated name:sha256-hash entries')
  }
  return { id, hash }
}) // Loads only hashed API credentials so a copied environment file cannot be used as a Bearer token.
if (new Set(environmentShowApiKeys.map(({ id }) => id)).size !== environmentShowApiKeys.length) throw new Error('SHOW_API_KEYS names must be unique')

const listShowApiKeys = () => {
  const stored = db.prepare(`SELECT show_api_keys.id, show_api_keys.name, show_api_keys.created_at,
    show_api_keys.last_used_at, show_api_keys.request_count, admins.username AS created_by
    FROM show_api_keys LEFT JOIN admins ON admins.id = show_api_keys.created_by
    WHERE show_api_keys.revoked_at IS NULL ORDER BY show_api_keys.created_at DESC`).all()
    .map((item) => ({ ...item, source: 'site' }))
  const configured = environmentShowApiKeys.map((item) => ({
    id: `environment:${item.id}`, name: item.id, created_at: null, last_used_at: null,
    request_count: null, created_by: null, source: 'environment'
  }))
  return [...stored, ...configured]
} // Returns safe key metadata for the control panel without ever exposing a credential hash or secret.

const failedShowApiAttempts = new Map()
const showApiAttempts = new Map()
const pruneAttempts = (attempts, now, windowMs) => attempts.filter((time) => now - time < windowMs) // Keeps each in-memory rate-limit bucket bounded to its active time window.
const requireShowApiKey = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  const now = Date.now()
  const failed = pruneAttempts(failedShowApiAttempts.get(req.ip) || [], now, 15 * 60_000)
  if (failed.length >= 20) {
    failedShowApiAttempts.set(req.ip, failed)
    res.setHeader('Retry-After', '900')
    return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many authentication attempts; try again later' } })
  }
  const authorization = req.get('Authorization') || ''
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)
  const presentedHash = tokenHash(match?.[1] || '')
  const storedCredential = db.prepare('SELECT id FROM show_api_keys WHERE token_hash = ? AND revoked_at IS NULL').get(presentedHash)
  const configuredCredential = environmentShowApiKeys.find((item) => safeEqual(presentedHash, item.hash))
  const credential = storedCredential
    ? { ledgerId: `site:${storedCredential.id}`, storedId: storedCredential.id }
    : configuredCredential ? { ledgerId: `environment:${configuredCredential.id}` } : null
  if (!credential) {
    failed.push(now)
    failedShowApiAttempts.set(req.ip, failed)
    res.setHeader('WWW-Authenticate', 'Bearer realm="show-api"')
    return res.status(401).json({ error: { code: 'invalid_token', message: 'A valid show API Bearer token is required' } })
  }
  failedShowApiAttempts.delete(req.ip)
  const recent = pruneAttempts(showApiAttempts.get(credential.ledgerId) || [], now, 60 * 60_000)
  if (recent.length >= 60) {
    showApiAttempts.set(credential.ledgerId, recent)
    res.setHeader('Retry-After', '3600')
    return res.status(429).json({ error: { code: 'rate_limited', message: 'Show API rate limit exceeded; try again later' } })
  }
  recent.push(now)
  showApiAttempts.set(credential.ledgerId, recent)
  if (credential.storedId) db.prepare('UPDATE show_api_keys SET last_used_at = CURRENT_TIMESTAMP, request_count = request_count + 1 WHERE id = ?').run(credential.storedId)
  req.showApiKeyId = credential.ledgerId
  next()
} // Authenticates machine clients with timing-safe hash comparisons and applies separate abuse limits.

const requireAuth = (req, res, next) => {
  const token = parseCookies(req.headers.cookie).tcpmm_session
  if (!token) return res.status(401).json({ error: 'Authentication required' })
  const session = db.prepare(`SELECT sessions.*, admins.username, admins.role FROM sessions
    JOIN admins ON admins.id = sessions.admin_id WHERE token_hash = ? AND expires_at > ?`).get(tokenHash(token), Date.now())
  if (!session) return res.status(401).json({ error: 'Session expired' })
  req.session = session
  next()
} // Refreshes the account role from the database on every request so permission changes take effect immediately.

const requireAdministrator = (req, res, next) => {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' })
  next()
} // Keeps user management and API-key controls behind the full administrator tier.

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
  res.json({ id: admin.id, username: admin.username, role: admin.role, csrfToken: csrf })
})

app.get('/api/admin/session', requireAuth, (req, res) => res.json({ id: req.session.admin_id, username: req.session.username, role: req.session.role, csrfToken: req.session.csrf_token }))
app.post('/api/admin/logout', requireAuth, requireCsrf, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.session.token_hash)
  res.setHeader('Set-Cookie', 'tcpmm_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
  res.status(204).end()
})

const adminFields = (body, passwordRequired = true) => {
  const username = String(body?.username || '').trim()
  const password = String(body?.password || '')
  const role = String(body?.role || '')
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw new Error('Username must be 3–32 letters, numbers, dots, dashes, or underscores')
  if ((passwordRequired || password) && (password.length < 12 || password.length > 128)) throw new Error('Password must be 12–128 characters')
  if (!['organizer', 'admin'].includes(role)) throw new Error('Role must be organizer or admin')
  return { username, password, role }
} // Validates both account credentials and the explicit two-tier role assignment.

app.post('/api/admin/users', requireAuth, requireAdministrator, requireCsrf, (req, res) => {
  try {
    const { username, password, role } = adminFields(req.body)
    const salt = crypto.randomBytes(24).toString('hex')
    const result = db.prepare('INSERT INTO admins (username, password_hash, password_salt, role) VALUES (?, ?, ?, ?)')
      .run(username, hashPassword(password, salt), salt, role)
    res.status(201).json({ id: result.lastInsertRowid })
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Username already exists' })
    res.status(400).json({ error: error.message })
  }
})

app.put('/api/admin/users/:id', requireAuth, requireAdministrator, requireCsrf, (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid administrator ID' })
    const { username, password, role } = adminFields(req.body, false)
    const updateAdmin = db.transaction(() => {
      const admin = db.prepare('SELECT id, role FROM admins WHERE id = ?').get(id)
      if (!admin) return 'missing'
      if (admin.role === 'admin' && role !== 'admin' && db.prepare("SELECT COUNT(*) AS count FROM admins WHERE role = 'admin'").get().count <= 1) return 'last-admin'
      if (password) {
        const salt = crypto.randomBytes(24).toString('hex')
        db.prepare('UPDATE admins SET username = ?, password_hash = ?, password_salt = ?, role = ? WHERE id = ?')
          .run(username, hashPassword(password, salt), salt, role, id)
        if (id === req.session.admin_id) db.prepare('DELETE FROM sessions WHERE admin_id = ? AND token_hash <> ?').run(id, req.session.token_hash)
        else db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(id)
      } else {
        db.prepare('UPDATE admins SET username = ?, role = ? WHERE id = ?').run(username, role, id)
      }
      return 'updated'
    })
    const result = updateAdmin()
    if (result === 'missing') return res.status(404).json({ error: 'Administrator not found' })
    if (result === 'last-admin') return res.status(400).json({ error: 'The last administrator cannot become an organizer' })
    res.status(204).end()
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Username already exists' })
    res.status(400).json({ error: error.message })
  }
})

app.delete('/api/admin/users/:id', requireAuth, requireAdministrator, requireCsrf, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid administrator ID' })
  if (id === req.session.admin_id) return res.status(400).json({ error: 'You cannot delete your own account' })
  const deleteAdmin = db.transaction(() => {
    const account = db.prepare('SELECT role FROM admins WHERE id = ?').get(id)
    if (!account) return 'missing'
    if (account.role === 'admin' && db.prepare("SELECT COUNT(*) AS count FROM admins WHERE role = 'admin'").get().count <= 1) return 'last'
    return db.prepare('DELETE FROM admins WHERE id = ?').run(id).changes ? 'deleted' : 'missing'
  })
  const result = deleteAdmin()
  if (result === 'last') return res.status(400).json({ error: 'The last administrator cannot be deleted' })
  if (result === 'missing') return res.status(404).json({ error: 'Administrator not found' })
  res.status(204).end()
})

const showApiKeyName = (value) => typeof value === 'string'
  ? value.normalize('NFKC').replace(/[\u0000-\u001F\u007F]/g, '').trim()
  : '' // Normalizes the human-readable key label before it reaches the security audit data.

app.post('/api/admin/show-api-keys', requireAuth, requireAdministrator, requireCsrf, (req, res) => {
  const name = showApiKeyName(req.body?.name)
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.\-]{1,47}$/.test(name)) return res.status(400).json({ error: 'Key name must be 2–48 letters, numbers, spaces, dots, dashes, or underscores' })
  const id = crypto.randomBytes(12).toString('base64url')
  const token = `tcpmm_${crypto.randomBytes(32).toString('base64url')}`
  try {
    db.prepare('INSERT INTO show_api_keys (id, name, token_hash, created_by) VALUES (?, ?, ?, ?)')
      .run(id, name, tokenHash(token), req.session.admin_id)
    const key = listShowApiKeys().find((item) => item.source === 'site' && item.id === id)
    res.setHeader('Cache-Control', 'no-store')
    res.status(201).json({ key, token })
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'An active API key already uses that name' })
    console.error('Show API key creation failed:', error)
    res.status(500).json({ error: 'The API key could not be created' })
  }
}) // Generates a publisher secret server-side and returns the plaintext exactly once to the authenticated administrator.

app.delete('/api/admin/show-api-keys/:id', requireAuth, requireAdministrator, requireCsrf, (req, res) => {
  if (!/^[A-Za-z0-9_-]{16}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid API key ID' })
  const result = db.prepare('UPDATE show_api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL').run(req.params.id)
  if (!result.changes) return res.status(404).json({ error: 'Active API key not found' })
  res.status(204).end()
}) // Revokes a database-managed publisher credential immediately while preserving its audit history.

const eventFields = (body) => {
  const item = {
    event_date: String(body.event_date || ''), title: String(body.title || '').trim(), venue: String(body.venue || '').trim(),
    city: String(body.city || '').trim(), lineup: String(body.lineup || '').trim(), genre: String(body.genre || ''),
    price: String(body.price || '').trim(), doors: String(body.doors || '').trim(), featured: body.featured ? 1 : 0,
    published: body.published === false ? 0 : 1
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.event_date) || !item.title || !item.venue || !item.city || !item.lineup || !isGenre(item.genre)) throw new Error('Complete all required event fields')
  return item
}

const venueText = (value, maximum) => String(value || '').normalize('NFKC').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, maximum)
const venueFields = (body) => {
  const item = {
    name: venueText(body?.name, 120), address: venueText(body?.address, 200), city: venueText(body?.city, 80),
    phone: venueText(body?.phone, 40), website: venueText(body?.website, 300), description: venueText(body?.description, 2000),
    featured: body?.featured ? 1 : 0, published: body?.published === false ? 0 : 1
  }
  if (!item.name || !item.address || !item.city) throw new Error('Venue name, address, and city are required')
  if (item.website) {
    try {
      const url = new URL(item.website)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
      item.website = url.toString()
    } catch { throw new Error('Venue website must be a complete http:// or https:// URL') }
  }
  return item
}

app.use('/api/public/v1', createPublicApi({ db, genres })) // Keeps the unauthenticated read-only app API isolated from the authenticated show publisher routes.

app.get('/api/content', (_req, res) => {
  const events = db.prepare('SELECT * FROM events WHERE published = 1 ORDER BY event_date, id').all()
  const news = db.prepare('SELECT id, label, title, summary, link, featured FROM news WHERE published = 1 ORDER BY featured DESC, id').all()
  const venues = db.prepare('SELECT id, name, address, city, phone, website, description, image_path, featured FROM venues WHERE published = 1 ORDER BY featured DESC, name COLLATE NOCASE, id').all()
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(({ key, value }) => [key, value]))
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0'
  })
  res.json({ events, news, venues, settings })
})

const showApiText = (value) => typeof value === 'string'
  ? value.normalize('NFKC').replace(/[\u0000-\u001F\u007F]/g, '').trim()
  : '' // Normalizes API text and strips control characters before validation and storage.
const showApiFields = (body) => {
  const errors = {}
  const allowed = new Set(['event_date', 'title', 'venue', 'city', 'lineup', 'genre', 'price', 'doors', 'featured', 'published'])
  const textLimits = { event_date: 10, title: 120, venue: 120, city: 80, lineup: 500, genre: 20, price: 40, doors: 40 }
  if (!body || typeof body !== 'object' || Array.isArray(body)) errors.body = 'Request body must be a JSON object'
  for (const field of Object.keys(body || {})) if (!allowed.has(field)) errors[field] = 'Unknown field'
  const item = {
    event_date: showApiText(body?.event_date), title: showApiText(body?.title),
    venue: showApiText(body?.venue), city: showApiText(body?.city),
    lineup: showApiText(body?.lineup), genre: showApiText(body?.genre).toLowerCase(),
    price: showApiText(body?.price), doors: showApiText(body?.doors),
    featured: body?.featured === true ? 1 : 0, published: body?.published === false ? 0 : 1
  }
  for (const [field, maximum] of Object.entries(textLimits)) {
    if (field in (body || {}) && typeof body[field] !== 'string') errors[field] = 'Use a JSON string'
    else if (item[field].length > maximum) errors[field] = `Must be no longer than ${maximum} characters`
  }
  const date = new Date(`${item.event_date}T12:00:00Z`)
  if (!errors.event_date && (!/^\d{4}-\d{2}-\d{2}$/.test(item.event_date) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== item.event_date)) errors.event_date = 'Use a real calendar date in YYYY-MM-DD format'
  for (const field of ['title', 'venue', 'city', 'lineup']) if (!item[field] && !errors[field]) errors[field] = 'This field is required'
  if (!errors.genre && !isGenre(item.genre)) errors.genre = `Use one of: ${genres.join(', ')}`
  if ('featured' in (body || {}) && typeof body.featured !== 'boolean') errors.featured = 'Use a JSON boolean'
  if ('published' in (body || {}) && typeof body.published !== 'boolean') errors.published = 'Use a JSON boolean'
  if (Object.keys(errors).length) {
    const error = new Error('The show payload is invalid')
    error.fields = errors
    throw error
  }
  return item
} // Applies an explicit schema to trusted publisher requests and reports every invalid field together.

const insertShowFromApi = db.transaction((apiKeyId, idempotencyKey, requestHash, item) => {
  const previous = db.prepare('SELECT event_id, request_hash FROM show_api_requests WHERE api_key_id = ? AND idempotency_key = ?').get(apiKeyId, idempotencyKey)
  if (previous) return { ...previous, replayed: true }
  const result = db.prepare(`INSERT INTO events (event_date,title,venue,city,lineup,genre,price,doors,featured,published)
    VALUES (@event_date,@title,@venue,@city,@lineup,@genre,@price,@doors,@featured,@published)`).run(item)
  db.prepare('INSERT INTO show_api_requests (api_key_id, idempotency_key, request_hash, event_id) VALUES (?, ?, ?, ?)')
    .run(apiKeyId, idempotencyKey, requestHash, result.lastInsertRowid)
  return { event_id: result.lastInsertRowid, request_hash: requestHash, replayed: false }
}) // Commits the show and its retry record atomically so network retries cannot create duplicates.

app.post('/api/v1/shows', requireShowApiKey, (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ error: { code: 'unsupported_media_type', message: 'Content-Type must be application/json' } })
  const idempotencyKey = req.get('Idempotency-Key') || ''
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    return res.status(400).json({ error: { code: 'invalid_idempotency_key', message: 'Idempotency-Key must be 8-128 letters, numbers, dots, underscores, colons, or dashes' } })
  }
  try {
    const item = showApiFields(req.body)
    const requestHash = tokenHash(JSON.stringify(item))
    const result = insertShowFromApi(req.showApiKeyId, idempotencyKey, requestHash, item)
    if (result.replayed && !safeEqual(result.request_hash, requestHash)) {
      return res.status(409).json({ error: { code: 'idempotency_conflict', message: 'That Idempotency-Key was already used with a different show payload' } })
    }
    const show = db.prepare('SELECT id, event_date, title, venue, city, lineup, genre, price, doors, featured, published, created_at, updated_at FROM events WHERE id = ?').get(result.event_id)
    if (!show) return res.status(410).json({ error: { code: 'show_deleted', message: 'This idempotent request succeeded previously, but its show has since been deleted' } })
    res.location(`/api/v1/shows/${result.event_id}`)
    res.status(result.replayed ? 200 : 201).json({ show, replayed: result.replayed })
  } catch (error) {
    if (error.fields) return res.status(400).json({ error: { code: 'validation_failed', message: error.message, fields: error.fields } })
    console.error('Show API insert failed:', error)
    res.status(500).json({ error: { code: 'internal_error', message: 'The show could not be saved' } })
  }
}) // Creates a calendar show for an authenticated publisher with safe retry semantics.

app.get('/api/v1/shows/:id', requireShowApiKey, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: { code: 'invalid_id', message: 'Show ID must be a positive integer' } })
  const show = db.prepare('SELECT id, event_date, title, venue, city, lineup, genre, price, doors, featured, published, created_at, updated_at FROM events WHERE id = ?').get(id)
  if (!show) return res.status(404).json({ error: { code: 'not_found', message: 'Show not found' } })
  res.json({ show })
}) // Lets an API tester verify the exact stored record without using an administrator session.

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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.event_date) || !item.title || !item.venue || !item.city || !item.address || !item.lineup || !isGenre(item.genre) || !item.description || !item.contact) throw new Error('Complete every required show submission field')
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
  res.json({ online: radio.online, title: radio.title, artist: radio.artist, album: radio.album, trackCount: radio.trackCount, listeners: radio.listeners.size })
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
    'icy-genre': 'Punk Metal Hardcore Rock Alternative EDM Rap',
    'icy-br': '128',
    ...(includeMetadata ? { 'icy-metaint': '16000' } : {})
  })
  res.flushHeaders()
  radio.addListener(res, includeMetadata)
})

app.get('/api/admin/content', requireAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({
    username: req.session.username,
    role: req.session.role,
    events: db.prepare('SELECT * FROM events ORDER BY event_date, id').all(),
    news: db.prepare('SELECT * FROM news ORDER BY featured DESC, id').all(),
    venues: db.prepare('SELECT * FROM venues ORDER BY featured DESC, name COLLATE NOCASE, id').all(),
    submissions: submissionsDb.prepare('SELECT * FROM show_submissions ORDER BY reviewed, created_at DESC, id DESC').all(),
    settings: Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(({ key, value }) => [key, value])),
    ...(req.session.role === 'admin' ? {
      admins: db.prepare('SELECT id, username, role, created_at FROM admins ORDER BY username COLLATE NOCASE, id').all(),
      showApiKeys: listShowApiKeys()
    } : {})
  })
}) // Omits user and API-key metadata entirely when an organizer loads the shared control panel.

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

app.post('/api/admin/venues', requireAuth, requireCsrf, (req, res) => {
  try {
    const item = venueFields(req.body)
    const result = db.prepare(`INSERT INTO venues (name,address,city,phone,website,description,featured,published)
      VALUES (@name,@address,@city,@phone,@website,@description,@featured,@published)`).run(item)
    res.status(201).json({ id: result.lastInsertRowid })
  } catch (error) { res.status(400).json({ error: error.message }) }
})
app.put('/api/admin/venues/:id', requireAuth, requireCsrf, (req, res) => {
  try {
    const item = { ...venueFields(req.body), id: Number(req.params.id) }
    const result = db.prepare(`UPDATE venues SET name=@name,address=@address,city=@city,phone=@phone,website=@website,
      description=@description,featured=@featured,published=@published,updated_at=CURRENT_TIMESTAMP WHERE id=@id`).run(item)
    if (!result.changes) return res.status(404).json({ error: 'Venue not found' })
    res.status(204).end()
  } catch (error) { res.status(400).json({ error: error.message }) }
})

const venueImageTypes = {
  'image/jpeg': { extension: '.jpg', valid: (data) => data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff },
  'image/png': { extension: '.png', valid: (data) => data.length > 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  'image/webp': { extension: '.webp', valid: (data) => data.length > 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP' }
}
const removeVenueImage = (imagePath) => {
  const filename = path.basename(String(imagePath || ''))
  if (/^[a-f0-9]{32}\.(?:jpg|png|webp)$/.test(filename)) fs.rmSync(path.join(venueImageDir, filename), { force: true })
}
const venueImageBody = express.raw({ type: () => true, limit: '5mb' })
app.put('/api/admin/venues/:id/image', requireAuth, requireCsrf, venueImageBody, (req, res) => {
  const id = Number(req.params.id)
  const venue = Number.isSafeInteger(id) ? db.prepare('SELECT image_path FROM venues WHERE id = ?').get(id) : null
  if (!venue) return res.status(404).json({ error: 'Venue not found' })
  const type = venueImageTypes[String(req.get('Content-Type') || '').split(';')[0].toLowerCase()]
  if (!type || !Buffer.isBuffer(req.body) || !type.valid(req.body)) return res.status(415).json({ error: 'Upload a valid JPEG, PNG, or WebP image' })
  const filename = `${crypto.randomBytes(16).toString('hex')}${type.extension}`
  const temporary = path.join(venueImageDir, `${filename}.tmp`)
  const destination = path.join(venueImageDir, filename)
  try {
    fs.writeFileSync(temporary, req.body, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, destination)
    const imagePath = `/venue-images/${filename}`
    db.prepare('UPDATE venues SET image_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(imagePath, id)
    removeVenueImage(venue.image_path)
    res.json({ image_path: imagePath })
  } catch (error) {
    fs.rmSync(temporary, { force: true }); fs.rmSync(destination, { force: true }); throw error
  }
})
app.delete('/api/admin/venues/:id/image', requireAuth, requireCsrf, (req, res) => {
  const id = Number(req.params.id)
  const venue = Number.isSafeInteger(id) ? db.prepare('SELECT image_path FROM venues WHERE id = ?').get(id) : null
  if (!venue) return res.status(404).json({ error: 'Venue not found' })
  db.prepare("UPDATE venues SET image_path = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id)
  removeVenueImage(venue.image_path)
  res.status(204).end()
})
app.delete('/api/admin/venues/:id', requireAuth, requireCsrf, (req, res) => {
  const id = Number(req.params.id)
  const venue = Number.isSafeInteger(id) ? db.prepare('SELECT image_path FROM venues WHERE id = ?').get(id) : null
  if (!venue) return res.status(404).json({ error: 'Venue not found' })
  db.prepare('DELETE FROM venues WHERE id = ?').run(id)
  removeVenueImage(venue.image_path)
  res.status(204).end()
})

const newsFields = (body) => {
  const item = {
    label: String(body.label || '').trim().slice(0, 80),
    title: String(body.title || '').trim().slice(0, 200),
    summary: String(body.summary || '').trim().slice(0, 1000),
    slug: slugify(body.slug || body.title),
    body_html: sanitizeArticleHtml(body.body_html),
    featured: body.featured ? 1 : 0,
    published: body.published === false ? 0 : 1
  }
  if (!item.label || !item.title || !item.slug) throw new Error('News requires a label, title, and page slug')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.slug)) throw new Error('Page slug may only contain lowercase letters, numbers, and dashes')
  item.link = item.body_html ? `/news/${item.slug}` : String(body.link || '#news').trim()
  if (!item.body_html && !item.link.startsWith('#') && !/^\/(?!\/)/.test(item.link)) throw new Error('A story without article content requires a local link')
  return item
}
app.post('/api/admin/news', requireAuth, requireCsrf, (req, res) => {
  try {
    const item = newsFields(req.body)
    const result = db.prepare('INSERT INTO news (label,title,summary,link,slug,body_html,featured,published) VALUES (@label,@title,@summary,@link,@slug,@body_html,@featured,@published)').run(item)
    const article = db.prepare('SELECT * FROM news WHERE id = ?').get(result.lastInsertRowid)
    writeArticlePage(article)
    res.status(201).json({ id: result.lastInsertRowid, link: article.link })
  } catch (error) { res.status(error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 400).json({ error: error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'That page slug is already in use' : error.message }) }
})
app.put('/api/admin/news/:id', requireAuth, requireCsrf, (req, res) => {
  try {
    const id = Number(req.params.id)
    const previous = db.prepare('SELECT slug FROM news WHERE id = ?').get(id)
    if (!previous) return res.status(404).json({ error: 'Story not found' })
    const item = { ...newsFields(req.body), id }
    db.prepare('UPDATE news SET label=@label,title=@title,summary=@summary,link=@link,slug=@slug,body_html=@body_html,featured=@featured,published=@published,updated_at=CURRENT_TIMESTAMP WHERE id=@id').run(item)
    if (previous.slug !== item.slug) removeArticlePage(previous.slug)
    writeArticlePage(db.prepare('SELECT * FROM news WHERE id = ?').get(id))
    res.status(204).end()
  } catch (error) { res.status(error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 400).json({ error: error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'That page slug is already in use' : error.message }) }
})
app.delete('/api/admin/news/:id', requireAuth, requireCsrf, (req, res) => {
  const article = db.prepare('SELECT slug FROM news WHERE id = ?').get(Number(req.params.id))
  if (article) removeArticlePage(article.slug)
  db.prepare('DELETE FROM news WHERE id = ?').run(Number(req.params.id))
  res.status(204).end()
})

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

app.use('/venue-images', express.static(venueImageDir, { dotfiles: 'deny', fallthrough: false, immutable: production, maxAge: production ? '30d' : 0 }))
app.use('/admin', express.static(path.join(root, 'dist', 'admin'), {
  index: false,
  maxAge: 0,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
})) // Prevents privileged HTML and JavaScript from surviving deployments with an incompatible role or security contract.
app.use(express.static(path.join(root, 'dist'), { index: false, maxAge: production ? '1h' : 0 }))
const sendUncachedFile = (res, file) => res.sendFile(file, { headers: {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  Pragma: 'no-cache',
  Expires: '0'
} })
app.get('/news/:slug', (req, res, next) => {
  const slug = String(req.params.slug || '')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return next()
  const file = articlePath(slug)
  if (!fs.existsSync(file)) return res.status(404).send('Article not found')
  sendUncachedFile(res, file)
})
app.get(['/admin', '/admin/'], (_req, res) => sendUncachedFile(res, path.join(root, 'dist', 'admin', 'index.html')))
app.get(['/submit', '/submit/'], (_req, res) => sendUncachedFile(res, path.join(root, 'dist', 'submit', 'index.html')))
app.get('/{*path}', (_req, res) => sendUncachedFile(res, path.join(root, 'dist', 'index.html')))

app.use((error, req, res, _next) => {
  console.error(error)
  if (error?.type === 'entity.too.large' && req.originalUrl.startsWith('/api/v1/')) return res.status(413).json({ error: { code: 'body_too_large', message: 'Request body must be no larger than 96 KB' } })
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Image must be no larger than 5 MB' })
  if (error instanceof SyntaxError && error?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'invalid_json', message: 'Request body must contain valid JSON' } })
  res.status(500).json({ error: 'Internal server error' })
})

const server = app.listen(port, host, () => console.log(`TCPM&M listening on http://${host}:${port}`))
const shutdown = () => { radio.stop(); for (const listener of chatListeners) listener.end(); server.close(() => { submissionsDb.close(); chatDb.close(); db.close(); process.exit(0) }) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
