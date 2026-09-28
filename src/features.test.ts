import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectProjectFeatures } from "./features.js";
import { loadTeamSettings, saveTeamSettings, settingsPath } from "./settings.js";
import { generateTeam } from "./generator.js";
import { loadPresets } from "./presets.js";
import { decisionsPath } from "./alloy.js";
import { runWeave } from "./weave.js";
import type { FeatureStatus } from "./features.js";
import type { RepoProfile, Requirements } from "./types.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "atf-status-"));
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

const base: Requirements = { phase: "active", focus: ["quality"], teamSize: "minimal" };

const feature = (features: FeatureStatus[], id: string): FeatureStatus => {
  const found = features.find((f) => f.id === id);
  if (!found) throw new Error(`feature not found: ${id}`);
  return found;
};

/** 全機能オフで導入したチーム */
describe("collectProjectFeatures(機能オフ)", () => {
  it("有効な機能がないことと、有効化の方法を返す", () => {
    generateTeam(preset(), profile(), base);

    const state = collectProjectFeatures(repoDir);

    expect(state.project).toBe("example");
    expect(state.preset).toBe("quality-review");
    expect(state.agents.map((a) => a.name)).toContain("orchestrator");
    // 共通エージェント(templates/common)とプリセット由来を区別する
    expect(state.agents.find((a) => a.name === "orchestrator")?.origin).toBe("common");
    expect(state.agents.every((a) => a.exists)).toBe(true);
    expect(state.missingAgents).toEqual([]);
    expect(state.features.filter((f) => f.enabled)).toEqual([]);
    // 無効な機能には有効化の方法が付く(何を選べば入るのかが分かるように)
    for (const f of state.features) {
      expect(f.howToEnable).toBeTruthy();
      expect(f.issues).toEqual([]);
    }
    expect(state.features.map((f) => f.id)).toEqual([
      "issue-driven",
      "pr-flow",
      "touchpoints",
      "formal-spec",
      "reverse-docs",
      "arch-check",
      "rubric-eval",
      "capability-scout",
      "design-skills",
      "tech-stack",
    ]);
  });

  it("無効なのに成果物のディレクトリが残っていれば要確認として報告する", () => {
    generateTeam(preset(), profile(), base);
    mkdirSync(join(repoDir, ".claude", "atf-arch"), { recursive: true });
    mkdirSync(join(repoDir, "spec"), { recursive: true });

    const state = collectProjectFeatures(repoDir);

    expect(feature(state.features, "arch-check").issues[0]).toContain("無効だが");
    expect(feature(state.features, "formal-spec").issues[0]).toContain("無効だが");
  });
});

