import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcpmm-security-')) // Isolates adversarial fixtures from project and production data.
let child
let baseUrl

const availablePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close((error) => error ? reject(error) : resolve(port))
  })
}) // Reserves an operating-system-selected port for the disposable security server.

const waitForServer = (process, timeoutMs = 10_000) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Security test server did not start in time')), timeoutMs)
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
    reject(new Error(`Security test server exited with code ${code}: ${output}`))
  })
}) // Waits for the real listening event so probes cannot race application startup.

const clientHeaders = (ip, extra = {}) => ({ 'X-Forwarded-For': ip, ...extra }) // Gives each abuse scenario an isolated effective client IP behind the trusted test proxy.

const login = async (ip = '198.51.100.10') => {
  const response = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: clientHeaders(ip, { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' }),
    body: JSON.stringify({ username: 'admin', password: 'security-test-password' })
  })
  assert.equal(response.status, 200)
  const session = await response.json()
  return {
    session,
    cookie: response.headers.get('set-cookie'),
    headers: clientHeaders(ip, {
      Cookie: response.headers.get('set-cookie').split(';', 1)[0],
      'Content-Type': 'application/json',
      'X-CSRF-Token': session.csrfToken
    })
  }
} // Establishes a real administrator session and returns its cookie and CSRF boundary.

before(async () => {
  const port = await availablePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['server/app.js'], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'test', TRUST_PROXY: '1',
      DATA_DIR: temporaryDirectory, MUSIC_DIR: path.join(temporaryDirectory, 'music'),
      CHAT_DB_PATH: path.join(temporaryDirectory, 'chat.sqlite'),
      SUBMISSIONS_DB_PATH: path.join(temporaryDirectory, 'submissions.sqlite'),
      ADMIN_USERNAME: 'admin', ADMIN_INITIAL_PASSWORD: 'security-test-password', SHOW_API_KEYS: ''
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  })
  await waitForServer(child)
}) // Boots the complete application with proxy behavior and disposable databases enabled.

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}) // Stops all streams and removes only the directory created by this test file.

test('sends browser security headers and hides framework metadata', async () => {
  const response = await fetch(`${baseUrl}/`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.equal(response.headers.get('referrer-policy'), 'same-origin')
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()')
  assert.match(response.headers.get('content-security-policy') || '', /default-src 'self'/)
  assert.equal(response.headers.has('x-powered-by'), false)
}) // Prevents regressions in the global browser hardening boundary.

test('requires authentication and treats malformed cookies and paths as client errors', async () => {
  const anonymous = await fetch(`${baseUrl}/api/admin/content`)
  assert.equal(anonymous.status, 401)

  const malformedCookie = await fetch(`${baseUrl}/api/admin/session`, { headers: { Cookie: 'tcpmm_session=%E0%A4%A' } })
  assert.equal(malformedCookie.status, 401)

  const malformedPath = await fetch(`${baseUrl}/venue-images/%2e%2e%2fserver%2fapp.js`)
  assert.equal(malformedPath.status >= 400 && malformedPath.status < 500, true, `unexpected traversal-shaped path status: ${malformedPath.status}`)
  assert.doesNotMatch(await malformedPath.text(), /import crypto from/)
}) // Ensures attacker-controlled encoding cannot cause a 500 response or expose source files.

test('sets hardened session cookies and rejects missing or incorrect CSRF tokens', async () => {
  const authenticated = await login('198.51.100.11')
  assert.match(authenticated.cookie, /HttpOnly/i)
  assert.match(authenticated.cookie, /SameSite=Strict/i)
  assert.match(authenticated.cookie, /Secure/i)

  const missing = await fetch(`${baseUrl}/api/admin/settings`, {
    method: 'PUT', headers: { Cookie: authenticated.headers.Cookie, 'Content-Type': 'application/json' }, body: '{}'
  })
  const incorrect = await fetch(`${baseUrl}/api/admin/settings`, {
    method: 'PUT', headers: { ...authenticated.headers, 'X-CSRF-Token': 'incorrect' }, body: '{}'
  })
  assert.equal(missing.status, 403)
  assert.equal(incorrect.status, 403)
}) // Verifies both cookie attributes and the independent request token required for state changes.

test('limits repeated administrator login failures', async () => {
  const statuses = []
  for (let index = 0; index < 9; index += 1) {
    const response = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: clientHeaders('198.51.100.12', { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ username: 'admin', password: 'incorrect-password' })
    })
    statuses.push(response.status)
  }
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 401, 401, 401, 429])
}) // Keeps password verification work bounded for a repeatedly failing client.

