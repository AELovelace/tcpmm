import crypto from 'node:crypto'

const keyId = String(process.argv[2] || 'friend').trim() // Gives each credential a short identity for revocation and rate limiting.
if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) {
  console.error('Key name must be 1-32 letters, numbers, underscores, or dashes.')
  process.exit(1)
}

const token = `tcpmm_${crypto.randomBytes(32).toString('base64url')}` // Generates 256 bits of cryptographically secure secret material.
const hash = crypto.createHash('sha256').update(token).digest('hex') // Produces the one-way value that belongs in the server environment.

console.log(`Key name: ${keyId}`)
console.log(`Bearer token (share securely; shown once): ${token}`)
console.log(`SHOW_API_KEYS entry (server only): ${keyId}:${hash}`)