describe("collectProjectFeatures(リバースドキュメント・アーキテクチャ検証)", () => {
  const requirements: Requirements = { ...base, reverseDocs: true, archCheck: true };

  it("有効な機能の担当エージェント・成果物・未整備を報告する", () => {
    generateTeam(preset(), profile(), requirements);

    const state = collectProjectFeatures(repoDir);

    const reverse = feature(state.features, "reverse-docs");
    expect(reverse.enabled).toBe(true);
    expect(reverse.details.join("\n")).toContain("担当: doc-reverser");
    expect(reverse.details.join("\n")).toContain("archify スキル");
    expect(reverse.commands.join(" ")).toContain("atf-bin/docs.sh");
    // 導入直後は文書がないので要確認になる
    expect(reverse.issues.join("\n")).toContain("文書の記録が 1 件もない");

    const arch = feature(state.features, "arch-check");
    expect(arch.enabled).toBe(true);
    expect(arch.details.join("\n")).toContain("担当: arch-guard");
    expect(arch.commands.join(" ")).toContain("atf-bin/arch.sh");
    // 規約の雛形と検証スクリプトの雛形は「未整備」として挙げる
    expect(arch.issues.join("\n")).toContain("規約が未定義");
    expect(arch.issues.join("\n")).toContain("検証スクリプトが雛形のまま");
  });

  it("規約・検証記録が揃えば適合ゲートの通過を返す", () => {
    generateTeam(preset(), profile(), requirements);
    const archDir = join(repoDir, ".claude", "atf-arch");
    writeFileSync(
      join(archDir, "rules.json"),
      JSON.stringify({
        tool: "dependency-cruiser",
        layers: [{ id: "domain", name: "ドメイン", patterns: ["src/domain/**"] }],
        rules: [{ id: "ARCH-01", kind: "no-cycle", description: "循環依存を禁止する" }],
      }),
    );
    writeFileSync(join(archDir, "run-arch-check.sh"), "#!/usr/bin/env bash\necho 'ARCH ARCH-01 PASS'\n");
    writeFileSync(
      join(archDir, "checks.jsonl"),
      JSON.stringify({ rule: "ARCH-01", result: "pass" }) + "\n",
    );

    const arch = feature(collectProjectFeatures(repoDir).features, "arch-check");

    expect(arch.details.join("\n")).toContain("適合ゲート: ✅ 通過");
    expect(arch.issues).toEqual([]);
  });

  it("違反が残っていれば要確認として報告する", () => {
    generateTeam(preset(), profile(), requirements);
    const archDir = join(repoDir, ".claude", "atf-arch");
    writeFileSync(
      join(archDir, "rules.json"),
      JSON.stringify({
        tool: "dependency-cruiser",
        layers: [],
        rules: [{ id: "ARCH-01", kind: "no-cycle", description: "循環依存を禁止する" }],
      }),
    );
    writeFileSync(join(archDir, "run-arch-check.sh"), "#!/usr/bin/env bash\necho x\n");
    writeFileSync(
      join(archDir, "checks.jsonl"),
      JSON.stringify({ rule: "ARCH-01", result: "violation", violations: 2 }) + "\n",
    );

    const arch = feature(collectProjectFeatures(repoDir).features, "arch-check");

    expect(arch.details.join("\n")).toContain("適合ゲート: ❌ 未通過");
    expect(arch.issues.join("\n")).toContain("規約違反・検証エラーが 1 件残っている");
  });

  it("実装に追随していない文書を要確認として報告する", () => {
    generateTeam(preset(), profile(), requirements);
    writeFileSync(
      join(repoDir, ".claude", "atf-docs", "docs.jsonl"),
      JSON.stringify({
        path: "docs/architecture/overview.md",
        title: "全体像",
        kind: "overview",
        sources: ["src/removed.ts"],
      }) + "\n",
    );

    const reverse = feature(collectProjectFeatures(repoDir).features, "reverse-docs");

    expect(reverse.details.join("\n")).toContain("要再生成 1 件");
    expect(reverse.issues.join("\n")).toContain("実装に追随していない文書が 1 件");
  });

  it("担当エージェントの定義が消えていれば要確認として報告する", () => {
    generateTeam(preset(), profile(), requirements);
    rmSync(join(repoDir, ".claude", "agents", "doc-reverser.md"));

    const state = collectProjectFeatures(repoDir);

    expect(state.missingAgents).toEqual(["doc-reverser.md"]);
    expect(feature(state.features, "reverse-docs").issues.join("\n")).toContain(
      "doc-reverser.md が .claude/agents/ にない",
    );
  });
});

