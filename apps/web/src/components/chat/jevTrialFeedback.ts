import type { TaskRouteSuggestion } from "@t3tools/contracts";

type ReadySuggestion = Extract<TaskRouteSuggestion, { status: "ready" }>;
export type TrialFeedback = "good_fit" | "too_weak" | "too_much";
export type TrialModelFamily = "astra" | "sol" | "terra" | "luna" | "other";
export interface TrialRecord {
  time: number;
  lane: ReadySuggestion["lane"];
  confidence: number;
  selected: TrialModelFamily;
  feedback: TrialFeedback;
}
export const JEV_TRIAL_STORAGE_KEY = "t3code:jev-trial-feedback:v1";
const LANES = new Set(["code", "luna", "terra", "astra"]);
const FAMILIES = new Set(["luna", "terra", "sol", "astra", "other"]);
const FEEDBACK = new Set(["good_fit", "too_weak", "too_much"]);

export function trialModelFamily(model: string): TrialModelFamily {
  for (const family of ["astra", "sol", "terra", "luna"] as const) {
    if (
      model
        .toLowerCase()
        .split(/[-_\s]/)
        .includes(family)
    )
      return family;
  }
  return "other";
}

/** Reconstruct an allowlisted record; never retain arbitrary fields from storage. */
export function readTrialRecords(raw: string | null): TrialRecord[] {
  try {
    const values: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(values)) return [];
    return values
      .flatMap((value): TrialRecord[] => {
        if (
          typeof value !== "object" ||
          value === null ||
          typeof value.time !== "number" ||
          !Number.isFinite(value.time) ||
          typeof value.confidence !== "number" ||
          !Number.isFinite(value.confidence) ||
          value.confidence < 0 ||
          value.confidence > 1 ||
          !LANES.has(value.lane) ||
          !FAMILIES.has(value.selected) ||
          !FEEDBACK.has(value.feedback)
        )
          return [];
        return [
          {
            time: value.time,
            lane: value.lane,
            confidence: value.confidence,
            selected: value.selected,
            feedback: value.feedback,
          },
        ];
      })
      .slice(-100);
  } catch {
    return [];
  }
}

export function appendTrialRecord(raw: string | null, record: TrialRecord): string {
  return JSON.stringify(readTrialRecords(JSON.stringify([...readTrialRecords(raw), record])));
}
