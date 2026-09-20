import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect } from "vite-plus/test";

import { make } from "./JevTaskRouteSuggestion.ts";

const readyResponse = (lane: "luna" | "terra" | "sol" | "astra", confidence = 1) => ({
  ok: true,
  json: async () => ({
    answers: {
      route: {
        type: "choice",
        choice: lane,
        probabilities: {
          sol: lane === "sol" ? 1 : 0,
          luna: lane === "luna" ? 1 : 0,
          terra: lane === "terra" ? 1 : 0,
          astra: lane === "astra" ? 1 : 0,
        },
        confidence,
      },
    },
    usage: { input_tokens: 1 },
  }),
});

describe("JevTaskRouteSuggestion", () => {
  it.effect("does not send input when no API key is configured", () =>
    Effect.gen(function* () {
      let fetchCalls = 0;
      const service = yield* make({
        getEnvironmentVariable: () => undefined,
        readFile: async () => {
          throw new Error("missing");
        },
        fetch: async () => {
          fetchCalls += 1;
          return readyResponse("luna");
        },
      });
      expect(yield* service.suggest({ task: "Add a button" })).toEqual({
        status: "not_configured",
      });
      expect(fetchCalls).toBe(0);
    }),
  );

  it.effect("blocks sensitive input and continuations before configuration or network access", () =>
    Effect.gen(function* () {
      let fetchCalls = 0;
      const service = yield* make({
        getEnvironmentVariable: () => undefined,
        fetch: async () => {
          fetchCalls += 1;
          return readyResponse("luna");
        },
      });
      expect(yield* service.suggest({ task: "Use this API key: sk_example_123456789012" })).toEqual(
        {
          status: "blocked",
          reason: "sensitive_input",
        },
      );
      expect(yield* service.suggest({ task: "Continue the previous turn" })).toEqual({
        status: "blocked",
        reason: "continuation",
      });
      expect(yield* service.suggest({ task: "Fix it." })).toEqual({
        status: "blocked",
        reason: "continuation",
      });
      expect(fetchCalls).toBe(0);
    }),
  );

  it.effect("uses only the exact local TypeSafe development config fallback", () =>
    Effect.gen(function* () {
      const requestedPaths: string[] = [];
      const service = yield* make({
        getEnvironmentVariable: () => undefined,
        configPath: "/safe/.config/typesafe/dev.env",
        readFile: async (path: string) => {
          requestedPaths.push(path);
          return "TYPESAFE_API_KEY=test-key";
        },
        fetch: async () => readyResponse("luna"),
      });
      expect(yield* service.suggest({ task: "Classify a task" })).toMatchObject({
        status: "ready",
        lane: "luna",
      });
      expect(requestedPaths).toEqual(["/safe/.config/typesafe/dev.env"]);
    }),
  );

  it.effect("maps only a validated Choice result to safe local fields", () =>
    Effect.gen(function* () {
      let init: RequestInit | undefined;
      const service = yield* make({
        getEnvironmentVariable: () => "test-key",
        fetch: async (_url: string, requestInit: RequestInit) => {
          init = requestInit;
          return {
            ...readyResponse("terra", 0.8),
            json: async () => ({
              answers: {
                route: {
                  type: "choice",
                  choice: "terra",
                  probabilities: { terra: 0.8, code: 0.1, luna: 0.05, astra: 0.05 },
                  confidence: 0.8,
                },
              },
              usage: { input_tokens: 42 },
              vendor_debug: "must not escape",
            }),
          };
        },
      });
      expect(yield* service.suggest({ task: "Implement a normal endpoint" })).toEqual({
        status: "ready",
        lane: "terra",
        reason: "implementation",
        confidence: 0.8,
        inputTokens: 42,
      });
      expect(init?.redirect).toBe("error");
      expect(init?.method).toBe("POST");
    }),
  );

  it.effect(
    "returns opaque unavailable results for malformed, rejected, and rate-limited calls",
    () =>
      Effect.gen(function* () {
        let fetchCalls = 0;
        let now = 10_000;
        const malformed = yield* make({
          getEnvironmentVariable: () => "test-key",
          fetch: async () => ({ ok: true, json: async () => ({ answers: {}, usage: {} }) }),
        });
        expect(yield* malformed.suggest({ task: "Malformed response" })).toEqual({
          status: "unavailable",
        });

        const rejected = yield* make({
          getEnvironmentVariable: () => "test-key",
          fetch: async () => Promise.reject(new Error("timeout")),
        });
        expect(yield* rejected.suggest({ task: "Rejected request" })).toEqual({
          status: "unavailable",
        });

        const rateLimited = yield* make({
          getEnvironmentVariable: () => "test-key",
          now: () => now,
          fetch: async () => {
            fetchCalls += 1;
            return readyResponse("luna");
          },
        });
        expect(yield* rateLimited.suggest({ task: "First task" })).toMatchObject({
          status: "ready",
        });
        now += 1;
        expect(yield* rateLimited.suggest({ task: "Second task" })).toEqual({
          status: "unavailable",
        });
        expect(fetchCalls).toBe(1);
      }),
  );

  it.effect("offers only available models and sends only the submitted task as state", () =>
    Effect.gen(function* () {
      let sent:
        | { state: string; questions: { route: { criteria: Record<string, string> } } }
        | undefined;
      const service = yield* make({
        getEnvironmentVariable: () => "test-key",
        fetch: async (_url, init) => {
          sent = JSON.parse(String(init.body));
          return readyResponse("sol", 0.9);
        },
      });
      expect(
        yield* service.suggest({
          task: "Evaluate a complex design",
          availableLanes: ["terra", "sol"],
        }),
      ).toMatchObject({ status: "ready", lane: "sol", reason: "analysis" });
      expect(sent?.state).toBe("Evaluate a complex design");
      expect(Object.keys(sent?.questions.route.criteria ?? {})).toEqual(["terra", "sol"]);
    }),
  );

  it.effect(
    "rejects a result outside the offered models and avoids calls with no meaningful choice",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const service = yield* make({
          getEnvironmentVariable: () => "test-key",
          fetch: async () => {
            calls += 1;
            return readyResponse("astra");
          },
        });
        expect(yield* service.suggest({ task: "Format a list", availableLanes: ["luna"] })).toEqual(
          { status: "unavailable" },
        );
        expect(yield* service.suggest({ task: "Format a list", availableLanes: [] })).toEqual({
          status: "unavailable",
        });
        expect(calls).toBe(0);
        expect(
          yield* service.suggest({ task: "Format a list", availableLanes: ["luna", "terra"] }),
        ).toEqual({ status: "unavailable" });
        expect(calls).toBe(1);
      }),
  );

  it.effect("does not queue a second concurrent request", () =>
    Effect.gen(function* () {
      let fetchCalls = 0;
      let release: (() => void) | undefined;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const service = yield* make({
        getEnvironmentVariable: () => "test-key",
        fetch: async () => {
          fetchCalls += 1;
          await pending;
          return readyResponse("luna");
        },
      });
      const first = yield* service
        .suggest({ task: "First task" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      expect(yield* service.suggest({ task: "Second task" })).toEqual({ status: "unavailable" });
      expect(fetchCalls).toBe(1);
      release?.();
      expect(yield* Fiber.join(first)).toMatchObject({ status: "ready" });
    }),
  );
});
