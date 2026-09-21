import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type TaskRouteSuggestion } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { availableJevModelLanes, resolveJevModelSelection } from "./jevAutoSelect";

const selected = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.6-terra", [
  { id: "reasoningEffort", value: "medium" },
  { id: "fastMode", value: false },
  { id: "unsupported", value: "keep-out" },
]);
const models = [
  { slug: "gpt-5.6-luna", capabilities: null },
  {
    slug: "gpt-5.6-sol",
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning effort",
          type: "select" as const,
          options: [
            { id: "medium", label: "Standard", isDefault: true },
            { id: "high", label: "High" },
          ],
        },
        { id: "fastMode", label: "Fast mode", type: "boolean" as const },
      ],
    },
  },
  { slug: "gpt-6-astra", capabilities: null },
];

describe("Jev auto-select", () => {
  it("offers only lanes backed by the current ready catalog", () => {
    expect(availableJevModelLanes(models)).toEqual(["sol"]);
  });

  it("uses a confident available route for this submission's dispatch selection", () => {
    const suggestion: TaskRouteSuggestion = {
      status: "ready",
      lane: "sol",
      reason: "analysis",
      confidence: 0.8,
      inputTokens: 12,
    };
    expect(resolveJevModelSelection({ suggestion, models, selected })).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
      options: [
        { id: "reasoningEffort", value: "medium" },
        { id: "fastMode", value: false },
      ],
    });
    expect(selected.model).toBe("gpt-5.6-terra");
  });

  it("keeps the selected dispatch model for low-confidence, blocked, and absent routes", () => {
    const lowConfidenceSelection =
      resolveJevModelSelection({
        suggestion: {
          status: "ready",
          lane: "luna",
          reason: "deterministic",
          confidence: 0.59,
          inputTokens: null,
        },
        models,
        selected,
      }) ?? selected;
    expect(lowConfidenceSelection).toBe(selected);
    const blockedSelection =
      resolveJevModelSelection({
        suggestion: { status: "blocked", reason: "sensitive_input" },
        models,
        selected,
      }) ?? selected;
    expect(blockedSelection).toBe(selected);
  });
});
