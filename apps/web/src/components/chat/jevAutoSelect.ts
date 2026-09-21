import {
  TASK_ROUTE_CONTEXT_LIMITS,
  type ModelSelection,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
  type ServerProviderModel,
  type TaskRouteContext,
  type TaskRouteModelLane,
  type TaskRouteReasoningEffort,
  type TaskRouteSuggestion,
  type TaskRouteSuggestionInput,
} from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  createModelSelection,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

const LANE_MODEL_SLUGS: Readonly<Record<TaskRouteModelLane, ReadonlyArray<string>>> = {
  luna: ["gpt-5.6-luna"],
  terra: ["gpt-5.6-terra"],
  sol: ["gpt-5.6-sol", "gpt-5.6"],
  astra: ["gpt-6-astra"],
};
const LANES = Object.keys(LANE_MODEL_SLUGS) as TaskRouteModelLane[];
const EFFORTS: readonly TaskRouteReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
const MINIMUM_CONFIDENCE = 0.6;
const CONTEXT_CONFIDENCE = 0.7;
const ESCALATION_PROBABILITY = 0.8;
// A conservative guard, not a dollar or subscription-quota estimate. Long
// conversations keep their model unless a stronger one is justified.
const LARGE_CONTEXT_TOKENS = 100_000;

type RoutingModel = Pick<ServerProviderModel, "slug" | "capabilities">;

function modelLane(slug: string): TaskRouteModelLane | undefined {
  return LANES.find((lane) => LANE_MODEL_SLUGS[lane].includes(slug));
}

function selectedEffort(selected: ModelSelection, models: readonly RoutingModel[]) {
  const caps = models.find((model) => model.slug === selected.model)?.capabilities;
  const descriptor =
    caps &&
    getProviderOptionDescriptors({ caps, selections: selected.options }).find(
      (option) => option.id === "reasoningEffort",
    );
  const value = getProviderOptionCurrentValue(descriptor);
  return EFFORTS.find((effort) => effort === value);
}

export function availableJevModelLanes(
  models: readonly RoutingModel[],
): readonly TaskRouteModelLane[] {
  return LANES.filter((lane) =>
    models.some((model) => model.capabilities && LANE_MODEL_SLUGS[lane].includes(model.slug)),
  );
}

/** Copies only bounded dialogue and latest-turn summaries, never tool payloads or attachments. */
export function buildJevRouteContext({
  selected,
  models,
  messages,
  activities,
  latestTurn,
  contextTokens,
  hasUnseenContext,
}: {
  selected: ModelSelection;
  models: readonly RoutingModel[];
  messages: readonly Pick<
    OrchestrationMessage,
    "role" | "text" | "streaming" | "attachments" | "context"
  >[];
  activities: readonly Pick<OrchestrationThreadActivity, "turnId" | "tone" | "summary">[];
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "state"> | null;
  contextTokens?: number | null;
  hasUnseenContext: boolean;
}): TaskRouteContext {
  const recent = messages
    .filter(
      (message) =>
        !message.streaming &&
        (message.role === "user" || message.role === "assistant") &&
        message.text.trim(),
    )
    .slice(-TASK_ROUTE_CONTEXT_LIMITS.messages);
  const currentLane = modelLane(selected.model);
  const currentEffort = selectedEffort(selected, models);
  return {
    ...(currentLane ? { currentLane } : {}),
    ...(currentEffort ? { currentEffort } : {}),
    recentMessages: recent.map((message) => ({
      role: message.role === "user" ? "user" : "assistant",
      text: message.text.trim().slice(-TASK_ROUTE_CONTEXT_LIMITS.messageChars).trim(),
    })),
    recentActivities:
      latestTurn === null
        ? []
        : activities
            .filter((activity) => activity.turnId === latestTurn.turnId && activity.summary.trim())
            .slice(-TASK_ROUTE_CONTEXT_LIMITS.activities)
            .map((activity) => ({
              tone: activity.tone,
              summary: activity.summary
                .trim()
                .slice(-TASK_ROUTE_CONTEXT_LIMITS.activityChars)
                .trim(),
            })),
    ...(latestTurn ? { latestTurnState: latestTurn.state } : {}),
    ...(contextTokens !== null &&
    contextTokens !== undefined &&
    Number.isFinite(contextTokens) &&
    contextTokens >= 0
      ? { contextTokens: Math.floor(contextTokens) }
      : {}),
    hasUnseenContext:
      hasUnseenContext ||
      recent.some((message) => Boolean(message.attachments?.length || message.context)),
  };
}

export function buildJevRouteInput({
  enabled,
  provider,
  running,
  multipleModels,
  task,
  models,
  context,
}: {
  enabled: boolean;
  provider: string;
  running: boolean;
  multipleModels: boolean;
  task: string;
  models: readonly RoutingModel[];
  context: TaskRouteContext | (() => TaskRouteContext);
}): TaskRouteSuggestionInput | null {
  const availableLanes = availableJevModelLanes(models);
  const text = task.trim();
  if (
    !enabled ||
    provider !== "codex" ||
    running ||
    multipleModels ||
    !text ||
    text.length > 4_000 ||
    availableLanes.length < 2
  )
    return null;
  return {
    task: text,
    availableLanes,
    context: typeof context === "function" ? context() : context,
  };
}

