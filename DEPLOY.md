# Deploying FlagshipRouter

The router runs as a long-lived process that owns a writable data directory.
Railway and Render both give you that, so the shipped `Dockerfile` works
unchanged. Vercel does not: no persistent filesystem, functions frozen between
requests, and a request body cap far below the 128 MB the proxy is configured
for.

## Files

| File | Purpose |
| --- | --- |
| `Dockerfile` | The image Railway builds |
| `.railway/railway.ts` | Railway Config-as-Code authoring file: service `Astra_Api`, variables unmanaged |
| `railway.json` | Legacy Railway config; read until the Config-as-Code cutover, kept for compatibility |
| `render.yaml` | Render Blueprint, paid plan with a disk |
| `render.free.yaml` | Render Blueprint variant without a disk (state resets) |
| `docker-compose.yml` | Local container run, for testing before you deploy |

## 1. What has to change relative to local hosting

Nothing in the application code. Three environment facts:

1. **`DATA_DIR` must point at a mounted volume.** The SQLite database, backups
   and request history live there. Without a volume every deploy starts from an
   empty router.
2. **The port comes from the platform.** The standalone server reads `PORT` and
   `HOSTNAME` from the environment, so Railway's injected values just work. The
   `EXPOSE 20128` in the Dockerfile is informational.
3. **The public URL must be configured.** `BASE_URL` and
   `NEXT_PUBLIC_BASE_URL` are used by cloud sync and internal self-calls, so they
   need the real public address.

## 2. Railway

### Create the service

1. Railway dashboard -> **New Project** -> **Deploy from GitHub repo**.
2. Pick the repository. Railway finds the `Dockerfile` and starts the first
   build immediately; `railway.json` supplies the health check, restart policy
   and `numReplicas: 1`.
3. Let the first build finish. It runs `npm install` and `next build` in the
   container, so give it a few minutes.

### Generate the public domain

Service -> **Settings** -> **Networking** -> **Generate Domain**.

Do this before setting `BASE_URL`, so Railway knows the hostname you are about to
reference. The result is something like `<service>-production.up.railway.app`.

### Add the volume

Service -> **Volumes** -> **Add Volume**, mount path `/app/data`.

Volumes cannot be declared in `railway.json`, and they cannot be attached to a
service that does not exist yet, so this is always a dashboard step. The
container entrypoint runs `chown -R node:node /app/data` before dropping to the
`node` user, so a root-owned volume is fine.

Without this step the router works but forgets everything on each deploy:
provider connections, OAuth tokens and generated API keys all live in
`/app/data/db/data.sqlite`.

### Set the variables

Service -> **Variables**. Add the values from the table in section 4.

Two of them can reference Railway's own predefined variables instead of being
pasted in, which avoids the chicken-and-egg of needing the URL before it exists:

```text
BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
NEXT_PUBLIC_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
```

Variable changes take effect on the next deploy, so let Railway restart the
service after you save them.

### Alternative: CLI

With the Railway CLI installed and logged in, the same setup runs from a
terminal:

```bash
npm i -g @railway/cli
railway login
railway init
railway volume add --mount-path /app/data
railway variables --set "DATA_DIR=/app/data" --set "NODE_ENV=production"
railway up
```

### Config as Code (recommended)

`railway.json` is deprecated and stops being read on 2026-12-01. The repo ships
an authoring file at `.railway/railway.ts` naming the service `Astra_Api` with
variables unmanaged. A project that predates Config as Code should migrate it once:

```bash
railway config migrate --apply --service Astra_Api --variables unmanaged
# review .railway/railway.ts, then hand the project to IaC:
railway config migrate cutover   # stop reading railway.json (reversible via `railway config migrate undo`)
railway config plan              # preview the IaC changes
railway config apply             # hand management to IaC
```

Variables stay `unmanaged`, so secrets set in the dashboard or with
`railway variables` keep working and are never owned by the repo.

## 3. Render (alternative)

Render's Blueprint flow needs a payment method on file because the disk in
`render.yaml` requires a paid instance type. The $1 shown in the dialog is a
temporary authorization, not a charge, and the starter plan bills prorated by
the second.

1. Render dashboard -> **New** -> **Blueprint** -> pick the repository.
2. Fill in the three `sync: false` values: `INITIAL_PASSWORD`, `BASE_URL`,
   `NEXT_PUBLIC_BASE_URL`.
3. **Apply** and wait for the first build.

To stay on Render's free plan, point the Blueprint at `render.free.yaml`
instead. Read that file's header first: without a disk, the router loses its
state on every restart, and free instances sleep after 15 idle minutes.

## 4. Environment variables

