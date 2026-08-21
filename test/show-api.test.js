import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcpmm-show-api-')) // Isolates all test databases and media from real project data.
const bearerToken = `tcpmm_${crypto.randomBytes(32).toString('base64url')}` // Creates a realistic credential without putting a reusable secret in the repository.
const bearerHash = crypto.createHash('sha256').update(bearerToken).digest('hex')
let child
let baseUrl

const availablePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close((error) => error ? reject(error) : resolve(port))
  })
}) // Asks the operating system for an unused local port to avoid collisions with development servers.

const waitForServer = (process, timeoutMs = 10_000) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Test server did not start in time')), timeoutMs)
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
    reject(new Error(`Test server exited with code ${code}: ${output}`))
  })
}) // Waits for the actual listening message so requests never race server startup.

const apiRequest = (route, options = {}) => fetch(`${baseUrl}${route}`, {
  ...options,
  headers: { Authorization: `Bearer ${bearerToken}`, ...options.headers }
}) // Adds the test publisher credential while allowing each case to override request details.

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
      ADMIN_USERNAME: 'admin',
      ADMIN_INITIAL_PASSWORD: 'test-password-long-enough',
      SHOW_API_KEYS: `integration:${bearerHash}`
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  })
  await waitForServer(child)
}) // Boots the complete application against disposable storage for realistic route and database coverage.

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}) // Stops background services and removes only the test-owned temporary directory.

test('rejects a missing Bearer credential', async () => {
  const response = await fetch(`${baseUrl}/api/v1/shows`, { method: 'POST' })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, 'invalid_token')
})

test('rejects an incorrect credential and malformed JSON', async () => {
  const unauthorized = await fetch(`${baseUrl}/api/v1/shows`, {
    method: 'POST', headers: { Authorization: `Bearer tcpmm_${'x'.repeat(43)}` }
  })
  assert.equal(unauthorized.status, 401)
  const malformed = await apiRequest('/api/v1/shows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'invalid-json-001' },
    body: '{"broken":'
  })
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.json()).error.code, 'invalid_json')
})

test('validates content type, idempotency key, and show fields', async () => {
  const wrongType = await apiRequest('/api/v1/shows', { method: 'POST', body: '{}' })
  assert.equal(wrongType.status, 415)
  const invalid = await apiRequest('/api/v1/shows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'invalid-001' },
    body: JSON.stringify({ event_date: '2027-02-30', genre: 'polka', surprise: true })
  })
  assert.equal(invalid.status, 400)
  const body = await invalid.json()
  assert.equal(body.error.code, 'validation_failed')
  assert.ok(body.error.fields.event_date)
  assert.ok(body.error.fields.surprise)
  const tooLong = await apiRequest('/api/v1/shows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'too-long-001' },
    body: JSON.stringify({ event_date: '2027-01-01', title: 'x'.repeat(121), venue: 'Room', city: 'Pasco', lineup: 'Band', genre: 'rock' })
  })
  assert.equal(tooLong.status, 400)
  assert.match((await tooLong.json()).error.fields.title, /120/)
})

test('lets an administrator generate, inspect, and revoke a site-managed key', async () => {
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password-long-enough' })
  })
  assert.equal(login.status, 200)
  const session = await login.json()
  const cookie = login.headers.get('set-cookie').split(';', 1)[0]
  const adminHeaders = { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }

  const generated = await fetch(`${baseUrl}/api/admin/show-api-keys`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Site tester' })
  })
  assert.equal(generated.status, 201)
  const created = await generated.json()
  assert.match(created.token, /^tcpmm_[A-Za-z0-9_-]{43}$/)
  assert.equal(created.key.name, 'Site tester')

  const authenticated = await fetch(`${baseUrl}/api/v1/shows/1`, { headers: { Authorization: `Bearer ${created.token}` } })
  assert.equal(authenticated.status, 200)
  const listing = await fetch(`${baseUrl}/api/admin/content`, { headers: adminHeaders })
  const listingText = await listing.text()
  assert.equal(listing.status, 200)
  assert.equal(listingText.includes(created.token), false)
  assert.equal(listingText.includes(crypto.createHash('sha256').update(created.token).digest('hex')), false)
  const listedKey = JSON.parse(listingText).showApiKeys.find((item) => item.id === created.key.id)
  assert.equal(listedKey.request_count, 1)
  assert.ok(listedKey.last_used_at)

  const revoked = await fetch(`${baseUrl}/api/admin/show-api-keys/${created.key.id}`, { method: 'DELETE', headers: adminHeaders })
  assert.equal(revoked.status, 204)
  const rejected = await fetch(`${baseUrl}/api/v1/shows/1`, { headers: { Authorization: `Bearer ${created.token}` } })
  assert.equal(rejected.status, 401)
})