describe("collectProjectFeatures(ルーブリック評価)", () => {
  const requirements: Requirements = { ...base, rubricEval: true };

  const writeRubric = (rubric: unknown): void =>
    writeFileSync(join(repoDir, ".claude", "atf-eval", "rubric.json"), JSON.stringify(rubric));
  const writeEvaluations = (records: unknown[]): void =>
    writeFileSync(
      join(repoDir, ".claude", "atf-eval", "evaluations.jsonl"),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );

  it("担当エージェント・評価対象・雛形のままの基準を報告する", () => {
    generateTeam(preset(), profile(), requirements);

    const evaluation = feature(collectProjectFeatures(repoDir).features, "rubric-eval");

    expect(evaluation.enabled).toBe(true);
    expect(evaluation.details.join("\n")).toContain("担当: evaluator");
    expect(evaluation.details.join("\n")).toContain("評価対象:");
    expect(evaluation.commands.join(" ")).toContain("atf-bin/eval.sh");
    // 導入直後は観点が雛形のままなので要確認になる
    expect(evaluation.issues.join("\n")).toContain("雛形のまま");
  });

  it("観点と評価記録が揃えば評価ゲートの通過を返す", () => {
    generateTeam(preset(), profile(), requirements);
    writeRubric({
      passScore: 3,
      criteria: [
        { id: "EVAL-01", name: "要求の充足", description: "...", levels: [] },
      ],
    });
    const targets = Object.keys(loadTeamSettings(repoDir).requirements.evalTargets ?? {});
    writeEvaluations(
      targets.map((target) => ({
        target,
        artifact: `${target}-output`,
        scores: [{ id: "EVAL-01", score: 4 }],
        verdict: "pass",
      })),
    );

    const evaluation = feature(collectProjectFeatures(repoDir).features, "rubric-eval");

    expect(evaluation.details.join("\n")).toContain("評価ゲート: ✅ 通過");
    expect(evaluation.issues).toEqual([]);
  });

  it("閾値未満のまま合格と記録されていれば、食い違いとして報告する", () => {
    generateTeam(preset(), profile(), requirements);
    writeRubric({
      passScore: 3,
      actions: { below: ["担当に差し戻す"] },
      criteria: [
        { id: "EVAL-01", name: "要求の充足", description: "...", passScore: 4, levels: [] },
      ],
    });
    writeEvaluations([
      {
        target: "code-reviewer",
        artifact: "src/a.ts",
        scores: [{ id: "EVAL-01", score: 3 }],
        verdict: "pass",
      },
    ]);

    const evaluation = feature(collectProjectFeatures(repoDir).features, "rubric-eval");

    expect(evaluation.details.join("\n")).toContain("既定の閾値: 3 以上");
    expect(evaluation.details.join("\n")).toContain("ネクストアクション: 設定あり");
    expect(evaluation.details.join("\n")).toContain("閾値未満の観点: 1 件");
    expect(evaluation.issues.join("\n")).toContain("合格と記録されているが、閾値未満の観点がある");
  });

  it("チームにいない target の記録は、ゲートに入らないことを知らせる", () => {
    generateTeam(preset(), profile(), requirements);
    writeRubric({ criteria: [{ id: "EVAL-01", name: "x", description: "...", levels: [] }] });
    writeEvaluations([
      { target: "who-is-this", artifact: "src/a.ts", scores: [], verdict: "pass" },
    ]);

    const evaluation = feature(collectProjectFeatures(repoDir).features, "rubric-eval");

    expect(evaluation.issues.join("\n")).toContain("チームにいない: who-is-this");
  });

  it("無効なら有効化の方法を返し、成果物が残っていれば知らせる", () => {
    generateTeam(preset(), profile(), base);

    let evaluation = feature(collectProjectFeatures(repoDir).features, "rubric-eval");
    expect(evaluation.enabled).toBe(false);
    expect(evaluation.howToEnable).toContain("atf apply eval");
    expect(evaluation.issues).toEqual([]);

    mkdirSync(join(repoDir, ".claude", "atf-eval"), { recursive: true });
    evaluation = feature(collectProjectFeatures(repoDir).features, "rubric-eval");
    expect(evaluation.issues.join("\n")).toContain("無効だが");
  });
});

