# DEPLOY — Production Setup Guide (RAG ChatBot)

Deploy the full stack (backend + frontend, one origin) to Render free tier,
with Cloudflare R2 as object storage and UptimeRobot as the keep-alive pinger.

**Total time:** ~25 minutes. **Cost:** ₹0.

---

## Architecture (what you're building)

```
┌──────────────────────────────────────────────────────┐
│ Render (free tier)                                   │
│  ┌──────────────────┐    ┌────────────────────────┐  │
│  │ Web Service      │    │ Managed Postgres (PG16)│  │
│  │ Dockerfile image │───►│ + pgvector extension   │  │
│  │ backend+frontend │    │ (auto-created on boot) │  │
│  └────────┬─────────┘    └────────────────────────┘  │
│           │ S3 API (HTTPS 443)                       │
└───────────┼──────────────────────────────────────────┘
            ▼
   ┌──────────────────┐
   │ Cloudflare R2    │  ← original PDFs (bucket: rag-files)
   └──────────────────┘
        ▲
        │ HTTP ping every 5 min
   UptimeRobot (free)  ← keeps Render awake
```

---

## STEP 1 — Cloudflare R2 bucket (5 min)

1. Go to https://dash.cloudflare.com → sign up / log in
2. Left sidebar → **R2** → **Create bucket**
3. Name: **`rag-files`** (exactly — it matches `MINIO_BUCKET` in the app)
4. Region: any (e.g. APAC) → **Create bucket**
5. Left sidebar → **Manage R2 API Tokens** → **Create API token**
   - Permissions: **Object Read & Write**
   - TTL: 1 year (or custom)
   - Copy these three values into a notepad — you'll paste them into Render:
     - **Access Key ID**
     - **Secret Access Key**
     - **S3 endpoint** — looks like `https://<accountid>.r2.cloudflarestorage.com`
6. Note: `MINIO_ENDPOINT` = the endpoint **without** `https://`
   → just `<accountid>.r2.cloudflarestorage.com`

> ✅ Step 1 done when: you have 3 values (access key, secret key, endpoint host) in a notepad.

---

## STEP 2 — Deploy on Render (10 min)

1. Go to https://render.com → **Sign up** (GitHub login is fastest)
2. Dashboard → **New** → **Blueprint** (NOT "Web Service")
3. **Connect a repository** → choose **`shubhambhattacharya-dev/RagChatBot`**
   (if you don't see it: Configure GitHub app → grant access to the repo)
4. Render reads `render.yaml` and shows:
   - 1 × Web Service (`ragchatbot`, Docker)
   - 1 × PostgreSQL (`ragchatbot-db`)
5. Click **Apply** — Render now:
   - creates the Postgres DB
   - starts building the Docker image (first build ~5-10 min)
6. While it builds → go to **Environment** tab of the service

### Paste these env vars (in the Environment tab)

| Key | Value |
|:----|:------|
| `MINIO_ENDPOINT` | `<accountid>.r2.cloudflarestorage.com` (no https://) |
| `MINIO_ACCESS_KEY` | (R2 Access Key ID) |
| `MINIO_SECRET_KEY` | (R2 Secret Access Key) |
| `MINIO_USE_SSL` | `true` |
| `GROQ_API` | (your Groq key — same as local .env) |
| `GEMINI_API` | (your Gemini key) |
| `OPENROUTER_API` | (your OpenRouter key) |

> `DATABASE_URL` is auto-filled by the Blueprint — **do not** override it.
> `MINIO_PORT=443` is already set in `render.yaml`. Leave `MINIO_BUCKET=rag-files`.

7. **Save** → **Deploy** (or it may auto-deploy after first build)
8. Wait for the build to finish → service shows **Live**
9. Copy your URL: `https://<name>.onrender.com`

> ✅ Step 2 done when: `https://<name>.onrender.com/health` returns
> `{"status":"ok",...}` in a browser.

---

## STEP 3 — Keep it awake with UptimeRobot (3 min)

Render free tier sleeps after 15 min idle. UptimeRobot pings every 5 min → never sleeps.

1. Go to https://uptimerobot.com → **Sign up** (free, no card)
2. Dashboard → **Add New Monitor**
3. Monitor type: **HTTP(s)** → Friendly name: `RAG ChatBot`
4. URL: `https://<name>.onrender.com/health`
5. Monitoring interval: **5 minutes**
6. **Create Monitor**

> ✅ Step 3 done when: the monitor shows **Up (green)** after a few minutes.

---

## STEP 4 — End-to-end test (5 min)

Open `https://<name>.onrender.com` in a browser:

1. **Health:** page loads, sidebar shows "Connected"
2. **Upload:** drag a PDF into the upload box → status QUEUED → READY (~10-30 s)
3. **Chat:** ask "What is this document about?" → answer streams
4. **Scoped:** click the doc → ask again → answers stay grounded in it
5. **Delete:** remove the doc → disappears from list (and from R2)

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|:--------|:-------------|:----|
| Service shows **Crashed** | Missing env var | Open Logs → look for `Invalid env:` → add the missing key |
| `P1001: Can't reach database` | DB not ready yet | Wait 1-2 min, Redeploy |
| Upload → **FAILED** | R2 endpoint wrong | Check `MINIO_ENDPOINT` has no `https://`; keys have read+write |
| Chat → `Failed to process` | Both providers down | Check `GROQ_API` / `OPENROUTER_API` values |
| App loads but API dead | Cold start | Wait ~1 min after first visit; UptimeRobot should prevent this |
| `vector(768)` error at boot | pgvector not enabled | Check logs show `pgvector extension ready` (init-db.ts runs first) |

---

## Cost & lifetime

- **Everything:** ₹0 / month
- **Caveat 1:** Render free Postgres **expires after 30 days** — fine for the video; for a durable portfolio, migrate DB to Neon (free, never expires) before Dec interviews.
- **Caveat 2:** Render free web service = 750 hours/month. UptimeRobot keeps it awake 24/7 → that's ~744 h/month. You're at the limit — don't add a second always-on Render service on the same account.

---

## Interview talking points (use these!)

1. **Same-origin architecture** — backend serves the frontend → zero CORS class of bugs
2. **Provider failover** — Groq → OpenRouter fallback, chat survives rate limits
3. **Multi-store consistency** — delete removes pgvector chunks + R2 object (no orphans)
4. **Boot-time DB init** — `CREATE EXTENSION vector` before schema push (managed PG ≠ Docker image)
5. **Uptime monitoring** — free-tier keep-alive via UptimeRobot, alerting included
6. **Secret hygiene** — `.env` gitignored, secrets injected via platform env vars, `render.yaml` marks them `sync: false`
