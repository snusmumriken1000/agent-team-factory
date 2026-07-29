import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDashboardHtml, buildFlowPreviewHtml, loadTaskDrafts } from "./report.js";
import { parseAgentMeta } from "./generator.js";
import type { Preset, RepoProfile, Requirements, RunRecord, TaskDraft, TeamManifest } from "./types.js";

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

  it("PR フローとタッチポイントを仕組みカードとメタ情報に反映する", () => {
    const withPr = {
      ...manifest,
      requirements: {
        ...manifest.requirements,
        prFlow: true,
        githubRepo: "octocat/hello-world",
        touchpoints: ["pr-merge"],
      },
    };
    const html = buildDashboardHtml(withPr, []);
    expect(html).toContain("PR ベースの変更フロー");
    expect(html).toContain("人間のタッチポイント");
    expect(html).toContain("PR マージはユーザーが実行");
    expect(html).toContain("あり(マージ: ユーザー)");
    expect(html).not.toContain("未導入(PR フローを有効にすると追加)");

    // pr-merge を選ばなければエージェントがマージする表示になる
    const agentMerge = {
      ...withPr,
      requirements: { ...withPr.requirements, touchpoints: [] },
    };
    const htmlAgent = buildDashboardHtml(agentMerge, []);
    expect(htmlAgent).toContain("あり(マージ: エージェント)");
    expect(htmlAgent).toContain("エージェントがマージ");
  });

  it("PR フローが無効なら関連する仕組みを未導入として表示する", () => {
    const html = buildDashboardHtml(manifest, []);
    expect(html).toContain("未導入(PR フローを有効にすると追加)");
    expect(html).toContain("PR フロー: なし");
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

describe("loadTaskDrafts", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "atf-report-test-"));
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  const writeDraft = (file: string, content: string) => {
    const dir = join(repoDir, ".claude", "atf-issues");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), content);
  };

  it("atf-issues がなければ空を返す", () => {
    expect(loadTaskDrafts(repoDir)).toEqual([]);
  });

  it("タイトル・ref・依存(depends コメント)を抽出する", () => {
    writeDraft("draft-01-scaffold.md", "# 足場を作る\n\n本文");
    writeDraft("draft-02-app.md", "# アプリを作る\n\n本文\n\n<!-- depends: draft-01 -->");
    const tasks = loadTaskDrafts(repoDir);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ ref: "draft-01", title: "足場を作る", dependsOn: [] });
    expect(tasks[1]).toMatchObject({ ref: "draft-02", dependsOn: ["draft-01"] });
  });

  it("depends コメントがなければ本文中の他ドラフト参照を依存とみなす", () => {
    writeDraft("draft-01-scaffold.md", "# 足場を作る\n\n本文");
    writeDraft("draft-02-app.md", "# アプリを作る\n\n足場(draft-01)の上に実装する。");
    const tasks = loadTaskDrafts(repoDir);
    expect(tasks[1].dependsOn).toEqual(["draft-01"]);
  });
});

describe("タスク依存関係セクション", () => {
  const tasks: TaskDraft[] = [
    { id: "draft-01-scaffold", ref: "draft-01", file: "draft-01-scaffold.md", title: "足場を作る", dependsOn: [] },
    {
      id: "draft-02-app",
      ref: "draft-02",
      file: "draft-02-app.md",
      title: "<b>アプリ</b>を作る",
      dependsOn: ["draft-01"],
    },
  ];

  it("タスク依存グラフを Mermaid で描き、タイトルをエスケープする", () => {
    const html = buildDashboardHtml(manifest, [], tasks);
    expect(html).toContain("タスク依存関係");
    expect(html).toContain("flowchart TD");
    expect(html).toContain("draft-01-scaffold --> draft-02-app");
    expect(html).toContain("&lt;b&gt;アプリ&lt;/b&gt;");
    expect(html).not.toContain("<b>アプリ</b>");
  });

  it("タスクがなければ案内文を表示する", () => {
    const html = buildDashboardHtml(manifest, []);
    expect(html).toContain("タスクドラフトはまだありません");
  });
});

describe("buildFlowPreviewHtml", () => {
  const preset: Preset = {
    id: "web-dev",
    name: "Web アプリ開発チーム",
    description: "",
    match: {},
    agents: ["architect.md", "implementer.md"],
    flow: [["architect", "implementer"]],
    dir: "/tmp/unused",
  };
  const profile: RepoProfile = {
    path: "/tmp/unused",
    name: "example",
    languages: ["typescript"],
    frameworks: [],
    hasCI: false,
    hasTests: false,
    fileCount: 1,
  };

  it("重視観点・開発フロー・タッチポイント候補を提示する", () => {
    const req: Requirements = {
      phase: "active",
      focus: ["speed"],
      teamSize: "standard",
      issueDriven: true,
      githubRepo: "octocat/hello-world",
      prFlow: true,
    };
    const html = buildFlowPreviewHtml(preset, profile, req);
    expect(html).toContain("開発フロープレビュー");
    expect(html).toContain("開発スピード"); // focus のラベル表示
    expect(html).toContain("gh issue create -R octocat/hello-world"); // Issue の作られ方
    expect(html).toContain("gh pr create -R octocat/hello-world"); // PR の作られ方
    expect(html).toContain("feature/issue-"); // ブランチの作られ方
    expect(html).toContain("タッチポイント候補");
    expect(html).toContain("PR マージ");
    expect(html).toContain("Issue 着手前");
    expect(html).toContain('architect["architect"] --> implementer["implementer"]'); // チーム構成(予定)
  });

  it("Issue 駆動・PR フローが無効なら候補なしの案内を表示する", () => {
    const req: Requirements = { phase: "active", focus: ["speed"], teamSize: "standard" };
    const html = buildFlowPreviewHtml(preset, profile, req);
    expect(html).toContain("選択できるタッチポイントはありません");
    expect(html).toContain("PR フローは無効");
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