| Variable | Value | Why |
| --- | --- | --- |
| `DATA_DIR` | `/app/data` | Must match the volume mount |
| `PORT` | platform-injected | Leave it to the platform |
| `HOSTNAME` | `0.0.0.0` | Bind on all interfaces |
| `NODE_ENV` | `production` | |
| `JWT_SECRET` | long random string | Signs the dashboard session cookie |
| `INITIAL_PASSWORD` | your password | Dashboard login. Set before first boot |
| `API_KEY_SECRET` | long random string | HMAC for generated API keys |
| `MACHINE_ID_SALT` | long random string | Machine-id derivation |
| `REQUIRE_API_KEY` | `true` | Forces `/v1` callers to authenticate |
| `AUTH_COOKIE_SECURE` | `true` | Both platforms serve HTTPS |
| `BASE_URL` | public `https://` URL | Cloud sync, internal self-calls |
| `NEXT_PUBLIC_BASE_URL` | same as `BASE_URL` | Public base for the client |
| `ENABLE_REQUEST_LOGS` | `false` | Logs full headers and bodies when on |

Generate secrets with `openssl rand -hex 32`, or use the variable editor's
generator if it offers one.

Do not rotate `API_KEY_SECRET` or `MACHINE_ID_SALT` after keys exist, or every
issued key stops working. Changing `INITIAL_PASSWORD` after the first boot does
not change the stored password; use **Settings** in the dashboard instead.

## 5. Carry over an existing setup

An existing local install keeps its state under `%APPDATA%\flagshiprouter` on
Windows or `~/.flagshiprouter` elsewhere. Copy `db/data.sqlite` into the volume
at `/app/data/db/` after the first deploy to bring providers, keys and combos
across. Copy `jwt-secret` and `machine-id` alongside it if you also want existing
session cookies and API keys to stay valid; otherwise just re-create the keys.

## 6. First run

1. Open the public URL and log in with `INITIAL_PASSWORD`.
2. Go to **Settings** and change the password.
3. Open **Endpoint & Key**, create an API key, and copy it.
4. Open **Models**. OpenCode Free models work with no signup; anything else
   needs a provider connection.

## 7. Calling the API

```bash
curl https://<your-service>-production.up.railway.app/v1/chat/completions \
  -H "Authorization: Bearer $FR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-6-astra","messages":[{"role":"user","content":"Say OK"}]}'
```

Checks that need no key:

```bash
curl https://<your-service>/api/health     # {"ok":true}
curl https://<your-service>/v1/models      # full model list
```

In a coding tool, set the base URL to `https://<your-service>/v1` and the API
key to the one you created. Models appear as `flagshiprouter/<model>`.

`/v1/chat/completions` answers `405 Method Not Allowed` to a browser `GET`. It is
a POST-only endpoint; `ERR_HTTP_RESPONSE_CODE_FAILURE` in a browser is that 405,
not a dead server.

## 8. What stops working off your laptop

| Feature | Why |
| --- | --- |
| MITM proxy | Intercepts traffic from the machine running your IDE. A remote host cannot install a root CA on your laptop |
| CLI Tools screen | Writes config files into the container, not into your local tools. Copy the values out by hand |
| Tray icon, auto-open browser | No desktop session |
| Ollama / self-hosted providers | No local services to reach, unless you run them as extra services |
| Built-in tunnels | Redundant once the platform gives you a URL |

Everything else - provider connections, routing, combos, translations,
fallbacks, usage tracking, streaming - is server-side and behaves identically.

## 9. Troubleshooting

| Symptom | Cause |
| --- | --- |
| Providers and keys vanish after each deploy | No volume mounted at `DATA_DIR` |
| Health check fails | App bound to a port other than the injected `PORT`, or the first build is still running |
| `401` from `/v1` | `REQUIRE_API_KEY=true` and the request has no valid key |
| Dashboard login loops | `AUTH_COOKIE_SECURE=true` while you are on plain HTTP. Use the HTTPS URL |
| Build fails on `better-sqlite3` | The Dockerfile installs `python3 make g++` in the builder stage; make sure you are building the image rather than running `npm install` on the host |
| `EACCES` on `/app/data` | Volume mounted at a path other than `/app/data` while `DATA_DIR` still points there |
| Only one provider ever answers | Expected on the free-only policy: `brand.json` restricts routing to free providers |

## 10. Security

The database holds provider OAuth tokens and API keys. On a public URL, treat it
like a production service:

* a real `INITIAL_PASSWORD`, and `REQUIRE_API_KEY=true`
* IP allowlisting if your plan supports it
* a backup of `/app/data/db/data.sqlite`, which is the whole router state