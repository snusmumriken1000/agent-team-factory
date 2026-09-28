import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTeam } from "./generator.js";
import { loadTeamSettings, settingsPath } from "./settings.js";
import { loadPresets } from "./presets.js";
import { lintFormal } from "./lint.js";
import type { RepoProfile, Requirements, TeamManifest } from "./types.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "atf-test-"));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

const profileFor = (path: string): RepoProfile => ({
  path,
  name: "example",
  languages: ["typescript"],
  frameworks: [],
  hasCI: false,
  hasTests: false,
  fileCount: 1,
});

const preset = () => {
  const p = loadPresets().find((p) => p.id === "quality-review");
  if (!p) throw new Error("quality-review preset not found");
  return p;
};

describe("generateTeam (Issue 駆動)", () => {
  const requirements: Requirements = {
    phase: "active",
    focus: ["quality"],
    teamSize: "minimal",
    issueDriven: true,
  };

  it("issue-manager を追加し、全エージェントに Issue 駆動の指示を付与する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    expect(result.written).toContain("issue-manager.md");
    const manifest: TeamManifest = loadTeamSettings(repoDir);
    // teamSize: minimal (3) の枠を消費せず追加される(env-builder / orchestrator は全チーム共通)
    expect(manifest.agents.map((a) => a.name)).toEqual([
      "code-reviewer",
      "test-engineer",
      "refactoring-advisor",
      "env-builder",
      "issue-manager",
      "orchestrator",
    ]);
    // issue-manager からチーム先頭エージェントへのフローが描かれる
    expect(manifest.flow).toContainEqual(["issue-manager", "code-reviewer"]);

    for (const file of result.written) {
      const content = readFileSync(join(result.agentsDir, file), "utf8");
      expect(content).toContain("## Issue 駆動開発");
      expect(content).toContain("## 実行記録");
    }
  });

  it("githubRepo が指定されていれば Issue 駆動指示に起票先リポジトリを明記する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      ...requirements,
      githubRepo: "octocat/hello-world",
    });

    for (const file of result.written) {
      const content = readFileSync(join(result.agentsDir, file), "utf8");
      expect(content).toContain("使用するリポジトリ: octocat/hello-world");
      expect(content).toContain("-R octocat/hello-world");
    }
  });

  it("ドラフトの置き場と、orchestrator / env-builder 向けの指示を用意する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      ...requirements,
      githubRepo: "octocat/hello-world",
    });

    expect(result.issuesDir).toBe(join(repoDir, ".claude", "atf-issues"));
    expect(existsSync(join(result.issuesDir!, "README.md"))).toBe(true);
    const orchestrator = readFileSync(join(result.agentsDir, "orchestrator.md"), "utf8");
    expect(orchestrator).toContain("## Issue 駆動モードの運用");
    const envBuilder = readFileSync(join(result.agentsDir, "env-builder.md"), "utf8");
    expect(envBuilder).toContain("## Issue 駆動の実行環境");
    expect(envBuilder).toContain("gh auth status");
  });

  it("issueDriven でなければ issue-manager を追加しない", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      ...requirements,
      issueDriven: false,
    });

    expect(result.written).not.toContain("issue-manager.md");
    expect(existsSync(join(result.agentsDir, "issue-manager.md"))).toBe(false);
    const content = readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8");
    expect(content).not.toContain("## Issue 駆動開発");
    expect(result.issuesDir).toBeUndefined();
    expect(existsSync(join(repoDir, ".claude", "atf-issues"))).toBe(false);
  });
});

describe("generateTeam (env-builder)", () => {
  const requirements: Requirements = {
    phase: "active",
    focus: ["quality"],
    teamSize: "minimal",
  };

  it("全チーム共通で env-builder を teamSize の枠外で追加する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    expect(result.written).toContain("env-builder.md");
    const manifest: TeamManifest = loadTeamSettings(repoDir);
    expect(manifest.agents.map((a) => a.name)).toEqual([
      "code-reviewer",
      "test-engineer",
      "refactoring-advisor",
      "env-builder",
      "orchestrator",
    ]);

    const content = readFileSync(join(result.agentsDir, "env-builder.md"), "utf8");
    expect(content).toContain("ハーネス");
    expect(content).toContain("ガードレール");
    expect(content).toContain("フィードバックループ");
    // プレースホルダが置換され、実行記録の指示も付与される
    expect(content).toContain("example のエージェントチームの実行環境ビルダー");
    expect(content).toContain("## 実行記録");
  });
});

