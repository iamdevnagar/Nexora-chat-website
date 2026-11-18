# NEXORA

NEXORA is a responsive, real-time chat application built with React, Tailwind CSS, Express, Socket.IO, and PostgreSQL. It includes username-based accounts, optional authenticator-app 2FA, friend requests and accepted friends, private and group conversations, the permanent NEXORA PUBLIC GROUP, message history and read receipts, file sharing, blocking/reporting, and an admin dashboard.

## Requirements

- Node.js 20.19+ or 22.12+
- PostgreSQL 14+
- npm

## Local development

1. Copy `.env.example` to `.env` and set `DATABASE_URL` and a unique `JWT_SECRET` (at least 32 characters). Keep `.env` private.
2. Install dependencies and generate Prisma's client:

   ```sh
   npm install
   npm run db:generate
   ```

3. Start the local PostgreSQL container (Docker required):

   ```sh
   npm run db:up
   ```

   The development database is bound to `127.0.0.1:5432` and persists in a Docker volume. The example credentials are for local development only. Stop the container with `npm run db:down`; this preserves the volume/data.

4. Apply the database schema:

   ```sh
   npm run db:dev
   ```

5. Start the API and Vite development server:

   ```sh
   npm run dev
   ```

   Open `http://localhost:5173`. The Vite server proxies API and Socket.IO requests to Express on port 3000.
   In Codespaces, the forwarded-port origin is allowed in development, and the proxy hop is trusted for rate limiting. Production still requires the exact public origin in `CLIENT_ORIGIN`.
   Stop the development servers with `Ctrl+C`; `Ctrl+Z` suspends them while leaving their ports occupied.

## Production deployment on a Linux VPS

These instructions target a fresh Ubuntu 22.04/24.04 or Debian 12 VPS and use one domain, one Node.js process managed by PM2, PostgreSQL on the same machine, Nginx, and Let's Encrypt. Express serves the built React app, REST API, and Socket.IO on the same origin. Nginx forwards normal HTTP and WebSocket traffic to Node. Keep PM2 at **one instance**: online presence and Socket.IO rooms are currently in process memory and are not shared across instances.

Replace `YOUR_DOMAIN`, `YOUR_VPS_IP`, and `YOUR_GITHUB_REPO_URL` in the commands below with your actual values.

### 1. Point your domain to the VPS

At your domain registrar/DNS provider, open DNS management and add:

| Type | Host/Name | Value |
| --- | --- | --- |
| A | `@` | Your VPS public IPv4 address |
| A | `www` | Your VPS public IPv4 address |

If your VPS has a working public IPv6 address, add matching AAAA records. Otherwise do not add AAAA records. Delete conflicting old records for these names. DNS can take a while to propagate; check with `dig +short YOUR_DOMAIN A` and `dig +short www.YOUR_DOMAIN A`.

### 2. Connect by SSH and install system packages

From your computer, connect with the username and IP supplied by your VPS provider:

```sh
ssh YOUR_VPS_USER@YOUR_VPS_IP
```

If your provider gave you an SSH key file, use `ssh -i /path/to/key YOUR_VPS_USER@YOUR_VPS_IP`. Run the following on the VPS. The first command is for Ubuntu/Debian:

```sh
sudo apt update
sudo apt upgrade -y
sudo apt install -y curl ca-certificates gnupg git build-essential nginx postgresql postgresql-contrib certbot python3-certbot-nginx
```

Install Node.js 22 LTS from NodeSource, then PM2:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install --global pm2
node --version
npm --version
pm2 --version
```

Open only SSH, HTTP, and HTTPS in the firewall. If your VPS provider has a cloud firewall, allow TCP ports 22, 80, and 443 there too. If SSH uses a non-standard port, allow that port before enabling UFW or you can lock yourself out. On a server using UFW:

```sh
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

Do **not** open port 3000 to the public internet; NEXORA will listen on `127.0.0.1:3000`, with Nginx as the public entry point.

### 3. Create a PostgreSQL database and user

Start and enable PostgreSQL:

```sh
sudo systemctl enable --now postgresql
sudo -u postgres psql
```

