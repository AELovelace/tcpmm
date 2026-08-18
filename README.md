# Tri-Cities Punk, Metal & More

An original three-pane community site scaffold for the Kennewick, Pasco, and Richland, Washington punk, metal, hardcore, and alternative music scene.

## Included

- Responsive left navigation and live SQL-backed community chat
- Filterable event listings and scene news
- SQL-backed venue directory with authenticated image uploads
- Shared FFmpeg-powered randomized ICY radio stream
- Live show board with compact mobile layouts
- Accessible semantic markup, keyboard controls, and reduced-motion support
- Integrated Node/SQLite content API and protected JavaScript admin panel
- Database-backed public show submissions with an admin review inbox
- Multi-administrator management with password resets and session revocation

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

Authenticated administrators can add, rename, reset passwords for, and remove other administrators from the **USERS** panel. Password resets revoke that administrator's existing sessions. An administrator cannot delete their own account or the final administrator account.

## Deployment architecture

The application VM owns Node, SQLite, and all site files. The separate Nginx VM terminates TLS and reverse-proxies to the application VM over the private network. See [deploy/README.md](deploy/README.md) for the service, firewall, environment, backup, and proxy instructions.

## Content and data

Initial listings are seeded into SQLite and can be changed in `/admin`. Events, news, venues, hero copy, and radio status use `tcpmm.sqlite`. Venue photos are validated JPEG, PNG, or WebP files (up to 5 MB) stored under the configured data directory, while their paths and venue details remain in SQLite. The dedicated `/submit/` page collects the same calendar fields as an event plus venue address, description, and contact information using a short-lived, one-time form token. New submissions are isolated in `tcpmm-submissions.sqlite` and appear in the admin **MAIL** inbox. An administrator can publish a complete submission to the live event calendar in one step, then edit the resulting event normally. The public multi-user chat stores messages in the separate `tcpmm-chat.sqlite` database.

## Radio

Place licensed audio files in the `music` directory. The Node process scans supported audio formats, randomizes all tracks, streams them through FFmpeg as a shared 128 kbps MP3 broadcast, and reshuffles the playlist after every complete loop. New listeners join the currently playing track through `/radio/stream`; ICY clients that send `Icy-MetaData: 1` also receive `StreamTitle` metadata.

FFmpeg must be installed and available on `PATH`. Set `FFMPEG_PATH` or `MUSIC_DIR` to override the executable or media directory. The directory is rescanned at the start of each playlist loop and every five seconds while empty.