/** Applies independent model/effort judgments only at a new turn boundary. */
export function resolveJevModelSelection({
  suggestion,
  models,
  selected,
  context,
}: {
  suggestion: TaskRouteSuggestion;
  models: readonly RoutingModel[];
  selected: ModelSelection;
  context?: TaskRouteContext;
}): ModelSelection | null {
  if (suggestion.status !== "ready" || suggestion.lane === "code") return null;
  // Older servers can still answer a task-only request. Their answers cannot
  // justify switching a contextual submission whose references they never saw.
  if (
    context &&
    (!suggestion.assessment || (suggestion.assessmentConfidence ?? 0) < CONTEXT_CONFIDENCE)
  )
    return null;
  if (suggestion.assessment === "continuation" || suggestion.assessment === "external_blocker")
    return null;
  const retry = suggestion.assessment === "retry";
  const currentLane = modelLane(selected.model);
  const currentRank = currentLane ? LANES.indexOf(currentLane) : -1;
  if (
    retry &&
    ((suggestion.escalationProbability ?? 0) < ESCALATION_PROBABILITY ||
      currentRank < 0 ||
      !context?.recentMessages.some((message) => message.role === "assistant"))
  )
    return null;

  let targetLane = suggestion.confidence >= MINIMUM_CONFIDENCE ? suggestion.lane : currentLane;
  if (retry) {
    const nextLane = availableJevModelLanes(models).find(
      (lane) => LANES.indexOf(lane) > currentRank,
    );
    if (!targetLane || LANES.indexOf(targetLane) <= currentRank)
      targetLane = nextLane ?? currentLane;
  }
  const preventDowngrade =
    retry ||
    Boolean(context && (suggestion.assessmentConfidence ?? 0) < 0.85) ||
    Boolean(context && suggestion.confidence < 0.85) ||
    Boolean(context?.hasUnseenContext) ||
    (context?.contextTokens ?? 0) >= LARGE_CONTEXT_TOKENS;
  if (preventDowngrade && (!currentLane || (targetLane && LANES.indexOf(targetLane) < currentRank)))
    targetLane = currentLane;
  const targetSlug =
    targetLane && targetLane !== currentLane
      ? LANE_MODEL_SLUGS[targetLane].find((slug) =>
          models.some((model) => model.slug === slug && model.capabilities),
        )
      : selected.model;
  const model = models.find((candidate) => candidate.slug === targetSlug);
  if (!model?.capabilities) return null;

  const currentEffort = selectedEffort(selected, models);
  const descriptors = getProviderOptionDescriptors({
    caps: model.capabilities,
    selections: selected.options,
  });
  const effortDescriptor = descriptors.find((option) => option.id === "reasoningEffort");
  const effort = suggestion.effort;
  const canApplyEffort =
    effort &&
    (suggestion.effortConfidence ?? 0) >= CONTEXT_CONFIDENCE &&
    effortDescriptor?.type === "select" &&
    effortDescriptor.options.some((option) => option.id === effort) &&
    (!preventDowngrade ||
      (currentEffort !== undefined && EFFORTS.indexOf(effort) >= EFFORTS.indexOf(currentEffort)));
  const minimumEffortRank = currentEffort ? EFFORTS.indexOf(currentEffort) : 0;
  let chosenEffort = canApplyEffort ? effort : currentEffort;
  if (
    chosenEffort &&
    effortDescriptor?.type === "select" &&
    !effortDescriptor.options.some((option) => option.id === chosenEffort)
  ) {
    chosenEffort = preventDowngrade
      ? EFFORTS.find(
          (candidate) =>
            EFFORTS.indexOf(candidate) >= minimumEffortRank &&
            effortDescriptor.options.some((option) => option.id === candidate),
        )
      : undefined;
  }
  // Preserving an implicit default matters as much as preserving an explicit
  // option: the next model's default can be lower even when its tier is higher.
  if (preventDowngrade && currentEffort && (!chosenEffort || effortDescriptor?.type !== "select"))
    return null;
  if (model.slug === selected.model && chosenEffort === currentEffort) return null;
  const selections = chosenEffort
    ? [
        ...(selected.options ?? []).filter((option) => option.id !== "reasoningEffort"),
        { id: "reasoningEffort", value: chosenEffort },
      ]
    : [...(selected.options ?? [])];
  if (
    descriptors.some((option) => option.id === "fastMode" && option.type === "boolean") &&
    !selections.some((option) => option.id === "fastMode")
  ) {
    selections.push({ id: "fastMode", value: false });
  }
  // Provider-owned options remain authoritative. Never enable Fast processing
  // or carry an unsupported effort to another model.
  const options = buildExplicitProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({ caps: model.capabilities, selections }),
    selections,
  );
  return createModelSelection(selected.instanceId, model.slug, options);
}

/** The normal send path always survives optional routing outages. */
export async function requestJevModelSelection({
  input,
  models,
  selected,
  suggest,
}: {
  input: TaskRouteSuggestionInput | null;
  models: readonly RoutingModel[];
  selected: ModelSelection;
  suggest: (input: TaskRouteSuggestionInput) => Promise<TaskRouteSuggestion>;
}): Promise<ModelSelection | null> {
  if (!input) return null;
  try {
    return resolveJevModelSelection({
      suggestion: await suggest(input),
      models,
      selected,
      ...(input.context ? { context: input.context } : {}),
    });
  } catch {
    return null;
  }
}
