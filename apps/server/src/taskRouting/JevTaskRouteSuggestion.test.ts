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

const contextualReadyResponse = ({
  lane = "terra",
  effort = "high",
  assessment = "retry",
  escalationProbability = 0.8,
}: {
  lane?: "luna" | "terra" | "sol" | "astra";
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  assessment?: "new_task" | "continuation" | "retry" | "external_blocker";
  escalationProbability?: number;
} = {}) => ({
  ok: true,
  json: async () => ({
    answers: {
      route: {
        type: "choice",
        choice: lane,
        probabilities: { luna: 0.05, terra: 0.8, sol: 0.1, astra: 0.05 },
        confidence: 0.8,
      },
      effort: {
        type: "choice",
        choice: effort,
        probabilities: { low: 0.05, medium: 0.1, high: 0.8, xhigh: 0.03, max: 0.01, ultra: 0.01 },
        confidence: 0.8,
      },
      assessment: {
        type: "choice",
        choice: assessment,
        probabilities: { new_task: 0.05, continuation: 0.1, retry: 0.8, external_blocker: 0.05 },
        confidence: 0.8,
      },
      escalation: { type: "noul", noul: escalationProbability },
    },
    usage: { input_tokens: 12 },
  }),
});

const context = {
  currentLane: "terra" as const,
  currentEffort: "medium" as const,
  recentMessages: [
    { role: "assistant" as const, text: "The first patch did not address the failure." },
  ],
  recentActivities: [{ tone: "error" as const, summary: "Focused test still fails." }],
  latestTurnState: "error" as const,
  contextTokens: 1_200,
  hasUnseenContext: false,
};

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

  it.effect("records the raw shadow suggestion even when it suppresses the client result", () =>
    Effect.gen(function* () {
      const finished: Array<{
        readonly mode: "apply" | "shadow";
        readonly result: { readonly status: string; readonly lane?: string };
        readonly apiRequested: boolean;
      }> = [];
      const service = yield* make({
        getEnvironmentVariable: (name) =>
          name === "T3CODE_JEV_ROUTING_MODE" ? "shadow" : "test-key",
        fetch: async () => contextualReadyResponse({ lane: "sol" }),
        records: {
          begin: () => "server-correlation",
          finish: (record) => finished.push(record),
          submitted: () => Effect.void,
          drain: async () => undefined,
        },
      });
      expect(
        yield* service.suggest(
          { task: "Investigate the failed patch", context, availableLanes: ["terra", "sol"] },
          "session",
        ),
      ).toEqual({ status: "unavailable", correlationId: "server-correlation" });
      expect(finished).toEqual([
        expect.objectContaining({
          mode: "shadow",
          result: expect.objectContaining({ status: "ready", lane: "sol" }),
          apiRequested: true,
        }),
      ]);
    }),
  );

  it.effect("sends bounded structured state and four independent contextual questions", () =>
    Effect.gen(function* () {
      let sent:
        | {
            state: { task: string; context: typeof context };
            questions: Record<
              string,
              { type: string; instructions: string; criteria?: Record<string, string> }
            >;
          }
        | undefined;
      const service = yield* make({
        getEnvironmentVariable: () => "test-key",
        fetch: async (_url, init) => {
          sent = JSON.parse(String(init.body));
          return contextualReadyResponse();
        },
      });

      expect(
        yield* service.suggest({
          task: "Continue investigating the failed patch",
          availableLanes: ["terra", "sol"],
          context,
        }),
      ).toEqual({
        status: "ready",
        lane: "terra",
        reason: "implementation",
        confidence: 0.8,
        inputTokens: 12,
        assessment: "retry",
        assessmentConfidence: 0.8,
        effort: "high",
        effortConfidence: 0.8,
        escalationProbability: 0.8,
      });
      expect(sent?.state).toEqual({ task: "Continue investigating the failed patch", context });
      expect(Object.keys(sent?.questions ?? {})).toEqual([
        "route",
        "effort",
        "assessment",
        "escalation",
      ]);
      expect(Object.keys(sent?.questions.route?.criteria ?? {})).toEqual(["terra", "sol"]);
      expect(sent?.questions.assessment?.instructions).toContain("outage");
      expect(sent?.questions.assessment?.instructions).toContain("capability failures");
      expect(sent?.questions.escalation?.instructions).toContain("repeated unsuccessful fixes");
    }),
  );

  it.effect(
    "screens sensitive assistant history and activities before configuration or network access",
    () =>
      Effect.gen(function* () {
        let fetchCalls = 0;
        const service = yield* make({
          getEnvironmentVariable: () => undefined,
          fetch: async () => {
            fetchCalls += 1;
            return contextualReadyResponse();
          },
        });
        expect(
          yield* service.suggest({
            task: "Route this follow-up",
            context: {
              ...context,
              recentMessages: [{ role: "assistant", text: "Contact me at jane@example.com" }],
            },
          }),
        ).toEqual({ status: "blocked", reason: "sensitive_input" });
        expect(
          yield* service.suggest({
            task: "Route this follow-up",
            context: {
              ...context,
              recentActivities: [{ tone: "tool", summary: "Found API key in output" }],
            },
          }),
        ).toEqual({ status: "blocked", reason: "sensitive_input" });
        expect(fetchCalls).toBe(0);
      }),
  );

  it.effect("allows continuation wording only when contextual evidence was supplied", () =>
    Effect.gen(function* () {
      const service = yield* make({
        getEnvironmentVariable: () => "test-key",
        fetch: async () => contextualReadyResponse({ assessment: "continuation" }),
      });
      expect(
        yield* service.suggest({
          task: "Continue the previous turn",
          context: {
            ...context,
            recentMessages: [
              { role: "assistant", text: "Continue from the completed investigation." },
            ],
          },
        }),
      ).toMatchObject({ status: "ready", assessment: "continuation" });
    }),
  );

  it.effect(
    "returns retry and external-blocker assessments without applying client selection policy",
    () =>
      Effect.gen(function* () {
        const retry = yield* make({
          getEnvironmentVariable: () => "test-key",
          fetch: async () => contextualReadyResponse({ assessment: "retry", effort: "low" }),
        });
        expect(yield* retry.suggest({ task: "Try another fix", context })).toMatchObject({
          status: "ready",
          assessment: "retry",
          effort: "low",
        });

        const externalBlocker = yield* make({
          getEnvironmentVariable: () => "test-key",
          fetch: async () =>
            contextualReadyResponse({ assessment: "external_blocker", escalationProbability: 0.1 }),
        });
        expect(
          yield* externalBlocker.suggest({
            task: "Investigate the unavailable dependency",
            context,
          }),
        ).toMatchObject({
          status: "ready",
          assessment: "external_blocker",
          escalationProbability: 0.1,
        });
      }),
  );

  it.effect(
    "falls back without leaking vendor fields when any contextual answer is malformed",
    () =>
      Effect.gen(function* () {
        const malformed = yield* make({
          getEnvironmentVariable: () => "test-key",
          fetch: async () => ({
            ok: true,
            json: async () => ({
              answers: {
                route: {
                  type: "choice",
                  choice: "terra",
                  probabilities: { terra: 1.1 },
                  confidence: 0.8,
                },
                effort: {
                  type: "choice",
                  choice: "high",
                  probabilities: { high: 0.8 },
                  confidence: 0.8,
                },
                assessment: {
                  type: "choice",
                  choice: "retry",
                  probabilities: { retry: 0.8 },
                  confidence: 0.8,
                },
                escalation: { type: "noul", noul: 0.8 },
              },
              usage: { input_tokens: 12 },
              vendor_debug: "must not escape",
            }),
          }),
        });
        expect(yield* malformed.suggest({ task: "Retry the failed work", context })).toEqual({
          status: "unavailable",
        });
      }),
  );

  it.effect("suppresses a completed contextual assessment in shadow mode", () =>
    Effect.gen(function* () {
      let fetchCalls = 0;
      const service = yield* make({
        getEnvironmentVariable: (name) =>
          name === "TYPESAFE_API_KEY"
            ? "test-key"
            : name === "T3CODE_JEV_ROUTING_MODE"
              ? "shadow"
              : undefined,
        fetch: async () => {
          fetchCalls += 1;
          return contextualReadyResponse();
        },
      });
      expect(yield* service.suggest({ task: "Assess the failed work", context })).toEqual({
        status: "unavailable",
      });
      expect(fetchCalls).toBe(1);
    }),
  );

  it.effect("rejects oversized contextual state from direct callers before network access", () =>
    Effect.gen(function* () {
      let fetchCalls = 0;
      const service = yield* make({
        getEnvironmentVariable: () => "test-key",
        fetch: async () => {
          fetchCalls += 1;
          return contextualReadyResponse();
        },
      });
      expect(
        yield* service.suggest({
          task: "Assess this",
          context: {
            ...context,
            recentMessages: Array.from({ length: 5 }, () => ({ role: "user", text: "x" })),
          },
        } as never),
      ).toEqual({ status: "unavailable" });
      expect(fetchCalls).toBe(0);
    }),
  );
  it.effect("strips unrecognized nested fields before sending state", () =>
    Effect.gen(function* () {
      let sent = "";
      const service = yield* make({
        getEnvironmentVariable: () => "test-key",
        fetch: async (_url, init) => {
          sent = String(init.body);
          return contextualReadyResponse();
        },
      });
      const suppliedContext = {
        ...context,
        rawToolOutput: "must not leave",
        recentMessages: [
          { role: "user" as const, text: "Investigate this failure", extra: "must not leave" },
        ],
      };
      yield* service.suggest({ task: "Try another fix", context: suppliedContext });
      expect(sent).not.toContain("must not leave");
    }),
  );

  it.effect(
    "retains the selection for a contextless continuation and incomplete contextual response",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const service = yield* make({
          getEnvironmentVariable: () => "test-key",
          fetch: async () => {
            calls++;
            return readyResponse("luna");
          },
        });
        expect(
          yield* service.suggest({
            task: "Try again",
            context: { ...context, recentMessages: [] },
          }),
        ).toEqual({ status: "blocked", reason: "continuation" });
        expect(calls).toBe(0);
        expect(yield* service.suggest({ task: "Try again", context })).toEqual({
          status: "unavailable",
        });
        expect(calls).toBe(1);
      }),
  );

  it.effect("also suppresses legacy prompt-only recommendations in shadow mode", () =>
    Effect.gen(function* () {
      const service = yield* make({
        getEnvironmentVariable: (name) =>
          name === "T3CODE_JEV_ROUTING_MODE" ? "shadow" : "test-key",
        fetch: async () => readyResponse("luna"),
      });
      expect(yield* service.suggest({ task: "Format a list" })).toEqual({ status: "unavailable" });
    }),
  );
});
