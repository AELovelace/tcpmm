# Two-VM deployment

## Application VM

The application VM runs Node, SQLite, the API, admin panel, and built public site. Use Node 20 or newer.

1. Copy the project to `/opt/tcpmm`.
2. Run `npm install`, then `npm run build`.
3. Create a locked-down `tcpmm` system user and `/var/lib/tcpmm`, owned by that user.
4. Copy `.env.example` to `/etc/tcpmm.env`, set a long random initial password, and restrict the file to root (`chmod 600`).
5. Install `deploy/tcpmm.service` in `/etc/systemd/system/`, then enable and start it.
6. After the first successful start, remove `ADMIN_INITIAL_PASSWORD` from `/etc/tcpmm.env`.
7. Allow TCP port 3000 through the application VM firewall **only from the private IP of the Nginx VM**.

Site data and sessions are stored in `/var/lib/tcpmm/tcpmm.sqlite`; public chat messages are isolated in `/var/lib/tcpmm/tcpmm-chat.sqlite`; show submissions are isolated in `/var/lib/tcpmm/tcpmm-submissions.sqlite`. Back up that directory while the service is stopped, or use SQLite's online backup tooling. Set `CHAT_DB_PATH` or `SUBMISSIONS_DB_PATH` only when either isolated database needs a different location. Keep all database paths writable only by the application service account.

## Nginx VM

Use `deploy/nginx.conf` as the site configuration. Replace `APP_VM_PRIVATE_IP`, hostname, and TLS certificate paths. The required forwarded headers are included. `TRUST_PROXY=1` on the application VM makes HTTPS admin session cookies work correctly through the proxy.

The admin interface is available at `/admin`. The API and admin panel are not separate services.
