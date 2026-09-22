// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - recorder tests exercise real temporary files, inspect JSONL fixtures, and control record expiry with wall-clock dates.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect } from "vite-plus/test";

import {
  jevRoutingTestRecordPath,
  makeJevRoutingTestRecords,
  trimJevRoutingTestRecords,
} from "./JevRoutingTestRecords.ts";

const temporaryDirectories: string[] = [];

function temporaryStateDir() {
  return Effect.promise(async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "jev-routing-records-"));
    temporaryDirectories.push(directory);
    return directory;
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("JevRoutingTestRecords", () => {
  it.effect(
    "persists only allowlisted metadata and links a recognized server-issued correlation",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* temporaryStateDir();
        const records = makeJevRoutingTestRecords({
          stateDir,
          randomId: () => "server-correlation",
        });
        const correlationId = records.begin({
          sessionId: "server-session",
          mode: "apply",
          before: {
            lane: "terra",
            effort: "high",
            extra: "super-secret prompt",
          } as never,
        });
        records.finish({
          correlationId,
          mode: "apply",
          latencyMs: 12,
          apiRequested: true,
          result: {
            status: "ready",
            lane: "sol",
            reason: "analysis",
            confidence: 0.91,
            inputTokens: 42,
            effort: "xhigh",
            assessment: "retry",
            assessmentConfidence: 0.8,
            effortConfidence: 0.7,
            escalationProbability: 0.6,
          },
        });
        yield* records.submitted({
          sessionId: "server-session",
          correlationId,
          threadId: "thread-1",
          messageId: "message-1",
          commandId: "command-1",
          model: "gpt-5.6-sol",
          effort: "xhigh",
        });
        yield* Effect.promise(() => records.drain());

        const contents = yield* Effect.promise(() =>
          NodeFSP.readFile(jevRoutingTestRecordPath(stateDir), "utf8"),
        );
        expect(contents).not.toContain("super-secret");
        const entries = contents
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(entries).toEqual([
          expect.objectContaining({
            event: "request",
            before: { lane: "terra", effort: "high" },
          }),
          expect.objectContaining({
            event: "suggestion",
            correlationId,
            apiRequested: true,
            after: { lane: "sol", effort: "xhigh" },
            inputTokens: 42,
            assessment: "retry",
            assessmentConfidence: 0.8,
            effortConfidence: 0.7,
            escalationProbability: 0.6,
          }),
          expect.objectContaining({
            event: "submitted",
            correlationId,
            routingObserved: true,
            threadId: "thread-1",
            after: { model: "gpt-5.6-sol", effort: "xhigh" },
          }),
        ]);
      }),
  );

  it.effect(
    "records unlinked submissions without treating absent routing data as auto-select off",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* temporaryStateDir();
        const records = makeJevRoutingTestRecords({ stateDir });
        yield* records.submitted({
          sessionId: "native-session",
          threadId: "thread-2",
          messageId: "message-2",
          commandId: "command-2",
          model: "gpt-5.6-terra",
          effort: "medium",
        });
        yield* Effect.promise(() => records.drain());
        const [entry] = (yield* Effect.promise(() =>
          NodeFSP.readFile(jevRoutingTestRecordPath(stateDir), "utf8"),
        ))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(entry).toMatchObject({
          event: "submitted",
          routingObserved: false,
        });
        expect(entry).not.toHaveProperty("correlationId");
      }),
  );

  it.effect(
    "observes a correlation once for its issuing session before expiry and deduplicates commands",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* temporaryStateDir();
        let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
        let nextId = 0;
        const records = makeJevRoutingTestRecords({
          stateDir,
          now: () => new Date(nowMs),
          randomId: () => `correlation-${nextId++}`,
        });
        const correlationId = records.begin({
          sessionId: "owner",
          mode: "apply",
        });
        yield* records.submitted({
          sessionId: "foreign",
          correlationId,
          threadId: "thread-foreign",
          messageId: "message-foreign",
          commandId: "command-foreign",
        });
        yield* records.submitted({
          sessionId: "owner",
          correlationId,
          threadId: "thread-owner",
          messageId: "message-owner",
          commandId: "command-owner",
        });
        yield* records.submitted({
          sessionId: "owner",
          threadId: "thread-owner",
          messageId: "message-owner",
          commandId: "command-owner",
        });
        yield* records.submitted({
          sessionId: "owner",
          correlationId,
          threadId: "thread-repeat",
          messageId: "message-repeat",
          commandId: "command-repeat",
        });
        const expiredCorrelationId = records.begin({
          sessionId: "owner",
          mode: "apply",
        });
        nowMs += 10 * 60 * 1_000;
        yield* records.submitted({
          sessionId: "owner",
          correlationId: expiredCorrelationId,
          threadId: "thread-expired",
          messageId: "message-expired",
          commandId: "command-expired",
        });
        yield* Effect.promise(() => records.drain());

        const entries = (yield* Effect.promise(() =>
          NodeFSP.readFile(jevRoutingTestRecordPath(stateDir), "utf8"),
        ))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const submitted = entries.filter((entry) => entry.event === "submitted");
        expect(submitted).toHaveLength(4);
        expect(submitted.map((entry) => entry.routingObserved)).toEqual([
          false,
          true,
          false,
          false,
        ]);
        expect(submitted[1]).toMatchObject({ correlationId });
        expect(submitted[0]).not.toHaveProperty("correlationId");
        expect(submitted[2]).not.toHaveProperty("correlationId");
        expect(submitted[3]).not.toHaveProperty("correlationId");
      }),
  );

  it.effect(
    "bounds pending correlations and serialized disk retention, including a sole oversized line",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* temporaryStateDir();
        let nextId = 0;
        const records = makeJevRoutingTestRecords({
          stateDir,
          randomId: () => `correlation-${nextId++}`,
        });
        for (let index = 0; index <= 1_000; index += 1) {
          records.begin({ sessionId: "session", mode: "apply" });
        }
        yield* records.submitted({
          sessionId: "session",
          correlationId: "correlation-0",
          threadId: "thread-3",
          messageId: "message-3",
          commandId: "command-3",
        });
        yield* Effect.promise(() => records.drain());
        const entries = (yield* Effect.promise(() =>
          NodeFSP.readFile(jevRoutingTestRecordPath(stateDir), "utf8"),
        ))
          .trim()
          .split("\n");
        expect(entries).toHaveLength(1_000);
        expect(JSON.parse(entries.at(-1) ?? "{}")).toMatchObject({
          routingObserved: false,
        });
        expect(trimJevRoutingTestRecords(`${"x".repeat(1_024 * 1_024)}\n`)).toBe("");
      }),
  );

  it.effect("never surfaces a record-write failure to a turn submission", () =>
    Effect.gen(function* () {
      const records = makeJevRoutingTestRecords({
        stateDir: "/unavailable",
        appendFile: async () => {
          throw new Error("disk unavailable");
        },
        readFile: async () => "",
        writeFile: async () => undefined,
        rename: async () => undefined,
        mkdir: async () => undefined,
      });
      yield* records.submitted({
        sessionId: "session",
        threadId: "thread-4",
        messageId: "message-4",
        commandId: "command-4",
      });
      yield* Effect.promise(() => records.drain());
    }),
  );
});
