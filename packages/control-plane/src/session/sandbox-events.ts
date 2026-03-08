import { generateId } from "../auth/crypto";
import type { Logger } from "../logger";
import type { GitPushSpec } from "../source-control";
import type { SandboxEvent, ServerMessage } from "../types";
import { shouldPersistToolCallEvent } from "./event-persistence";
import type { SessionRepository } from "./repository";
import type { CallbackNotificationService } from "./callback-notification-service";
import type { SessionWebSocketManager } from "./websocket-manager";

type PushResolver = { resolve: () => void; reject: (err: Error) => void };

interface SessionSandboxEventProcessorDeps {
  ctx: DurableObjectState;
  log: Logger;
  repository: SessionRepository;
  callbackService: CallbackNotificationService;
  wsManager: SessionWebSocketManager;
  broadcast: (message: ServerMessage) => void;
  getIsProcessing: () => boolean;
  triggerSnapshot: (reason: string) => Promise<void>;
  reconcileSessionStatusAfterExecution: (success: boolean) => Promise<void>;
  updateLastActivity: (timestamp: number) => void;
  scheduleInactivityCheck: () => Promise<void>;
  processMessageQueue: () => Promise<void>;
  r2?: R2Bucket;
}

/** Event types that require delivery acknowledgement. */
const CRITICAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "execution_complete",
  "error",
  "snapshot_ready",
  "push_complete",
  "push_error",
]);

export class SessionSandboxEventProcessor {
  private pendingPushResolvers = new Map<string, PushResolver>();

  constructor(private readonly deps: SessionSandboxEventProcessorDeps) {}

  async processSandboxEvent(event: SandboxEvent): Promise<void> {
    if (event.type === "heartbeat" || event.type === "token") {
      this.deps.log.debug("Sandbox event", { event_type: event.type });
    } else if (event.type !== "execution_complete") {
      this.deps.log.info("Sandbox event", { event_type: event.type });
    }
    const now = Date.now();

    // Extract ackId from the raw event (attached by bridge for critical events)
    const ackId = (event as Record<string, unknown>).ackId as string | undefined;

    if (event.type === "heartbeat") {
      this.deps.repository.updateSandboxHeartbeat(now);
      return;
    }

    const eventMessageId = "messageId" in event ? event.messageId : null;
    const processingMessage = this.deps.repository.getProcessingMessage();
    const messageId = eventMessageId ?? processingMessage?.id ?? null;

    if (event.type === "token") {
      if (messageId) {
        this.deps.repository.upsertTokenEvent(messageId, event, now);
      }
      this.deps.broadcast({ type: "sandbox_event", event });
      return;
    }

    if (event.type === "step_start" || event.type === "step_finish") {
      this.deps.updateLastActivity(now);
      this.deps.broadcast({ type: "sandbox_event", event });
      return;
    }

    if (event.type === "tool_call") {
      this.deps.updateLastActivity(now);

      // Strip attachments before persisting/broadcasting (they're large base64 blobs)
      const attachments = event.attachments;
      const eventForStorage = attachments ? { ...event, attachments: undefined } : event;

      if (shouldPersistToolCallEvent(event.status)) {
        this.deps.repository.createEvent({
          id: generateId(),
          type: event.type,
          data: JSON.stringify(eventForStorage),
          messageId,
          createdAt: now,
        });
      }

      // Broadcast the tool_call without attachments (they'd bloat client WS messages)
      this.deps.broadcast({ type: "sandbox_event", event: eventForStorage as SandboxEvent });

      if (messageId && event.status === "running") {
        this.deps.ctx.waitUntil(
          this.deps.callbackService.notifyToolCall(messageId, event).catch((error) => {
            this.deps.log.error("callback.tool_call.background_error", {
              message_id: messageId,
              error,
            });
          })
        );
      }

      // Upload image attachments to R2 and create screenshot artifacts
      if (attachments?.length && this.deps.r2) {
        this.deps.ctx.waitUntil(
          this.uploadScreenshotAttachments(attachments, event.tool, messageId, now)
        );
      }

      return;
    }

    if (event.type === "tool_result") {
      this.deps.repository.createEvent({
        id: generateId(),
        type: event.type,
        data: JSON.stringify(event),
        messageId,
        createdAt: now,
      });
      this.deps.broadcast({ type: "sandbox_event", event });
      return;
    }

    if (event.type === "execution_complete") {
      if (messageId) {
        this.deps.repository.upsertExecutionCompleteEvent(messageId, event, now);
      }

      const completionMessageId = messageId;
      const isStillProcessing =
        completionMessageId != null && processingMessage?.id === completionMessageId;

      if (isStillProcessing) {
        const status = event.success ? "completed" : "failed";
        this.deps.repository.updateMessageCompletion(completionMessageId, status, now);

        const timestamps = this.deps.repository.getMessageTimestamps(completionMessageId);
        const totalDurationMs = timestamps ? now - timestamps.created_at : undefined;
        const processingDurationMs =
          timestamps?.started_at != null ? now - timestamps.started_at : undefined;
        const queueDurationMs =
          timestamps?.started_at != null
            ? timestamps.started_at - timestamps.created_at
            : undefined;

        this.deps.log.info("prompt.complete", {
          event: "prompt.complete",
          message_id: completionMessageId,
          outcome: event.success ? "success" : "failure",
          message_status: status,
          total_duration_ms: totalDurationMs,
          processing_duration_ms: processingDurationMs,
          queue_duration_ms: queueDurationMs,
        });

        this.deps.broadcast({ type: "sandbox_event", event });
        this.deps.broadcast({
          type: "processing_status",
          isProcessing: this.deps.getIsProcessing(),
        });
        this.deps.ctx.waitUntil(
          this.deps.callbackService.notifyComplete(completionMessageId, event.success)
        );

        await this.deps.reconcileSessionStatusAfterExecution(event.success);
      } else {
        this.deps.log.info("prompt.complete", {
          event: "prompt.complete",
          message_id: completionMessageId,
          outcome: "already_stopped",
        });
      }

      this.deps.ctx.waitUntil(this.deps.triggerSnapshot("execution_complete"));
      this.deps.updateLastActivity(now);
      await this.deps.scheduleInactivityCheck();
      await this.deps.processMessageQueue();
      this.sendAck(ackId);
      return;
    }

    this.deps.repository.createEvent({
      id: generateId(),
      type: event.type,
      data: JSON.stringify(event),
      messageId,
      createdAt: now,
    });

    if (event.type === "git_sync") {
      this.deps.repository.updateSandboxGitSyncStatus(event.status);

      if (event.sha) {
        this.deps.repository.updateSessionCurrentSha(event.sha);
      }
    }

    if (event.type === "push_complete" || event.type === "push_error") {
      this.handlePushEvent(event);
    }

    this.deps.broadcast({ type: "sandbox_event", event });

    if (CRITICAL_EVENT_TYPES.has(event.type)) {
      this.sendAck(ackId);
    }
  }

