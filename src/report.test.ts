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

  it("Issue 駆動のときだけ Issue 列を表示する", () => {
    const runs: RunRecord[] = [
      { agent: "market-researcher", task: "調査", issue: "#42", finishedAt: "2026-07-28T10:00:00Z" },
    ];
    const issueDriven = {
      ...manifest,
      requirements: { ...manifest.requirements, issueDriven: true },
    };
    const html = buildDashboardHtml(issueDriven, runs);
    expect(html).toContain("<th>Issue</th>");
    expect(html).toContain("#42");
    expect(html).toContain("Issue 駆動");

    const htmlWithout = buildDashboardHtml(manifest, runs);
    expect(htmlWithout).not.toContain("<th>Issue</th>");
  });

  it("ハーネス / ガードレール / フィードバックループの 3 要素セクションを含む", () => {
    const runs: RunRecord[] = [
      { agent: "market-researcher", status: "success", finishedAt: "2026-07-28T10:00:00Z" },
      { agent: "product-planner", status: "failure", finishedAt: "2026-07-28T11:00:00Z" },
    ];
    const html = buildDashboardHtml(manifest, runs);
    expect(html).toContain("実行環境の仕組み");
    expect(html).toContain("ハーネス");
    expect(html).toContain("ガードレール");
    expect(html).toContain("フィードバックループ");
    // マニフェスト・実行記録から動的に導出される値
    expect(html).toContain("2 体"); // エージェント数
    expect(html).toContain("1 本定義"); // チーム内で完結するフローの数(除外辺はカウントしない)
    expect(html).toContain("現在 2 件"); // 実行記録数
    expect(html).toContain("現在 1 件"); // failure 数
    expect(html).toContain("標準構成(最大 5 体)");
  });

  it("Issue 駆動でないとき、Issue 関連の仕組みは未導入として表示する", () => {
    const html = buildDashboardHtml(manifest, []);
    expect(html).toContain("未導入(Issue 駆動を有効にすると追加)");

    const issueDriven = {
      ...manifest,
      requirements: { ...manifest.requirements, issueDriven: true },
    };
    const htmlOn = buildDashboardHtml(issueDriven, []);
    expect(htmlOn).not.toContain("未導入(Issue 駆動を有効にすると追加)");
    expect(htmlOn).toContain("Issue 起点のタスク供給");
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
