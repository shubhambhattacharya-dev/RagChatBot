# DEPLOY — Production Setup Guide (RAG ChatBot)

Deploy the full stack (backend + frontend, one origin) to Render free tier,
with Supabase (Postgres + pgvector + S3-compatible storage) as the data layer,
Redis (in-container) for the upload→index queue, and UptimeRobot as the keep-alive pinger.

**Total time:** ~30 minutes. **Cost:** ₹0. **Card:** none required.

---

## Architecture (what you're building)

```
┌──────────────────────────────────────────────────────────────┐
│ Render (free tier)                                           │
│  ┌──────────────────────────────────┐                        │
│  │ Web Service                      │                        │
│  │ backend + frontend + Redis       │   Dockerfile image     │
│  │ (one origin → zero CORS)         │   (Redis in-container) │
│  └──────┬───────────┬───────────────┘                        │
└─────────┼───────────┼────────────────────────────────────────┘
          │           │
          │ DATABASE_URL (Postgres)    │ S3 API (HTTPS 443)
          ▼                             ▼
 ┌──────────────────────┐    ┌──────────────────────┐
 │ Supabase Postgres    │    │ Supabase Storage     │
 │ + pgvector           │    │ (S3-compatible)      │
 │ (never expires)      │    │ bucket: rag-files    │
 └──────────────────────┘    └──────────────────────┘

 UptimeRobot (free)  ← HTTP pings /health every 5 min
                        keeps Render awake + monitors status
```

> **Why Supabase?** Free, no card, nothing expires. Postgres + pgvector + S3
> in one account. Render Postgres expires after 30 days.
>
> **Why in-container Redis?** Free, no card, and no metered quota to exhaust.
> BullMQ (the document-indexing queue) requires Redis — without it, uploads
> hang forever. External serverless Redis (Upstash free tier) burns its
> 500k requests/month quota in days because BullMQ polls continuously. The
> container's own Redis costs nothing. It's memory-only, so on restart the
> app automatically re-queues any QUEUED/PROCESSING documents.

---

## STEP 1 — Supabase project (10 min)

1. Go to https://supabase.com → **Start your project** → **Sign in with GitHub**
   (no card anywhere in this flow)
2. **New project**:
   - Project name: `ragchatbot`
   - Database password: create one, save it in a notepad
   - Region: **Mumbai (ap-south-1)** — closest to you
   - Plan: Free → **Create new project** (~2 min to provision)
3. **Collect the S3 endpoint** → Project Settings → **API** → copy **Project URL**
   - Your S3 endpoint = `https://<projectref>.supabase.co/storage/v1/s3`
4. **Create S3 access keys** → **Storage** → **Configuration** → **S3** →
   **Create new key** → copy **Access Key ID** + **Secret Access Key**
   (⚠️ secret shows once — save both now)
5. **Create the bucket** → **Storage** → **New bucket**:
   - Name: **`rag-files`** (exactly — matches `MINIO_BUCKET` in the app)
   - Visibility: **Private** (app accesses it server-side with keys)
6. **Copy the DB connection string** → Project Settings → **Database** →
   **Connection string** → **URI** — copy the whole `postgresql://...` string

> ✅ Step 1 done when: you have 4 values in a notepad — S3 endpoint URL,
> access key, secret key, and the `postgresql://...` DB string.

---

## STEP 2 — Redis: nothing to set up 🎉

The Dockerfile installs Redis **inside** the container and starts it before the
app boots. `REDIS_URL` is already `redis://localhost:6379` in `render.yaml` —
**do not** add an external Redis (Upstash) override in the Render dashboard:
BullMQ's worker polling exhausts Upstash's free 500k requests/month quota in
days, which breaks uploads with `ERR max requests limit exceeded`.

> ✅ Step 2 done when: nothing to do — skip straight to Step 3.

---

## STEP 3 — Deploy on Render (10 min)

