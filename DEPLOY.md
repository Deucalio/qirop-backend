# Deploying the backend to an Ubuntu VPS (systemd)

The service runs the TypeScript sources directly (`node -r tsx/cjs
src/server.ts`), reads `.env` from its working directory, and never writes to
local disk (uploads stream to the external FileStore), so it runs under a
hardened unit.

**There is no build step in a deploy.** `tsx` strips types at load time, so
updating is `git pull` + `systemctl restart` — see §8. This costs ~1-2s of
extra startup and means type errors surface at runtime, not at deploy time;
run `npm run typecheck` before pushing to keep that safety net.

> **The live server does not match §1-§2 below.** Those sections describe a
> greenfield `/opt/akm` + dedicated `akm` user setup. The actual deployment
> runs as **`rdpuser` from `/home/rdpuser/qirop-backend`**, and
> `deploy/akm-backend.service` is written to match *that*. If you copy the unit
> file, it is already correct — don't "fix" the paths back to `/opt/akm`.
> Sections §4 (migrate) and §8 (updating) apply as written.

Two production constraints decide the architecture:

- The auth cookie is **`SameSite=Lax`** → the frontend and API must be served
  from the **same site**. Easiest: one host (domain OR bare IP), nginx serves
  the built frontend and proxies `/api` to the service (see
  `deploy/nginx-akm.conf`).
- The cookie is **`Secure` in production by default** → over HTTPS only.

## Frontend on Vercel? (backend on a bare-IP VPS)

An `https://…vercel.app` page can NOT call `http://VPS_IP` directly — browsers
block mixed content, and cross-site cookies are dropped. Route the API
through Vercel instead (see `vercel.json` at the repo root):

- `/api/*` is rewritten server-side to `http://VPS_IP:4000/api/*` — the
  browser only ever talks to vercel.app, so everything is same-origin:
  cookies (`Secure` + `Lax`) and CORS just work. Keep `COOKIE_SECURE="auto"`.
- In the Vercel project settings set the env var `VITE_API_URL=/api` and
  redeploy.
- The VPS port must be reachable from Vercel: `sudo ufw allow 4000`.
- `CLIENT_ORIGIN="https://your-app.vercel.app"` in the backend `.env`.

## No domain yet? (bare IP over HTTP)

Everything below works the same, with three adjustments:

1. In `.env` set `COOKIE_SECURE="false"` (otherwise the browser drops the
   auth cookie over plain HTTP and logins won't stick) and
   `CLIENT_ORIGIN="http://YOUR.VPS.IP"`.
2. Build the frontend with `VITE_API_URL=http://YOUR.VPS.IP/api`.
3. Skip the certbot step; the nginx config's `server_name _;` default already
   answers on the bare IP.

When you get a domain: point its A record at the VPS, set `server_name`,
run certbot, flip `COOKIE_SECURE` back to `"auto"`, rebuild the frontend with
the `https://` API URL, and `sudo systemctl restart akm-backend`.

## 1. One-time server setup (as root / sudo)

```bash
# Node 22 (system-wide, so systemd can use /usr/bin/node)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx git

# PostgreSQL — skip if your DB already runs elsewhere
sudo apt-get install -y postgresql
sudo -u postgres psql -c "CREATE USER qirop WITH PASSWORD 'STRONG_PASSWORD';"
sudo -u postgres psql -c "CREATE DATABASE qirop OWNER qirop;"

# Service user + app directory
sudo useradd --system --create-home --shell /usr/sbin/nologin akm
sudo mkdir -p /opt/akm && sudo chown akm:akm /opt/akm
```

## 2. Get the code

```bash
sudo -u akm git clone <your-repo-url> /opt/akm/src   # or rsync/scp the repo
cd /opt/akm/src/backend
sudo -u akm npm ci                  # dev deps included — needed for prisma CLI
sudo -u akm npx prisma generate
```

No compile step: `tsx` is a runtime dependency and the unit runs `src/server.ts`
directly.

> If you clone to `/opt/akm/src`, either symlink `/opt/akm/backend` →
> `/opt/akm/src/backend` or adjust `WorkingDirectory` in the unit file.

## 3. Production `.env` (in the backend working directory)

```bash
sudo -u akm cp .env.example .env && sudo -u akm nano .env
sudo chmod 600 .env
```

Set at minimum:

```
DATABASE_URL="postgresql://qirop:STRONG_PASSWORD@localhost:5432/qirop"
JWT_SECRET="$(openssl rand -base64 48)"     # paste the output, don't leave the $()
CLIENT_ORIGIN="https://school.example.com"  # or http://YOUR.VPS.IP while domain-less
NODE_ENV="production"
PORT="4000"
COOKIE_SECURE="auto"                        # "false" ONLY while serving plain HTTP
SUPERADMIN_CNIC / SUPERADMIN_PASSWORD       # change before seeding!
FILESTORE_TOKEN / FILESTORE_APP_ID          # server-side only
```

## 4. Migrate (and optionally seed once)

```bash
sudo -u akm npx prisma migrate deploy
sudo -u akm npm run prisma:seed      # first deploy only — creates the superadmin
```

## 5. Install the systemd service

```bash
sudo cp deploy/akm-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now akm-backend
systemctl status akm-backend                   # should be active (running)
curl -s http://127.0.0.1:4000/api/health       # sanity check
journalctl -u akm-backend -f                   # live logs
```

## 6. nginx + TLS (frontend and /api on one domain)

Build the frontend locally with the production API URL and upload it:

```bash
# on your machine, repo root:
VITE_API_URL=https://school.example.com/api npm run build
scp -r dist/* user@vps:/opt/akm/frontend/
```

Then on the VPS:

```bash
sudo cp /opt/akm/src/backend/deploy/nginx-akm.conf /etc/nginx/sites-available/akm
sudo nano /etc/nginx/sites-available/akm       # set server_name + root
sudo ln -s /etc/nginx/sites-available/akm /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d school.example.com
```

## 7. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable        # port 4000 stays unreachable from outside — only nginx talks to it
```

## 8. Updating a running deployment

The common case — code changes only:

```bash
cd /opt/akm/src/backend
sudo -u akm git pull origin main
sudo systemctl restart akm-backend.service
sudo systemctl status akm-backend.service
sudo journalctl -u akm-backend.service -f
```

Two things `git pull` cannot apply on its own. Run these only when the pull
actually touched them:

```bash
# package.json changed → new/updated deps
sudo -u akm npm ci

# prisma/schema.prisma changed → regenerate client, apply migrations
sudo -u akm npx prisma generate
sudo -u akm npx prisma migrate deploy
```

The server shuts down gracefully on SIGTERM (systemd's stop signal), so
restarts are clean.
