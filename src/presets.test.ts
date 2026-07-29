import { describe, it, expect } from "vitest";
import { loadPresets, scorePresets } from "./presets.js";
import { render } from "./generator.js";
import type { RepoProfile, Requirements } from "./types.js";

const profile: RepoProfile = {
  path: "/tmp/example",
  name: "example",
  languages: ["typescript"],
  frameworks: ["react"],
  hasCI: true,
  hasTests: true,
  fileCount: 100,
};

describe("loadPresets", () => {
  it("同梱プリセットをロードできる", () => {
    const presets = loadPresets();
    const ids = presets.map((p) => p.id);
    expect(ids).toContain("web-dev");
    expect(ids).toContain("quality-review");
    expect(ids).toContain("security-audit");
    for (const p of presets) {
      expect(p.agents.length).toBeGreaterThan(0);
    }
  });
});

describe("scorePresets", () => {
  it("security 重視なら security-audit が最上位になる", () => {
    const requirements: Requirements = {
      phase: "maintenance",
      focus: ["security"],
      teamSize: "standard",
    };
    const ranked = scorePresets(loadPresets(), profile, requirements);
    expect(ranked[0].preset.id).toBe("security-audit");
  });

  it("greenfield + planning 重視なら new-service が最上位になる", () => {
    const requirements: Requirements = {
      phase: "greenfield",
      focus: ["planning"],
      teamSize: "standard",
    };
    const ranked = scorePresets(loadPresets(), profile, requirements);
    expect(ranked[0].preset.id).toBe("new-service");
  });

  it("TypeScript + react + speed 重視なら web-dev が最上位になる", () => {
    const requirements: Requirements = {
      phase: "active",
      focus: ["speed"],
      teamSize: "standard",
    };
    const ranked = scorePresets(loadPresets(), profile, requirements);
    expect(ranked[0].preset.id).toBe("web-dev");
  });
});

describe("render", () => {
  it("プレースホルダを置換し、未知のキーは空文字にする", () => {
    expect(render("{{projectName}} / {{unknown}}", { projectName: "x" })).toBe("x / ");
  });
});
