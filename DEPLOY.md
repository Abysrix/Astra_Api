# Deploying FlagshipRouter to Render or Railway

The router was built to run as a long-lived process that owns a writable data
directory. Render and Railway give you exactly that, so the shipped `Dockerfile`
works unchanged. Vercel does not: it has no persistent filesystem, it freezes
functions between requests, and it caps request bodies far below the 128 MB the
proxy is configured for.

Config in this repo:

| File | Purpose |
| --- | --- |
| `Dockerfile` | The image both platforms build |
| `render.yaml` | Render Blueprint (service + disk + env) |
| `railway.json` | Railway build/deploy settings |
| `docker-compose.yml` | Local container run, for testing before you deploy |

## 0. Push the code somewhere

Both platforms deploy from a git remote. This folder is a zip extract, not a
clone, so:

```bash
git init
git add -A
git commit -m "FlagshipRouter deployment"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

## 1. What has to change relative to local hosting

Nothing in the application code. Three things in the environment:

1. **`DATA_DIR` must point at a mounted volume.** The SQLite database, backups
   and request history all live there. Without a volume, every redeploy starts
   from an empty router.
2. **The port comes from the platform.** The standalone server reads `PORT` and
   `HOSTNAME` from the environment, so Render's and Railway's injected values
   just work. The `EXPOSE 20128` in the Dockerfile is informational.
3. **The public URL has to be configured.** Set `BASE_URL` and
   `NEXT_PUBLIC_BASE_URL` to the `https://...` address the platform gives you.
   Cloud sync and internal self-calls use them.

## 2. Render

### Blueprint route (recommended)

1. Push the repo.
2. Render dashboard -> **New** -> **Blueprint** -> pick the repository.
3. Render reads `render.yaml` and creates the service with its disk and env vars.
4. Fill in the three `sync: false` values when prompted:
   `INITIAL_PASSWORD`, `BASE_URL`, `NEXT_PUBLIC_BASE_URL`.

### Manual route

1. **New** -> **Web Service** -> connect the repo.
2. Language: **Docker**. Dockerfile path: `./Dockerfile`.
3. **Add disk**: mount path `/app/data`, 1 GB is plenty.
4. Health check path: `/api/health`.
5. Add the environment variables from the table below.

Notes:

* A disk requires a paid instance type and pins you to one instance. Do not turn
  on autoscaling.
* The container's entrypoint chowns `/app/data`, so a root-owned disk is fine.

## 3. Railway

1. **New Project** -> **Deploy from GitHub repo**. Railway detects the
   Dockerfile; `railway.json` supplies the health check and restart policy.
2. **Add a volume** and mount it at `/app/data`. Volumes cannot be declared in
   `railway.json`, so this is a dashboard (or CLI) step:

   ```bash
   railway volume add --mount-path /app/data
   ```

3. Add the environment variables from the table below.
4. Railway injects `PORT` and routes to it automatically.

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
| `BASE_URL` | `https://<your-service>` | Cloud sync, internal self-calls |
| `NEXT_PUBLIC_BASE_URL` | same as `BASE_URL` | Public base for the client |
| `ENABLE_REQUEST_LOGS` | `false` | Logs full headers and bodies when on |

Generate secrets with `openssl rand -hex 32` or any password manager.

Do not rotate `API_KEY_SECRET` or `MACHINE_ID_SALT` after keys exist, or every
issued key stops working. Changing `INITIAL_PASSWORD` after the first boot does
not change the stored password; use **Settings** in the dashboard instead.

## 5. First run

1. Open `https://<your-service>/` and log in with `INITIAL_PASSWORD`.
2. Go to **Settings** and change the password.
3. Open **Endpoint & Key**, create an API key, and copy it.
4. Open **Models**. OpenCode Free models work with no signup; anything else
   needs a provider connection.

## 6. Calling the deployed API

The surface is the same OpenAI-compatible one, just with a public host:

```bash
curl https://<your-service>/v1/chat/completions \
  -H "Authorization: Bearer $FR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-6-astra","messages":[{"role":"user","content":"Say OK"}]}'
```

Sanity checks that need no key:

```bash
curl https://<your-service>/api/health     # {"ok":true}
curl https://<your-service>/v1/models      # full model list
```

Pointing a coding tool at it: set the base URL to
`https://<your-service>/v1` and the API key to the one you created. Models
appear as `flagshiprouter/<model>`.

Note that `/v1/chat/completions` answers `405 Method Not Allowed` to a browser
`GET`. It is a POST-only endpoint; `ERR_HTTP_RESPONSE_CODE_FAILURE` in a browser
is that 405, not a dead server.

## 7. What stops working off your laptop

| Feature | Why |
| --- | --- |
| MITM proxy | Intercepts traffic from the machine running your IDE. A remote host cannot install a root CA on your laptop |
| CLI Tools screen | Writes config files into the container, not into your local tools. Copy the values out by hand |
| Tray icon, auto-open browser | No desktop session |
| Ollama / self-hosted providers | No local services to reach, unless you run them as extra services |
| Built-in tunnels | Redundant once the platform gives you a URL |

Everything else - provider connections, routing, combos, translations,
fallbacks, usage tracking, streaming - is server-side and behaves identically.

## 8. Troubleshooting

| Symptom | Cause |
| --- | --- |
| Providers and keys vanish after each deploy | No volume mounted at `DATA_DIR` |
| Health check fails | App bound to a port other than the injected `PORT`, or first build still running |
| `401` from `/v1` | `REQUIRE_API_KEY=true` and the request has no valid key |
| Dashboard login loops | `AUTH_COOKIE_SECURE=true` while you are on plain HTTP. Use the HTTPS URL |
| Build fails on `better-sqlite3` | The Dockerfile installs `python3 make g++` in the builder stage; make sure you are building the image, not running `npm install` on the host |
| Only one provider ever answers | Expected on free-only policy: `brand.json` restricts routing to free providers |

## 9. Security

The database holds provider OAuth tokens and API keys. On a public URL, treat it
like a production service:

* a real `INITIAL_PASSWORD`, and `REQUIRE_API_KEY=true`
* IP allowlisting if your plan supports it
* a backup of `/app/data/db/data.sqlite`, which is the whole router state