describe("collectProjectFeatures(その他の機能)", () => {
  it("Issue 駆動・PR フロー・タッチポイント・技術スタックの適用状況を返す", () => {
    generateTeam(preset(), profile(), {
      ...base,
      issueDriven: true,
      githubRepo: "octocat/hello-world",
      prFlow: true,
      touchpoints: ["pr-merge"],
      techStack: { languages: ["typescript"], frameworks: [], categories: { languages: ["typescript"] } },
    });

    const state = collectProjectFeatures(repoDir);

    expect(feature(state.features, "issue-driven").details.join("\n")).toContain(
      "起票先: octocat/hello-world",
    );
    expect(feature(state.features, "pr-flow").details.join("\n")).toContain(
      "マージの実行主体: ユーザー",
    );
    expect(feature(state.features, "touchpoints").details.join("\n")).toContain(
      "PR のマージはユーザーが実行する",
    );
    expect(feature(state.features, "tech-stack").enabled).toBe(true);
    expect(feature(state.features, "tech-stack").details.join("\n")).toContain("TypeScript");
  });

  it("GitHub リポジトリ未設定のまま Issue 駆動・PR フローが有効なら要確認にする", () => {
    generateTeam(preset(), profile(), { ...base, issueDriven: true, prFlow: true });

    const state = collectProjectFeatures(repoDir);

    expect(feature(state.features, "issue-driven").issues.join("\n")).toContain(
      "GitHub リポジトリが未設定",
    );
    expect(feature(state.features, "pr-flow").issues.join("\n")).toContain("GitHub リポジトリが未設定");
  });

  it("形式仕様モードでは jar・検証コマンド・規約違反を報告する", () => {
    generateTeam(preset(), profile(), { ...base, formalSpec: true });

    const spec = feature(collectProjectFeatures(repoDir).features, "formal-spec");

    expect(spec.enabled).toBe(true);
    // 雛形の main.als だけが置かれた直後の状態
    expect(spec.details.join("\n")).toContain("モデル: 1 件");
    expect(spec.issues.join("\n")).toContain("検証コマンド(check / run)が 1 つもない");
    // ルートモジュールの必須タグが TODO のままなので、規約検査が落ちる
    expect(spec.details.join("\n")).toContain("規約検査(atf lint)");
    expect(spec.issues.join("\n")).toContain("@title が雛形(TODO)のままです");
    expect(spec.commands.join(" ")).toContain("atf-bin/formal.sh");
    expect(spec.commands.join(" ")).toContain("atf-bin/lint.sh");
  });

  it("反例への対処方針と、ユーザー未確認の自動確定を報告する", () => {
    generateTeam(preset(), profile(), { ...base, formalSpec: true });
    writeFileSync(
      decisionsPath(repoDir),
      [
        JSON.stringify({
          requirement: "REQ-01",
          finding: "反例",
          decision: "顧客は必須",
          rationale: "整合性",
          status: "auto",
        }),
        JSON.stringify({
          requirement: "REQ-02",
          finding: "反例",
          decision: "上限は 10",
          rationale: "設計書 4.1",
          status: "confirmed",
        }),
      ].join("\n") + "\n",
    );

    const spec = feature(collectProjectFeatures(repoDir).features, "formal-spec");

    expect(spec.details.join("\n")).toContain("反例への対処: 明白なものは自動確定");
    expect(spec.details.join("\n")).toContain("自動確定の記録: 2 件(ユーザー未確認 1 件)");
    expect(spec.issues.join("\n")).toContain("ユーザー未確認の自動確定が 1 件ある");
  });

  it("自動確定を無効にしていれば、その方針を報告する", () => {
    generateTeam(preset(), profile(), { ...base, formalSpec: true, specAutoFix: false });

    const spec = feature(collectProjectFeatures(repoDir).features, "formal-spec");

    expect(spec.details.join("\n")).toContain("反例への対処: 常にユーザーへ確認");
  });

  it("派生文書(docs/generated/)が .als に追いついていなければ要確認にする", () => {
    generateTeam(preset(), profile(), { ...base, formalSpec: true });
    writeFileSync(
      join(repoDir, "spec", "order.als"),
      "module order\n\n/**\n * @req R-01  要件\n */\nsig Order {}\n",
    );

    const before = feature(collectProjectFeatures(repoDir).features, "formal-spec");
    expect(before.details.join("\n")).toContain("派生文書(docs/generated/): ⬜");
    expect(before.issues.join("\n")).toContain("docs/generated/ が .als に追随していない");

    runWeave(repoDir, "example");
    const after = feature(collectProjectFeatures(repoDir).features, "formal-spec");
    expect(after.details.join("\n")).toContain("派生文書(docs/generated/): ✅ 最新");
    expect(after.issues.join("\n")).not.toContain("追随していない");
  });
});