describe("generateTeam (orchestrator)", () => {
  const base: Requirements = {
    phase: "active",
    focus: ["quality"],
    teamSize: "minimal",
    issueDriven: true,
    githubRepo: "octocat/hello-world",
    prFlow: true,
  };

  it("全チーム共通で orchestrator を teamSize の枠外で追加し、入口へのフローを描く", () => {
    const result = generateTeam(preset(), profileFor(repoDir), base);

    expect(result.written).toContain("orchestrator.md");
    const manifest: TeamManifest = loadTeamSettings(repoDir);
    // Issue 駆動なら orchestrator → issue-manager がタスクの入口になる
    expect(manifest.flow).toContainEqual(["orchestrator", "issue-manager"]);

    const content = readFileSync(join(result.agentsDir, "orchestrator.md"), "utf8");
    expect(content).toContain("example の開発オーケストレーター");
    expect(content).toContain("## 動作モード");
    // 既定は立ち上げ期向けのブートストラップモード、もう一方が Issue 駆動モード
    expect(content).toContain("既定はブートストラップモード");
    expect(content).toContain("### ブートストラップモード(既定)");
    expect(content).toContain("### Issue 駆動モード");
    expect(content).toContain("## 実行記録");
  });

  it("Issue 駆動でなければ orchestrator からチーム先頭エージェントへのフローを描く", () => {
    generateTeam(preset(), profileFor(repoDir), { ...base, issueDriven: false });

    const manifest: TeamManifest = loadTeamSettings(repoDir);
    expect(manifest.flow).toContainEqual(["orchestrator", "code-reviewer"]);
  });

  it("タッチポイントが設定されていれば一時停止して承認を仰ぐ指示を付与する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      ...base,
      touchpoints: ["issue-approval", "pr-merge"],
    });

    const content = readFileSync(join(result.agentsDir, "orchestrator.md"), "utf8");
    expect(content).toContain("## タッチポイント(一時停止してユーザー承認を仰ぐ)");
    expect(content).toContain("必ずループを一時停止し、ユーザーの承認を得てから");
    expect(content).toContain("**Issue 承認**");
    expect(content).toContain("**PR マージ**");
    // タッチポイントの一時停止指示は orchestrator 専用(他エージェントには付与しない)
    const reviewer = readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8");
    expect(reviewer).not.toContain("## タッチポイント(一時停止してユーザー承認を仰ぐ)");
  });

  it("タッチポイントなしなら自動で進めてよい旨の指示になる", () => {
    const result = generateTeam(preset(), profileFor(repoDir), { ...base, touchpoints: [] });

    const content = readFileSync(join(result.agentsDir, "orchestrator.md"), "utf8");
    expect(content).toContain("タッチポイントは設定されていない");
    expect(content).not.toContain("**Issue 承認**");
    expect(content).not.toContain("**PR マージ**");
  });
});

describe("generateTeam (PR フロー・タッチポイント)", () => {
  const base: Requirements = {
    phase: "active",
    focus: ["quality"],
    teamSize: "minimal",
    issueDriven: true,
    githubRepo: "octocat/hello-world",
    prFlow: true,
  };

  it("prFlow が有効なら全エージェントに PR 作成の手順を付与する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      ...base,
      touchpoints: ["pr-merge"],
    });

    for (const file of result.written) {
      const content = readFileSync(join(result.agentsDir, file), "utf8");
      expect(content).toContain("## PR フロー(ブランチ・Pull Request)");
      expect(content).toContain("gh pr create -R octocat/hello-world");
      expect(content).toContain("Closes #123");
    }
  });

  it("タッチポイント pr-merge を選ぶとマージはユーザー担当になる(エージェントのマージ禁止)", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      ...base,
      touchpoints: ["pr-merge"],
    });

    const content = readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8");
    expect(content).toContain("マージはユーザーが行う(タッチポイント)");
    expect(content).toContain("実行してはならない");
    expect(content).not.toContain("gh pr merge -R");
  });

  it("pr-merge を選ばなければエージェントがマージまで実行する手順になる", () => {
    const result = generateTeam(preset(), profileFor(repoDir), { ...base, touchpoints: [] });

    const content = readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8");
    expect(content).toContain("マージはエージェントが行う");
    expect(content).toContain("gh pr merge -R octocat/hello-world --squash --delete-branch");
  });

  it("タッチポイント issue-approval を選ぶと Issue 承認後に着手する指示が付く", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      ...base,
      touchpoints: ["issue-approval"],
    });

    const content = readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8");
    expect(content).toContain("ユーザーが内容を確認・承認してから着手する");
  });

  it("prFlow が無効なら PR フローの指示を付与しない", () => {
    const result = generateTeam(preset(), profileFor(repoDir), { ...base, prFlow: false });

    const content = readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8");
    expect(content).not.toContain("## PR フロー");
  });

  it("マニフェストの requirements に prFlow と touchpoints が記録される", () => {
    generateTeam(preset(), profileFor(repoDir), { ...base, touchpoints: ["pr-merge"] });

    const manifest: TeamManifest = loadTeamSettings(repoDir);
    expect(manifest.requirements.prFlow).toBe(true);
    expect(manifest.requirements.touchpoints).toEqual(["pr-merge"]);
  });
});

