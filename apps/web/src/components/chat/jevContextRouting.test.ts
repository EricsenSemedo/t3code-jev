import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ProviderInstanceId,
  TurnId,
  TaskRouteSuggestionInput,
  type ModelSelection,
  type TaskRouteContext,
  type TaskRouteSuggestion,
} from "@t3tools/contracts";
import {
  buildJevRouteContext,
  buildJevRouteInput,
  requestJevModelSelection,
  resolveJevModelSelection,
} from "./jevAutoSelect";

const isRouteInput = Schema.is(TaskRouteSuggestionInput);

const models = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"].map((slug) => ({
  slug,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select" as const,
        options: ["low", "medium", "high", "xhigh"].map((id) => ({
          id,
          label: id,
          isDefault: id === "medium",
        })),
      },
      { id: "fastMode", label: "Fast", type: "boolean" as const },
    ],
  },
}));
const selected: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-terra",
  options: [
    { id: "reasoningEffort", value: "medium" },
    { id: "fastMode", value: false },
  ],
};
const context: TaskRouteContext = {
  currentLane: "terra",
  currentEffort: "medium",
  recentMessages: [
    { role: "user", text: "Fix the intermittent cache race" },
    { role: "assistant", text: "The fix still fails the concurrent test." },
  ],
  recentActivities: [{ tone: "error", summary: "Concurrent test failed again" }],
  latestTurnState: "completed",
  hasUnseenContext: false,
};
const suggestion = (
  overrides: Partial<Extract<TaskRouteSuggestion, { status: "ready" }>> = {},
): TaskRouteSuggestion => ({
  status: "ready",
  lane: "sol",
  reason: "analysis",
  confidence: 0.9,
  inputTokens: 80,
  assessment: "new_task",
  assessmentConfidence: 0.95,
  effort: "high",
  effortConfidence: 0.9,
  escalationProbability: 0.1,
  ...overrides,
});
const resolve = (
  route: TaskRouteSuggestion,
  changes: { selected?: ModelSelection; models?: typeof models; context?: TaskRouteContext } = {},
) => resolveJevModelSelection({ suggestion: route, selected, models, context, ...changes });
const effortOf = (selection: ModelSelection | null) =>
  selection?.options?.find((option) => option.id === "reasoningEffort")?.value;