1. Go to https://render.com → **Sign up** (GitHub login is fastest)
2. Dashboard → **New** → **Blueprint** (NOT "Web Service")
3. **Connect a repository** → choose **`shubhambhattacharya-dev/RagChatBot`**
   (if you don't see it: Configure GitHub app → grant access to the repo)
4. Render reads `render.yaml` → shows **1 × Web Service** (`ragchatbot`, Docker)
5. Click **Apply** — Render starts building the Docker image (first build ~5-10 min)
6. While it builds → go to the **Environment** tab of the service

### Paste these env vars (in the Environment tab)

| Key | Value |
|:----|:------|
| `DATABASE_URL` | your Supabase `postgresql://...` URI |
| `REDIS_URL` | **leave as `redis://localhost:6379`** — Redis runs in-container (started by the Dockerfile). Remove any external/Upstash override |
| `MINIO_ENDPOINT` | `https://<projectref>.supabase.co/storage/v1/s3` |
| `MINIO_ACCESS_KEY` | (Supabase S3 Access Key ID) |
| `MINIO_SECRET_KEY` | (Supabase S3 Secret Access Key) |
| `MINIO_BUCKET` | `rag-files` (already in render.yaml — leave it) |
| `GROQ_API` | (your Groq key — same as local .env) |
| `GEMINI_API` | (your Gemini key) |
| `OPENROUTER_API` | (your OpenRouter key) |

> Every secret in `render.yaml` is `sync: false` — the repo only declares the
> key NAMES; the VALUES live in Render's dashboard. Never commit secrets.

7. **Save** → **Deploy** (or it may auto-deploy after first build)
8. Wait for the build to finish → service shows **Live**
9. Copy your URL: `https://<name>.onrender.com`

> ✅ Step 3 done when: `https://<name>.onrender.com/health` returns
> `{"status":"ok","checks":{"postgres":"ok","redis":"ok"},...}` in a browser.

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

1. **Health:** page loads, sidebar shows "Connected" (green dot)
2. **Upload:** drag a PDF into the upload box → status QUEUED → READY (~10-30 s)
3. **Chat:** ask "What is this document about?" → answer streams
4. **Scoped:** click the doc → ask again → answers stay grounded in it
5. **Delete:** remove the doc → disappears from list (and from Supabase Storage)

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|:--------|:-------------|:----|
| Service shows **Crashed** | Missing env var | Open Logs → look for `Invalid env:` → add the missing key |
| `P1001: Can't reach database` | Supabase URI wrong / not saved | Check `DATABASE_URL` uses the full `postgresql://...` URI |
| **Backend offline** (red dot) | `REDIS_URL` override points at an external Redis | Remove the `REDIS_URL` override in Render → Environment; it must be `redis://localhost:6379` (in-container) |
| Health returns `503` / `redis: error` | `ERR max requests limit exceeded` from a metered Redis (Upstash) | Remove the Upstash override and redeploy — the container's Redis is unlimited and free |
| Upload → **FAILED** | S3 endpoint wrong | Check `MINIO_ENDPOINT` includes `https://.../storage/v1/s3`; keys are the S3 keys (not the project anon key) |
| Log spam: `ERR max requests limit exceeded` (Upstash) | External Redis override left in the dashboard | Delete the `REDIS_URL` override in Render → Environment → it must be `redis://localhost:6379` (in-container Redis) |
| Chat → `Failed to process` | Both providers down | Check `GROQ_API` / `OPENROUTER_API` values |
| App loads but API dead | Cold start | Wait ~1 min after first visit; UptimeRobot should prevent this |
| `vector(768)` error at boot | pgvector not enabled | Check logs show `pgvector extension ready` (init-db.ts runs first) |

---

## Cost & lifetime

- **Everything:** ₹0 / month
- **Supabase:** free projects pause after 1 week of inactivity
  (wake on the next request — log in occasionally; UptimeRobot keeps it alive).
- **Redis:** runs inside the container — no external service, no quota to
  watch. Memory-only: a restart re-queues any in-flight documents (the app
  re-queues QUEUED/PROCESSING docs automatically at boot).
- **Render free web service:** 750 hours/month. UptimeRobot keeps it awake
  24/7 → ~744 h/month. You're at the limit — don't add a second always-on
  Render service on the same account.

---

## Interview talking points (use these!)

1. **Same-origin architecture** — backend serves the frontend → zero CORS class of bugs
2. **Provider failover** — Groq → OpenRouter fallback, chat survives rate limits
3. **One S3-standard client, three backends** — AWS SDK speaks to local MinIO, Supabase, and R2; swapping storage is a config change, not a code change
4. **Multi-store consistency** — delete removes pgvector chunks + S3 object (no orphans)
5. **Boot-time DB init** — `CREATE EXTENSION vector` before schema push (managed PG ≠ Docker image)
6. **Durable document queue** — BullMQ on in-container Redis (free, unlimited): exponential backoff, 3 retries, plus boot-time re-queue of stranded QUEUED/PROCESSING docs so cold starts never lose an upload
7. **Health endpoint with per-dependency timeouts** — each probe (Postgres, Redis) races a 3 s deadline; a dead dependency reports fast instead of hanging the probe (used by both the UI status dot and Render's own health checks)
8. **Uptime monitoring** — free-tier keep-alive via UptimeRobot, alerting included
9. **Secret hygiene** — `.env` gitignored, secrets injected via platform env vars, `render.yaml` marks them `sync: false`