  private async uploadScreenshotAttachments(
    attachments: NonNullable<(SandboxEvent & { type: "tool_call" })["attachments"]>,
    tool: string,
    messageId: string | null,
    timestamp: number
  ): Promise<void> {
    const r2 = this.deps.r2;
    if (!r2) return;

    for (const att of attachments) {
      try {
        const match = att.dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
        if (!match) {
          this.deps.log.warn("screenshot.upload.invalid_data_url", { filename: att.filename });
          continue;
        }

        const binaryString = atob(match[2]);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        const r2Key = `screenshots/${crypto.randomUUID()}-${att.filename}`;
        await r2.put(r2Key, bytes, {
          httpMetadata: { contentType: att.mime },
        });

        const artifactId = generateId();
        this.deps.repository.createArtifact({
          id: artifactId,
          type: "screenshot",
          url: null,
          metadata: JSON.stringify({
            tool,
            filename: att.filename,
            mimeType: att.mime,
            r2Key,
            sizeBytes: bytes.length,
          }),
          createdAt: timestamp,
        });

        this.deps.broadcast({
          type: "screenshot_created",
          screenshotUrl: `/api/screenshots/${r2Key}`,
          filename: att.filename,
          tool,
          messageId,
          artifactId,
          timestamp,
        });

        this.deps.log.info("screenshot.uploaded", {
          artifact_id: artifactId,
          r2_key: r2Key,
          size_bytes: bytes.length,
          tool,
        });
      } catch (error) {
        this.deps.log.error("screenshot.upload.failed", {
          filename: att.filename,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async pushBranchToRemote(
    branchName: string,
    pushSpec: GitPushSpec
  ): Promise<{ success: true } | { success: false; error: string }> {
    const sandboxWs = this.deps.wsManager.getSandboxSocket();

    if (!sandboxWs) {
      this.deps.log.info("No sandbox connected, assuming branch was pushed manually");
      return { success: true };
    }

    const normalizedBranch = this.normalizeBranchName(branchName);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const pushPromise = new Promise<void>((resolve, reject) => {
      this.pendingPushResolvers.set(normalizedBranch, { resolve, reject });

      timeoutId = setTimeout(() => {
        if (this.pendingPushResolvers.has(normalizedBranch)) {
          this.pendingPushResolvers.delete(normalizedBranch);
          reject(new Error("Push operation timed out after 180 seconds"));
        }
      }, 180000);
    });

    this.deps.log.info("Sending push command", { branch_name: branchName });
    this.deps.wsManager.send(sandboxWs, {
      type: "push",
      pushSpec,
    });

    try {
      await pushPromise;
      this.deps.log.info("Push completed successfully", { branch_name: branchName });
      return { success: true };
    } catch (pushError) {
      this.deps.log.error("Push failed", {
        branch_name: branchName,
        error: pushError instanceof Error ? pushError : String(pushError),
      });
      return { success: false, error: `Failed to push branch: ${pushError}` };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private handlePushEvent(event: SandboxEvent): void {
    const branchName = (event as { branchName?: string }).branchName;

    if (!branchName) {
      return;
    }

    const normalizedBranch = this.normalizeBranchName(branchName);
    const resolver = this.pendingPushResolvers.get(normalizedBranch);

    if (!resolver) {
      return;
    }

    if (event.type === "push_complete") {
      this.deps.log.info("Push completed, resolving promise", {
        branch_name: branchName,
        pending_resolvers: Array.from(this.pendingPushResolvers.keys()),
      });
      resolver.resolve();
    } else if (event.type === "push_error") {
      const error = (event as { error?: string }).error || "Push failed";
      this.deps.log.warn("Push failed for branch", { branch_name: branchName, error });
      resolver.reject(new Error(error));
    }

    this.pendingPushResolvers.delete(normalizedBranch);
  }

  private sendAck(ackId: string | undefined): void {
    if (!ackId) return;
    const sandboxWs = this.deps.wsManager.getSandboxSocket();
    if (sandboxWs) {
      this.deps.wsManager.send(sandboxWs, { type: "ack", ackId });
    } else {
      this.deps.log.debug("Cannot send ACK: no sandbox socket", { ack_id: ackId });
    }
  }

  private normalizeBranchName(name: string): string {
    return name.trim().toLowerCase();
  }
}
