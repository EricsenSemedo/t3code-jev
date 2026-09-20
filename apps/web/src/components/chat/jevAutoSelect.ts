import type {
  ServerProviderModel,
  TaskRouteModelLane,
  TaskRouteSuggestion,
  ModelSelection,
} from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  createModelSelection,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

const LANE_MODEL_SLUGS: Readonly<Record<TaskRouteModelLane, ReadonlyArray<string>>> = {
  luna: ["gpt-5.6-luna"],
  terra: ["gpt-5.6-terra"],
  sol: ["gpt-5.6-sol", "gpt-5.6"],
  astra: ["gpt-6-astra"],
};

const MINIMUM_CONFIDENCE = 0.6;

export function availableJevModelLanes(
  models: ReadonlyArray<Pick<ServerProviderModel, "slug" | "capabilities">>,
): ReadonlyArray<TaskRouteModelLane> {
  const availableSlugs = new Set(
    models.filter((model) => model.capabilities !== null).map((model) => model.slug),
  );
  return (Object.keys(LANE_MODEL_SLUGS) as Array<TaskRouteModelLane>).filter((lane) =>
    LANE_MODEL_SLUGS[lane].some((slug) => availableSlugs.has(slug)),
  );
}

/** Returns a submission-only selection; it never changes the picker or global preference. */
export function resolveJevModelSelection({
  suggestion,
  models,
  selected,
}: {
  suggestion: TaskRouteSuggestion;
  models: ReadonlyArray<Pick<ServerProviderModel, "slug" | "capabilities">>;
  selected: ModelSelection;
}): ModelSelection | null {
  if (suggestion.status !== "ready" || suggestion.confidence < MINIMUM_CONFIDENCE) return null;
  if (suggestion.lane === "code") return null;
  const availableSlugs = new Set(models.map((model) => model.slug));
  const modelSlug = LANE_MODEL_SLUGS[suggestion.lane].find((slug) => availableSlugs.has(slug));
  const model = models.find((candidate) => candidate.slug === modelSlug);
  if (!model?.capabilities) return null;
  // Option ids are model-specific. Preserve only explicit values which the
  // chosen model advertises, including a false `fastMode` when it supports it.
  const options = buildExplicitProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({ caps: model.capabilities, selections: selected.options }),
    selected.options,
  );
  return createModelSelection(selected.instanceId, model.slug, options);
}