test('rejects oversized anonymous JSON bodies', async () => {
  const response = await fetch(`${baseUrl}/api/chat/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'tester', text: 'hello', padding: 'x'.repeat(100_000) })
  })
  assert.equal(response.status, 413)
  assert.match((await response.json()).error, /96 KB/)
}) // Stops anonymous callers from forcing unbounded JSON parsing or allocation.

test('keeps stored article and chat payloads inert', async () => {
  const authenticated = await login('198.51.100.13')
  const hostileArticle = '<script>alert(1)</script><p onclick="alert(2)">safe</p><a href="javascript:alert(3)">bad</a><img src=x onerror=alert(4)>'
  const created = await fetch(`${baseUrl}/api/admin/news`, {
    method: 'POST', headers: authenticated.headers,
    body: JSON.stringify({ label: 'TEST', title: 'Security Story', slug: 'security-story', body_html: hostileArticle, published: true })
  })
  assert.equal(created.status, 201)
  const article = await fetch(`${baseUrl}/news/security-story`).then((response) => response.text())
  assert.doesNotMatch(article, /<script|onclick=|javascript:|<img/i)

  const hostileChat = '<img src=x onerror=alert(5)>'
  const chat = await fetch(`${baseUrl}/api/chat/messages`, {
    method: 'POST', headers: clientHeaders('198.51.100.14', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name: '<b>tester</b>', text: hostileChat })
  })
  assert.equal(chat.status, 201)
  const message = (await chat.json()).message
  assert.equal(message.name, '<b>tester</b>')
  assert.equal(message.text, hostileChat)
}) // Confirms rich articles are sanitized while chat markup remains JSON text for textContent rendering.

test('rate-limits secure-form token issuance and binds tokens to a client IP', async () => {
  const tokenResponses = []
  for (let index = 0; index < 21; index += 1) {
    tokenResponses.push(await fetch(`${baseUrl}/api/show-submissions/form-token`, { headers: clientHeaders('198.51.100.15') }))
  }
  assert.equal(tokenResponses.slice(0, 20).every((response) => response.status === 200), true)
  assert.equal(tokenResponses[20].status, 429)

  const token = await fetch(`${baseUrl}/api/show-submissions/form-token`, { headers: clientHeaders('198.51.100.16') }).then((response) => response.json())
  await new Promise((resolve) => setTimeout(resolve, 1_550))
  const wrongClient = await fetch(`${baseUrl}/api/show-submissions`, {
    method: 'POST', headers: clientHeaders('198.51.100.17', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ form_token: token.token })
  })
  assert.equal(wrongClient.status, 403)
}) // Proves token minting is bounded and a stolen token cannot move between client addresses.

test('caps concurrent anonymous chat streams per client IP', async () => {
  const controllers = Array.from({ length: 8 }, () => new AbortController())
  const responses = await Promise.all(controllers.map((controller) => fetch(`${baseUrl}/api/chat/events`, {
    headers: clientHeaders('198.51.100.18'), signal: controller.signal
  })))
  assert.equal(responses.filter((response) => response.status === 200).length, 6)
  assert.equal(responses.filter((response) => response.status === 429).length, 2)
  controllers.forEach((controller) => controller.abort())
  await Promise.allSettled(responses.map((response) => response.body?.cancel()))
}) // Prevents one source address from consuming every long-lived application socket.

test('keeps deploy-time Nginx request and connection limits configured', () => {
  const config = fs.readFileSync(path.join(root, 'deploy', 'nginx.conf'), 'utf8')
  assert.match(config, /limit_req_zone \$binary_remote_addr zone=tcpmm_general:/)
  assert.match(config, /limit_req zone=tcpmm_login /)
  assert.match(config, /limit_req zone=tcpmm_submissions /)
  assert.match(config, /limit_req zone=tcpmm_chat /)
  assert.match(config, /limit_conn tcpmm_chat_connections 6;/)
  assert.match(config, /limit_conn tcpmm_radio_connections 3;/)
  assert.match(config, /limit_req_status 429;/)
  assert.match(config, /limit_conn_status 429;/)
  assert.equal((config.match(/proxy_pass http:\/\/tcpmm_app;/g) || []).length, 2)
  assert.doesNotMatch(config, /proxy_pass http:\/\/\d{1,3}(?:\.\d{1,3}){3}/)
}) // Makes edge-layer abuse protection a reviewed and test-enforced deployment requirement.