test('lets organizers manage site content but blocks users and API keys', async () => {
  const adminLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password-long-enough' })
  })
  assert.equal(adminLogin.status, 200)
  const adminSession = await adminLogin.json()
  assert.equal(adminSession.role, 'admin')
  const adminCookie = adminLogin.headers.get('set-cookie').split(';', 1)[0]
  const adminHeaders = { Cookie: adminCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': adminSession.csrfToken }
  const createdAccount = await fetch(`${baseUrl}/api/admin/users`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ username: 'organizer', password: 'organizer-password-long', role: 'organizer' })
  })
  assert.equal(createdAccount.status, 201)
  const organizerAccount = await createdAccount.json()
  const adminContent = await fetch(`${baseUrl}/api/admin/content`, { headers: adminHeaders })
  assert.equal(adminContent.status, 200)
  assert.equal((await adminContent.json()).admins.find((item) => item.id === organizerAccount.id).role, 'organizer')
  const lastAdminDemotion = await fetch(`${baseUrl}/api/admin/users/${adminSession.id}`, {
    method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({ username: 'admin', password: '', role: 'organizer' })
  })
  assert.equal(lastAdminDemotion.status, 400)

  const organizerLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'organizer', password: 'organizer-password-long' })
  })
  assert.equal(organizerLogin.status, 200)
  const organizerSession = await organizerLogin.json()
  assert.equal(organizerSession.role, 'organizer')
  const organizerCookie = organizerLogin.headers.get('set-cookie').split(';', 1)[0]
  const organizerHeaders = { Cookie: organizerCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': organizerSession.csrfToken }

  const contentResponse = await fetch(`${baseUrl}/api/admin/content`, { headers: organizerHeaders })
  assert.equal(contentResponse.status, 200)
  const organizerContent = await contentResponse.json()
  assert.equal(organizerContent.role, 'organizer')
  assert.equal(Object.hasOwn(organizerContent, 'admins'), false)
  assert.equal(Object.hasOwn(organizerContent, 'showApiKeys'), false)
  for (const field of ['settings', 'submissions', 'events', 'venues', 'news']) assert.ok(Object.hasOwn(organizerContent, field))

  const settings = await fetch(`${baseUrl}/api/admin/settings`, {
    method: 'PUT', headers: organizerHeaders, body: JSON.stringify({ radio_status: 'Organizer updated' })
  })
  assert.equal(settings.status, 204)
  const submissions = await fetch(`${baseUrl}/api/admin/submissions`, { headers: organizerHeaders })
  assert.equal(submissions.status, 200)
  const event = await fetch(`${baseUrl}/api/admin/events`, {
    method: 'POST', headers: organizerHeaders,
    body: JSON.stringify({ event_date: '2027-11-06', title: 'Organizer Event', venue: 'Test Room', city: 'Pasco', lineup: 'Test Band', genre: 'punk', published: false })
  })
  assert.equal(event.status, 201)
  const venue = await fetch(`${baseUrl}/api/admin/venues`, {
    method: 'POST', headers: organizerHeaders,
    body: JSON.stringify({ name: 'Organizer Venue', address: '123 Test Ave', city: 'Pasco', published: false })
  })
  assert.equal(venue.status, 201)
  const news = await fetch(`${baseUrl}/api/admin/news`, {
    method: 'POST', headers: organizerHeaders,
    body: JSON.stringify({ label: 'Test', title: 'Organizer Story', slug: 'organizer-story', link: '#news', published: false })
  })
  assert.equal(news.status, 201)

  const blockedUser = await fetch(`${baseUrl}/api/admin/users`, {
    method: 'POST', headers: organizerHeaders,
    body: JSON.stringify({ username: 'forbidden', password: 'forbidden-password-long', role: 'organizer' })
  })
  assert.equal(blockedUser.status, 403)
  const blockedUserUpdate = await fetch(`${baseUrl}/api/admin/users/${organizerAccount.id}`, {
    method: 'PUT', headers: organizerHeaders,
    body: JSON.stringify({ username: 'organizer', password: '', role: 'admin' })
  })
  assert.equal(blockedUserUpdate.status, 403)
  const blockedUserDelete = await fetch(`${baseUrl}/api/admin/users/${adminSession.id}`, { method: 'DELETE', headers: organizerHeaders })
  assert.equal(blockedUserDelete.status, 403)
  const blockedKey = await fetch(`${baseUrl}/api/admin/show-api-keys`, {
    method: 'POST', headers: organizerHeaders, body: JSON.stringify({ name: 'Forbidden key' })
  })
  assert.equal(blockedKey.status, 403)
  const blockedKeyDelete = await fetch(`${baseUrl}/api/admin/show-api-keys/abcdefghijklmnop`, { method: 'DELETE', headers: organizerHeaders })
  assert.equal(blockedKeyDelete.status, 403)
}) // Covers the exact organizer navigation matrix at the HTTP authorization boundary.

test('creates, safely replays, and retrieves a show', async () => {
  const payload = {
    event_date: '2027-10-16', title: 'API TEST SHOW', venue: 'Test Room', city: 'Richland',
    lineup: 'Band One / Band Two', genre: 'punk', price: '$10', doors: '7 PM',
    featured: false, published: false
  }
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'integration-show-001' },
    body: JSON.stringify(payload)
  }
  const created = await apiRequest('/api/v1/shows', options)
  assert.equal(created.status, 201)
  const first = await created.json()
  assert.equal(first.replayed, false)
  assert.equal(first.show.title, payload.title)
  assert.equal(first.show.published, 0)

  const replay = await apiRequest('/api/v1/shows', options)
  assert.equal(replay.status, 200)
  const second = await replay.json()
  assert.equal(second.replayed, true)
  assert.equal(second.show.id, first.show.id)

  const fetched = await apiRequest(`/api/v1/shows/${first.show.id}`)
  assert.equal(fetched.status, 200)
  assert.equal((await fetched.json()).show.lineup, payload.lineup)

  const conflict = await apiRequest('/api/v1/shows', { ...options, body: JSON.stringify({ ...payload, title: 'DIFFERENT SHOW' }) })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).error.code, 'idempotency_conflict')
})