describe("generateTeam (形式仕様モード)", () => {
  const requirements: Requirements = {
    phase: "active",
    focus: ["quality"],
    teamSize: "minimal",
    formalSpec: true,
  };

  it("spec-formalizer を teamSize の枠外で追加し、実装エージェントの手前に配置する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    expect(result.written).toContain("spec-formalizer.md");
    const manifest: TeamManifest = loadTeamSettings(repoDir);
    expect(manifest.agents.map((a) => a.name)).toEqual([
      "code-reviewer",
      "test-engineer",
      "refactoring-advisor",
      "env-builder",
      "spec-formalizer",
      "orchestrator",
    ]);
    // 形式化 → 実装、オーケストレーターの入口も spec-formalizer になる
    expect(manifest.flow).toContainEqual(["spec-formalizer", "code-reviewer"]);
    expect(manifest.flow).toContainEqual(["orchestrator", "spec-formalizer"]);
  });

  it("Issue 駆動と併用すると issue-manager → spec-formalizer → 実装の順になる", () => {
    generateTeam(preset(), profileFor(repoDir), { ...requirements, issueDriven: true });

    const manifest: TeamManifest = loadTeamSettings(repoDir);
    expect(manifest.flow).toContainEqual(["issue-manager", "spec-formalizer"]);
    expect(manifest.flow).toContainEqual(["spec-formalizer", "code-reviewer"]);
    expect(manifest.flow).toContainEqual(["orchestrator", "issue-manager"]);
  });

  it("全エージェントに単一情報源の指示を付与し、オーケストレーターにはゲートを付ける", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    for (const file of result.written) {
      const content = readFileSync(join(result.agentsDir, file), "utf8");
      expect(content).toContain("## 要件・仕様の単一情報源(形式仕様 + ADR)");
      expect(content).toContain("spec/*.als");
      expect(content).toContain("docs/adr/");
      // 自然言語の仕様書は手書きせず weave で生成する
      expect(content).toContain("bash atf-bin/weave.sh");
      expect(content).toContain("検証が通るまで実装を始めない");
    }
    const orchestrator = readFileSync(join(result.agentsDir, "orchestrator.md"), "utf8");
    expect(orchestrator).toContain("## 形式検証ゲート(実装前に必ず通す)");
    expect(orchestrator).toContain("bash atf-bin/formal.sh");
    // env-builder には Alloy 実行環境の整備を依頼する
    expect(readFileSync(join(result.agentsDir, "env-builder.md"), "utf8")).toContain(
      "## 形式仕様(Alloy)の実行環境",
    );
  });

  it("atf-bin にゲートの実行スクリプトを配り、マシン固有のファイルを .gitignore に足す", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    expect(result.binDir).toBe(join(repoDir, "atf-bin"));
    expect(readFileSync(join(result.binDir, "formal.sh"), "utf8")).toContain(
      'atf_run formal "$ATF_PROJECT_DIR"',
    );
    const ignore = readFileSync(join(repoDir, ".gitignore"), "utf8");
    expect(ignore).toContain("atf-bin/atf.local.sh");
    // 生成物と非決定的な出力は commit しない(正は spec/*.als と docs/adr/)
    expect(ignore).toContain("docs/generated/");
    expect(ignore).toContain(".claude/atf-formal/narration/");
  });

  it("weave と lint の実行スクリプトも配る", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    expect(readFileSync(join(result.binDir, "weave.sh"), "utf8")).toContain(
      'atf_run weave "$ATF_PROJECT_DIR"',
    );
    expect(readFileSync(join(result.binDir, "lint.sh"), "utf8")).toContain(
      'atf_run lint "$ATF_PROJECT_DIR"',
    );
  });

  it("spec/ と docs/adr/ を用意し、ルートモジュールの雛形を置く", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    expect(result.specDir).toBe(join(repoDir, "spec"));
    const readme = readFileSync(join(result.specDir!, "README.md"), "utf8");
    expect(readme).toContain("# example 形式仕様(Alloy)");
    expect(readme).toContain("@out-of-scope");
    expect(readme).toContain("docs/adr/");

    // ルートモジュールは TODO のままでよい(spec-formalizer がユーザーと埋める)
    const root = readFileSync(join(result.specDir!, "main.als"), "utf8");
    expect(root).toContain("module main");
    expect(root).toContain("@title  TODO:");
    expect(root).toContain("@out-of-scope TODO:");

    const adr = readFileSync(join(repoDir, "docs", "adr", "README.md"), "utf8");
    expect(adr).toContain("追記のみ");
    expect(adr).toContain("superseded by");

    const runner = join(result.specDir!, "run-alloy.sh");
    expect(readFileSync(runner, "utf8")).toContain("exec java -jar");
    expect(statSync(runner).mode & 0o111).toBeTruthy(); // 実行権限がある
  });

  it("ヒアリングした枠があれば、ルートモジュールの必須タグを埋めて配る", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements, {
      specFrame: {
        title: "注文システムの仕様",
        scope: "注文の状態遷移と出荷の関係。",
        outOfScope: ["決済ゲートウェイの内部", "通知メールの文面"],
        stakeholder: "プロダクトオーナー (承認: 2026-09-26)",
        tradeoff: "品質(品質を落としてまで期日を守らない)",
      },
    });

    const root = readFileSync(join(result.specDir!, "main.als"), "utf8");
    expect(root).toContain("@title  注文システムの仕様");
    expect(root).toContain("@scope  注文の状態遷移と出荷の関係。");
    // 扱わない範囲は 1 件 1 タグに展開する
    expect(root).toContain("@out-of-scope 決済ゲートウェイの内部");
    expect(root).toContain("@out-of-scope 通知メールの文面");
    expect(root).toContain("@stakeholder プロダクトオーナー (承認: 2026-09-26)");
    expect(root).toContain("@tradeoff 品質(品質を落としてまで期日を守らない)");
    expect(root).not.toContain("TODO:");
    // 枠が埋まっていれば、導入直後でも規約検査を通る
    expect(lintFormal(repoDir).filter((f) => f.severity === "error")).toEqual([]);
  });

  it("枠が渡されなければ TODO のまま配り、規約検査が未確定として落とす", () => {
    generateTeam(preset(), profileFor(repoDir), requirements);

    const errors = lintFormal(repoDir).filter((f) => f.severity === "error");
    expect(errors.map((f) => f.rule)).toEqual(["root-tags", "root-tags", "root-tags", "root-tags"]);
  });

  it("既にあるルートモジュールは上書きしない(仕様そのものなので)", () => {
    mkdirSync(join(repoDir, "spec"), { recursive: true });
    writeFileSync(join(repoDir, "spec", "main.als"), "module main\n// 手で書いた仕様\n");

    generateTeam(preset(), profileFor(repoDir), requirements);

    expect(readFileSync(join(repoDir, "spec", "main.als"), "utf8")).toContain("手で書いた仕様");
  });

  it("spec-formalizer に、反例が出たときの判断と解説 HTML の維持を指示する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    const formalizer = readFileSync(join(result.agentsDir, "spec-formalizer.md"), "utf8");
    expect(formalizer).toContain("## 反例が出たときの進め方(自動確定の判断)");
    expect(formalizer).toContain("### 自動確定してよい(圧倒的に推奨される仕様がある)");
    expect(formalizer).toContain("### ユーザーに確認する(自動確定しない)");
    expect(formalizer).toContain("decisions.jsonl");
    expect(formalizer).toContain("## 自然言語化(weave)と規約検査(lint)");
    // 実装の修正は自分でやらず、オーケストレーター経由で委譲する
    expect(formalizer).toContain("orchestrator に実装修正の委譲を依頼する");
  });

  it("自動確定を無効にすると、反例の決着は必ずユーザー確認になる", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      ...requirements,
      specAutoFix: false,
    });

    const formalizer = readFileSync(join(result.agentsDir, "spec-formalizer.md"), "utf8");
    expect(formalizer).toContain("## 反例が出たときの進め方(自動確定の判断)");
    expect(formalizer).toContain("**自動確定を無効**");
    expect(formalizer).not.toContain("### 自動確定してよい(圧倒的に推奨される仕様がある)");

    const orchestrator = readFileSync(join(result.agentsDir, "orchestrator.md"), "utf8");
    expect(orchestrator).toContain("仕様を決めるのはユーザー");
    expect(orchestrator).not.toContain("自動確定できる");

    const reviewer = readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8");
    expect(reviewer).toContain("ユーザーの判断待ち");
  });

  it("既定(自動確定あり)では、実装エージェントに決定への追随を指示する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    const orchestrator = readFileSync(join(result.agentsDir, "orchestrator.md"), "utf8");
    expect(orchestrator).toContain("自動確定できる");
    expect(orchestrator).toContain("実装エージェントに修正を委譲");

    const reviewer = readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8");
    expect(reviewer).toContain("decisions.jsonl");
    expect(reviewer).toContain("explain.html");
  });

  it("解説ページのテンプレートを配り、既にある .als から派生文書を生成する", () => {
    // 先に .als を置いた状態で導入しても、派生文書が .als と対で揃う
    mkdirSync(join(repoDir, "spec"), { recursive: true });
    writeFileSync(
      join(repoDir, "spec", "order.als"),
      "module order\n\n/**\n * @req R-01  注文は 1 人の顧客に属する\n */\nsig Order {}\n",
    );

    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    const template = join(repoDir, ".claude", "atf-formal", "explain-template.html");
    expect(readFileSync(template, "utf8")).toContain("{{blocks}}");

    const generated = join(repoDir, "docs", "generated");
    const explained = readFileSync(join(generated, "order.explain.html"), "utf8");
    expect(explained).toContain("R-01");
    expect(explained).toContain("注文は 1 人の顧客に属する");
    // 自然言語の文書一式(仕様書・用語集・トレーサビリティ)も派生物として出る
    expect(readFileSync(join(generated, "traceability.md"), "utf8")).toContain("R-01");
    expect(readFileSync(join(generated, "spec.md"), "utf8")).toContain("GENERATED FROM spec/*.als");

    const readme = readFileSync(join(result.specDir!, "README.md"), "utf8");
    expect(readme).toContain("explain-template.html");
    expect(readme).toContain("decisions.jsonl");
  });

  it("形式仕様モードが無効なら spec-formalizer も spec/ も作らない", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      phase: "active",
      focus: ["quality"],
      teamSize: "minimal",
    });

    expect(result.written).not.toContain("spec-formalizer.md");
    expect(result.specDir).toBeUndefined();
    expect(existsSync(join(repoDir, "spec"))).toBe(false);
    expect(existsSync(join(repoDir, "docs", "adr"))).toBe(false);
    expect(readFileSync(join(result.agentsDir, "orchestrator.md"), "utf8")).not.toContain(
      "形式検証ゲート",
    );
  });
});

