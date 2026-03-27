/**
 * Sentry webhook route — per-automation endpoint that verifies the Sentry
 * HMAC signature using the automation's stored (encrypted) client secret.
 */

import { verifySentrySignature, normalizeSentryEvent } from "@open-inspect/shared";
import { AutomationStore } from "../db/automation-store";
import { decryptSentrySecret } from "../auth/webhook-key";
import type { Route, RequestContext } from "../routes/shared";
import { parsePattern, json, error } from "../routes/shared";
import { createLogger } from "../logger";
import type { Env } from "../types";

const logger = createLogger("sentry-webhook");

/** Maximum Sentry webhook payload size (256KB — Sentry payloads with stack traces can be large). */
const MAX_PAYLOAD_SIZE = 256 * 1024;

async function handleSentryWebhook(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const automationId = match.groups?.id;
  if (!automationId) return error("Automation ID required", 400);

  logger.info("sentry webhook received", {
    automation_id: automationId,
    sentry_hook_resource: request.headers.get("sentry-hook-resource"),
    sentry_hook_timestamp: request.headers.get("sentry-hook-timestamp"),
    content_length: request.headers.get("content-length"),
    user_agent: request.headers.get("user-agent"),
  });

  // 1. Look up the automation
  const store = new AutomationStore(env.DB);
  const automation = await store.getById(automationId);
  if (!automation || automation.trigger_type !== "sentry") {
    logger.warn("automation not found or wrong trigger type", {
      automation_id: automationId,
      found: !!automation,
      trigger_type: automation?.trigger_type,
    });
    return error("Not found", 404);
  }

  logger.info("automation found", {
    automation_id: automationId,
    trigger_type: automation.trigger_type,
    event_type: automation.event_type,
    enabled: automation.enabled,
    has_trigger_auth_data: !!automation.trigger_auth_data,
    has_trigger_config: !!automation.trigger_config,
  });

  if (!automation.trigger_auth_data) {
    logger.error("sentry secret not configured", { automation_id: automationId });
    return error("Sentry secret not configured for this automation", 500);
  }

  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    logger.error("encryption key not configured", { automation_id: automationId });
    return error("Encryption key not configured", 503);
  }

  // 2. Check signature header before doing any expensive work (decrypt, body read)
  const signature = request.headers.get("sentry-hook-signature");
  if (!signature) {
    logger.warn("missing sentry-hook-signature header", { automation_id: automationId });
    return error("Invalid signature", 401);
  }

  // Fast-path: reject if Content-Length header exceeds limit
  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_PAYLOAD_SIZE) {
    return error("Payload too large", 413);
  }

  const body = await request.text();
  if (body.length > MAX_PAYLOAD_SIZE) {
    return error("Payload too large", 413);
  }

  // 3. Decrypt stored secret and verify signature
  const secret = await decryptSentrySecret(
    automation.trigger_auth_data,
    env.REPO_SECRETS_ENCRYPTION_KEY
  );

  const valid = await verifySentrySignature(body, signature, secret);
  if (!valid) {
    logger.warn("HMAC signature verification failed", {
      automation_id: automationId,
      signature,
      body_length: body.length,
    });
    return error("Invalid signature", 401);
  }

  logger.info("signature verified", { automation_id: automationId });

  // 3. Parse and normalize
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch (e) {
    logger.warn("invalid JSON body", { automation_id: automationId, error: String(e) });
    return error("Invalid JSON", 400);
  }

  logger.info("payload parsed", {
    automation_id: automationId,
    payload,
  });

  const event = normalizeSentryEvent(payload, automationId);
  if (!event) {
    logger.warn("normalization returned null — skipping", {
      automation_id: automationId,
      action: payload.action,
    });
    return json({ ok: true, skipped: true });
  }

  logger.info("event normalized", {
    automation_id: automationId,
    event_type: event.eventType,
    trigger_key: event.triggerKey,
    concurrency_key: event.concurrencyKey,
    sentry_project: event.sentryProject,
    sentry_level: event.sentryLevel,
    culprit_file: event.culpritFile,
    context_block: event.contextBlock,
  });

  // 4. Forward to SchedulerDO
  if (!env.SCHEDULER) {
    logger.error("scheduler not configured", { automation_id: automationId });
    return error("Scheduler not configured", 503);
  }

  const doId = env.SCHEDULER.idFromName("global-scheduler");
  const stub = env.SCHEDULER.get(doId);

  logger.info("forwarding event to scheduler", {
    automation_id: automationId,
    event_type: event.eventType,
  });

  const response = await stub.fetch("http://internal/internal/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });

  const result = await response.json<{ triggered: number; skipped: number }>();

  logger.info("scheduler response", {
    automation_id: automationId,
    scheduler_status: response.status,
    triggered: result.triggered,
    skipped: result.skipped,
  });

  return json({ ok: true, ...result }, response.status === 200 ? 200 : response.status);
}

export const sentryWebhookRoute: Route = {
  method: "POST",
  pattern: parsePattern("/webhooks/sentry/:id"),
  handler: handleSentryWebhook,
};
