// @effect-diagnostics nodeBuiltinImport:off globalDate:off cryptoRandomUUID:off - this deliberately plain, non-blocking adapter persists best-effort local test metadata outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { TaskRouteSuggestion } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const FILE_NAME = "jev-routing-test-records.jsonl";
const MAX_RECORDS = 1_000;
const MAX_BYTES = 1_024 * 1_024;
const PENDING_TTL_MS = 10 * 60 * 1_000;
const MAX_PENDING = 1_000;
const MAX_PENDING_WRITES = 10_000;
const LANES = new Set(["luna", "terra", "sol", "astra"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

type RouteResult = TaskRouteSuggestion & {
  readonly correlationId?: string | undefined;
};

export type JevRoutingTestRecord =
  | {
      readonly schemaVersion: 1;
      readonly event: "request";
      readonly recordedAt: string;
      readonly correlationId: string;
      readonly mode: "apply" | "shadow";
      readonly before?: { readonly lane?: string; readonly effort?: string };
    }
  | {
      readonly schemaVersion: 1;
      readonly event: "suggestion" | "skipped" | "failed";
      readonly recordedAt: string;
      readonly correlationId: string;
      readonly mode: "apply" | "shadow";
      readonly status: RouteResult["status"];
      readonly latencyMs: number;
      readonly apiRequested: boolean;
      readonly reason?: string;
      readonly confidence?: number;
      readonly inputTokens?: number | null;
      readonly assessment?: string;
      readonly assessmentConfidence?: number;
      readonly effortConfidence?: number;
      readonly escalationProbability?: number;
      readonly after?: { readonly lane?: string; readonly effort?: string };
    }
  | {
      readonly schemaVersion: 1;
      readonly event: "submitted";
      readonly recordedAt: string;
      readonly correlationId?: string;
      readonly routingObserved: boolean;
      readonly threadId: string;
      readonly messageId: string;
      readonly commandId: string;
      readonly after?: { readonly model?: string; readonly effort?: string };
    };

export interface JevRoutingTestRecordsDependencies {
  readonly stateDir: string;
  readonly now?: () => Date;
  readonly randomId?: () => string;
  readonly appendFile?: (path: string, data: string) => Promise<void>;
  readonly readFile?: (path: string) => Promise<string>;
  readonly writeFile?: (path: string, data: string) => Promise<void>;
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly mkdir?: (path: string) => Promise<void>;
  readonly chmod?: (path: string, mode: number) => Promise<void>;
}

export interface JevRoutingTestRecords {
  readonly begin: (input: {
    readonly sessionId: string;
    readonly mode: "apply" | "shadow";
    readonly before?: { readonly lane?: string; readonly effort?: string };
  }) => string;
  readonly finish: (input: {
    readonly correlationId: string;
    readonly mode: "apply" | "shadow";
    readonly result: RouteResult;
    readonly latencyMs: number;
    readonly apiRequested: boolean;
  }) => void;
  readonly submitted: (input: {
    readonly sessionId: string;
    readonly correlationId?: string;
    readonly threadId: string;
    readonly messageId: string;
    readonly commandId: string;
    readonly model?: string;
    readonly effort?: string;
  }) => Effect.Effect<void>;
  /** Flush queued writes at server teardown and in tests. */
  readonly drain: () => Promise<void>;
}

export function trimJevRoutingTestRecords(contents: string): string {
  const lines = contents.split("\n").filter(Boolean);
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines.slice(-MAX_RECORDS).toReversed()) {
    const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
    // An oversized line cannot be made private or valid by truncating JSON;
    // omit it and retain any newer complete records that do fit.
    if (lineBytes > MAX_BYTES || bytes + lineBytes > MAX_BYTES) continue;
    kept.push(line);
    bytes += lineBytes;
  }
  return kept.reverse().join("\n") + (kept.length > 0 ? "\n" : "");
}

function safeIdentifier(value: string | undefined, maxLength = 128): string | undefined {
  return value && value.length <= maxLength && /^[A-Za-z0-9._:-]+$/.test(value) ? value : undefined;
}

function safeBefore(before: { readonly lane?: string; readonly effort?: string } | undefined) {
  if (!before) return undefined;
  const lane = before.lane && LANES.has(before.lane) ? before.lane : undefined;
  const effort = before.effort && EFFORTS.has(before.effort) ? before.effort : undefined;
  return lane || effort ? { ...(lane ? { lane } : {}), ...(effort ? { effort } : {}) } : undefined;
}

/**
 * Metadata-only, local test records. The file deliberately never receives
 * task text, context, attachments, tool data, credentials, or client clocks.
 */
export function makeJevRoutingTestRecords(
  dependencies: JevRoutingTestRecordsDependencies,
): JevRoutingTestRecords {
  const now = dependencies.now ?? (() => new Date());
  const randomId = dependencies.randomId ?? (() => crypto.randomUUID());
  const filePath = NodePath.join(dependencies.stateDir, FILE_NAME);
  const appendFile =
    dependencies.appendFile ?? ((path, data) => NodeFSP.appendFile(path, data, { mode: 0o600 }));
  const readFile = dependencies.readFile ?? ((path) => NodeFSP.readFile(path, "utf8"));
  const writeFile =
    dependencies.writeFile ?? ((path, data) => NodeFSP.writeFile(path, data, { mode: 0o600 }));
  const rename = dependencies.rename ?? ((from, to) => NodeFSP.rename(from, to));
  const mkdir =
    dependencies.mkdir ??
    ((path) => NodeFSP.mkdir(path, { recursive: true, mode: 0o700 }).then(() => undefined));
  const chmod = dependencies.chmod ?? ((path, mode) => NodeFSP.chmod(path, mode));
  const pendingSessions = new Map<
    string,
    { readonly sessionId: string; readonly expiresAt: number }
  >();
  const submittedCommandIds = new Map<string, number>();
  let pendingWrite = Promise.resolve();
  let pendingWriteCount = 0;

  const enqueue = (record: JevRoutingTestRecord) => {
    // A stalled filesystem must not retain unbounded turn metadata in memory
    // or delay dispatch. Dropping excess test records is preferable to either.
    if (pendingWriteCount >= MAX_PENDING_WRITES) return;
    pendingWriteCount += 1;
    const line = `${JSON.stringify(record)}\n`;
    pendingWrite = pendingWrite.then(async () => {
      try {
        await mkdir(dependencies.stateDir);
        // `mode` applies only at creation. Tighten an existing recorder file
        // before appending; unsupported Windows permissions remain non-fatal.
        await chmod(filePath, 0o600).catch(() => undefined);
        await appendFile(filePath, line);
        await chmod(filePath, 0o600).catch(() => undefined);
        const contents = await readFile(filePath);
        if (
          Buffer.byteLength(contents, "utf8") <= MAX_BYTES &&
          contents.split("\n").length <= MAX_RECORDS
        ) {
          return;
        }
        const temporaryPath = `${filePath}.next`;
        await chmod(temporaryPath, 0o600).catch(() => undefined);
        await writeFile(temporaryPath, trimJevRoutingTestRecords(contents));
        await chmod(temporaryPath, 0o600).catch(() => undefined);
        await rename(temporaryPath, filePath);
        await chmod(filePath, 0o600).catch(() => undefined);
      } catch {
        // Metadata collection is strictly best effort.
      } finally {
        pendingWriteCount -= 1;
      }
    });
  };
  const at = () => now().toISOString();

  return {
    begin({ sessionId, mode, before }) {
      const correlationId = randomId();
      const nowMs = now().getTime();
      for (const [id, pending] of pendingSessions) {
        if (pending.expiresAt <= nowMs) pendingSessions.delete(id);
      }
      if (pendingSessions.size >= MAX_PENDING) {
        const oldest = pendingSessions.keys().next().value;
        if (oldest) pendingSessions.delete(oldest);
      }
      pendingSessions.set(correlationId, {
        sessionId,
        expiresAt: nowMs + PENDING_TTL_MS,
      });
      const safe = safeBefore(before);
      enqueue({
        schemaVersion: 1,
        event: "request",
        recordedAt: at(),
        correlationId,
        mode,
        ...(safe ? { before: safe } : {}),
      });
      return correlationId;
    },
    finish({ correlationId, mode, result, latencyMs, apiRequested }) {
      const base = {
        schemaVersion: 1 as const,
        recordedAt: at(),
        correlationId,
        mode,
        status: result.status,
        latencyMs: Math.max(0, Math.floor(latencyMs)),
        apiRequested,
      };
      if (result.status === "ready") {
        enqueue({
          ...base,
          event: "suggestion",
          reason: result.reason,
          confidence: result.confidence,
          inputTokens: result.inputTokens,
          ...(result.assessment ? { assessment: result.assessment } : {}),
          ...(result.assessmentConfidence !== undefined
            ? { assessmentConfidence: result.assessmentConfidence }
            : {}),
          ...(result.effortConfidence !== undefined
            ? { effortConfidence: result.effortConfidence }
            : {}),
          ...(result.escalationProbability !== undefined
            ? { escalationProbability: result.escalationProbability }
            : {}),
          after: {
            lane: result.lane,
            ...(result.effort ? { effort: result.effort } : {}),
          },
        });
      } else {
        enqueue({
          ...base,
          event: result.status === "unavailable" ? "failed" : "skipped",
          ...(result.status === "blocked" ? { reason: result.reason } : {}),
        });
      }
    },
    submitted(input) {
      return Effect.sync(() => {
        const pending = input.correlationId ? pendingSessions.get(input.correlationId) : undefined;
        const routingObserved =
          pending !== undefined &&
          pending.sessionId === input.sessionId &&
          pending.expiresAt > now().getTime();
        if (routingObserved && input.correlationId !== undefined)
          pendingSessions.delete(input.correlationId);
        const threadId = safeIdentifier(input.threadId);
        const messageId = safeIdentifier(input.messageId);
        const commandId = safeIdentifier(input.commandId);
        if (!threadId || !messageId || !commandId) return;
        const nowMs = now().getTime();
        for (const [id, expiresAt] of submittedCommandIds) {
          if (expiresAt <= nowMs) submittedCommandIds.delete(id);
        }
        if (submittedCommandIds.has(commandId)) return;
        if (submittedCommandIds.size >= MAX_PENDING) {
          const oldest = submittedCommandIds.keys().next().value;
          if (oldest) submittedCommandIds.delete(oldest);
        }
        submittedCommandIds.set(commandId, nowMs + PENDING_TTL_MS);
        const model = safeIdentifier(input.model);
        const effort = input.effort && EFFORTS.has(input.effort) ? input.effort : undefined;
        enqueue({
          schemaVersion: 1,
          event: "submitted",
          recordedAt: at(),
          ...(routingObserved && input.correlationId ? { correlationId: input.correlationId } : {}),
          routingObserved,
          threadId,
          messageId,
          commandId,
          ...(model || effort
            ? {
                after: {
                  ...(model ? { model } : {}),
                  ...(effort ? { effort } : {}),
                },
              }
            : {}),
        });
      });
    },
    drain: () => pendingWrite,
  };
}

export const jevRoutingTestRecordPath = (stateDir: string) => NodePath.join(stateDir, FILE_NAME);