describe("contextual selection policy", () => {
  it("independently selects supported reasoning without enabling Fast", () => {
    expect(resolve(suggestion())).toEqual({
      instanceId: selected.instanceId,
      model: "gpt-5.6-sol",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: false },
      ],
    });
  });
  it.each(["continuation", "external_blocker"] as const)(
    "keeps the exact selection for %s despite an expensive recommendation",
    (assessment) => {
      expect(
        resolve(suggestion({ assessment, lane: "astra", escalationProbability: 1 })),
      ).toBeNull();
    },
  );
  it("rejects context-blind old-server responses and uncertain task relationships", () => {
    expect(
      resolve({
        status: "ready",
        lane: "luna",
        reason: "transformation",
        confidence: 1,
        inputTokens: 1,
      }),
    ).toBeNull();
    expect(resolve(suggestion({ assessmentConfidence: 0.69 }))).toBeNull();
  });
  it("changes effort independently when the model vote is uncertain", () => {
    const result = resolve(suggestion({ lane: "astra", confidence: 0.2 }));
    expect(result?.model).toBe(selected.model);
    expect(effortOf(result)).toBe("high");
  });
  it.each([{ effortConfidence: 0.2 }, { effort: "ultra" as const }])(
    "retains effort for uncertain or unsupported recommendations: %j",
    (change) => {
      const result = resolve(suggestion(change));
      expect(result?.model).toBe("gpt-5.6-sol");
      expect(effortOf(result)).toBe("medium");
    },
  );
  it("retains the route for a retry without evidence more reasoning would help", () => {
    expect(resolve(suggestion({ assessment: "retry", escalationProbability: 0.79 }))).toBeNull();
  });
  it("never escalates a retry without a previous assistant attempt", () => {
    expect(
      resolve(suggestion({ assessment: "retry", escalationProbability: 1 }), {
        context: { ...context, recentMessages: [], recentActivities: [] },
      }),
    ).toBeNull();
  });
  it.each([{ assessmentConfidence: 0.84 }, { confidence: 0.84 }])(
    "requires stronger confidence before lowering a model: %j",
    (uncertain) => {
      const result = resolve(suggestion({ lane: "luna", effort: "medium", ...uncertain }));
      expect(result).toBeNull();
    },
  );
  it("escalates a justified retry without lowering model or effort", () => {
    const result = resolve(
      suggestion({ assessment: "retry", lane: "luna", escalationProbability: 0.9, effort: "low" }),
    );
    expect(result?.model).toBe("gpt-5.6-sol");
    expect(effortOf(result)).toBe("medium");
  });
  it("skips unavailable lanes during escalation", () => {
    expect(
      resolve(suggestion({ assessment: "retry", lane: "terra", escalationProbability: 0.9 }), {
        models: models.filter((model) => model.slug !== "gpt-5.6-sol"),
      })?.model,
    ).toBe("gpt-6-astra");
  });
  it("raises effort at the strongest model without bouncing to a cheaper one", () => {
    const result = resolve(
      suggestion({ assessment: "retry", lane: "luna", escalationProbability: 0.9 }),
      { selected: { ...selected, model: "gpt-6-astra" } },
    );
    expect(result?.model).toBe("gpt-6-astra");
    expect(effortOf(result)).toBe("high");
  });
  it.each([{ contextTokens: 100_000 }, { hasUnseenContext: true }])(
    "blocks opportunistic downgrades with %j",
    (guard) => {
      expect(
        resolve(suggestion({ lane: "luna", effort: "low" }), { context: { ...context, ...guard } }),
      ).toBeNull();
      expect(
        resolve(suggestion({ lane: "astra" }), { context: { ...context, ...guard } })?.model,
      ).toBe("gpt-6-astra");
    },
  );
  it("allows a cheaper model for a clear new task with small complete context", () => {
    expect(resolve(suggestion({ lane: "luna", effort: "low" }))?.model).toBe("gpt-5.6-luna");
  });
  it("does not invent escalation from an unknown manually selected model", () => {
    expect(
      resolve(suggestion({ assessment: "retry", escalationProbability: 1 }), {
        selected: { ...selected, model: "custom-codex" },
      }),
    ).toBeNull();
  });
});

describe("provider defaults during a switch", () => {
  it("does not silently lower implicit reasoning effort when retrying on a new model", () => {
    const differentDefaults = models.map((model) => ({
      ...model,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select" as const,
            options: ["low", "medium", "high", "xhigh"].map((id) => ({
              id,
              label: id,
              isDefault: id === (model.slug === selected.model ? "high" : "low"),
            })),
          },
          { id: "fastMode", label: "Fast", type: "boolean" as const, currentValue: true },
        ],
      },
    }));
    const route = resolveJevModelSelection({
      suggestion: suggestion({
        assessment: "retry",
        escalationProbability: 0.9,
        effortConfidence: 0.1,
      }),
      selected: { instanceId: selected.instanceId, model: selected.model },
      models: differentDefaults,
      context,
    });
    expect(route?.model).toBe("gpt-5.6-sol");
    expect(effortOf(route)).toBe("high");
    expect(route?.options?.find((option) => option.id === "fastMode")?.value).toBe(false);
  });
});

