import { describe, it, expect } from "vitest";
import { buildDashboardHtml } from "./report.js";
import { parseAgentMeta } from "./generator.js";
import type { RunRecord, TeamManifest } from "./types.js";

const manifest: TeamManifest = {
  generatedBy: "agent-team-factory",
  preset: "new-service",
  presetName: "新サービス検討チーム",
  project: "example",
  requirements: { phase: "greenfield", focus: ["planning"], teamSize: "standard" },
  agents: [
    { file: "product-planner.md", name: "product-planner", description: "企画リード" },
    { file: "market-researcher.md", name: "market-researcher", description: "市場調査" },
  ],
  flow: [
    ["market-researcher", "product-planner"],
    ["market-researcher", "biz-evaluator"], // チームに含まれないエージェントへの辺
  ],
};

describe("buildDashboardHtml", () => {
  it("チーム構成のフローチャートとエージェントカードを含む", () => {
    const html = buildDashboardHtml(manifest, []);
    expect(html).toContain("flowchart LR");
    expect(html).toContain("market-researcher --> product-planner");
    expect(html).toContain("企画リード");
    expect(html).toContain("実行記録はまだありません");
  });

  it("チームに含まれないエージェントへの辺は描かない", () => {
    const html = buildDashboardHtml(manifest, []);
    expect(html).not.toContain("biz-evaluator");
  });

  it("実行記録をテーブルに反映し、HTML をエスケープする", () => {
    const runs: RunRecord[] = [
      {
        agent: "market-researcher",
        task: "<script>alert(1)</script> 競合調査",
        outputs: "競合比較表",
        status: "success",
        finishedAt: "2026-07-28T10:00:00Z",
      },
    ];
    const html = buildDashboardHtml(manifest, runs);
    expect(html).toContain("競合比較表");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("parseAgentMeta", () => {
  it("frontmatter から name と description を抽出する", () => {
    const md = "---\nname: architect\ndescription: 設計担当\n---\n\n本文";
    expect(parseAgentMeta(md, "fallback")).toEqual({ name: "architect", description: "設計担当" });
  });

  it("frontmatter がなければフォールバック名を使う", () => {
    expect(parseAgentMeta("本文のみ", "fallback").name).toBe("fallback");
  });
});
