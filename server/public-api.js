import express from 'express'

const PUBLIC_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300'
const PUBLIC_SETTINGS = ['hero_title', 'hero_text', 'radio_status', 'radio_title', 'radio_message']

class PublicApiError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
} // Carries safe client error details from query parsing to the public API error handler.

const positiveId = (value, resource) => {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1) throw new PublicApiError('invalid_id', `${resource} ID must be a positive integer`)
  return id
} // Rejects malformed resource identifiers before they reach SQLite.

const queryValue = (value, name, maximum = 120) => {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new PublicApiError('invalid_query', `${name} must be supplied once as text`)
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u001F\u007F]/g, '').trim()
  if (!normalized || normalized.length > maximum) throw new PublicApiError('invalid_query', `${name} must contain 1-${maximum} characters`)
  return normalized
} // Normalizes public filters and prevents arrays, objects, and control characters from entering queries.

const queryDate = (value, name) => {
  const normalized = queryValue(value, name, 10)
  if (normalized === undefined) return undefined
  const date = new Date(`${normalized}T12:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw new PublicApiError('invalid_query', `${name} must be a real calendar date in YYYY-MM-DD format`)
  }
  return normalized
} // Validates calendar filters strictly so impossible dates do not produce surprising result sets.

const queryBoolean = (value, name) => {
  if (value === undefined) return undefined
  if (value === 'true') return 1
  if (value === 'false') return 0
  throw new PublicApiError('invalid_query', `${name} must be true or false`)
} // Converts explicit URL booleans to the integer representation used by SQLite.

const pagination = (query) => {
  const parse = (value, fallback, name, minimum, maximum) => {
    if (value === undefined) return fallback
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new PublicApiError('invalid_query', `${name} must be an integer from ${minimum} to ${maximum}`)
    const number = Number(value)
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new PublicApiError('invalid_query', `${name} must be an integer from ${minimum} to ${maximum}`)
    return number
  }
  return { limit: parse(query.limit, 50, 'limit', 1, 100), offset: parse(query.offset, 0, 'offset', 0, 1_000_000) }
} // Applies bounded offset pagination so anonymous callers cannot request unbounded collection responses.

const allowQuery = (query, allowed) => {
  const unknown = Object.keys(query).find((name) => !allowed.includes(name))
  if (unknown) throw new PublicApiError('invalid_query', `Unknown query parameter: ${unknown}`)
} // Rejects misspelled filters so client bugs fail visibly instead of returning misleading unfiltered data.

const eventJson = (row) => ({ ...row, featured: Boolean(row.featured) }) // Publishes event flags as JSON booleans instead of SQLite integers.
const venueJson = ({ image_path, ...row }) => ({ ...row, image_url: image_path || null, featured: Boolean(row.featured) }) // Gives mobile clients a nullable public image URL while hiding the storage-oriented column name.
const newsJson = ({ body_html, ...row }, includeBody = false) => ({
  ...row,
  featured: Boolean(row.featured),
  has_article: Boolean(body_html),
  ...(includeBody ? { body_html } : {})
}) // Keeps collection payloads compact while making sanitized article HTML available from detail routes.

const collection = (db, select, count, parameters, page, map) => {
  const rows = db.prepare(`${select} LIMIT ? OFFSET ?`).all(...parameters, page.limit, page.offset).map(map)
  const total = db.prepare(count).get(...parameters).total
  return { data: rows, pagination: { ...page, count: rows.length, total } }
} // Runs each paginated read and its matching count with the same safely bound filters.

export const createPublicApi = ({ db, genres }) => {
  const router = express.Router()

  router.use((req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept, Content-Type',
      'Cache-Control': PUBLIC_CACHE_CONTROL
    })
    if (req.method === 'OPTIONS') return res.status(204).end()
    next()
  }) // Marks this namespace as public, cacheable, cross-origin, and read-only for future app clients.

  router.get('/', (_req, res) => res.json({
    api: { name: 'TCPM&M Public API', version: '1', authentication: 'none', read_only: true },
    resources: {
      content: '/api/public/v1/content', events: '/api/public/v1/events',
      venues: '/api/public/v1/venues', news: '/api/public/v1/news'
    }
  })) // Provides a small discovery document without coupling clients to the publisher API.

  router.get('/content', (_req, res) => {
    const events = db.prepare(`SELECT id, event_date, title, venue, city, lineup, genre, price, doors, featured, created_at, updated_at
      FROM events WHERE published = 1 ORDER BY event_date, id`).all().map(eventJson)
    const venues = db.prepare(`SELECT id, name, address, city, phone, website, description, image_path, featured, created_at, updated_at
      FROM venues WHERE published = 1 ORDER BY featured DESC, name COLLATE NOCASE, id`).all().map(venueJson)
    const news = db.prepare(`SELECT id, label, title, summary, link, slug, body_html, featured, created_at, updated_at
      FROM news WHERE published = 1 ORDER BY featured DESC, updated_at DESC, id DESC`).all().map((row) => newsJson(row))
    const settings = Object.fromEntries(db.prepare(`SELECT key, value FROM settings WHERE key IN (${PUBLIC_SETTINGS.map(() => '?').join(',')})`).all(...PUBLIC_SETTINGS).map(({ key, value }) => [key, value]))
    res.json({ data: { events, venues, news, settings } })
  }) // Supplies a convenient first-sync snapshot while the collection routes support independent pagination and filters.

  router.get('/events', (req, res, next) => {
    try {
      allowQuery(req.query, ['limit', 'offset', 'from', 'to', 'genre', 'city', 'featured'])
      const page = pagination(req.query)
      const where = ['published = 1']
      const parameters = []
      const from = queryDate(req.query.from, 'from')
      const to = queryDate(req.query.to, 'to')
      const genre = queryValue(req.query.genre, 'genre', 20)?.toLowerCase()
      const city = queryValue(req.query.city, 'city', 80)
      const featured = queryBoolean(req.query.featured, 'featured')
      if (from) { where.push('event_date >= ?'); parameters.push(from) }
      if (to) { where.push('event_date <= ?'); parameters.push(to) }
      if (from && to && from > to) throw new PublicApiError('invalid_query', 'from cannot be later than to')
      if (genre && !genres.includes(genre)) throw new PublicApiError('invalid_query', `genre must be one of: ${genres.join(', ')}`)
      if (genre) { where.push('genre = ?'); parameters.push(genre) }
      if (city) { where.push('city = ? COLLATE NOCASE'); parameters.push(city) }
      if (featured !== undefined) { where.push('featured = ?'); parameters.push(featured) }
      const clause = where.join(' AND ')
      res.json(collection(db, `SELECT id, event_date, title, venue, city, lineup, genre, price, doors, featured, created_at, updated_at FROM events WHERE ${clause} ORDER BY event_date, id`, `SELECT COUNT(*) AS total FROM events WHERE ${clause}`, parameters, page, eventJson))
    } catch (error) { next(error) }
  }) // Lists published events with bounded pagination and app-friendly date, city, genre, and feature filters.

  router.get('/events/:id', (req, res, next) => {
    try {
      const id = positiveId(req.params.id, 'Event')
      const row = db.prepare(`SELECT id, event_date, title, venue, city, lineup, genre, price, doors, featured, created_at, updated_at
        FROM events WHERE id = ? AND published = 1`).get(id)
      if (!row) throw new PublicApiError('not_found', 'Event not found', 404)
      res.json({ data: eventJson(row) })
    } catch (error) { next(error) }
  }) // Retrieves one published event without revealing whether an unpublished record occupies the requested ID.

  router.get('/venues', (req, res, next) => {
    try {
      allowQuery(req.query, ['limit', 'offset', 'city', 'featured'])
      const page = pagination(req.query)
      const where = ['published = 1']
      const parameters = []
      const city = queryValue(req.query.city, 'city', 80)
      const featured = queryBoolean(req.query.featured, 'featured')
      if (city) { where.push('city = ? COLLATE NOCASE'); parameters.push(city) }
      if (featured !== undefined) { where.push('featured = ?'); parameters.push(featured) }
      const clause = where.join(' AND ')
      res.json(collection(db, `SELECT id, name, address, city, phone, website, description, image_path, featured, created_at, updated_at FROM venues WHERE ${clause} ORDER BY featured DESC, name COLLATE NOCASE, id`, `SELECT COUNT(*) AS total FROM venues WHERE ${clause}`, parameters, page, venueJson))
    } catch (error) { next(error) }
  }) // Lists only published venues with bounded pagination and optional city and feature filters.

  router.get('/venues/:id', (req, res, next) => {
    try {
      const id = positiveId(req.params.id, 'Venue')
      const row = db.prepare(`SELECT id, name, address, city, phone, website, description, image_path, featured, created_at, updated_at
        FROM venues WHERE id = ? AND published = 1`).get(id)
      if (!row) throw new PublicApiError('not_found', 'Venue not found', 404)
      res.json({ data: venueJson(row) })
    } catch (error) { next(error) }
  }) // Retrieves one published venue with its public contact and image information.

  router.get('/news', (req, res, next) => {
    try {
      allowQuery(req.query, ['limit', 'offset', 'featured'])
      const page = pagination(req.query)
      const where = ['published = 1']
      const parameters = []
      const featured = queryBoolean(req.query.featured, 'featured')
      if (featured !== undefined) { where.push('featured = ?'); parameters.push(featured) }
      const clause = where.join(' AND ')
      res.json(collection(db, `SELECT id, label, title, summary, link, slug, body_html, featured, created_at, updated_at FROM news WHERE ${clause} ORDER BY featured DESC, updated_at DESC, id DESC`, `SELECT COUNT(*) AS total FROM news WHERE ${clause}`, parameters, page, (row) => newsJson(row)))
    } catch (error) { next(error) }
  }) // Lists published story summaries while leaving potentially large article bodies to the detail route.

  router.get('/news/:id', (req, res, next) => {
    try {
      const id = positiveId(req.params.id, 'News item')
      const row = db.prepare(`SELECT id, label, title, summary, link, slug, body_html, featured, created_at, updated_at
        FROM news WHERE id = ? AND published = 1`).get(id)
      if (!row) throw new PublicApiError('not_found', 'News item not found', 404)
      res.json({ data: newsJson(row, true) })
    } catch (error) { next(error) }
  }) // Retrieves a published story and its already-sanitized article HTML when the site hosts the article.

  router.use((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD, OPTIONS')
      return res.status(405).json({ error: { code: 'method_not_allowed', message: 'The public API is read-only' } })
    }
    res.status(404).json({ error: { code: 'not_found', message: 'Public API route not found' } })
  }) // Keeps unknown public API requests in JSON instead of allowing them to fall through to the website shell.

  router.use((error, _req, res, _next) => {
    res.setHeader('Cache-Control', 'no-store')
    if (error instanceof PublicApiError) return res.status(error.status).json({ error: { code: error.code, message: error.message } })
    console.error('Public API request failed:', error)
    res.status(500).json({ error: { code: 'internal_error', message: 'The public API request could not be completed' } })
  }) // Converts expected validation and lookup failures into a consistent machine-readable error contract.

  return router
} // Builds the isolated unauthenticated router around the application's read-only SQLite connection.
