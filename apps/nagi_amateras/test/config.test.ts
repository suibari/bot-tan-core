import { describe, it, expect } from "vitest";
import { LABEL_DEFINITIONS, CONFIG } from "../src/config.js";

describe("Labeler Configuration & Definitions", () => {
  it("has valid default CONFIG structure", () => {
    expect(CONFIG.did).toBeDefined();
    expect(CONFIG.did).toMatch(/^did:plc:[a-z0-9]+$/);
    expect(CONFIG.port).toBeGreaterThan(0);
  });

  it("contains all standard AT Protocol and custom label definitions", () => {
    const identifiers = LABEL_DEFINITIONS.map((def) => def.identifier);
    expect(identifiers).toContain("sexual");
    expect(identifiers).toContain("nudity");
    expect(identifiers).toContain("graphic-media");
    expect(identifiers).toContain("hate");
    expect(identifiers).toContain("harassment");
    expect(identifiers).not.toContain("ai-generated");
    expect(identifiers).not.toContain("!warn");
  });

  it("has no duplicate label identifiers", () => {
    const identifiers = LABEL_DEFINITIONS.map((def) => def.identifier);
    const uniqueIdentifiers = new Set(identifiers);
    expect(uniqueIdentifiers.size).toBe(identifiers.length);
  });

  it("includes valid Japanese and English localization for all labels", () => {
    for (const def of LABEL_DEFINITIONS) {
      expect(def.locales).toBeDefined();
      expect(def.locales.length).toBeGreaterThanOrEqual(2);

      const ja = def.locales.find((l) => l.lang === "ja");
      const en = def.locales.find((l) => l.lang === "en");

      expect(ja).toBeDefined();
      expect(ja?.name).toBeTruthy();
      expect(ja?.description).toBeTruthy();

      expect(en).toBeDefined();
      expect(en?.name).toBeTruthy();
      expect(en?.description).toBeTruthy();
    }
  });

  it("has valid blurs and severity settings", () => {
    const validBlurs = ["content", "media", "none"];
    const validSeverities = ["inform", "alert", "none"];
    const validDefaultSettings = ["ignore", "warn", "hide"];

    for (const def of LABEL_DEFINITIONS) {
      expect(validBlurs).toContain(def.blurs);
      expect(validSeverities).toContain(def.severity);
      expect(validDefaultSettings).toContain(def.defaultSetting);
    }
  });
});
