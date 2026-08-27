# Backup and recovery runbook

Production must use managed PostgreSQL, object storage with versioning, and
managed Redis. Redis is a work queue, not the source of truth: documents and
chat history live in PostgreSQL and uploaded originals live in S3-compatible
storage.

## PostgreSQL

Run a daily encrypted logical backup from a trusted machine:

```bash
pg_dump --format=custom --no-owner --file=backups/rag-$(date -u +%Y%m%d).dump "$DATABASE_URL"
```

Retain at least 7 daily, 4 weekly, and 12 monthly backups. Test restoration
monthly into a separate database, then run Prisma migrations and the backend
health check. Never commit backup files or credentials.

## Object storage

Enable bucket versioning and a lifecycle policy with a recovery window. Keep
the database backup and object-storage backup from the same period. A database
row without its `fileKey` object cannot be re-indexed.

## Queue recovery

Configure `REDIS_URL` to a managed persistent Redis in production. The worker
keeps failed jobs for seven days, detects stalled jobs, and re-queues
`QUEUED`/`PROCESSING` documents at boot. After an outage, verify `/health`, the
document status list, and `/admin/dead-letters`; retry only after the backing
file exists.

## Monitoring and alerts

Set `METRICS_ENABLED=true` and scrape `/metrics` from an authenticated/private
monitor. Monitor `/health` for HTTP 503, latency, error rate, queue backlog,
dead-letter count, database storage, Redis memory, and provider quota failures.
Set `ALERT_WEBHOOK_URL` to a private Slack/Teams-compatible incoming webhook
for degraded-health notifications. Notifications are cooldown-limited to
avoid alert storms.
