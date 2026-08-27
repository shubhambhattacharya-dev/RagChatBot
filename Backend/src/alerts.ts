import { env } from "./config/env";
import logger from "./logger";

let lastAlertAt = 0;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

export async function notifyAlert(title: string, details: Record<string, unknown>): Promise<void> {
  if (!env.ALERT_WEBHOOK_URL || Date.now() - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = Date.now();
  try {
    const response = await fetch(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `${title}: ${JSON.stringify(details)}` }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) logger.warn({ status: response.status }, "Alert webhook rejected notification");
  } catch (error) {
    logger.warn({ err: error }, "Alert webhook failed");
  }
}
