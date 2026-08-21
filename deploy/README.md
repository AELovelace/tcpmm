# Two-VM deployment

## Application VM

The application VM runs Node, SQLite, the API, admin panel, and built public site. Use Node 20 or newer.

### First install on Fedora

Run the installer from any checkout of this repository. Pass the Git URL and, optionally, a branch or tag:

```sh
sudo PROXY_IP=10.0.0.20 bash deploy/install-fedora.sh https://example.com/owner/tcpmm.git main
```

`PROXY_IP` is the private IP of the Nginx VM. When firewalld is active, the installer adds a port 3030 rule limited to that address. If it is omitted, the installer does not expose the port.

The installer:

- Installs Git, Node.js, npm, FFmpeg, native build tools, and curl with DNF.
- Requires Node.js 20 or newer.
- Clones the application to `/opt/tcpmm`.
- Creates the locked-down `tcpmm` account and `/var/lib/tcpmm`.
- Runs `npm ci`, compiles TypeScript, and builds the production assets.
- Creates `/etc/tcpmm.env`, installs the systemd unit, and starts the service.
- Checks `/api/content` before reporting success.
- Removes the bootstrap password from the environment file after the administrator is created.

A random initial password is printed once at the end of installation. Save it immediately.

### Updates

Run the updater from the installed application:

```sh
sudo /opt/tcpmm/deploy/update-fedora.sh
```

To switch or explicitly update a branch:

```sh
sudo /opt/tcpmm/deploy/update-fedora.sh main
```

The updater refuses to overwrite tracked local changes, fast-forwards from Git, installs the locked dependencies, recompiles TypeScript, rebuilds production assets, prunes development packages, updates the systemd unit, restarts the service, and checks the application endpoint. If an update or health check fails, it restores the previous Git revision and rebuilds it.

Do not edit deployed tracked files directly. Make changes in Git and use the updater.

Site data and sessions are stored in `/var/lib/tcpmm/tcpmm.sqlite`; public chat messages are isolated in `/var/lib/tcpmm/tcpmm-chat.sqlite`; show submissions are isolated in `/var/lib/tcpmm/tcpmm-submissions.sqlite`. Back up that directory while the service is stopped, or use SQLite's online backup tooling. Set `CHAT_DB_PATH` or `SUBMISSIONS_DB_PATH` only when either isolated database needs a different location. Keep all database paths writable only by the application service account.

## Nginx VM

Use `deploy/nginx.conf` as the site configuration. Replace `APP_VM_PRIVATE_IP`, hostname, and TLS certificate paths. The required forwarded headers are included. `TRUST_PROXY=1` on the application VM makes HTTPS admin session cookies work correctly through the proxy.

The supplied proxy configuration redirects plain HTTP to the canonical HTTPS URL, sends HSTS on HTTPS responses, limits general request bursts, and applies tighter per-IP limits to login, submission, and chat endpoints. It also permits at most six concurrent chat event streams and three radio streams per source IP. The application enforces the same stream ceilings and global caps if traffic reaches it without the proxy.

The `map`, `limit_req_zone`, and `limit_conn_zone` directives belong in Nginx's `http` context. Standard `conf.d` and `sites-enabled` files are already included from that context. After installing or changing the configuration, validate and reload it on the proxy VM:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Verify both entry points from another machine. HTTP should return `308` with an HTTPS `Location`, while HTTPS should include `Strict-Transport-Security`:

```bash
curl -I http://tcpmm.wtf/
curl -I https://tcpmm.wtf/
```

The admin interface is available at `/admin`. The API and admin panel are not separate services.
