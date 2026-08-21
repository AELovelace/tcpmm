# Tri-Cities Punk, Metal & More

An original three-pane community site scaffold for the Kennewick, Pasco, and Richland, Washington punk, metal, hardcore, rock, alternative, EDM, rap, and underground music scene.

## Included

- Responsive left navigation and live SQL-backed community chat
- Filterable event listings and scene news
- SQL-backed venue directory with authenticated image uploads
- Shared FFmpeg-powered randomized ICY radio stream
- Live show board with compact mobile layouts
- Accessible semantic markup, keyboard controls, and reduced-motion support
- Integrated Node/SQLite content API and protected JavaScript admin panel
- Database-backed public show submissions with an admin review inbox
- Hashed-key show publishing API with validation, rate limits, and idempotent retries
- Versioned unauthenticated read-only API for published events, venues, news, and public site settings
- Two-tier operator management with organizer/admin roles, password resets, and session revocation

## Development

```sh
npm run dev
```

On this mapped Windows workspace, the development command automatically mirrors source files to a local cache, installs Vite there on first run, and keeps edits synchronized for hot reload. This avoids the mapped drive's Node `realpath` and package-directory limitations.

Production check:

```powershell
npm run build
Copy-Item .env.example .env
# Set ADMIN_INITIAL_PASSWORD in .env before the first start.
npm start
```

The Node process loads `.env`, then serves the built site, `/api` endpoints, and the control panel at `/admin`. On first start it creates the SQLite database and initial administrator. `ADMIN_INITIAL_PASSWORD` must contain at least 12 characters and should be removed from `.env` after that first successful start. Existing process environment variables take precedence over values in `.env`.

The control panel has two operator tiers. Organizers can manage **SITE**, **MAIL**, **EVENTS**, **VENUES**, and **NEWS**. Full administrators can do everything organizers can, plus manage accounts in **USERS** and publishing credentials in **API KEYS**. Existing accounts are migrated to the full administrator role. Password resets revoke that operator's existing sessions, role changes take effect on the next request, and the final full administrator cannot be demoted or deleted.

Admin HTML, styles, and JavaScript are served with `Cache-Control: no-store` because the browser controls must remain synchronized with the server's current authorization contract after every deployment.

### Administrator recovery

Someone with direct write access to the application database can restore an existing organizer account to the administrator role. The recovery tool makes an online SQLite backup, changes only the requested account, and revokes that account's existing sessions:

```sh
npm run promote:admin -- doll
```

On the packaged Fedora deployment, run it as the application service account and specify the production database explicitly:

```sh
sudo -u tcpmm node /opt/tcpmm/server/promote-user-to-admin.js doll --database /var/lib/tcpmm/tcpmm.sqlite
```

Sign in again with that account after the command completes. Recovery backups are written to a protected `recovery-backups` directory beside the database. The tool does not reveal or reset passwords and refuses missing or ambiguous account names.

## Deployment architecture

The application VM owns Node, SQLite, and all site files. The separate Nginx VM terminates TLS and reverse-proxies to the application VM over the private network. See [deploy/README.md](deploy/README.md) for the service, firewall, environment, backup, and proxy instructions.

## Content and data

Initial listings are seeded into SQLite and can be changed in `/admin`. Events, news, venues, hero copy, and radio status use `tcpmm.sqlite`. Venue photos are validated JPEG, PNG, or WebP files (up to 5 MB) stored under the configured data directory, while their paths and venue details remain in SQLite. The dedicated `/submit/` page collects the same calendar fields as an event plus venue address, description, and contact information using a short-lived, one-time form token. Token issuance is rate-limited, outstanding tokens and abuse buckets are memory-bounded, and expired state is cleaned periodically. New submissions are isolated in `tcpmm-submissions.sqlite` and appear in the admin **MAIL** inbox. An administrator can publish a complete submission to the live event calendar in one step, then edit the resulting event normally. The public multi-user chat stores messages in the separate `tcpmm-chat.sqlite` database and caps long-lived streams per client and across the service.

Event listings and show submissions support punk, metal, hardcore, rock, alternative, EDM, rap, and other as genre categories.

## Show publishing API

Trusted testers and integrations can create calendar shows through the versioned API. While signed in as a full administrator, open **API KEYS**, choose **GENERATE KEY**, and give every person or integration a separate credential. Organizers cannot view or change API credentials. The secret is displayed once; copy it before dismissing the notice. The panel shows usage metadata and revokes site-managed keys immediately without a service restart.

For unattended provisioning, a server operator can still generate an environment-managed credential from the command line:

```sh
npm run generate:show-api-key -- friend
```

Share only the generated Bearer token with that tester. For command-line keys, add the generated `name:sha256-hash` entry to `SHOW_API_KEYS` in `.env`; multiple entries are comma-separated. Environment-managed keys appear as read-only entries in the admin panel and require removing the entry and restarting to revoke.

The server stores only credential hashes, requires an idempotency key on every create request, validates an explicit JSON schema, and limits each key to 60 requests per hour. Keep the API behind HTTPS in production. Give testers the standalone [Show API testing guide](SHOW_API_TESTING.md), which includes curl and PowerShell examples, field rules, expected responses, and safe draft-testing instructions.

## Public site API

Phone apps and other public clients can read published site content without a credential under `/api/public/v1`. The namespace is isolated from the authenticated `/api/v1/shows` publisher API, accepts only `GET`, `HEAD`, and `OPTIONS`, and never exposes drafts. It includes a first-sync content snapshot plus paginated event, venue, and news collection and detail routes. Public responses allow cross-origin reads and are cacheable for one minute.

See the [Public Site API guide](PUBLIC_API.md) for the complete route, filter, response, caching, and error contract.

## Radio

Place licensed audio files in the `music` directory. The Node process scans supported audio formats, randomizes all tracks, streams them through FFmpeg as a shared 128 kbps MP3 broadcast, and reshuffles the playlist after every complete loop. The site displays the current song title, artist, and album from embedded media tags. Missing tags fall back to a `music/Artist/Album/Song.ext` directory layout. New listeners join the currently playing track through `/radio/stream`; ICY clients that send `Icy-MetaData: 1` also receive artist and title in `StreamTitle` metadata.

FFmpeg and FFprobe must be installed and available on `PATH`. Set `FFMPEG_PATH`, `FFPROBE_PATH`, or `MUSIC_DIR` to override the executables or media directory. The directory is rescanned at the start of each playlist loop and every five seconds while empty.
