# Testing Guide

## Automated checks

Run the complete verification suite from the repository root:

```powershell
npm.cmd test
npm.cmd run build
```

The integration coverage starts real servers against disposable databases. It verifies that organizers can use **SITE**, **MAIL**, **EVENTS**, **VENUES**, and **NEWS**, while user-management and API-key routes return `403`. It also verifies that sensitive account and key metadata is omitted from organizer content responses and that the final full administrator cannot be demoted.

The public API coverage creates published and draft events, venues, and news through the real administrator routes. It then verifies unauthenticated discovery and first-sync responses, published-only visibility, filters, pagination, detail records, article-body behavior, CORS, caching, structured errors, preflight handling, and rejection of write methods.

The security coverage checks browser headers, hardened cookies, authentication, CSRF, login throttling, body limits, article and chat XSS handling, form-token throttling and IP binding, malformed request handling, application stream caps, and required Nginx abuse limits.

For a focused public API run:

```powershell
node --test test/public-api.test.js
```

For a focused security run:

```powershell
node --test test/security.test.js
```

## Manual role check

1. Sign in as a full administrator and create an organizer from **USERS**.
2. Sign in as that organizer in a separate private browser window.
3. Confirm **SITE**, **MAIL**, **EVENTS**, **VENUES**, and **NEWS** are visible and usable.
4. Confirm **USERS** and **API KEYS** are absent.
5. Sign back in as the full administrator and confirm every section remains available.

UI visibility is only a convenience. The server-side `403` checks are the security boundary and must remain covered whenever control-panel routes change.

## Deployment security smoke check

After changing the public Nginx proxy, verify that plain HTTP redirects to HTTPS and that HTTPS advertises HSTS:

```powershell
curl.exe -I http://tcpmm.wtf/
curl.exe -I https://tcpmm.wtf/
```

The first request must return `308` with `Location: https://tcpmm.wtf/`. The second must return `200` and include `Strict-Transport-Security: max-age=31536000`. Repeated abusive requests or excess streams should return `429`, normally with a `Retry-After` header from the application limits.