describe("generateTeam (最新機能スカウト)", () => {
  const requirements: Requirements = {
    phase: "active",
    focus: ["quality"],
    teamSize: "minimal",
    capabilityScout: true,
  };

  it("capability-scout を teamSize の枠外で追加し、オーケストレーターへ流す", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    expect(result.written).toContain("capability-scout.md");
    const manifest: TeamManifest = loadTeamSettings(repoDir);
    expect(manifest.agents.map((a) => a.name)).toEqual([
      "code-reviewer",
      "test-engineer",
      "refactoring-advisor",
      "env-builder",
      "orchestrator",
      "capability-scout",
    ]);
    // 調査結果(採否表・計画書)はオーケストレーターに渡る
    expect(manifest.flow).toContainEqual(["capability-scout", "orchestrator"]);
  });

  it("オーケストレーターと env-builder に取り込みループ・調査環境の指示を付ける", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    const orchestrator = readFileSync(join(result.agentsDir, "orchestrator.md"), "utf8");
    expect(orchestrator).toContain("## 最新機能の取り込み(capability-scout の使い方)");
    expect(orchestrator).toContain("承認を得るまで、取り込みの実装を委譲しない");
    expect(readFileSync(join(result.agentsDir, "env-builder.md"), "utf8")).toContain(
      "## 最新機能の調査環境",
    );
    // 実装エージェントには付与しない(調査は capability-scout の担当)
    expect(readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8")).not.toContain(
      "capability-scout の使い方",
    );
  });

  it("調査結果・計画書の置き場と書式ガイドを用意する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    expect(result.capabilitiesDir).toBe(join(repoDir, ".claude", "atf-capabilities"));
    const readme = readFileSync(join(result.capabilitiesDir!, "README.md"), "utf8");
    expect(readme).toContain("# example 最新機能の取り込み(Claude Code / Codex)");
    expect(readme).toContain("findings.jsonl");
    expect(readme).toContain("quality"); // 重視観点が判定の観点に反映される
  });

  it("無効なら capability-scout も atf-capabilities も作らない", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      phase: "active",
      focus: ["quality"],
      teamSize: "minimal",
    });

    expect(result.written).not.toContain("capability-scout.md");
    expect(result.capabilitiesDir).toBeUndefined();
    expect(existsSync(join(repoDir, ".claude", "atf-capabilities"))).toBe(false);
    expect(readFileSync(join(result.agentsDir, "orchestrator.md"), "utf8")).not.toContain(
      "capability-scout",
    );
  });
});

