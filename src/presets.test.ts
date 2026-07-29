import { describe, it, expect } from "vitest";
import { loadPresets, scorePresets, uncoveredFocus } from "./presets.js";
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

  it("batch 重視なら batch-dev が最上位になる", () => {
    const requirements: Requirements = {
      phase: "active",
      focus: ["batch"],
      teamSize: "standard",
    };
    const javaProfile: RepoProfile = { ...profile, languages: ["java"], frameworks: [] };
    const ranked = scorePresets(loadPresets(), javaProfile, requirements);
    expect(ranked[0].preset.id).toBe("batch-dev");
  });

  it("docs 重視なら docs-team、mobile 重視なら mobile-dev、infra 重視なら infra-sre が最上位になる", () => {
    const base: Requirements = { phase: "active", focus: [], teamSize: "standard" };
    const top = (focus: string, p: RepoProfile = profile) =>
      scorePresets(loadPresets(), p, { ...base, focus: [focus] })[0].preset.id;

    expect(top("docs")).toBe("docs-team");
    expect(top("mobile", { ...profile, languages: ["swift"], frameworks: [] })).toBe("mobile-dev");
    expect(top("infra", { ...profile, languages: [], frameworks: ["docker"] })).toBe("infra-sre");
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

describe("uncoveredFocus", () => {
  // 同梱プリセットは全 focus をカバーしているため、未カバーの検証には架空の値を使う
  it("どのプリセットもカバーしない focus を返す", () => {
    const requirements: Requirements = {
      phase: "active",
      focus: ["compliance"],
      teamSize: "standard",
    };
    expect(uncoveredFocus(loadPresets(), requirements)).toEqual(["compliance"]);
  });

  it("カバーされている focus は返さない(部分カバーは未カバー分のみ)", () => {
    const requirements: Requirements = {
      phase: "active",
      focus: ["quality", "compliance"],
      teamSize: "standard",
    };
    expect(uncoveredFocus(loadPresets(), requirements)).toEqual(["compliance"]);
  });

  it("ヒアリングの全 focus 選択肢がいずれかのプリセットにカバーされている", () => {
    // hearing.ts の選択肢と同期していることの保証(未カバーの選択肢は generate 中断につながる)
    const allChoices = ["quality", "security", "speed", "testing", "batch", "mobile", "infra", "docs", "planning"];
    const requirements: Requirements = {
      phase: "active",
      focus: allChoices,
      teamSize: "standard",
    };
    expect(uncoveredFocus(loadPresets(), requirements)).toEqual([]);
  });
});

describe("render", () => {
  it("プレースホルダを置換し、未知のキーは空文字にする", () => {
    expect(render("{{projectName}} / {{unknown}}", { projectName: "x" })).toBe("x / ");
  });
});
