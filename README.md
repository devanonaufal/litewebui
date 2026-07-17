# brengseek

**A simple, lightweight chat website for AI models.**  
**Product name:** brengseek  
**Repo / Docker / binary:** still litewebui (internal package name).

brengseek is a private ChatGPT-style web app you can run on your own computer or VPS.  
It talks to any **OpenAI-compatible** API (local gateway, reverse proxy, cloud provider, etc.).

| | |
|---|---|
| **Author** | [Devano Naufal](https://github.com/devanonaufal) |
| **Language** | Go (backend) + plain HTML/CSS/JS (frontend) |
| **Database** | SQLite (one folder, no separate DB server) |
| **Default port** | `3050` |
| **Typical RAM** | often under ~40 MB idle |
| **License** | MIT |

### Interface preview

![brengseek chat interface](https://i.imgur.com/iOKi5U7.png)

*Dark theme chat UI — sidebar, streaming messages, model picker, and composer.*

---

## What problem does this solve?

Most full chat platforms are heavy (many services, high RAM, complex setup).

**brengseek** aims to be the opposite:

- One small program (or one Docker container)
- Login with a single username/password
- Chat history saved on your server
- Upload images/files when the model supports them
- You own the data (stored under `DATA_DIR`)

> **Not** a clone of Open WebUI. There is no multi-user admin panel, RAG, plugins marketplace, or built-in Ollama manager. Just a clean chat UI + proxy to your API.

---

## Features

### For everyday use
- Sign-in page (session cookie; survives container restart when data is on a volume)
- Sidebar: new chat, recent chats, rename, delete, pin/archive (as implemented in the UI)
- Streaming replies (text appears as the model generates it)
- Attachments: upload files/images and send them with the message
- Paste screenshots (Ctrl+V) or drag-and-drop files onto the composer
- Settings page: API base URL, API key, connection test, model list from upstream

### For reading AI answers
- Markdown: headings, lists (including nested), tables, quotes, task lists
- Code blocks with copy button + syntax highlighting (via CDN)
- Math formulas (`$...$` / `$$...$$`) via KaTeX (CDN)
- Safe link handling (blocks dangerous URL schemes in rendered content)

### For operators
- Environment-based config (no secrets baked into the binary for production)
- Docker + Docker Compose + simple VPS deploy script
- Static UI files are **embedded** in the binary → one file to deploy after build

---

## Requirements

Pick **one** path:

| Path | You need |
|------|----------|
| **Docker** (recommended) | Docker Engine (and optionally Docker Compose) |
| **Binary** | Go **1.22+** to build; Linux/Windows/macOS to run |
| **Upstream AI** | Any HTTP API that speaks **OpenAI Chat Completions** style (`…/v1`) |

You also need:

- A password you will hash with **SHA-256** (explained below)
- An **API base URL** ending with `/v1` (example: `http://127.0.0.1:20128/v1`)
- An **API key** if your provider requires one

---

## 5-minute quick start (Docker)

### 1. Get the code

```bash
git clone https://github.com/devanonaufal/litewebui.git
cd litewebui
```

### 2. Create a password hash

brengseek does **not** store the plain password in the config.  
You store the **SHA-256 fingerprint** of the password.

**Linux:**

```bash
echo -n 'your-strong-password' | sha256sum | awk '{print $1}'
```

**macOS:**

```bash
echo -n 'your-strong-password' | shasum -a 256 | awk '{print $1}'
```

**Windows (PowerShell):**

```powershell
$s = [Text.Encoding]::UTF8.GetBytes('your-strong-password')
$h = [Security.Cryptography.SHA256]::Create().ComputeHash($s)
($h | ForEach-Object { $_.ToString('x2') }) -join ''
```

Copy the long 64-character hex string. That is your `AUTH_PASSWORD`.

### 3. Run the container

```bash
docker build -t litewebui .

docker run -d \
  --name litewebui \
  --restart unless-stopped \
  -p 3050:3050 \
  -e AUTH_USERNAME=admin \
  -e AUTH_PASSWORD='PASTE_YOUR_64_CHAR_HASH_HERE' \
  -e NINEROUTER_BASE_URL='http://host.docker.internal:20128/v1' \
  -e NINEROUTER_API_KEY='sk-your-key-if-needed' \
  -e DATA_DIR=/data \
  -v litewebui-data:/data \
  litewebui
```

> On Linux servers, `host.docker.internal` may not exist.  
> If your API runs on the host machine, try:  
> `http://172.17.0.1:20128/v1` (Docker bridge gateway) or the real LAN IP.

### 4. Open the app

Browser: **http://YOUR_SERVER_IP:3050**

- Username: `admin` (or whatever you set in `AUTH_USERNAME`)
- Password: the **plain** password you hashed (not the hash)

Then open **Settings**, confirm the API endpoint + key, press **Test Connection**, choose a model, and chat.

### Docker Compose (optional)

```bash
cp .env.example .env
# edit .env → set AUTH_PASSWORD hash and API settings

docker compose up -d --build
```

---

## Quick start without Docker (Go binary)

```bash
cp .env.example .env
# edit AUTH_PASSWORD (hash), NINEROUTER_BASE_URL, NINEROUTER_API_KEY

# load env (bash example)
set -a; source .env; set +a

go mod tidy
CGO_ENABLED=0 go build -ldflags="-s -w" -o litewebui .
./litewebui
```

Open **http://127.0.0.1:3050**.

### Build Linux binary from Windows

```powershell
$env:CGO_ENABLED = "0"
$env:GOOS = "linux"
$env:GOARCH = "amd64"
go mod tidy
go build -ldflags="-s -w" -o litewebui-linux .
```

Copy `litewebui-linux` to the server, `chmod +x`, set env vars, run it (or put it behind systemd / reverse proxy).

---

## First login (defaults in this repository)

If you run with the sample values from `.env.example` **without changing them**:

| Field | Value |
|-------|--------|
| Username | `admin` |
| Password | `changeme` |

**Change this before exposing the port to the internet.**

The hash in the example files is SHA-256 of `changeme`:

```text
057ba03d6c44104863dc7361fe4578965d1887360f90a0895882e58a6248fc86
```

---

## Connecting your AI API

brengseek is a **client + proxy**. It does not run models by itself.

1. Log in → open **Settings**
2. Set **API endpoint** to an OpenAI-compatible base, usually ending with `/v1`  
   Examples:
   - Local gateway: `http://127.0.0.1:20128/v1`
   - Remote provider: `https://api.example.com/v1`
3. Set **API key** if required
4. Use **Test Connection**
5. Pick a model from the list (loaded from upstream `/models`)

Environment variables `NINEROUTER_BASE_URL` and `NINEROUTER_API_KEY` only **seed** settings on first run. After that, values in the app database (under `DATA_DIR`) take precedence when you save in Settings.

---

## Configuration reference

| Variable | Default | What it means (plain language) |
|----------|---------|--------------------------------|
| `LISTEN` | `:3050` | Where the web server listens (`:3050` = all interfaces, port 3050) |
| `DATA_DIR` | `./data` | Folder for database, sessions, and uploaded files |
| `AUTH_USERNAME` | `admin` | Login username |
| `AUTH_PASSWORD` | hash of `changeme` | **SHA-256 hex (64 chars)** of the real password. Legacy MD5 hex (32) still accepted but not recommended |
| `NINEROUTER_BASE_URL` | `http://127.0.0.1:20128/v1` | First-run default API base URL |
| `NINEROUTER_API_KEY` | _(empty)_ | First-run default API key |

### Important notes about passwords

- Put the **hash** in `AUTH_PASSWORD`, type the **real password** in the login form.
- Always use `echo -n` (no newline) when hashing, or the hash will not match.
- Prefer SHA-256 (64 hex characters).

---

## Updating the app (very important)

The website files (`static/`) are **compiled into** the Go binary.

So after you change UI/code:

1. Copy new source to the server  
2. **Rebuild** Docker image or binary  
3. Recreate the container / restart the process  
4. Hard-refresh the browser (`Ctrl+Shift+R` / `Cmd+Shift+R`)

**`docker restart litewebui` alone does not apply code changes.**

### Safe rebuild on VPS (keeps chat history)

History lives in the Docker volume `litewebui-data` (or your `DATA_DIR`).  
Do **not** delete that volume if you want to keep chats.

```bash
cd /path/to/litewebui

# optional: set secrets
export AUTH_PASSWORD="$(echo -n 'your-strong-password' | sha256sum | awk '{print $1}')"
export NINEROUTER_BASE_URL=http://172.17.0.1:20128/v1

chmod +x deploy-vps.sh
./deploy-vps.sh
```

Or manually:

```bash
docker build --no-cache -t litewebui .
docker stop litewebui && docker rm litewebui
docker run -d --name litewebui --restart unless-stopped \
  -p 3050:3050 \
  -e AUTH_USERNAME=admin \
  -e AUTH_PASSWORD="$AUTH_PASSWORD" \
  -e NINEROUTER_BASE_URL="$NINEROUTER_BASE_URL" \
  -e DATA_DIR=/data \
  -v litewebui-data:/data \
  litewebui
```

Check the running build stamp:

```bash
curl -s http://127.0.0.1:3050/ | grep litewebui-build
```

---

## Reverse proxy & HTTPS (recommended for public servers)

Put Nginx, Caddy, or Traefik in front of port `3050`, enable HTTPS, and forward to `http://127.0.0.1:3050`.

Send header:

```http
X-Forwarded-Proto: https
```

so secure cookies work correctly behind TLS.

Do not expose port `3050` raw on the internet without HTTPS and a strong password.

---

## Project layout

```text
litewebui/
├── main.go              # HTTP server & config
├── auth.go              # login / sessions
├── store.go             # SQLite conversations & settings
├── chat.go / proxy.go   # chat + OpenAI-compatible proxy
├── files.go             # uploads
├── static/              # web UI (embedded at build time)
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── favicon.svg
├── Dockerfile
├── docker-compose.yml
├── deploy-vps.sh
├── .env.example
└── README.md
```

---

## HTTP API (for developers)

After login, the browser uses a session cookie.  
Main routes:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/login` | `{ "username", "password" }` |
| `GET` | `/api/me` | Check session |
| `POST` | `/api/logout` | End session |
| `GET` / `PUT` | `/api/settings` | API base URL + key |
| `POST` | `/api/settings/test` | Probe upstream |
| `GET` | `/api/v1/models` | Proxy model list |
| `POST` | `/api/v1/*` | OpenAI-compatible proxy |
| `POST` | `/api/files` | Multipart upload (`file`) |
| `GET` | `/api/files/{id}` | Download attachment |
| `POST` | `/api/chat` | Stream chat for a conversation |
| `GET` / `POST` | `/api/conversations` | List / create chats |
| `GET` / `PATCH` / `DELETE` | `/api/conversations/{id}` | Chat detail / update / delete |
| `POST` | `/api/conversations/{id}/messages` | Save messages |
| `GET` | `/api/health` | Liveness: `{"ok":true}` |

---

## Security checklist

- [ ] Change default password before public access  
- [ ] Never commit `.env` or the `data/` folder  
- [ ] Use HTTPS in production  
- [ ] Firewall: only proxy port 443 (or SSH) exposed if possible  
- [ ] Treat as **single-user / trusted network** software  
- [ ] Keep API keys only in Settings DB / env, not in screenshots or git  

Rendered markdown allows only `http(s)` links and `/api/files/…` for images.

---

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| Cannot log in | Hash must be SHA-256 of password **without** trailing newline (`echo -n`). Username must match `AUTH_USERNAME`. |
| Empty model list | Check Settings base URL ends with `/v1`, key is valid, Test Connection, and upstream is reachable **from the container** (not only from your laptop). |
| UI looks old after update | Rebuild image/binary, recreate container, hard-refresh browser. Check `litewebui-build` in page source. |
| Chats disappeared | You removed the Docker volume or changed `DATA_DIR` to a new empty path. |
| Stream errors | Upstream may return JSON error instead of SSE; check container logs: `docker logs litewebui`. |
| CDN features missing | Code highlight / math need outbound HTTPS to CDNs, or they fail silently and fall back to plain rendering. |

---

## FAQ

**Is this free?**  
Yes. MIT license — use, modify, and host yourself.

**Does it need a GPU?**  
No. Models run on whatever API you point to.

**Can many people use one install?**  
It is designed as a simple shared-password app, not full multi-tenant accounts. Anyone with the password can see the same chats. For real multi-user isolation, use separate deployments or a different product.

**Where is my data?**  
Under `DATA_DIR` (Docker volume `litewebui-data` by default): SQLite DB, sessions, uploads.

**Why is the env name `NINEROUTER_*`?**  
Historical naming for an OpenAI-compatible gateway. Functionally it is just “upstream base URL” and “upstream API key”.

---

## Contributing

Issues and pull requests are welcome.

1. Fork the repository  
2. Create a branch  
3. Keep diffs small and focused  
4. Do not commit secrets, `data/`, or personal deploy passwords  

---

## Author

**Devano Naufal**  
GitHub: [devanonaufal](https://github.com/devanonaufal)

---

## License

[MIT](LICENSE) © 2026 Devano Naufal

---

## Credits

Created by **Devano Naufal** as a minimal alternative to heavyweight chat frontends: one binary, SQLite, OpenAI-compatible APIs, and a focused browser UI.