describe("generateTeam (デザインスキル)", () => {
  const requirements: Requirements = {
    phase: "active",
    focus: ["quality", "design"],
    teamSize: "minimal",
    designSkills: ["taste-skill", "redesign-skill"],
  };

  it("スキルを .claude/skills/<スキル名>/SKILL.md に配置する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    expect(result.skillsDir).toBe(join(repoDir, ".claude", "skills"));
    expect(existsSync(join(result.skillsDir!, "design-taste-frontend", "SKILL.md"))).toBe(true);
    expect(existsSync(join(result.skillsDir!, "redesign-existing-projects", "SKILL.md"))).toBe(true);
    // 出典とライセンスを残す(MIT の再配布条件)
    expect(readFileSync(join(result.skillsDir!, "README.md"), "utf8")).toContain(
      "Leonxlnx/taste-skill",
    );
  });

  it("全エージェントに UI 実装時のスキル使用を指示する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    const reviewer = readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8");
    expect(reviewer).toContain("## デザインスキル(UI 実装時に使う)");
    expect(reviewer).toContain("design-taste-frontend");
    // 見た目の方向性は 1 つに統一させる(併用すると指示が衝突する)
    expect(reviewer).toContain("他の方向性のスキルを併用してはならない");
    // UI と無関係な作業でスキルを読ませない(長大なため)
    expect(reviewer).toContain("必要になったときだけ読む");
  });

  it("オーケストレーターと env-builder に専用の指示を付ける", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    const orchestrator = readFileSync(join(result.agentsDir, "orchestrator.md"), "utf8");
    expect(orchestrator).toContain("## デザインスキルの配分");
    expect(orchestrator).toContain("依頼文に使うスキル名を明記する");
    expect(readFileSync(join(result.agentsDir, "env-builder.md"), "utf8")).toContain(
      "## デザインスキルの実行環境",
    );
    // 実装エージェントには配分の指示を付けない
    expect(readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8")).not.toContain(
      "デザインスキルの配分",
    );
  });

  it("マニフェストに導入したスキルを記録する(ダッシュボードの入力)", () => {
    generateTeam(preset(), profileFor(repoDir), requirements);

    const manifest: TeamManifest = loadTeamSettings(repoDir);
    expect(manifest.skills?.map((s) => s.name)).toEqual([
      "design-taste-frontend",
      "redesign-existing-projects",
    ]);
    expect(manifest.skills?.[0].category).toBe("aesthetic");
    expect(manifest.skills?.[0].source?.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("未指定ならスキルを配らず、指示も付けない", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      phase: "active",
      focus: ["quality"],
      teamSize: "minimal",
    });

    expect(result.skillsDir).toBeUndefined();
    expect(existsSync(join(repoDir, ".claude", "skills"))).toBe(false);
    expect(readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8")).not.toContain(
      "デザインスキル",
    );
  });

  it("カタログにない id だけを指定した場合はスキル未導入として扱う", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      ...requirements,
      designSkills: ["存在しないスキル"],
    });

    expect(result.skillsDir).toBeUndefined();
    expect(readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8")).not.toContain(
      "デザインスキル",
    );
  });
});

