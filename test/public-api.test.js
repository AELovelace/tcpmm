import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcpmm-public-api-')) // Keeps public API integration data separate from both the project and other test workers.
let child
let baseUrl
let publicVenueId
let publicStoryId
let draftVenueId

const availablePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close((error) => error ? reject(error) : resolve(port))
  })
}) // Reserves an operating-system-selected port so parallel test files cannot collide.

const waitForServer = (process, timeoutMs = 10_000) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Public API test server did not start in time')), timeoutMs)
  let output = ''
  const inspect = (chunk) => {
    output += String(chunk)
    if (!output.includes('TCPM&M listening')) return
    clearTimeout(timeout)
    resolve()
  }
  process.stdout.on('data', inspect)
  process.stderr.on('data', inspect)
  process.once('exit', (code) => {
    clearTimeout(timeout)
    reject(new Error(`Public API test server exited with code ${code}: ${output}`))
  })
}) // Waits for the real listening message before any integration request is issued.

const createAdminRecord = async (route, headers, body) => {
  const response = await fetch(`${baseUrl}/api/admin/${route}`, { method: 'POST', headers, body: JSON.stringify(body) })
  assert.equal(response.status, 201)
  return response.json()
} // Uses the supported administrator boundary to prepare both public and draft visibility fixtures.

before(async () => {
  const port = await availablePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['server/app.js'], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'test',
      DATA_DIR: temporaryDirectory, MUSIC_DIR: path.join(temporaryDirectory, 'music'),
      CHAT_DB_PATH: path.join(temporaryDirectory, 'chat.sqlite'),
      SUBMISSIONS_DB_PATH: path.join(temporaryDirectory, 'submissions.sqlite'),
      ADMIN_USERNAME: 'admin', ADMIN_INITIAL_PASSWORD: 'test-password-long-enough', SHOW_API_KEYS: ''
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  })
  await waitForServer(child)

  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password-long-enough' })
  })
  assert.equal(login.status, 200)
  const session = await login.json()
  const headers = {
    Cookie: login.headers.get('set-cookie').split(';', 1)[0],
    'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken
  }
  const publicVenue = await createAdminRecord('venues', headers, {
    name: 'Public Test Room', address: '101 Main Street', city: 'Pasco', description: 'All ages.', featured: true, published: true
  })
  publicVenueId = publicVenue.id
  const draftVenue = await createAdminRecord('venues', headers, {
    name: 'Draft Test Room', address: '404 Hidden Street', city: 'Pasco', published: false
  })
  draftVenueId = draftVenue.id
  const publicStory = await createAdminRecord('news', headers, {
    label: 'API TEST', title: 'Public API Story', summary: 'A mobile-readable story.', slug: 'public-api-story', body_html: '<p>Hello <strong>app</strong>.</p>', featured: true, published: true
  })
  publicStoryId = publicStory.id
  await createAdminRecord('news', headers, {
    label: 'DRAFT', title: 'Draft API Story', slug: 'draft-api-story', published: false
  })
  await createAdminRecord('events', headers, {
    event_date: '2027-12-31', title: 'Draft API Event', venue: 'Hidden Room', city: 'Pasco', lineup: 'Secret Band', genre: 'punk', published: false
  })
}) // Boots the application and creates records that prove published-only filtering at the HTTP boundary.

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}) // Stops the isolated server and removes only this test file's temporary databases.