describe("submission boundary", () => {
  const input = (changes: Partial<Parameters<typeof buildJevRouteInput>[0]> = {}) =>
    buildJevRouteInput({
      enabled: true,
      provider: "codex",
      running: false,
      multipleModels: false,
      task: "Try again; the concurrent test still fails",
      models,
      context,
      ...changes,
    });
  it.each([
    { enabled: false },
    { provider: "claudeAgent" },
    { running: true },
    { multipleModels: true },
    { task: "" },
    { task: "x".repeat(4001) },
    { models: models.slice(0, 1) },
  ])("never calls Jev for ineligible submissions (%#)", async (changes) => {
    let calls = 0;
    const route = await requestJevModelSelection({
      input: input({
        ...changes,
        context: () => {
          throw new Error("ineligible sends must not read history");
        },
      }),
      models,
      selected,
      suggest: async () => {
        calls++;
        return suggestion();
      },
    });
    expect(calls).toBe(0);
    expect(route ?? selected).toBe(selected);
  });
  it("reassesses every eligible send using that submission's context", async () => {
    const seen: TaskRouteSuggestionInput[] = [];
    const dispatches: ModelSelection[] = [];
    for (const answer of [
      suggestion({ lane: "luna", effort: "low" }),
      suggestion({ assessment: "retry", lane: "astra", escalationProbability: 0.95 }),
    ]) {
      const route = await requestJevModelSelection({
        input: input(),
        models,
        selected,
        suggest: async (request) => {
          seen.push(request);
          return answer;
        },
      });
      dispatches.push(route ?? selected);
    }
    expect(seen).toHaveLength(2);
    expect(seen[1]?.context?.recentActivities[0]?.summary).toBe("Concurrent test failed again");
    expect(dispatches.map((selection) => selection.model)).toEqual(["gpt-5.6-luna", "gpt-6-astra"]);
  });
  it("preserves normal dispatch on rejection, unavailable, sensitive, and uncertain results", async () => {
    for (const answer of [
      null,
      { status: "unavailable" } as const,
      { status: "blocked", reason: "sensitive_input" } as const,
      suggestion({ confidence: 0.1, effortConfidence: 0.1 }),
    ]) {
      const route = await requestJevModelSelection({
        input: input(),
        models,
        selected,
        suggest: async () => {
          if (!answer) throw new Error("offline");
          return answer;
        },
      });
      expect(route ?? selected).toBe(selected);
    }
  });
});

describe("bounded routing context", () => {
  it("keeps recent dialogue and latest-turn summaries without reasoning, system or raw tool content", () => {
    const turnId = TurnId.make("latest");
    const messages = [
      ...Array.from({ length: 5 }, (_, index) => ({
        role: "user" as const,
        text: `old-${index}`,
        streaming: false,
      })),
      { role: "reasoning" as const, text: "private reasoning", streaming: false },
      { role: "system" as const, text: "system rules", streaming: false },
      { role: "assistant" as const, text: "x".repeat(2000), streaming: false },
      { role: "assistant" as const, text: "unfinished", streaming: true },
    ];
    const built = buildJevRouteContext({
      selected,
      models,
      messages,
      activities: [
        { turnId: TurnId.make("old"), tone: "error", summary: "unrelated old failure" },
        ...Array.from({ length: 5 }, () => ({
          turnId,
          tone: "tool" as const,
          summary: "s".repeat(500),
          payload: "raw tool data",
        })),
      ],
      latestTurn: { turnId, state: "completed" },
      contextTokens: 1234.5,
      hasUnseenContext: false,
    });
    expect(built.recentMessages).toHaveLength(4);
    expect(built.recentMessages.at(-1)?.text).toHaveLength(1000);
    expect(built.recentActivities).toHaveLength(4);
    expect(built.recentActivities[0]?.summary).toHaveLength(240);
    expect(built.contextTokens).toBe(1234);
    expect(built.currentEffort).toBe("medium");
    expect(JSON.stringify(built)).not.toMatch(
      /private reasoning|system rules|unfinished|raw tool data|unrelated old failure/,
    );
    expect(isRouteInput({ task: "try again", context: built })).toBe(true);
  });
});
