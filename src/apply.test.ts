import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFeatures, enabledFeatures, FEATURE_IDS, smokeRun } from "./apply.js";
import { generateTeam } from "./generator.js";
import { loadPresets } from "./presets.js";
import { loadTeamSettings } from "./settings.js";
import type { RepoProfile, Requirements, TeamManifest } from "./types.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "atf-apply-"));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

const profile = (): RepoProfile => ({
  path: repoDir,
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

/** 機能をひとつも有効にしていないチームを導入する */
function team(over: Partial<Requirements> = {}): void {
  const requirements: Requirements = {
    phase: "active",
    focus: ["quality"],
    teamSize: "minimal",
    ...over,
  };
  generateTeam(preset(), profile(), requirements);
}

const agentPath = (file: string) => join(repoDir, ".claude", "agents", file);
const read = (file: string) => readFileSync(agentPath(file), "utf8");
const manifest = (): TeamManifest => loadTeamSettings(repoDir);

describe("applyFeatures", () => {
  it("requirements を有効にし、担当エージェント・足場・実行スクリプトを用意する", () => {
    team();
    const result = applyFeatures(repoDir, ["arch"]);

    expect(manifest().requirements.archCheck).toBe(true);
    expect(result.applied[0]).toMatchObject({ id: "arch", alreadyEnabled: false, agentFile: "arch-guard.md" });
    expect(existsSync(agentPath("arch-guard.md"))).toBe(true);
    expect(existsSync(join(repoDir, ".claude", "atf-arch", "rules.json"))).toBe(true);
    expect(existsSync(join(repoDir, "atf-bin", "arch.sh"))).toBe(true);
    // マニフェストにも担当エージェントが載る(status / ダッシュボードの入力になる)
    expect(manifest().agents.some((a) => a.file === "arch-guard.md")).toBe(true);
  });

  it("既存のエージェント定義に機能の指示を差し込む(実行記録より前)", () => {
    team();
    applyFeatures(repoDir, ["arch"]);

    const orchestrator = read("orchestrator.md");
    expect(orchestrator).toContain("## アーキテクチャ適合検証(実装後に必ず通す)");
    expect(orchestrator).toContain("## アーキテクチャ適合ゲート(実装を完了とする前に通す)");
    expect(orchestrator.indexOf("## アーキテクチャ適合ゲート")).toBeLessThan(
      orchestrator.indexOf("## 実行記録"),
    );
    // env-builder には整備指示、実装エージェントには共通の指示だけが入る
    expect(read("env-builder.md")).toContain("## アーキテクチャ適合検証の実行環境");
    expect(read("code-reviewer.md")).toContain("## アーキテクチャ適合検証(実装後に必ず通す)");
    expect(read("code-reviewer.md")).not.toContain("## アーキテクチャ適合ゲート");
  });

  it("繰り返し実行しても指示が増殖せず、手で書き足した節は残る", () => {
    team();
    applyFeatures(repoDir, ["arch"]);
    writeFileSync(agentPath("orchestrator.md"), read("orchestrator.md") + "\n## 手書きのメモ\n\n残ること\n");

    const result = applyFeatures(repoDir, ["arch"]);

    const body = read("orchestrator.md");
    expect(body.match(/## アーキテクチャ適合ゲート/g)?.length).toBe(1);
    expect(body).toContain("## 手書きのメモ");
    expect(result.applied[0].alreadyEnabled).toBe(true);
  });

  it("リバースドキュメントでは図のスキル(archify)も配る", () => {
    team();
    const result = applyFeatures(repoDir, ["docs"]);

    expect(result.skills.map((s) => s.id)).toContain("archify");
    expect(manifest().skills?.some((s) => s.id === "archify")).toBe(true);
    expect(existsSync(join(repoDir, ".claude", "skills", "archify", "SKILL.md"))).toBe(true);
  });

  it("複数の機能をまとめて導入し、構成図の辺を組み直す", () => {
    team();
    const result = applyFeatures(repoDir, ["arch", "docs"]);

    expect(result.applied.map((a) => a.id)).toEqual(["arch", "docs"]);
    const flow = manifest().flow.map((e) => e.join(" → "));
    const first = manifest().agents[0].name;
    expect(flow).toContain(`doc-reverser → ${first}`);
    expect(flow).toContain(`${first} → arch-guard`);
    expect(flow).toContain("doc-reverser → arch-guard");
    // 同じ辺が二重に入らない
    expect(new Set(flow).size).toBe(flow.length);
  });

  it("形式仕様では spec/ と docs/adr/ を用意し、実行スクリプトを 3 本配る", () => {
    team();
    applyFeatures(repoDir, ["formal"]);

    expect(manifest().requirements.formalSpec).toBe(true);
    expect(existsSync(join(repoDir, "spec", "run-alloy.sh"))).toBe(true);
    expect(existsSync(join(repoDir, "spec", "main.als"))).toBe(true);
    expect(existsSync(join(repoDir, "docs", "adr", "README.md"))).toBe(true);
    for (const script of ["formal.sh", "weave.sh", "lint.sh"]) {
      expect(existsSync(join(repoDir, "atf-bin", script))).toBe(true);
    }
  });

  it("追加した spec-formalizer にも、反例の判断と weave / lint の指示が入る", () => {
    team();
    const result = applyFeatures(repoDir, ["formal"]);

    expect(result.applied[0].agentFile).toBe("spec-formalizer.md");
    const formalizer = read("spec-formalizer.md");
    expect(formalizer).toContain("## 要件・仕様の単一情報源(形式仕様 + ADR)");
    expect(formalizer).toContain("## 反例が出たときの進め方(自動確定の判断)");
    expect(formalizer).toContain("## 自然言語化(weave)と規約検査(lint)");
    // 追加した定義は「更新した定義」の一覧には並べない(追加として報告するため)
    expect(result.agents).not.toContain("spec-formalizer.md");
  });

  it("apply formal を繰り返してもセクションが増えない", () => {
    team();
    applyFeatures(repoDir, ["formal"]);
    applyFeatures(repoDir, ["formal"]);

    const formalizer = read("spec-formalizer.md");
    expect(formalizer.split("## 反例が出たときの進め方(自動確定の判断)")).toHaveLength(2);
    expect(formalizer.split("## 要件・仕様の単一情報源(形式仕様 + ADR)")).toHaveLength(2);
    expect(read("orchestrator.md").split("## 形式検証ゲート(実装前に必ず通す)")).toHaveLength(2);
  });

  it("--ask-only(specAutoFix: false)を設定に残し、指示を確認優先に入れ替える", () => {
    team();
    applyFeatures(repoDir, ["formal"]);
    expect(read("spec-formalizer.md")).toContain("**自動確定を有効**");

    applyFeatures(repoDir, ["formal"], { specAutoFix: false });

    expect(manifest().requirements.specAutoFix).toBe(false);
    const formalizer = read("spec-formalizer.md");
    expect(formalizer).toContain("**自動確定を無効**");
    expect(formalizer).not.toContain("**自動確定を有効**");
    expect(read("orchestrator.md")).toContain("仕様を決めるのはユーザー");

    // 指定しなければ既存の設定を保つ
    applyFeatures(repoDir, ["formal"]);
    expect(manifest().requirements.specAutoFix).toBe(false);
  });

  it("形式仕様の導入時に解説テンプレートを配り、既存の .als から派生文書を生成する", () => {
    team();
    mkdirSync(join(repoDir, "spec"), { recursive: true });
    writeFileSync(
      join(repoDir, "spec", "order.als"),
      "module order\n\n/**\n * @req R-01  注文は 1 人の顧客に属する\n */\nsig Order {}\n",
    );

    applyFeatures(repoDir, ["formal"]);

    expect(existsSync(join(repoDir, ".claude", "atf-formal", "explain-template.html"))).toBe(true);
    const generated = join(repoDir, "docs", "generated");
    expect(readFileSync(join(generated, "order.explain.html"), "utf8")).toContain("R-01");
    expect(readFileSync(join(generated, "overview.md"), "utf8")).toContain("DO NOT EDIT");
  });

  it("既存のエージェント定義は上書きせず、指示の差し込みだけを行う", () => {
    team();
    writeFileSync(agentPath("arch-guard.md"), "# 自前の arch-guard\n\n## 役割\n\n独自。\n");

    const result = applyFeatures(repoDir, ["arch"]);

    expect(result.applied[0].agentFile).toBeUndefined();
    const body = read("arch-guard.md");
    expect(body).toContain("# 自前の arch-guard");
    expect(body).toContain("## アーキテクチャ適合検証(実装後に必ず通す)");
  });

  it("report は requirements を持たず、実行スクリプトとダッシュボードだけを配る", () => {
    team();
    const result = applyFeatures(repoDir, ["report"]);

    expect(result.applied[0]).toMatchObject({ id: "report", agentFile: undefined });
    expect(existsSync(join(repoDir, "atf-bin", "report.sh"))).toBe(true);
    expect(existsSync(join(repoDir, ".claude", "atf-dashboard.html"))).toBe(true);
    // 機能のオン/オフを持たないので requirements は増えない
    expect(Object.keys(manifest().requirements)).not.toContain("report");
    expect(result.agents).toEqual([]);
  });

  it("知らない機能 id は報告して、他の機能の導入は進める", () => {
    team();
    const result = applyFeatures(repoDir, ["arch", "unknown-feature"]);

    expect(result.unknown).toEqual(["unknown-feature"]);
    expect(manifest().requirements.archCheck).toBe(true);
  });
});

describe("applyFeatures(Issue 駆動)", () => {
  it("issue-manager と Issue 駆動の指示・ドラフトの置き場を用意する", () => {
    team({ githubRepo: "acme/app" });
    const result = applyFeatures(repoDir, ["issue"]);

    expect(manifest().requirements.issueDriven).toBe(true);
    expect(result.applied[0]).toMatchObject({ id: "issue", agentFile: "issue-manager.md" });
    expect(existsSync(agentPath("issue-manager.md"))).toBe(true);
    // ゲートではないので実行スクリプトは配らない
    expect(existsSync(join(repoDir, "atf-bin", "issue.sh"))).toBe(false);
    // 起案段階のタスク置き場(ダッシュボードのタスク依存グラフの入力)
    expect(existsSync(join(repoDir, ".claude", "atf-issues", "README.md"))).toBe(true);
    // 起票先は全エージェントの指示に入る
    expect(read("code-reviewer.md")).toContain("## Issue 駆動開発");
    expect(read("code-reviewer.md")).toContain("acme/app");
    // orchestrator と env-builder には専用の節が付く
    expect(read("orchestrator.md")).toContain("## Issue 駆動モードの運用");
    expect(read("env-builder.md")).toContain("## Issue 駆動の実行環境");
    // 構成図は issue-manager を入口にする
    expect(manifest().flow).toContainEqual(["orchestrator", "issue-manager"]);
  });

  it("Issue 承認のタッチポイントがあれば、承認前に着手しない指示を入れる", () => {
    team({ githubRepo: "acme/app", touchpoints: ["issue-approval"] });
    applyFeatures(repoDir, ["issue"]);

    expect(read("code-reviewer.md")).toContain("承認前に実装を始めない");
  });

  it("繰り返し実行しても Issue の指示が増殖しない", () => {
    team();
    applyFeatures(repoDir, ["issue"]);
    applyFeatures(repoDir, ["issue"]);

    expect(read("code-reviewer.md").match(/## Issue 駆動開発/g)).toHaveLength(1);
    expect(read("orchestrator.md").match(/## Issue 駆動モードの運用/g)).toHaveLength(1);
  });

  it("実行スクリプトを持たないのでスモーク実行の対象にならない", () => {
    team();
    applyFeatures(repoDir, ["issue"]);

    expect(smokeRun(repoDir, "issue")).toBeUndefined();
  });
});

describe("applyFeatures(ルーブリック評価)", () => {
  it("evaluator を追加し、評価対象の表を atf-settings.yaml に書き出す", () => {
    team();
    const result = applyFeatures(repoDir, ["eval"]);

    expect(manifest().requirements.rubricEval).toBe(true);
    expect(result.applied[0]).toMatchObject({ id: "eval", agentFile: "evaluator.md" });
    expect(existsSync(agentPath("evaluator.md"))).toBe(true);
    expect(existsSync(join(repoDir, ".claude", "atf-eval", "rubric.json"))).toBe(true);
    expect(existsSync(join(repoDir, "atf-bin", "eval.sh"))).toBe(true);

    // 評価対象はチーム構成から導かれ、evaluator 自身は載らない
    const targets = manifest().requirements.evalTargets ?? {};
    expect(targets["code-reviewer"]).toBe(true);
    expect(targets["orchestrator"]).toBe(true);
    expect(targets).not.toHaveProperty("evaluator");
  });

  it("評価対象には評価の指示、evaluator には対象一覧、まとめ役にはゲートを入れる", () => {
    team();
    applyFeatures(repoDir, ["eval"]);

    expect(read("code-reviewer.md")).toContain("## ルーブリック評価(成果物は評価を通す)");
    expect(read("code-reviewer.md")).not.toContain("## ルーブリック評価ゲート");
    expect(read("orchestrator.md")).toContain("## ルーブリック評価ゲート(成果物を完了とする前に通す)");
    expect(read("env-builder.md")).toContain("## ルーブリック評価の実行環境");

    // 評価する側は評価されない(自己採点にならないように)
    const evaluator = read("evaluator.md");
    expect(evaluator).not.toContain("## ルーブリック評価(成果物は評価を通す)");
    expect(evaluator).toContain("## 評価対象のエージェント(設定に従う)");
    expect(evaluator).toContain("code-reviewer");
  });

  it("evalTargets を false にして再実行すると、そのエージェントから指示が外れる", () => {
    team();
    applyFeatures(repoDir, ["eval"]);
    expect(read("code-reviewer.md")).toContain("## ルーブリック評価(成果物は評価を通す)");

    // ユーザーが atf-settings.yaml を手で書き換えた状態を再現する
    const settings = join(repoDir, "atf-settings.yaml");
    writeFileSync(
      settings,
      readFileSync(settings, "utf8").replace("code-reviewer: true", "code-reviewer: false"),
    );
    applyFeatures(repoDir, ["eval"]);

    expect(read("code-reviewer.md")).not.toContain("## ルーブリック評価(成果物は評価を通す)");
    expect(read("test-engineer.md")).toContain("## ルーブリック評価(成果物は評価を通す)");
    // 手で書いた false は保たれ、evaluator の指示にも反映される
    expect(manifest().requirements.evalTargets?.["code-reviewer"]).toBe(false);
    expect(read("evaluator.md")).toContain("評価しない: code-reviewer");
  });

  it("あとから追加した機能の担当エージェントにも評価の指示が入る", () => {
    team();
    applyFeatures(repoDir, ["eval"]);
    applyFeatures(repoDir, ["arch"]);

    expect(read("arch-guard.md")).toContain("## ルーブリック評価(成果物は評価を通す)");
  });

  it("actions を持たない既存のルーブリックには、既定を補う(観点は変えない)", () => {
    team();
    applyFeatures(repoDir, ["eval"]);
    // ネクストアクションを足す前に作られたルーブリックを再現する
    const rubricFile = join(repoDir, ".claude", "atf-eval", "rubric.json");
    writeFileSync(
      rubricFile,
      JSON.stringify({
        project: "example",
        passScore: 3,
        criteria: [{ id: "EVAL-01", name: "要求の充足", description: "...", levels: [] }],
      }),
    );

    applyFeatures(repoDir, ["eval"]);

    const rubric = JSON.parse(readFileSync(rubricFile, "utf8"));
    expect(rubric.actions.below.length).toBeGreaterThan(0);
    expect(rubric.actions.meets.length).toBeGreaterThan(0);
    // 観点は evaluator の作業結果なので触らない
    expect(rubric.criteria).toHaveLength(1);
    expect(rubric.criteria[0].id).toBe("EVAL-01");
  });

  it("evaluator には、閾値とネクストアクションの決め方を管理セクションで配る", () => {
    team();
    applyFeatures(repoDir, ["eval"]);

    // 本文ではなく管理セクションなので、既に evaluator.md があるチームにも届く
    expect(read("evaluator.md")).toContain("## 閾値とネクストアクションの設定");
    expect(read("code-reviewer.md")).not.toContain("## 閾値とネクストアクションの設定");
  });

  it("スモーク実行は、観点が雛形のままなら未整備として扱う", () => {
    team();
    applyFeatures(repoDir, ["eval"]);

    expect(smokeRun(repoDir, "eval")?.verdict).toBe("pending");
  });
});

describe("enabledFeatures", () => {
  it("有効になっている機能だけを返す", () => {
    team({ archCheck: true });

    expect(enabledFeatures(manifest())).toEqual(["arch"]);
    expect(FEATURE_IDS).toEqual(["formal", "arch", "docs", "issue", "eval", "report"]);
  });
});

describe("smokeRun", () => {
  /** atf の代わりに呼ばれる偽コマンド(終了コードと出力を固定する) */
  function fakeAtf(exitCode: number, message = "fake atf"): Record<string, string> {
    const script = join(repoDir, "fake-atf.sh");
    writeFileSync(script, `#!/usr/bin/env bash\necho "${message} $*"\nexit ${exitCode}\n`);
    return { ATF: `bash ${script}` };
  }

  it("中身が未整備なら、ゲートが落ちても pending(導入直後の想定どおりの状態)", () => {
    team();
    applyFeatures(repoDir, ["arch"]);

    // 規約は雛形(rules 0 件)のまま = 検証対象がない
    const result = smokeRun(repoDir, "arch", { env: fakeAtf(1) });

    expect(result?.verdict).toBe("pending");
    expect(result?.output).toContain("fake atf arch");
    expect(result?.next).toContain("arch-guard");
  });

  it("中身が揃っていれば、終了コードで合否を判定する", () => {
    team();
    applyFeatures(repoDir, ["arch"]);
    writeFileSync(
      join(repoDir, ".claude", "atf-arch", "rules.json"),
      JSON.stringify({ project: "example", layers: [], rules: [{ id: "ARCH-01", description: "x" }] }),
    );
    // 雛形のままだと「ツール未配線」で未整備扱いになるため、検証スクリプトも差し替える
    writeFileSync(join(repoDir, ".claude", "atf-arch", "run-arch-check.sh"), "echo ARCH ARCH-01 PASS\n");

    expect(smokeRun(repoDir, "arch", { env: fakeAtf(0) })?.verdict).toBe("pass");
    expect(smokeRun(repoDir, "arch", { env: fakeAtf(1) })?.verdict).toBe("fail");
  });

  it("スクリプトから atf を解決できなければ unresolved(配線の不備)", () => {
    team();
    applyFeatures(repoDir, ["docs"]);
    // このマシンの atf を指す記録を潰し、PATH からも atf を外す
    writeFileSync(join(repoDir, "atf-bin", "atf.local.sh"), `ATF_HOME_DIR="${join(repoDir, "nowhere")}"\n`);

    const result = smokeRun(repoDir, "docs", { env: { ATF: "", PATH: "/usr/bin:/bin" } });

    expect(result?.verdict).toBe("unresolved");
    expect(result?.code).toBe(127);
  });

  it("有効にしていない機能のスクリプトは配られていないので missing", () => {
    team();
    applyFeatures(repoDir, ["arch"]);

    expect(smokeRun(repoDir, "formal", { env: fakeAtf(0) })?.verdict).toBe("missing");
  });

  it("ダッシュボードは中身の条件がないので、終了コードがそのまま合否になる", () => {
    team();
    applyFeatures(repoDir, ["report"]);

    expect(smokeRun(repoDir, "report", { env: fakeAtf(0) })?.verdict).toBe("pass");
  });
});