describe("generateTeam (技術スタック)", () => {
  it("選択した技術をカテゴリ別に全エージェント定義へ明記する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      phase: "active",
      focus: ["quality"],
      teamSize: "minimal",
      techStack: {
        languages: ["java"],
        frameworks: ["liquibase", "tbls"],
        categories: { languages: ["java"], database: ["liquibase", "tbls"] },
      },
    });

    for (const file of result.written) {
      const content = readFileSync(join(result.agentsDir, file), "utf8");
      expect(content).toContain("## 技術スタック");
      expect(content).toContain("- 言語: Java");
      expect(content).toContain("データベース・スキーマ管理: Liquibase(マイグレーション), tbls(スキーマドキュメント生成)");
      expect(content).toContain("ユーザーに確認してから使う");
    }
  });

  it("技術スタックが未選択なら技術スタックのセクションを付けない", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      phase: "active",
      focus: ["quality"],
      teamSize: "minimal",
    });

    for (const file of result.written) {
      expect(readFileSync(join(result.agentsDir, file), "utf8")).not.toContain("## 技術スタック");
    }
  });
});

describe("generateTeam (リバースドキュメント)", () => {
  const requirements: Requirements = {
    phase: "active",
    focus: ["quality"],
    teamSize: "minimal",
    reverseDocs: true,
  };

  it("doc-reverser を teamSize の枠外で追加し、実装エージェントへ流す", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    expect(result.written).toContain("doc-reverser.md");
    const manifest: TeamManifest = loadTeamSettings(repoDir);
    expect(manifest.agents.map((a) => a.name)).toEqual([
      "code-reviewer",
      "test-engineer",
      "refactoring-advisor",
      "env-builder",
      "doc-reverser",
      "orchestrator",
    ]);
    // 現状を示す文書 → 実装 の流れを描く
    expect(manifest.flow).toContainEqual(["doc-reverser", "code-reviewer"]);
  });

  it("全エージェントに文書維持の指示を、orchestrator と env-builder に専用の指示を付ける", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    const reviewer = readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8");
    expect(reviewer).toContain("## リバースドキュメント(コードが単一情報源)");
    expect(reviewer).toContain("doc-reverser へ文書と図の更新を依頼する");

    const orchestrator = readFileSync(join(result.agentsDir, "orchestrator.md"), "utf8");
    expect(orchestrator).toContain("## リバースドキュメントの維持(doc-reverser の使い方)");
    expect(readFileSync(join(result.agentsDir, "env-builder.md"), "utf8")).toContain(
      "## リバースドキュメントと図の実行環境",
    );
    // 実装エージェントには orchestrator 専用の指示を付けない
    expect(reviewer).not.toContain("doc-reverser の使い方");
  });

  it("図の生成に使う archify スキルを配置し、マニフェストに記録する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    expect(result.skillsDir).toBe(join(repoDir, ".claude", "skills"));
    // SKILL.md だけでなくスキル本体(スクリプト・スキーマ)も配られる
    expect(existsSync(join(repoDir, ".claude", "skills", "archify", "SKILL.md"))).toBe(true);
    expect(existsSync(join(repoDir, ".claude", "skills", "archify", "bin", "archify.mjs"))).toBe(
      true,
    );
    expect(existsSync(join(repoDir, ".claude", "skills", "archify", "skill.json"))).toBe(false);

    const manifest: TeamManifest = loadTeamSettings(repoDir);
    expect(manifest.skills?.map((s) => s.id)).toEqual(["archify"]);
    // UI 実装向けのデザイン指示は付けない(図のスキルはデザインスキルではない)
    expect(readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8")).not.toContain(
      "## デザインスキル(UI 実装時に使う)",
    );
  });

  it("文書の索引と書式ガイドの置き場を用意する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    expect(result.docsDir).toBe(join(repoDir, ".claude", "atf-docs"));
    const readme = readFileSync(join(result.docsDir!, "README.md"), "utf8");
    expect(readme).toContain("# example リバースドキュメント");
    expect(readme).toContain("docs.jsonl");
    expect(readme).toContain("archify");
  });

  it("無効なら doc-reverser も atf-docs も archify も作らない", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      phase: "active",
      focus: ["quality"],
      teamSize: "minimal",
    });

    expect(result.written).not.toContain("doc-reverser.md");
    expect(result.docsDir).toBeUndefined();
    expect(existsSync(join(repoDir, ".claude", "atf-docs"))).toBe(false);
    expect(existsSync(join(repoDir, ".claude", "skills"))).toBe(false);
    expect(readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8")).not.toContain(
      "リバースドキュメント",
    );
  });
});

