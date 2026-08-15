import { describe, it, expect } from "vitest";
import {
  mapCategoryToLabel,
  evaluateModerationResult,
  DEFAULT_THRESHOLDS,
} from "../src/moderation/rules.js";
import { ModerationResult } from "../src/moderation/openai.js";

describe("Moderation Rules & Mapping", () => {
  describe("mapCategoryToLabel", () => {
    it("maps sexual categories to appropriate labels", () => {
      expect(mapCategoryToLabel("sexual")).toBe("sexual");
      expect(mapCategoryToLabel("sexual/minors")).toBe("!hide");
    });

    it("maps hate and harassment to appropriate labels", () => {
      expect(mapCategoryToLabel("hate")).toBe("hate");
      expect(mapCategoryToLabel("hate/threatening")).toBe("hate");
      expect(mapCategoryToLabel("harassment")).toBe("harassment");
      expect(mapCategoryToLabel("harassment/threatening")).toBe("harassment");
    });

    it("maps violence categories to appropriate labels", () => {
      expect(mapCategoryToLabel("violence/graphic")).toBe("graphic-media");
      expect(mapCategoryToLabel("violence")).toBe("!warn");
    });

    it("maps self-harm to !warn label", () => {
      expect(mapCategoryToLabel("self-harm")).toBe("!warn");
      expect(mapCategoryToLabel("self-harm/intent")).toBe("!warn");
    });
  });

  describe("evaluateModerationResult", () => {
    const createMockResult = (
      scores: Record<string, number>,
    ): ModerationResult => ({
      flagged: Object.values(scores).some((s) => s > 0.5),
      categories: Object.fromEntries(
        Object.entries(scores).map(([k, v]) => [k, v > 0.5]),
      ),
      categoryScores: scores,
      rawResponse: { id: "test", model: "omni-moderation-latest", results: [] },
    });

    it("returns 'none' action for clean content", () => {
      const result = createMockResult({
        sexual: 0.01,
        hate: 0.005,
        violence: 0.02,
        "self-harm": 0.001,
      });

      const evaluation = evaluateModerationResult(result, DEFAULT_THRESHOLDS);
      expect(evaluation.action).toBe("none");
      expect(evaluation.labels).toHaveLength(0);
    });

    it("does not label borderline content", () => {
      const result = createMockResult({
        sexual: 0.5, // Between observe (0.45) and label (0.75)
        hate: 0.01,
      });

      const evaluation = evaluateModerationResult(result, DEFAULT_THRESHOLDS);
      expect(evaluation.action).toBe("none");
      expect(evaluation.highestCategory).toBe("sexual");
      expect(evaluation.maxScore).toBe(0.5);
    });

    it("returns 'label' with appropriate AT Protocol labels for sensitive content", () => {
      const result = createMockResult({
        sexual: 0.85, // Above label threshold (0.75)
        hate: 0.01,
      });

      const evaluation = evaluateModerationResult(result, DEFAULT_THRESHOLDS);
      expect(evaluation.action).toBe("label");
      expect(evaluation.labels).toContain("sexual");
    });

    it("returns 'drop' for severe policy violations (AppView exclusion)", () => {
      const result = createMockResult({
        "hate/threatening": 0.9, // Above drop threshold (0.85)
        harassment: 0.8,
      });

      const evaluation = evaluateModerationResult(result, DEFAULT_THRESHOLDS);
      expect(evaluation.action).toBe("drop");
      expect(evaluation.labels).toContain("hate");
    });

    it("strictly drops child sexual abuse material (CSAM / sexual/minors)", () => {
      const result = createMockResult({
        "sexual/minors": 0.25, // Even 25% triggers drop (drop threshold: 0.20)
      });

      const evaluation = evaluateModerationResult(result, DEFAULT_THRESHOLDS);
      expect(evaluation.action).toBe("drop");
      expect(evaluation.labels).toContain("!hide");
    });
  });
});
