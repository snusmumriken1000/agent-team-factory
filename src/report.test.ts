import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildArchSection,
  buildCapabilitySection,
  buildDashboardHtml,
  buildEvalSection,
  buildReverseSection,
  buildFlowPreviewHtml,
  buildSkillSection,
  buildTechStackSection,
  buildSpecSection,
  loadTaskDrafts,
} from "./report.js";
import { parseAgentMeta } from "./generator.js";
import type {
  ArchRuleSet,
  CapabilityFinding,
  EvaluationRecord,
  Rubric,
  Preset,
  RepoProfile,
  Requirements,
  ReverseDocStatus,
  RunRecord,
  SpecCheckRecord,
  SpecModel,
  TaskDraft,
  TeamManifest,
} from "./types.js";

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

  it("書式ガイド(README.md)はドラフトとして数えない", () => {
    const dir = join(repoDir, ".claude", "atf-issues");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "# 書式ガイド\n");
    writeFileSync(join(dir, "draft-01-login.md"), "# ログイン画面\n");

    expect(loadTaskDrafts(repoDir).map((t) => t.ref)).toEqual(["draft-01"]);
  });

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

  it("形式仕様モードでは Alloy 検証を実装前ゲートとして提示する", () => {
    const req: Requirements = {
      phase: "active",
      focus: ["speed"],
      teamSize: "standard",
      formalSpec: true,
    };
    const html = buildFlowPreviewHtml(preset, profile, req);
    expect(html).toContain("形式仕様(Alloy)+ ADR を要件・仕様の単一情報源にする");
    expect(html).toContain("docs/adr/");
    expect(html).toContain("atf-bin/weave.sh");
    expect(html).toContain("atf-bin/formal.sh");
    // 開発フロー図に形式化 → 検証 → 実装 と、反例時の差し戻しが描かれる
    expect(html).toContain("spec --> verify");
    expect(html).toContain("verify --> impl");
    expect(html).toContain("verify -- 反例・充足不能 --> spec");

    const off = buildFlowPreviewHtml(preset, profile, {
      phase: "active",
      focus: ["speed"],
      teamSize: "standard",
    });
    expect(off).toContain("形式仕様モードは無効");
    expect(off).not.toContain("spec --> verify");
  });

  it("最新機能スカウトでは調査・採否表・計画書の作られ方を提示する", () => {
    const req: Requirements = {
      phase: "active",
      focus: ["speed"],
      teamSize: "standard",
      capabilityScout: true,
    };
    const html = buildFlowPreviewHtml(preset, profile, req);
    expect(html).toContain("最新機能の取り込み(Claude Code / Codex)");
    expect(html).toContain("findings.jsonl");
    expect(html).toContain("最新機能スカウト: あり");
    expect(html).toContain("承認"); // 取り込みの可否はユーザーが決める

    const off = buildFlowPreviewHtml(preset, profile, {
      phase: "active",
      focus: ["speed"],
      teamSize: "standard",
    });
    expect(off).toContain("最新機能スカウトは無効");
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

describe("buildSpecSection", () => {
  const models: SpecModel[] = [
    {
      file: "order.als",
      module: "order",
      doc: {
        prose: [],
        tags: [
          { name: "module", value: "order" },
          { name: "out-of-scope", value: "出荷通知は 5 分以内に送る" },
        ],
      },
      declarations: [],
      requirements: [
        { id: "R-01", text: "注文は 1 人の顧客に属する", declarations: ["NoOrphanOrder"], line: 1 },
        {
          id: "R-02",
          text: "キャンセル済みの注文は出荷されない",
          declarations: ["CancelledIsNeverShipped"],
          line: 2,
        },
      ],
      commands: [
        { kind: "check", name: "NoOrphanOrder", scope: "for 5", requirements: ["R-01"], line: 3 },
        {
          kind: "check",
          name: "CancelledIsNeverShipped",
          scope: "for 5",
          requirements: ["R-02"],
          line: 4,
        },
        { kind: "run", name: "Consistent", scope: "for 5", requirements: [], line: 5 },
      ],
    },
  ];

  it("モデルがなければ案内だけを表示する", () => {
    expect(buildSpecSection([], [])).toContain("Alloy モデルはまだありません");
  });

  it("未検証のコマンドがあればゲートを未確認として表示する", () => {
    const html = buildSpecSection(models, []);
    expect(html).toContain("実装前ゲート: <b>未確認</b>");
    expect(html).toContain("R-01");
    expect(html).toContain("check NoOrphanOrder");
    expect(html).toContain("出荷通知は 5 分以内に送る"); // @out-of-scope
  });

  it("最新の検証記録を採用し、すべて充足ならゲート通過を表示する", () => {
    const checks: SpecCheckRecord[] = [
      { model: "order.als", command: "NoOrphanOrder", result: "counterexample", checkedAt: "2026-01-01T00:00:00Z" },
      { model: "order.als", command: "NoOrphanOrder", result: "pass", checkedAt: "2026-01-02T00:00:00Z" },
      { model: "order.als", command: "CancelledIsNeverShipped", result: "pass", checkedAt: "2026-01-02T00:00:00Z" },
      { model: "order.als", command: "Consistent", result: "instance", checkedAt: "2026-01-02T00:00:00Z" },
    ];
    const html = buildSpecSection(models, checks);
    expect(html).toContain("実装前ゲート: <b>通過</b>");
    expect(html).toContain("2026-01-02T00:00:00Z");
    expect(html).not.toContain("反例あり");
  });

  it("反例が残っていればゲート未通過として警告する", () => {
    const checks: SpecCheckRecord[] = [
      { model: "order.als", command: "NoOrphanOrder", result: "pass" },
      { model: "order.als", command: "CancelledIsNeverShipped", result: "counterexample", detail: "Counterexample found." },
      { model: "order.als", command: "Consistent", result: "no-instance" },
    ];
    const html = buildSpecSection(models, checks);
    expect(html).toContain("実装前ゲート: <b>未通過</b>");
    expect(html).toContain("反例あり");
    expect(html).toContain("充足不能");
    expect(html).toContain("spec-ng");
  });

  it("モデルごとの解説ページへのリンクを出す", () => {
    const html = buildSpecSection(models, []);
    expect(html).toContain('href="../docs/generated/order.explain.html"');
    expect(html).toContain("order.als の解説");
  });

  it("反例から確定した仕様を、未確認の件数つきで表示する", () => {
    const html = buildSpecSection(models, [], [
      {
        requirement: "R-02",
        model: "order.als",
        finding: "キャンセル済みなのに出荷される反例",
        decision: "出荷済みの注文はキャンセルできない",
        rationale: "在庫と請求の整合性が崩れる案しかない",
        alternatives: ["キャンセル時に出荷を取り消す"],
        changed: ["spec/order.als"],
        decidedAt: "2026-01-02T00:00:00Z",
        status: "auto",
      },
      {
        requirement: "R-01",
        finding: "顧客のいない注文",
        decision: "顧客は必須",
        rationale: "ユーザーが了承",
        status: "confirmed",
      },
    ]);
    expect(html).toContain("ユーザー未確認 1 件");
    expect(html).toContain("出荷済みの注文はキャンセルできない");
    expect(html).toContain("採らなかった案: キャンセル時に出荷を取り消す");
    expect(html).toContain("確認済み");
  });

  it("確定の記録がなければ、その表は出さない", () => {
    expect(buildSpecSection(models, [])).not.toContain("反例から確定した仕様");
  });
});

describe("buildDashboardHtml (形式仕様)", () => {
  const specs = {
    models: [
      {
        file: "order.als",
        module: "order",
        declarations: [],
        requirements: [
          { id: "R-01", text: "注文は 1 人の顧客に属する", declarations: ["NoOrphanOrder"], line: 1 },
        ],
        commands: [
          {
            kind: "check" as const,
            name: "NoOrphanOrder",
            requirements: ["R-01"],
            line: 2,
          },
        ],
      },
    ],
    checks: [{ model: "order.als", command: "NoOrphanOrder", result: "pass" as const }],
  };

  it("formalSpec が有効なときだけ形式仕様セクションを表示する", () => {
    const withSpec = {
      ...manifest,
      requirements: { ...manifest.requirements, formalSpec: true },
    };
    const html = buildDashboardHtml(withSpec, [], [], specs);
    expect(html).toContain("形式仕様(Alloy)と実装前検証");
    expect(html).toContain("R-01");
    expect(html).toContain("実装前の形式検証ゲート"); // ガードレールの項目
    expect(html).toContain("実装前ゲート: <b>通過</b>");

    const html2 = buildDashboardHtml(manifest, [], [], specs);
    expect(html2).not.toContain("形式仕様(Alloy)と実装前検証");
    expect(html2).toContain("未導入(形式仕様モードを有効にすると追加)");
  });
});

describe("buildCapabilitySection", () => {
  const findings: CapabilityFinding[] = [
    {
      id: "cx-bar",
      product: "codex",
      name: "Bar",
      summary: "Codex の新機能",
      verdict: "reject",
      reason: "前提の有料プランを満たせない",
      version: "codex 0.1.0",
    },
    {
      id: "cc-foo",
      product: "claude-code",
      name: "Foo",
      summary: "Claude Code の新機能",
      verdict: "adopt",
      reason: "手元の版で動作確認済み",
      evidence: "実行して確認",
      version: "claude-code 2.0.0",
      effort: "M",
      plan: "plan-cc-foo.md",
      surveyedAt: "2026-09-01T00:00:00Z",
    },
    {
      id: "cc-baz",
      product: "claude-code",
      name: "Baz",
      summary: "版が上がれば使える機能",
      verdict: "hold",
      reason: "2.1.0 以降が必要",
    },
  ];

  it("調査がなければ案内だけを表示する", () => {
    expect(buildCapabilitySection([])).toContain("最新機能の調査結果はまだありません");
  });

  it("組み込めるもの・組み込めないものを 1 つの表に、組み込める順で並べる", () => {
    const html = buildCapabilitySection(findings, [
      { file: "plan-cc-foo.md", id: "cc-foo", title: "Foo の組み込み計画" },
    ]);

    // 表は 1 つだけ(組み込める / 組み込めないで分割しない)
    expect(html.match(/<table>/g)).toHaveLength(1);
    expect(html.indexOf("Foo")).toBeLessThan(html.indexOf("Baz"));
    expect(html.indexOf("Baz")).toBeLessThan(html.indexOf("Bar"));
    // 判定は絵文字ではなく色付きチップで示す(HTML 側は絵文字を使わない)
    expect(html).toContain('<span class="chip chip-ok">組み込める</span>');
    expect(html).toContain('<span class="chip chip-ng">組み込めない</span>');
    expect(html).toContain("取り込み候補: <b>1 件</b>(計画書あり 1 件)");
    // 計画書があればリンクする
    expect(html).toContain('href="atf-capabilities/plan-cc-foo.md"');
    expect(html).toContain("Foo の組み込み計画");
  });

  it("計画書が未作成なら未作成と表示する", () => {
    const html = buildCapabilitySection([{ ...findings[1], plan: "plan-cc-foo.md" }], []);
    expect(html).toContain("未作成");
    expect(html).not.toContain('href="atf-capabilities/plan-cc-foo.md"');
  });

  it("組み込めるものがなければ候補なしとして表示する", () => {
    const html = buildCapabilitySection(findings.filter((f) => f.verdict !== "adopt"));
    expect(html).toContain("取り込み候補: <b>なし</b>");
  });

  it("エージェント由来の文字列をエスケープする", () => {
    const html = buildCapabilitySection([
      {
        id: "x",
        product: "claude-code",
        name: "<script>alert(1)</script>",
        summary: "s",
        verdict: "adopt",
        reason: "r",
      },
    ]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("buildDashboardHtml (最新機能スカウト)", () => {
  const capabilities = {
    findings: [
      {
        id: "cc-foo",
        product: "claude-code",
        name: "Foo",
        summary: "Claude Code の新機能",
        verdict: "adopt" as const,
        reason: "手元の版で動作確認済み",
      },
    ],
    plans: [],
  };

  it("capabilityScout が有効なときだけ最新機能セクションを表示する", () => {
    const withScout = {
      ...manifest,
      requirements: { ...manifest.requirements, capabilityScout: true },
    };
    const html = buildDashboardHtml(withScout, [], [], undefined, capabilities);
    expect(html).toContain("最新機能の取り込み(Claude Code / Codex)");
    expect(html).toContain("Claude Code の新機能");
    expect(html).toContain("取り込みの承認"); // ガードレールの項目
    expect(html).toContain("最新機能スカウト: あり(調査 1 件)");

    const html2 = buildDashboardHtml(manifest, [], [], undefined, capabilities);
    expect(html2).not.toContain("最新機能の取り込み(Claude Code / Codex)");
    expect(html2).toContain("未導入(最新機能スカウトを有効にすると追加)");
  });
});

describe("buildSkillSection", () => {
  const skills = [
    {
      id: "taste-skill",
      name: "design-taste-frontend",
      description: "Anti-slop frontend skill",
      category: "aesthetic",
      source: {
        repo: "Leonxlnx/taste-skill",
        homepage: "https://github.com/Leonxlnx/taste-skill",
        path: "skills/taste-skill/SKILL.md",
        commit: "ccbc15639c97057cbfcf32ecebc38ef716e4bb37",
        license: "MIT",
      },
    },
  ];

  it("スキル名・分類・出典を表にする", () => {
    const html = buildSkillSection(skills);
    expect(html).toContain("design-taste-frontend");
    expect(html).toContain("Leonxlnx/taste-skill");
    expect(html).toContain("MIT");
    expect(html).toContain("ccbc15639c"); // commit は先頭だけ表示する
  });

  it("未導入なら追加方法を案内する", () => {
    expect(buildSkillSection([])).toContain("atf apply design");
  });

  it("スキル由来の文字列をエスケープする", () => {
    const html = buildSkillSection([
      { ...skills[0], description: '<img src=x onerror="alert(1)">' },
    ]);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("ダッシュボードはスキルがあるときだけセクションを出す", () => {
    expect(buildDashboardHtml(manifest, [])).not.toContain("<h2>デザインスキル</h2>");
    expect(buildDashboardHtml({ ...manifest, skills }, [])).toContain("<h2>デザインスキル</h2>");
  });

  it("ハーネスのカードに導入状況を出す(未導入なら薄く表示)", () => {
    expect(buildDashboardHtml(manifest, [])).toContain(
      "未導入(重視観点に「UI/UX デザイン品質」を選ぶと追加)",
    );
    expect(buildDashboardHtml({ ...manifest, skills }, [])).toContain(
      "<code>.claude/skills/</code> に 1 件",
    );
  });
});

describe("buildFlowPreviewHtml (デザインスキル)", () => {
  const previewProfile: RepoProfile = {
    path: "/tmp/example",
    name: "example",
    languages: ["typescript"],
    frameworks: ["react"],
    hasCI: false,
    hasTests: false,
    fileCount: 1,
  };
  const previewPreset: Preset = {
    id: "web-dev",
    name: "Web アプリ開発チーム",
    description: "標準的な開発チーム",
    match: {},
    agents: ["architect.md"],
    dir: "/tmp/preset",
  };

  it("導入予定のスキルをチーム構築の確認前に提示する", () => {
    const html = buildFlowPreviewHtml(previewPreset, previewProfile, {
      phase: "active",
      focus: ["design"],
      teamSize: "minimal",
      designSkills: ["taste-skill"],
    });
    expect(html).toContain("デザインスキル");
    expect(html).toContain("design-taste-frontend");
  });

  it("未選択なら「導入しない」と明示する", () => {
    const html = buildFlowPreviewHtml(previewPreset, previewProfile, {
      phase: "active",
      focus: ["quality"],
      teamSize: "minimal",
    });
    expect(html).toContain("デザインスキルは導入しない");
  });
});

describe("buildTechStackSection", () => {
  const stack = {
    languages: ["java"],
    frameworks: ["liquibase", "tbls"],
    categories: { languages: ["java"], database: ["liquibase", "tbls"] },
  };

  it("カテゴリ別の表示名で表を組み立てる", () => {
    const html = buildTechStackSection(stack);
    expect(html).toContain("言語");
    expect(html).toContain("Java");
    expect(html).toContain("データベース・スキーマ管理");
    expect(html).toContain("Liquibase(マイグレーション)");
    expect(html).toContain("tbls(スキーマドキュメント生成)");
  });

  it("未設定なら空文字(見出しごと省略される)", () => {
    expect(buildTechStackSection(undefined)).toBe("");
  });

  it("ダッシュボードとフロープレビューの両方に表示する", () => {
    const dashboard = buildDashboardHtml(
      { ...manifest, requirements: { ...manifest.requirements, techStack: stack } },
      [],
    );
    expect(dashboard).toContain("<h2>技術スタック</h2>");
    expect(dashboard).toContain("Liquibase(マイグレーション)");
    expect(buildDashboardHtml(manifest, [])).not.toContain("<h2>技術スタック</h2>");

    const previewPreset: Preset = {
      id: "web-dev",
      name: "Web 開発チーム",
      description: "Web アプリ開発",
      dir: "/tmp/preset",
      match: {},
      agents: ["frontend-dev.md"],
      flow: [["frontend-dev", "backend-dev"]],
    };
    const previewProfile: RepoProfile = {
      path: "/tmp/example",
      name: "example",
      languages: ["typescript"],
      frameworks: [],
      hasCI: false,
      hasTests: false,
      fileCount: 3,
    };
    const preview = buildFlowPreviewHtml(previewPreset, previewProfile, {
      phase: "active",
      focus: ["speed"],
      teamSize: "standard",
      techStack: stack,
    });
    expect(preview).toContain("<h2>技術スタック</h2>");
    expect(preview).toContain("tbls(スキーマドキュメント生成)");
  });
});

describe("buildReverseSection", () => {
  const status = (over: Partial<ReverseDocStatus> = {}): ReverseDocStatus => ({
    record: {
      path: "docs/architecture/overview.md",
      title: "システム全体像",
      kind: "overview",
      sources: ["src/cli.ts"],
      diagram: "docs/architecture/diagrams/overview.html",
      diagramType: "architecture",
      commit: "a1b2c3d",
      generatedAt: "2026-01-01T00:00:00Z",
    },
    docExists: true,
    diagramExists: true,
    missingSources: [],
    ...over,
  });

  it("文書 ↔ 根拠コード ↔ 図の対応を表にし、追随していれば鮮度を通過にする", () => {
    const html = buildReverseSection([status()]);
    expect(html).toContain("システム全体像");
    expect(html).toContain("docs/architecture/diagrams/overview.html");
    expect(html).toContain("src/cli.ts");
    expect(html).toContain("全体像(システム概要)");
    expect(html).toContain("ドキュメントの鮮度: <b>追随</b>");
  });

  it("根拠コードが消えた文書・欠けた図を要再生成として表示する", () => {
    const html = buildReverseSection([
      status({ diagramExists: false, missingSources: ["src/cli.ts"] }),
    ]);
    expect(html).toContain("要再生成 1 件");
    expect(html).toContain("根拠のコードが消えている");
    expect(html).toContain("図が見つからない");
    expect(html).toContain('class="missing"');
  });

  it("記録がなければ doc-reverser への案内を出す", () => {
    expect(buildReverseSection([])).toContain("doc-reverser");
  });

  it("エージェント由来の文字列をエスケープする", () => {
    const html = buildReverseSection([
      status({ record: { ...status().record, title: "<script>alert(1)</script>" } }),
    ]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("buildArchSection", () => {
  const rules: ArchRuleSet = {
    tool: "dependency-cruiser",
    layers: [
      { id: "domain", name: "ドメイン", patterns: ["src/domain/**"], description: "業務ルール" },
      { id: "infra", name: "インフラ", patterns: ["src/infra/**"] },
    ],
    rules: [
      {
        id: "ARCH-01",
        kind: "forbid",
        from: "domain",
        to: ["infra"],
        description: "ドメインはインフラに依存しない",
        tool: "no-domain-to-infra",
        source: "docs/architecture/overview.md",
      },
    ],
    notes: ["トランザクション境界はレビューで担保する"],
  };

  it("レイヤ・規約・最新結果を表にし、適合していればゲートを通過にする", () => {
    const html = buildArchSection(rules, [{ rule: "ARCH-01", result: "pass" }]);
    expect(html).toContain("ARCH-01");
    expect(html).toContain("ドメインはインフラに依存しない");
    expect(html).toContain("ドメイン → インフラ");
    expect(html).toContain("no-domain-to-infra");
    expect(html).toContain("適合ゲート: <b>通過</b>");
    expect(html).toContain("トランザクション境界"); // notes(レビューで担保)
  });

  it("違反があればゲートを未通過にし、件数と詳細を出す", () => {
    const html = buildArchSection(rules, [
      { rule: "ARCH-01", result: "violation", violations: 3, detail: "src/domain/order.ts" },
    ]);
    expect(html).toContain("適合ゲート: <b>未通過</b>");
    expect(html).toContain("3 件");
    expect(html).toContain("src/domain/order.ts");
  });

  it("検証記録がなければ未確認としてアーキテクチャ検証を案内する", () => {
    const html = buildArchSection(rules, []);
    expect(html).toContain("適合ゲート: <b>未確認</b>");
    expect(html).toContain("atf-bin/arch.sh");
  });

  it("規約が未定義なら arch-guard への案内を出す", () => {
    expect(buildArchSection(undefined, [])).toContain("arch-guard");
    expect(buildArchSection({ layers: [], rules: [] }, [])).toContain("arch-guard");
  });
});

describe("buildDashboardHtml (リバースドキュメント・アーキテクチャ検証)", () => {
  const architecture = {
    docs: [
      {
        record: {
          path: "docs/architecture/overview.md",
          title: "システム全体像",
          kind: "overview" as const,
          sources: ["src/cli.ts"],
        },
        docExists: true,
        missingSources: [] as string[],
      },
    ],
    rules: {
      layers: [],
      rules: [{ id: "ARCH-01", kind: "no-cycle" as const, description: "循環依存を禁止する" }],
    },
    checks: [{ rule: "ARCH-01", result: "pass" as const }],
  };

  it("reverseDocs / archCheck が有効なときだけセクションを表示する", () => {
    const enabled = {
      ...manifest,
      requirements: { ...manifest.requirements, reverseDocs: true, archCheck: true },
    };
    const html = buildDashboardHtml(enabled, [], [], undefined, undefined, architecture);
    expect(html).toContain("リバースドキュメント(コードから起こした文書と図)");
    expect(html).toContain("アーキテクチャ適合検証");
    expect(html).toContain("システム全体像");
    expect(html).toContain("アーキテクチャ適合ゲート"); // ガードレールの項目
    expect(html).toContain("ドキュメントの鮮度検知"); // フィードバックループの項目

    const off = buildDashboardHtml(manifest, [], [], undefined, undefined, architecture);
    expect(off).not.toContain("リバースドキュメント(コードから起こした文書と図)");
    expect(off).toContain("未導入(リバースドキュメントモードを有効にすると追加)");
    expect(off).toContain("未導入(アーキテクチャ適合検証を有効にすると追加)");
  });
});

describe("buildEvalSection", () => {
  const rubric: Rubric = {
    passScore: 3,
    criteria: [
      {
        id: "EVAL-01",
        name: "要求の充足",
        description: "完了条件を満たしているか",
        weight: 2,
        levels: [
          { score: 4, label: "優秀", description: "境界条件も扱っている" },
          { score: 3, label: "合格", description: "完了条件をすべて満たしている" },
        ],
      },
    ],
    notes: ["ユーザー体験はレビューで担保する"],
  };
  const targets = ["product-planner", "market-researcher"];
  const pass = (target: string): EvaluationRecord => ({
    target,
    artifact: `docs/${target}.md`,
    scores: [{ id: "EVAL-01", score: 4, comment: "完了条件 3 件を満たす" }],
    verdict: "pass",
  });

  it("観点・エージェント別の状況・成果物ごとの判定を表にし、全員合格ならゲートを通過にする", () => {
    const html = buildEvalSection(rubric, targets.map(pass), targets);
    expect(html).toContain("EVAL-01");
    expect(html).toContain("要求の充足");
    expect(html).toContain("完了条件 3 件を満たす");
    expect(html).toContain("評価ゲート: <b>通過</b>");
    expect(html).toContain("ユーザー体験はレビューで担保する"); // notes
  });

  it("未達があればゲートを未通過にし、改善指示を出す", () => {
    const html = buildEvalSection(
      rubric,
      [
        pass("product-planner"),
        {
          target: "market-researcher",
          artifact: "docs/market.md",
          scores: [{ id: "EVAL-01", score: 2 }],
          verdict: "revise",
          actions: ["競合 3 社の比較を追加する"],
        },
      ],
      targets,
    );
    expect(html).toContain("評価ゲート: <b>未通過</b>");
    expect(html).toContain("競合 3 社の比較を追加する");
  });

  it("未評価の対象が残っていれば未確認にする", () => {
    const html = buildEvalSection(rubric, [pass("product-planner")], targets);
    expect(html).toContain("評価ゲート: <b>未確認</b>");
    expect(html).toContain("market-researcher");
  });

  it("対象外のエージェントの記録はゲートに入れない", () => {
    const html = buildEvalSection(
      rubric,
      [
        ...targets.map(pass),
        { target: "biz-evaluator", artifact: "x", scores: [], verdict: "fail" as const },
      ],
      targets,
    );
    expect(html).toContain("評価ゲート: <b>通過</b>");
  });

  it("評価対象 × 観点の表に、観点ごとの平均スコアを出す", () => {
    const html = buildEvalSection(
      rubric,
      [
        pass("product-planner"),
        {
          target: "product-planner",
          artifact: "docs/plan2.md",
          scores: [{ id: "EVAL-01", score: 2 }],
          verdict: "revise",
        },
      ],
      targets,
    );
    expect(html).toContain("評価対象 × 観点(誰の成果物を、どの観点で採点しているか)");
    // 列は観点の id、セルは 4 と 2 の平均
    expect(html).toContain("<th>EVAL-01</th>");
    expect(html).toContain("<b>3</b>");
    // 採点がない対象は「未採点」
    expect(html).toContain("未採点");
  });

  it("appliesTo で絞られた観点は、対象外のエージェントの行で「対象外」になる", () => {
    const scoped: Rubric = {
      ...rubric,
      criteria: [
        ...rubric.criteria,
        {
          id: "EVAL-02",
          name: "調査の網羅性",
          description: "競合を漏れなく見たか",
          appliesTo: ["market-researcher"],
          levels: [{ score: 4, label: "優秀", description: "..." }],
        },
      ],
    };
    const html = buildEvalSection(scoped, targets.map(pass), targets);

    expect(html).toContain("<th>EVAL-02</th>");
    expect(html).toContain("対象外");
    // 観点の表には「どのエージェントに適用されるか」が出る
    expect(html).toContain("market-researcher");
  });

  it("閾値とネクストアクションを観点の表に出し、閾値未満には次の一手を一覧にする", () => {
    const actionable: Rubric = {
      passScore: 3,
      actions: { below: ["担当に差し戻す"], meets: ["次の作業へ進む"] },
      criteria: [
        {
          id: "EVAL-01",
          name: "要求の充足",
          description: "完了条件を満たしているか",
          passScore: 4,
          actions: { below: ["未達の完了条件を一覧にして差し戻す"] },
          levels: [{ score: 4, label: "優秀", description: "..." }],
        },
      ],
    };
    const html = buildEvalSection(
      actionable,
      [
        {
          target: "product-planner",
          artifact: "docs/plan.md",
          scores: [{ id: "EVAL-01", score: 3 }],
          verdict: "revise",
        },
      ],
      targets,
    );

    // 観点の表に閾値と、閾値を跨いだときの手順が並ぶ
    expect(html).toContain("<th>閾値</th>");
    expect(html).toContain("<th>閾値未満のとき</th>");
    expect(html).toContain("未達の完了条件を一覧にして差し戻す");
    expect(html).toContain("次の作業へ進む"); // meets は全体の既定にフォールバック
    // 閾値(4)を下回った採点は「次にやること」に出る
    expect(html).toContain("次にやること(閾値未満の観点)");
    expect(html).toContain("/ 閾値 4");
  });

  it("観点の表は評価対象のエージェントごとに並び、適用されない観点は出さない", () => {
    const scoped: Rubric = {
      ...rubric,
      criteria: [
        ...rubric.criteria,
        {
          id: "EVAL-09",
          name: "調査の網羅性",
          description: "競合を漏れなく見たか",
          appliesTo: ["market-researcher"],
          levels: [{ score: 4, label: "優秀", description: "..." }],
        },
      ],
    };
    const html = buildEvalSection(scoped, targets.map(pass), targets);

    expect(html).toContain("評価観点(評価対象のエージェントごと)");
    // 行見出しがエージェントになる
    for (const agent of targets) {
      expect(html).toContain(`<th><span class="badge">${agent}</span></th>`);
    }
    // appliesTo で絞った観点は、対象のエージェントの並びにだけ現れる(観点の表の中で 1 行だけ)
    const table = html.slice(html.indexOf("<h3>評価観点"), html.indexOf("</table>"));
    expect(table.match(/EVAL-09/g) ?? []).toHaveLength(1);
    // 全員に効く観点は評価対象の数だけ出る
    expect(table.match(/EVAL-01/g) ?? []).toHaveLength(targets.length);
  });

  it("既定のネクストアクションは (既定) に畳み、表の下で 1 度だけ展開する", () => {
    const shared: Rubric = {
      passScore: 3,
      actions: { below: ["担当に差し戻す"] },
      criteria: [
        { id: "EVAL-01", name: "要求の充足", description: "...", levels: [] },
        {
          id: "EVAL-02",
          name: "検証の裏づけ",
          description: "...",
          actions: { below: ["不足しているテストを足す"] },
          levels: [],
        },
      ],
    };
    const html = buildEvalSection(shared, [], targets);

    // 既定が効く観点はセルを畳む(エージェント数ぶん同じ文面を並べない)
    expect(html).toContain("(既定)");
    expect(html.match(/担当に差し戻す/g) ?? []).toHaveLength(1);
    // 観点固有の手順はセルにそのまま出る(対象 2 体ぶん)
    expect(html.match(/不足しているテストを足す/g) ?? []).toHaveLength(2);
  });

  it("ネクストアクションが未設定なら、その列を出さない", () => {
    const html = buildEvalSection(rubric, targets.map(pass), targets);
    expect(html).not.toContain("<th>閾値未満のとき</th>");
    expect(html).not.toContain("次にやること(閾値未満の観点)");
  });

  it("合格と記録されていても閾値未満の観点があれば警告する", () => {
    const strict: Rubric = {
      ...rubric,
      criteria: [{ ...rubric.criteria[0], passScore: 4 }],
    };
    const html = buildEvalSection(
      strict,
      [
        {
          target: "product-planner",
          artifact: "docs/plan.md",
          scores: [{ id: "EVAL-01", score: 3 }],
          verdict: "pass",
        },
      ],
      targets,
    );
    expect(html).toContain("閾値未満の観点が残っている評価が 1 件");
    expect(html).toContain("docs/plan.md");
  });

  it("観点が未定義なら evaluator への案内を出す", () => {
    expect(buildEvalSection(undefined, [], targets)).toContain("evaluator");
    expect(buildEvalSection({ criteria: [] }, [], targets)).toContain("evaluator");
  });
});

describe("buildDashboardHtml (ルーブリック評価)", () => {
  const evaluation = {
    rubric: {
      criteria: [{ id: "EVAL-01", name: "要求の充足", description: "...", levels: [] }],
    } as Rubric,
    records: [
      {
        target: "product-planner",
        artifact: "docs/plan.md",
        scores: [{ id: "EVAL-01", score: 4 }],
        verdict: "pass" as const,
      },
    ],
  };

  it("rubricEval が有効なときだけセクションを表示する", () => {
    const enabled = {
      ...manifest,
      requirements: { ...manifest.requirements, rubricEval: true },
    };
    const html = buildDashboardHtml(enabled, [], [], undefined, undefined, undefined, evaluation);
    expect(html).toContain("<h2>ルーブリック評価</h2>");
    expect(html).toContain("ルーブリック評価ゲート"); // ガードレールの項目
    expect(html).toContain("評価による差し戻し"); // フィードバックループの項目

    const off = buildDashboardHtml(manifest, [], [], undefined, undefined, undefined, evaluation);
    expect(off).not.toContain("<h2>ルーブリック評価</h2>");
    expect(off).toContain("未導入(ルーブリック評価を有効にすると追加)");
  });

  it("評価対象から外したエージェントは集計に入れない", () => {
    const enabled = {
      ...manifest,
      requirements: {
        ...manifest.requirements,
        rubricEval: true,
        evalTargets: { "product-planner": true, "market-researcher": false },
      },
    };
    const html = buildDashboardHtml(enabled, [], [], undefined, undefined, undefined, evaluation);
    // 対象 1 体で、その 1 件が合格しているためゲートは通過
    expect(html).toContain("評価ゲート: <b>通過</b>");
    expect(html).toContain("ルーブリック評価: あり(対象 1 体 / 記録 1 件)");
  });
});

describe("buildFlowPreviewHtml (リバースドキュメント・アーキテクチャ検証)", () => {
  const preset: Preset = {
    id: "quality-review",
    name: "品質レビューチーム",
    description: "コード品質",
    match: {},
    agents: ["code-reviewer.md"],
    flow: [],
    dir: "/tmp/preset",
  };
  const profile: RepoProfile = {
    path: "/tmp/example",
    name: "example",
    languages: ["typescript"],
    frameworks: [],
    hasCI: false,
    hasTests: false,
    fileCount: 1,
  };

  it("有効なら開発フローに文書化・適合ゲートの段を追加する", () => {
    const html = buildFlowPreviewHtml(preset, profile, {
      phase: "active",
      focus: ["quality"],
      teamSize: "minimal",
      reverseDocs: true,
      archCheck: true,
    });
    expect(html).toContain("現状の文書化・図");
    expect(html).toContain("アーキテクチャ検証");
    expect(html).toContain("arch -- 規約違反 --> impl"); // 違反時は実装に戻る
    expect(html).toContain("リバースドキュメント(コードから文書と図を起こす)");
    expect(html).toContain("ArchUnit");
  });

  it("無効なら該当セクションを出さない", () => {
    const html = buildFlowPreviewHtml(preset, profile, {
      phase: "active",
      focus: ["quality"],
      teamSize: "minimal",
    });
    expect(html).toContain("リバースドキュメントモードは無効");
    expect(html).toContain("アーキテクチャ適合検証は無効");
    expect(html).toContain("ルーブリック評価は無効");
    expect(html).not.toContain("現状の文書化・図");
  });

  it("ルーブリック評価が有効なら、評価ゲートと差し戻しの辺を描く", () => {
    const html = buildFlowPreviewHtml(preset, profile, {
      phase: "active",
      focus: ["quality"],
      teamSize: "minimal",
      rubricEval: true,
    });
    expect(html).toContain("ルーブリック評価<br/>(評価ゲート)");
    expect(html).toContain("eval -- 要改善・不合格 --> impl");
    expect(html).toContain("ルーブリック評価(成果物の採点)");
    expect(html).toContain("requirements.evalTargets");
  });
});