describe("generateTeam (アーキテクチャ適合検証)", () => {
  const requirements: Requirements = {
    phase: "active",
    focus: ["quality"],
    teamSize: "minimal",
    archCheck: true,
  };

  it("arch-guard を teamSize の枠外で追加し、実装 → 検証の流れを描く", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    expect(result.written).toContain("arch-guard.md");
    const manifest: TeamManifest = loadTeamSettings(repoDir);
    expect(manifest.agents.map((a) => a.name)).toContain("arch-guard");
    expect(manifest.flow).toContainEqual(["code-reviewer", "arch-guard"]);
  });

  it("リバースドキュメントと併用すると、文書 → 規約化の流れも描く", () => {
    generateTeam(preset(), profileFor(repoDir), { ...requirements, reverseDocs: true });

    const manifest: TeamManifest = loadTeamSettings(repoDir);
    expect(manifest.flow).toContainEqual(["doc-reverser", "arch-guard"]);
  });

  it("全エージェントに適合検証の指示を、orchestrator にゲートの指示を付ける", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    const reviewer = readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8");
    expect(reviewer).toContain("## アーキテクチャ適合検証(実装後に必ず通す)");
    expect(reviewer).toContain("違反が残っている状態で完了と報告しない");

    const orchestrator = readFileSync(join(result.agentsDir, "orchestrator.md"), "utf8");
    expect(orchestrator).toContain("## アーキテクチャ適合ゲート(実装を完了とする前に通す)");
    expect(readFileSync(join(result.agentsDir, "env-builder.md"), "utf8")).toContain(
      "## アーキテクチャ適合検証の実行環境",
    );
  });

  it("規約の雛形・書式ガイド・実行権限付きの検証スクリプトを用意する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    expect(result.archDir).toBe(join(repoDir, ".claude", "atf-arch"));
    const readme = readFileSync(join(result.archDir!, "README.md"), "utf8");
    expect(readme).toContain("# example アーキテクチャ適合検証");
    expect(readme).toContain("ArchUnit");
    expect(readme).toContain("typescript"); // 検出された言語を書く

    const rules = JSON.parse(readFileSync(join(result.archDir!, "rules.json"), "utf8"));
    expect(rules).toMatchObject({ project: "example", layers: [], rules: [] });

    const runner = join(result.archDir!, "run-arch-check.sh");
    expect(readFileSync(runner, "utf8")).toContain("ARCH <規約 id>");
    expect(statSync(runner).mode & 0o111).toBeTruthy();

    // ArchUnit 系のツールを配線するための変換スクリプト(実行権限つき)
    const converter = join(result.archDir!, "report-junit.mjs");
    expect(existsSync(converter)).toBe(true);
    expect(statSync(converter).mode & 0o111).toBeTruthy();
  });

  it("README と検証スクリプトに、検出した言語のツールだけを書く", () => {
    const readme = readFileSync(
      join(generateTeam(preset(), profileFor(repoDir), requirements).archDir!, "README.md"),
      "utf8",
    );

    // TypeScript のリポジトリなので推奨は ArchUnitTS、dependency-cruiser も併記する
    expect(readme).toContain("### ArchUnitTS(推奨)");
    expect(readme).toContain("npm i -D archunit");
    expect(readme).toContain("dependency-cruiser");
    // 他の言語のツールは畳んで一覧だけ出す(エージェントに読ませる量を絞る)
    expect(readme).toContain("その他の言語のツール");
    expect(readme).not.toContain("### ArchUnitPython");
    // テスト名 = 規約 id の共通の約束と、変換スクリプトの使い方
    expect(readme).toContain("node .claude/atf-arch/report-junit.mjs");
  });

  it("言語ごとに検証スクリプトの実装例が変わる", () => {
    const pythonRepo = mkdtempSync(join(tmpdir(), "atf-arch-py-"));
    const profile = { ...profileFor(pythonRepo), languages: ["python"] };
    const result = generateTeam(preset(), profile, requirements);

    const runner = readFileSync(join(result.archDir!, "run-arch-check.sh"), "utf8");
    expect(runner).toContain("pytest tests/test_architecture.py --junitxml=");
    expect(runner).not.toContain("npx vitest");

    const readme = readFileSync(join(result.archDir!, "README.md"), "utf8");
    expect(readme).toContain("### ArchUnitPython(推奨)");
    expect(readme).toContain("pip install archunitpython");
    expect(readme).toContain("import-linter"); // 代替も併記する
    rmSync(pythonRepo, { recursive: true, force: true });
  });

  it("無効なら arch-guard も atf-arch も作らない", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      phase: "active",
      focus: ["quality"],
      teamSize: "minimal",
    });

    expect(result.written).not.toContain("arch-guard.md");
    expect(result.archDir).toBeUndefined();
    expect(existsSync(join(repoDir, ".claude", "atf-arch"))).toBe(false);
  });
});