test('serves an unauthenticated, cacheable, cross-origin discovery document', async () => {
  const response = await fetch(`${baseUrl}/api/public/v1`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.match(response.headers.get('cache-control') || '', /public, max-age=60/)
  const body = await response.json()
  assert.equal(body.api.authentication, 'none')
  assert.equal(body.api.read_only, true)
  assert.equal(body.resources.events, '/api/public/v1/events')
}) // Locks down the public namespace contract and the headers needed by independently hosted app clients.

test('returns a published-only first-sync content snapshot', async () => {
  const response = await fetch(`${baseUrl}/api/public/v1/content`)
  assert.equal(response.status, 200)
  const { data } = await response.json()
  assert.ok(data.events.length >= 4)
  assert.ok(data.venues.some((venue) => venue.name === 'Public Test Room'))
  assert.ok(data.news.some((story) => story.title === 'Public API Story'))
  assert.equal(data.events.some((event) => event.title === 'Draft API Event'), false)
  assert.equal(data.venues.some((venue) => venue.name === 'Draft Test Room'), false)
  assert.equal(data.news.some((story) => story.title === 'Draft API Story'), false)
  assert.equal(Object.hasOwn(data.events[0], 'published'), false)
  assert.equal(typeof data.events[0].featured, 'boolean')
  assert.ok(data.settings.hero_title)
}) // Ensures app bootstrap data cannot expose drafts or internal publication flags.

test('filters and paginates public events and retrieves event details', async () => {
  const filtered = await fetch(`${baseUrl}/api/public/v1/events?from=2026-08-29&to=2026-09-05&city=PASCO&genre=metal&limit=1`)
  assert.equal(filtered.status, 200)
  const body = await filtered.json()
  assert.equal(body.data.length, 1)
  assert.equal(body.data[0].title, 'HEAVY WEATHER')
  assert.deepEqual(body.pagination, { limit: 1, offset: 0, count: 1, total: 1 })

  const detail = await fetch(`${baseUrl}/api/public/v1/events/${body.data[0].id}`)
  assert.equal(detail.status, 200)
  assert.equal((await detail.json()).data.genre, 'metal')
}) // Covers the filters and response metadata a calendar screen needs for incremental loading.

test('returns venue and news details without placing article bodies in collections', async () => {
  const venues = await fetch(`${baseUrl}/api/public/v1/venues?city=pasco&featured=true`)
  assert.equal(venues.status, 200)
  const venueBody = await venues.json()
  assert.equal(venueBody.data.length, 1)
  assert.equal(venueBody.data[0].image_url, null)

  const venueDetail = await fetch(`${baseUrl}/api/public/v1/venues/${publicVenueId}`)
  assert.equal(venueDetail.status, 200)
  assert.equal((await venueDetail.json()).data.name, 'Public Test Room')

  const news = await fetch(`${baseUrl}/api/public/v1/news?featured=true`)
  assert.equal(news.status, 200)
  const story = (await news.json()).data.find((item) => item.id === publicStoryId)
  assert.equal(story.has_article, true)
  assert.equal(Object.hasOwn(story, 'body_html'), false)

  const storyDetail = await fetch(`${baseUrl}/api/public/v1/news/${publicStoryId}`)
  assert.equal(storyDetail.status, 200)
  assert.equal((await storyDetail.json()).data.body_html, '<p>Hello <strong>app</strong>.</p>')
}) // Proves the mobile detail contract includes sanitized articles while collection downloads stay compact.

test('returns consistent validation, lookup, read-only, and preflight responses', async () => {
  const invalid = await fetch(`${baseUrl}/api/public/v1/events?limit=0`)
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error.code, 'invalid_query')

  const unknownQuery = await fetch(`${baseUrl}/api/public/v1/news?feature=true`)
  assert.equal(unknownQuery.status, 400)
  assert.equal((await unknownQuery.json()).error.code, 'invalid_query')

  const missing = await fetch(`${baseUrl}/api/public/v1/venues/999999`)
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error.code, 'not_found')

  const draft = await fetch(`${baseUrl}/api/public/v1/venues/${draftVenueId}`)
  assert.equal(draft.status, 404)
  assert.equal(draft.headers.get('cache-control'), 'no-store')

  const write = await fetch(`${baseUrl}/api/public/v1/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(write.status, 405)
  assert.equal(write.headers.get('allow'), 'GET, HEAD, OPTIONS')
  assert.equal((await write.json()).error.code, 'method_not_allowed')

  const preflight = await fetch(`${baseUrl}/api/public/v1/events`, { method: 'OPTIONS' })
  assert.equal(preflight.status, 204)
}) // Keeps anonymous clients within an explicitly read-only and predictably machine-readable boundary.
