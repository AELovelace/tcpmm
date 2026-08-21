# Show Posting API — Friend Testing Guide

This guide is everything needed to test the TCPM&M show API. Ask the site owner for these two values through a private channel:

- `BASE_URL` — the HTTPS site address, with no trailing slash (example: `https://shows.example.com`)
- `API_TOKEN` — the secret token beginning with `tcpmm_`

Never paste the token into chat, screenshots, bug reports, source control, or a URL. The server must be reached over HTTPS outside local development.

## Quick test with curl

Set temporary shell variables:

```sh
export BASE_URL="https://shows.example.com"
export API_TOKEN="tcpmm_replace_with_the_private_token"
```

Create a draft test show. Change `friend-test-2027-001` every time you intend to create a new record:

```sh
curl --fail-with-body --request POST "$BASE_URL/api/v1/shows" \
  --header "Authorization: Bearer $API_TOKEN" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: friend-test-2027-001" \
  --data '{
    "event_date": "2027-10-16",
    "title": "API TEST SHOW",
    "venue": "Test Room",
    "city": "Richland",
    "lineup": "Band One / Band Two",
    "genre": "punk",
    "price": "$10",
    "doors": "7 PM",
    "featured": false,
    "published": false
  }'
```

A new show returns HTTP `201` and JSON like this:

```json
{
  "show": {
    "id": 12,
    "event_date": "2027-10-16",
    "title": "API TEST SHOW",
    "venue": "Test Room",
    "city": "Richland",
    "lineup": "Band One / Band Two",
    "genre": "punk",
    "price": "$10",
    "doors": "7 PM",
    "featured": 0,
    "published": 0,
    "created_at": "2026-08-21 16:00:00",
    "updated_at": "2026-08-21 16:00:00"
  },
  "replayed": false
}
```

Save the returned `show.id`. Verify the stored record:

```sh
curl --fail-with-body \
  --header "Authorization: Bearer $API_TOKEN" \
  "$BASE_URL/api/v1/shows/12"
```

Repeat the original POST with the same `Idempotency-Key`. It should return HTTP `200`, the same show ID, and `"replayed": true`; it must not create a duplicate. Reusing that key with different show data returns HTTP `409`.

## PowerShell version

```powershell
$BaseUrl = 'https://shows.example.com'
$ApiToken = 'tcpmm_replace_with_the_private_token'
$Headers = @{
  Authorization = "Bearer $ApiToken"
  'Idempotency-Key' = 'friend-test-2027-001'
}
$Body = @{
  event_date = '2027-10-16'
  title = 'API TEST SHOW'
  venue = 'Test Room'
  city = 'Richland'
  lineup = 'Band One / Band Two'
  genre = 'punk'
  price = '$10'
  doors = '7 PM'
  featured = $false
  published = $false
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/v1/shows" -Headers $Headers -ContentType 'application/json' -Body $Body
```

## Request fields

| Field | Required | Rules |
| --- | --- | --- |
| `event_date` | Yes | Real calendar date formatted `YYYY-MM-DD` |
| `title` | Yes | Text, up to 120 characters |
| `venue` | Yes | Text, up to 120 characters |
| `city` | Yes | Text, up to 80 characters |
| `lineup` | Yes | Text, up to 500 characters |
| `genre` | Yes | `punk`, `metal`, `hardcore`, `rock`, `alternative`, `edm`, `rap`, or `other` |
| `price` | No | Text, up to 40 characters; defaults to empty |
| `doors` | No | Text, up to 40 characters; defaults to empty |
| `featured` | No | JSON boolean; defaults to `false` |
| `published` | No | JSON boolean; defaults to `true` |

Unknown fields are rejected. Control characters are removed from text. For harmless testing, explicitly send `"published": false`; the site owner can inspect and delete the draft in the admin panel. Omit `published` or set it to `true` only when the show should immediately appear on the public calendar.

Every POST requires an `Idempotency-Key` containing 8–128 letters, numbers, dots, underscores, colons, or dashes. Generate a unique value for each intended show and keep the same value when retrying that exact request.

## Status codes

| Status | Meaning |
| --- | --- |
| `200` | An identical request was safely replayed, or a show was retrieved |
| `201` | A new show was created |
| `400` | Invalid JSON, idempotency key, ID, or show fields |
| `401` | Missing, malformed, revoked, or incorrect Bearer token |
| `404` | The requested show ID does not exist |
| `409` | An idempotency key was reused with different data |
| `410` | The idempotent request succeeded before, but an administrator later deleted its show |
| `413` | Request body is too large |
| `415` | POST body is not `application/json` |
| `429` | Rate limit reached; obey the `Retry-After` response header |
| `500` | Server error; report the time and response, but never the token |

The API permits 60 authenticated requests per key per hour. Repeated invalid tokens are limited separately by client IP.

## What to report

Please send the site owner:

- The UTC time of the test
- HTTP method and path (but no query containing secrets)
- Response status and body
- Whether a retry returned the same show ID
- Any behavior that differed from this guide

Redact the `Authorization` header completely. The `Idempotency-Key` is safe to include.