describe("generateTeam (ルーブリック評価)", () => {
  const requirements = (): Requirements => ({
    phase: "active",
    focus: ["quality"],
    teamSize: "minimal",
    rubricEval: true,
  });

  const read = (file: string) => readFileSync(join(repoDir, ".claude", "agents", file), "utf8");

  it("evaluator を teamSize の枠外で追加し、実装 → 評価 → まとめ役の流れを描く", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements());

    expect(result.written).toContain("evaluator.md");
    const manifest: TeamManifest = loadTeamSettings(repoDir);
    expect(manifest.agents.map((a) => a.name)).toContain("evaluator");
    expect(manifest.flow).toContainEqual(["code-reviewer", "evaluator"]);
    expect(manifest.flow).toContainEqual(["evaluator", "orchestrator"]);
  });

  it("評価基準の雛形と書式ガイドを用意する(評価観点は evaluator が埋める)", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements());

    expect(result.evalDir).toBe(join(repoDir, ".claude", "atf-eval"));
    const rubric = JSON.parse(readFileSync(join(result.evalDir!, "rubric.json"), "utf8"));
    expect(rubric.template).toBe(true);
    expect(rubric.criteria).toEqual([]);
    expect(existsSync(join(result.evalDir!, "README.md"))).toBe(true);
  });

  it("評価対象の ON/OFF 表を atf-settings.yaml に書き出す(evaluator 自身は除く)", () => {
    generateTeam(preset(), profileFor(repoDir), requirements());

    const manifest: TeamManifest = loadTeamSettings(repoDir);
    const targets = manifest.requirements.evalTargets ?? {};
    // チームにいる全員が既定で評価対象(ユーザーが false に書き換えて外す)
    for (const agent of manifest.agents) {
      if (agent.name === "evaluator") continue;
      expect(targets[agent.name]).toBe(true);
    }
    expect(targets).not.toHaveProperty("evaluator");
    expect(readFileSync(settingsPath(repoDir), "utf8")).toContain("evalTargets:");
  });

  it("評価対象には評価の指示、evaluator には対象一覧、orchestrator にはゲートを付ける", () => {
    generateTeam(preset(), profileFor(repoDir), requirements());

    expect(read("code-reviewer.md")).toContain("## ルーブリック評価(成果物は評価を通す)");
    expect(read("orchestrator.md")).toContain("## ルーブリック評価ゲート(成果物を完了とする前に通す)");
    expect(read("env-builder.md")).toContain("## ルーブリック評価の実行環境");
    // 評価する側は評価されない
    expect(read("evaluator.md")).not.toContain("## ルーブリック評価(成果物は評価を通す)");
    expect(read("evaluator.md")).toContain("## 評価対象のエージェント(設定に従う)");
  });

  it("evalTargets で false にしたエージェントには評価の指示を付けない", () => {
    generateTeam(preset(), profileFor(repoDir), {
      ...requirements(),
      evalTargets: { "code-reviewer": false },
    });

    expect(read("code-reviewer.md")).not.toContain("## ルーブリック評価(成果物は評価を通す)");
    expect(read("test-engineer.md")).toContain("## ルーブリック評価(成果物は評価を通す)");
    expect(read("evaluator.md")).toContain("評価しない: code-reviewer");
  });

  it("無効なら evaluator も指示も足場も作らない", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      phase: "active",
      focus: ["quality"],
      teamSize: "minimal",
    });

    expect(result.written).not.toContain("evaluator.md");
    expect(result.evalDir).toBeUndefined();
    expect(existsSync(join(repoDir, ".claude", "atf-eval"))).toBe(false);
    expect(existsSync(join(repoDir, "atf-bin", "eval.sh"))).toBe(false);
    expect(read("code-reviewer.md")).not.toContain("ルーブリック評価");
    expect(loadTeamSettings(repoDir).requirements.evalTargets).toBeUndefined();
  });
});

describe("generateTeam (atf-settings.yaml)", () => {
  const requirements: Requirements = {
    phase: "active",
    focus: ["quality"],
    teamSize: "minimal",
    archCheck: true,
    reverseDocs: true,
  };

  it("チーム設定をプロジェクトルートの atf-settings.yaml に書く(.claude/team.json は作らない)", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    expect(result.settingsPath).toBe(settingsPath(repoDir));
    expect(existsSync(join(repoDir, ".claude", "team.json"))).toBe(false);

    const yaml = readFileSync(result.settingsPath, "utf8");
    // 何のファイルで、どこを書き換えてよいのかが先頭に書いてある
    expect(yaml).toContain("example のチーム設定");
    expect(yaml).toContain("requirements: ヒアリングの結果");
    expect(yaml).toContain("archCheck: true");
    // フロー(from → to)は 1 行 1 辺で読める形にする
    expect(yaml).toMatch(/- \[.*doc-reverser.*\]/);
  });

  it("書き出した設定はそのまま読み戻せる", () => {
    generateTeam(preset(), profileFor(repoDir), {
      ...requirements,
      issueDriven: true,
      githubRepo: "octocat/hello-world",
      techStack: {
        languages: ["typescript"],
        frameworks: [],
        categories: { languages: ["typescript"] },
      },
    });

    const manifest = loadTeamSettings(repoDir);

    expect(manifest.project).toBe("example");
    expect(manifest.preset).toBe("quality-review");
    expect(manifest.requirements.githubRepo).toBe("octocat/hello-world");
    expect(manifest.requirements.techStack?.categories).toEqual({ languages: ["typescript"] });
    expect(manifest.agents.map((a) => a.name)).toContain("orchestrator");
    expect(manifest.flow.some(([from, to]) => from === "doc-reverser" && to === "arch-guard")).toBe(
      true,
    );
  });

  it("旧 .claude/team.json が残っていれば作り直しのときに消える", () => {
    mkdirSync(join(repoDir, ".claude"), { recursive: true });
    writeFileSync(join(repoDir, ".claude", "team.json"), "{}");

    generateTeam(preset(), profileFor(repoDir), requirements);

    expect(existsSync(join(repoDir, ".claude", "team.json"))).toBe(false);
    expect(existsSync(settingsPath(repoDir))).toBe(true);
  });
});
