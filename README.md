# Prediction Index

Tracks the Polymarket **"SpaceX IPO closing market cap above ___?"** prediction
market. It runs two ways:

- **Local** (`tracker.js` + pm2): fetches live prices, stores daily snapshots in
  SQLite, prints a coloured terminal digest, and fires a macOS notification on
  significant moves. This is the original tool and still works as a fallback.
- **Cloud** (GitHub Actions + Pages + Microsoft Graph): runs on a schedule with
  no laptop, publishes a public dashboard, and emails subscribers at market open
  and close. This is the production system.

Built to be imported into `~/jarvis/daemon.js` when Jarvis Phase 2 begins.

---

## Local quick start

```bash
npm install        # better-sqlite3 + chalk + dotenv
node tracker.js    # fetch, store snapshot, print digest, notify on big moves
```

Local daily cron via pm2 (fallback only — the cloud system is primary):

```bash
pm2 start ecosystem.config.cjs   # runs at 14:00 UTC (9:00 AM ET / EDT)
pm2 ls
pm2 logs polymarket-tracker
```

Once the GitHub Actions pipeline is verified, retire the local cron:

```bash
pm2 delete polymarket-tracker && pm2 save
```

---

## Cloud architecture

```
GitHub Actions (cron)                 GitHub Pages
  update.yml                            docs/index.html  ← dashboard
   ├─ scripts/snapshot.js     ──────▶   docs/api/v1/*    ← committed each run
   └─ scripts/send-emails.js
         ├─ email.js (Microsoft Graph)  ──▶ subscribers' inboxes
         └─ subscribers from private Gist

subscribe.yml  ◀── dashboard form (workflow_dispatch via public PAT)
   └─ scripts/add-subscriber.js ──▶ private Gist + welcome email
```

### GitHub Pages
- URL: **https://ilanbenamaro-cyber.github.io/polymarket-tracker/**
- Source: `main` branch, `/docs` folder (Settings → Pages).
- `docs/api/v1/` (latest.json, history*.json, history.csv, daily snapshot
  archive) is regenerated and committed by Actions on every cron tick; the page
  fetches it client-side. `docs/.nojekyll` disables Jekyll processing.

### GitHub Actions
`.github/workflows/update.yml` runs on three schedules (UTC; offsets assume EDT):

| Cron | ET time | Mode | Emails? |
|------|---------|------|---------|
| `0 14 * * *`    | 9:00 AM daily   | snapshot     | no  |
| `30 14 * * 1-5` | 9:30 AM weekdays| market-open  | yes |
| `0 21 * * 1-5`  | 4:00 PM weekdays| market-close | yes |

Each run: `npm ci` → `scripts/snapshot.js` (fetch + build + validate + write
`docs/api/v1/` + bake HTML fallback) → commit/push → on open/close,
`send-emails.js` (reads `docs/api/v1/`). You can also trigger it manually from
the Actions tab (`workflow_dispatch`) with a chosen mode.

Requires **Settings → Actions → General → Workflow permissions: Read and write**
so the bot can push the generated API files.

---

## Subscribe form & the public PAT

The dashboard's subscribe form calls the GitHub API to trigger `subscribe.yml`
(`workflow_dispatch`). That call uses a token hardcoded in `docs/index.html`:

```js
const SUBSCRIBE_PAT = 'github_pat_REPLACE_ME';   // ← paste your fine-grained PAT
```

This PAT is **intentionally public**. Create it as a **fine-grained** token
(github.com/settings/tokens) scoped to **this repository only**, permission
**Actions: Read and write** — nothing else. It can trigger the subscribe workflow
and do nothing else: it cannot read secrets, read code, or modify other resources.

**Rotating it:** revoke the old token at github.com/settings/tokens, create a new
one with the same scope, paste it into `docs/index.html`, and commit. Abuse only
ever costs you spurious subscribe-workflow runs.

---

## Subscriber management

