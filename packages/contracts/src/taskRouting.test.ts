import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { TaskRouteSuggestion, TaskRouteSuggestionInput } from "./server.ts";

const decodeInput = Schema.decodeUnknownSync(TaskRouteSuggestionInput);
const isInput = Schema.is(TaskRouteSuggestionInput);
const isSuggestion = Schema.is(TaskRouteSuggestion);

const context = {
  currentLane: "terra",
  currentEffort: "medium",
  recentMessages: [{ role: "user", text: "Fix the race" }],
  recentActivities: [{ tone: "error", summary: "Concurrent assertion failed" }],
  latestTurnState: "completed",
  hasUnseenContext: false,
};

describe("task routing wire compatibility and bounds", () => {
  it("accepts both old prompt-only callers and bounded contextual requests", () => {
    expect(decodeInput({ task: "Format a list" })).toEqual({
      task: "Format a list",
    });
    expect(
      isInput({
        task: "Try again",
        availableLanes: ["terra", "astra"],
        context,
      }),
    ).toBe(true);
  });
  it.each([
    { recentMessages: Array.from({ length: 5 }, () => ({ role: "user", text: "too many" })) },
    { recentMessages: [{ role: "user", text: "x".repeat(1001) }] },
    { recentMessages: [{ role: "reasoning", text: "not dialogue" }] },
    { recentActivities: Array.from({ length: 5 }, () => ({ tone: "error", summary: "too many" })) },
    { recentActivities: [{ tone: "error", summary: "x".repeat(241) }] },
    { contextTokens: -1 },
    { contextTokens: 1.5 },
    { currentEffort: "invented" },
  ])("rejects oversized or invalid context (%#)", (invalid) => {
    expect(isInput({ task: "Retry", context: { ...context, ...invalid } })).toBe(false);
  });
  it("accepts legacy results and validates contextual probability fields", () => {
    const legacy = {
      status: "ready",
      lane: "terra",
      reason: "implementation",
      confidence: 0.9,
      inputTokens: 10,
    };
    expect(isSuggestion(legacy)).toBe(true);
    expect(
      isSuggestion({
        ...legacy,
        assessment: "retry",
        assessmentConfidence: 0.9,
        effort: "high",
        effortConfidence: 0.9,
        escalationProbability: 0.95,
      }),
    ).toBe(true);
    expect(isSuggestion({ ...legacy, escalationProbability: 1.1 })).toBe(false);
    expect(isSuggestion({ ...legacy, effortConfidence: Number.NaN })).toBe(false);
  });
});
