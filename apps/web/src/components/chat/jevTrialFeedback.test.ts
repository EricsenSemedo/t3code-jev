import { describe, expect, it } from "vite-plus/test";
import {
  appendTrialRecord,
  readTrialRecords,
  trialModelFamily,
  type TrialRecord,
} from "./jevTrialFeedback";

const record: TrialRecord = {
  time: 1,
  lane: "terra",
  confidence: 0.8,
  selected: "astra",
  feedback: "good_fit",
};

describe("Jev trial feedback privacy and persistence", () => {
  it("exports only known metadata even if storage contains task text or arbitrary fields", () => {
    const saved = readTrialRecords(
      JSON.stringify([
        { ...record, task: "private text", apiKey: "secret", model: "custom private endpoint" },
      ]),
    );
    expect(saved).toEqual([record]);
    expect(JSON.stringify(saved)).not.toContain("private");
    expect(JSON.stringify(saved)).not.toContain("secret");
  });

  it("rejects corrupt data, unknown enums and invalid confidence", () => {
    expect(readTrialRecords("not json")).toEqual([]);
    expect(readTrialRecords('{"task":"private"}')).toEqual([]);
    expect(
      readTrialRecords(
        JSON.stringify([null, { ...record, confidence: 3 }, { ...record, lane: "arbitrary" }]),
      ),
    ).toEqual([]);
  });

  it("bounds storage and keeps the newest feedback", () => {
    const old = JSON.stringify(Array.from({ length: 150 }, (_, time) => ({ ...record, time })));
    const next = readTrialRecords(
      appendTrialRecord(old, { ...record, time: 151, feedback: "too_weak" }),
    );
    expect(next).toHaveLength(100);
    expect(next[0]?.time).toBe(51);
    expect(next.at(-1)?.feedback).toBe("too_weak");
  });

  it("stores only known model families, never custom model names", () => {
    expect(trialModelFamily("gpt-6-astra")).toBe("astra");
    expect(trialModelFamily("gpt-5.6-luna")).toBe("luna");
    expect(trialModelFamily("custom-sensitive-model")).toBe("other");
  });
});