At the `postgres=#` prompt, set a unique password in place of `REPLACE_WITH_A_LONG_RANDOM_PASSWORD`, then run:

```sql
CREATE USER nexora_user WITH PASSWORD 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';
CREATE DATABASE nexora OWNER nexora_user;
\q
```

The database stays local; do not expose PostgreSQL port 5432 to the internet. Use URL-encoded characters in the password if it contains symbols reserved in a URL (such as `@`, `:`, `/`, `?`, or `#`).

### 4. Clone the repository and configure secrets

Create a dedicated Linux account and app directory:

```sh
sudo adduser --disabled-password --gecos "" nexora
sudo mkdir -p /var/lib/nexora/uploads
sudo chown -R nexora:nexora /var/lib/nexora
sudo -iu nexora
```

While logged in as `nexora`, clone the complete GitHub repository. If it is private, first configure SSH access to GitHub for this VPS or use a deploy key; do not put a GitHub access token in the clone URL.

```sh
git clone YOUR_GITHUB_REPO_URL /home/nexora/app
cd /home/nexora/app
```

Create a private production `.env` file:

```sh
cat > .env <<'EOF'
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
CLIENT_ORIGIN=https://YOUR_DOMAIN,https://www.YOUR_DOMAIN
DATABASE_URL=postgresql://nexora_user:REPLACE_WITH_URL_ENCODED_PASSWORD@127.0.0.1:5432/nexora?schema=public
JWT_SECRET=REPLACE_WITH_A_RANDOM_SECRET
TOTP_ENCRYPTION_KEY=
UPLOAD_DIR=/var/lib/nexora/uploads
EOF
chmod 600 .env
```

Generate secret values on the VPS with `openssl rand -base64 48`. Put a generated value in `JWT_SECRET`; optionally generate a separate base64 32-byte value for `TOTP_ENCRYPTION_KEY` if you want to enable authenticator-app 2FA. Keep both safe and backed up. Do not change `JWT_SECRET` later or existing sessions will stop working. `CLIENT_ORIGIN` must be the exact HTTPS website origin(s), without trailing slashes.

### 5. Install, migrate, and build NEXORA

Still in `/home/nexora/app` as `nexora`:

```sh
npm ci --include=dev
npm run db:generate
npm run db:migrate
npm run build
```

`npm ci --include=dev` keeps Prisma and Vite available for production migrations and builds. Uploaded files and avatars go to `/var/lib/nexora/uploads`, outside the Git checkout, so repository updates will not remove them. PostgreSQL stores chat messages and accounts in its own data directory.

### 6. Start NEXORA under PM2 and enable boot startup

The repository includes [ecosystem.config.cjs](./ecosystem.config.cjs), which runs exactly one production process on `127.0.0.1:3000`:

```sh
pm2 start ecosystem.config.cjs --env production
pm2 status
curl http://127.0.0.1:3000/api/health
```

The health request should return `{"status":"ok"}`. Configure PM2 to start after VPS reboot:

```sh
pm2 startup systemd
```

PM2 prints a command beginning with `sudo env PATH=... pm2 startup systemd ...`. Copy and run the exact command it prints. Then save the app's process list:

```sh
pm2 save
```

If running PM2 as the `nexora` Linux user, keep using that user for `pm2` commands. To leave its shell, type `exit`.

### 7. Configure Nginx and WebSockets

Copy the included Nginx template, then edit its two placeholder domain names:

```sh
sudo cp /home/nexora/app/deploy/nginx-nexora.conf.example /etc/nginx/sites-available/nexora
sudo nano /etc/nginx/sites-available/nexora
```

Replace `example.com` and `www.example.com` in `server_name` with your domain and `www` domain. Save and enable the site:

```sh
sudo ln -s /etc/nginx/sites-available/nexora /etc/nginx/sites-enabled/nexora
sudo nginx -t
sudo systemctl reload nginx
```

The provided config forwards `Upgrade` and `Connection` headers and uses long proxy timeouts so Socket.IO WebSocket connections remain open. It also permits the app's 20 MB file uploads. If `nginx -t` reports a duplicate site/default conflict, disable the default site with `sudo rm /etc/nginx/sites-enabled/default`, then test again.