Subscribers live in a **private Gist** as a single file `subscribers.json`:

```json
{ "subscribers": [ { "email": "a@b.com", "active": true, "added_at": "…" } ] }
```

- **Via the form / Actions:** the dashboard form, or `subscribe.yml`
  `workflow_dispatch` with an `email` input, runs `add-subscriber.js` to upsert
  the address and send a welcome email.
- **Directly:** edit the Gist's `subscribers.json` by hand. To unsubscribe, set a
  subscriber's `"active": false` (kept for history; `send-emails.js` only mails
  active addresses).

---

## Email (Microsoft Graph) — Azure setup

`email.js` uses the Microsoft Graph **client-credentials** flow against a
corporate Microsoft 365 tenant (app-only auth, headless). SMTP AUTH is disabled
by default on M365, so Graph is the reliable path. (Personal Outlook.com instead:
use `smtp-mail.outlook.com` + nodemailer.)

Azure portal checklist:
- App registration → API permissions → **Mail.Send** (Application) → **grant admin
  consent**.
- Certificates & secrets → new **client secret** → copy the value.

---

## Secrets (Settings → Secrets and variables → Actions)

| Secret | What it is |
|--------|-----------|
| `GRAPH_TENANT_ID`     | Azure AD tenant ID |
| `GRAPH_CLIENT_ID`     | App registration (client) ID |
| `GRAPH_CLIENT_SECRET` | Client secret value |
| `MAIL_FROM`           | Sending mailbox, e.g. `tracker@yourco.com` |
| `GIST_TOKEN`          | Classic PAT, **gist** scope only |
| `GIST_ID`             | The hash in the private Gist's URL |

See `.env.example` for the same variables when running the scripts locally
(create a `.env` file — it is gitignored).

---

## Local development

```bash
node tracker.js                                   # local SQLite pipeline (unchanged)
node scripts/snapshot.js                          # regenerate docs/api/v1 from live data
node scripts/send-emails.js market-open           # needs .env with Graph + Gist vars
node scripts/add-subscriber.js you@example.com           # needs .env
```

Preview the dashboard locally (it `fetch`es the API, so use a server, not
`file://`):

```bash
cd docs && python3 -m http.server 8000   # open http://localhost:8000
```

---

## APIs used (no auth required)

1. **Gamma** — `GET https://gamma-api.polymarket.com/events?slug=spacex-ipo-closing-market-cap-above`
   - `clobTokenIds` arrives as a JSON **string** — always `JSON.parse()` it.
   - `clobTokenIds[0]` is the **YES** token; `[1]` is NO.
2. **CLOB** — `POST https://clob.polymarket.com/midpoints`
   Body `[{"token_id":"…"}, …]`; returns `{ "<id>": "0.875", … }` (mid as a
   **string**, = P(YES) 0.0–1.0). It's a **POST**, not the GET shape older docs show.

## Implied median

The point where `P(market cap above X) = 50%`, by linear interpolation between
the two consecutive thresholds straddling 50%:

```
median = t[i] + (t[i+1] - t[i]) * (p[i] - 0.5) / (p[i] - p[i+1])
```

`null` if every probability is above 50% or every one is below. Computed once in
`digest.js` (`computeImpliedMedian`); the cloud pipeline computes it in `core/`.

## Local notifications

`tracker.js` fires a macOS notification when any threshold moved **>5% absolute**
or the implied median shifted **>$0.1T** vs the prior day. Non-macOS environments
log a warning and continue.

## Importing into Jarvis

```js
import { fetchSnapshot } from './api.js';
```

Returns `Array<{ label, threshold, prob, volume }>` ascending by threshold, or
`null` on failure.

## Notes

- Requires Node 18+ (native `fetch`; no `node-fetch`).
- The live market currently has 16 thresholds ($1T–$4T in $0.2T steps).
- GitHub cron is UTC and best-effort (can lag a few minutes); ET offsets assume EDT.
