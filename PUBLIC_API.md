# Public Site API

The public API is an unauthenticated, read-only interface for phone apps, independently hosted frontends, and other consumers of published TCPM&M content. Its versioned base URL is:

```text
/api/public/v1
```

It is separate from `/api/v1/shows`, which remains an authenticated publishing API. Public API routes never return drafts and do not accept writes or API keys.

## Endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/public/v1` | Discover the API version and resource URLs. |
| `GET` | `/api/public/v1/content` | Fetch published events, venues, news summaries, and public site settings in one first-sync response. |
| `GET` | `/api/public/v1/events` | List published events. |
| `GET` | `/api/public/v1/events/:id` | Fetch one published event. |
| `GET` | `/api/public/v1/venues` | List published venues. |
| `GET` | `/api/public/v1/venues/:id` | Fetch one published venue. |
| `GET` | `/api/public/v1/news` | List published news summaries. |
| `GET` | `/api/public/v1/news/:id` | Fetch one published news item, including sanitized `body_html` when it has a site-hosted article. |

`HEAD` is supported anywhere `GET` is supported. `OPTIONS` returns a CORS preflight response. Other methods return `405 Method Not Allowed` because this API is read-only.

## Collections and filters

Collection responses use this shape:

```json
{
  "data": [],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "count": 0,
    "total": 0
  }
}
```

All collections accept `limit` from 1 through 100 and `offset` from 0 through 1,000,000.

- Events also accept `from` and `to` as `YYYY-MM-DD`, `genre`, case-insensitive `city`, and `featured=true|false`.
- Venues also accept case-insensitive `city` and `featured=true|false`.
- News also accepts `featured=true|false`.

Unknown or invalid query parameters return `400` instead of silently changing the request. Detail and first-sync responses wrap their payload in `data` but do not include pagination.

## Resource notes

- `featured` values are JSON booleans.
- The internal `published` field is omitted because every returned resource is published.
- Venue `image_url` and news `link` values may be root-relative URLs. Resolve them against the API server's public origin.
- News collections include `has_article` but omit `body_html`; fetch the news detail when the app needs the article body.
- Timestamps are SQLite UTC text in `YYYY-MM-DD HH:MM:SS` form.

Example:

```sh
curl "https://tcpmm.wtf/api/public/v1/events?from=2026-08-21&city=Pasco&limit=20"
```

## Caching, CORS, and errors

Responses allow cross-origin reads with `Access-Control-Allow-Origin: *` and use `Cache-Control: public, max-age=60, stale-while-revalidate=300`. Clients may cache a response for one minute and may show it for up to five additional minutes while revalidating.

Errors are JSON and use a stable code plus a human-readable message:

```json
{
  "error": {
    "code": "not_found",
    "message": "Event not found"
  }
}
```

Current codes are `invalid_query`, `invalid_id`, `not_found`, `method_not_allowed`, and `internal_error`.