### 8. Enable HTTPS with Certbot

Confirm both DNS names point to the VPS and ports 80/443 are reachable, then run:

```sh
sudo certbot --nginx -d YOUR_DOMAIN -d www.YOUR_DOMAIN
```

Enter an email address, agree to the terms, and choose the HTTPS redirect option when prompted. Certbot will update Nginx to serve HTTPS. Test automatic certificate renewal:

```sh
sudo certbot renew --dry-run
```

Use the exact domains you have DNS records for. If you do not plan to use `www`, omit it from the DNS, `CLIENT_ORIGIN`, and Certbot command.

### 9. Verify login, friends, DMs, and public chat

Open `https://YOUR_DOMAIN` in a browser and confirm the secure-lock icon appears. Then:

1. Register two accounts and check that both see **NEXORA PUBLIC GROUP**.
2. Send a group message from one account and confirm it appears for the other.
3. Search for the other account's exact username, send a friend request, accept it, and confirm a private DM works in both directions.
4. Upload an image or file and confirm it loads.
5. In the VPS shell, check the services with `pm2 logs nexora`, `sudo systemctl status nginx`, and `sudo systemctl status postgresql`.

Register your own account and promote it to admin while in the app directory as `nexora`:

```sh
npm run admin:promote -- YOUR_USERNAME
```

### Updating NEXORA later

As the `nexora` Linux user:

```sh
cd /home/nexora/app
git pull
npm ci --include=dev
npm run db:generate
npm run db:migrate
npm run build
pm2 reload ecosystem.config.cjs --env production
pm2 save
```

Before updates, back up PostgreSQL and `/var/lib/nexora/uploads`. One basic database backup command is:

```sh
sudo -u postgres pg_dump nexora > "$HOME/nexora-$(date +%F).sql"
```

Store backups somewhere other than the VPS as well. Never commit `.env`, passwords, or generated secrets. The frontend calls the API and Socket.IO on its own origin; production requires no hardcoded development or localhost backend URL.

## Authentication and account recovery

- Usernames are normalized to lowercase and must be 3–20 letters, numbers, or underscores.
- Passwords must be at least 8 characters and are hashed with bcrypt.
- Session tokens are stored in HTTP-only, same-site cookies; HTTPS is required in production.
- Auth endpoints are rate limited. Optional TOTP-based 2FA can be enabled in profile settings. Set `TOTP_ENCRYPTION_KEY` to a unique base64-encoded 32-byte key (generate one with `openssl rand -base64 32`) to enable it; TOTP secrets are encrypted before storage. Keep this key backed up and stable—rotating it without re-enrolling users will invalidate their 2FA setup.
- Password recovery is administrator-assisted because accounts do not collect email addresses. Users submit a request from the login screen. An administrator reviews it in the dashboard, sets a temporary password, and must share it with the user through a secure out-of-band channel.

## Friend requests and direct messages

- Search uses an exact username match to send friend requests. Incoming and sent requests are listed separately, and recipients can accept or reject incoming requests.
- New request, acceptance, and rejection events show in-app notifications; pending incoming requests also appear in the Friends badge.
- Only accepted friends can start or continue a private direct conversation. Removing a friend hides and disables their existing direct conversation until a new request is accepted. Group chats are unchanged.

## Public group

- Database migrations create the permanent `NEXORA PUBLIC GROUP` and add every existing user as a member. Server startup also verifies the room and repairs missing memberships.
- Each new account is added to the public group as part of registration. The group is stored as a normal PostgreSQL conversation, so its membership and chat history survive server restarts.
- The public room is pinned at the top of the conversation list. Its messages are delivered to all connected members, and the conversation details menu lists its members.

## Deployment notes

- Only image, PDF, and plain-text uploads are accepted (20 MB maximum). Keep `UPLOAD_DIR` on a persistent volume and back it up.
- The initial Socket.IO presence and room state is in memory, suitable for a single app instance. Horizontal multi-instance scaling requires a shared Socket.IO adapter and coordinated presence storage.
- Configure regular PostgreSQL and persistent-volume backups before using this for important conversations.
- Never commit `.env`, secrets, uploaded files, or production database credentials.