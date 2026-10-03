import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_LOG_VIEWER_URL, agentLogStatus } from "./agentlog.js";
import {
  archChecksPath,
  archDir,
  archGateStatus,
  archRulesPath,
  archRunnerPath,
  isArchRunnerTemplate,
  loadArchChecks,
  loadArchRules,
} from "./arch.js";
import {
  legacySpecLeftovers,
  loadSpecChecks,
  loadSpecDecisions,
  loadSpecModels,
  resolveAlloyJar,
  specDir,
  specGateStatus,
  unconfirmedDecisions,
} from "./alloy.js";
import { adrDir, loadAdrs } from "./adr.js";
import { lintFormal } from "./lint.js";
import { planWeave } from "./weave.js";
import { capabilitiesDir, isAdoptable, loadCapabilityFindings, loadCapabilityPlans } from "./capabilities.js";
import { CHROME_DEVTOOLS_SERVER, uiPointingStatus } from "./mcp.js";
import {
  evalDir,
  evalGateStatus,
  evalTargetNames,
  evaluationsPath,
  hasNextActions,
  isRubricTemplate,
  loadEvaluations,
  loadRubric,
  nextActionItems,
  NON_TARGET_AGENTS,
  passScoreOf,
  rubricPath,
  thresholdMismatches,
} from "./evaluate.js";
import { docsDir, loadReverseDocs, reverseDocStatuses, staleReverseDocs } from "./reverse.js";
import { commonRoot } from "./presets.js";
import { issuesDir, loadRuns, loadTaskDrafts } from "./report.js";
import { loadTeamSettings, settingsPath } from "./settings.js";
import { SKILL_CATEGORY_LABEL, skillsDir } from "./skills.js";
import { formatTechStack, loadTechStackCatalog } from "./techstack.js";
import type { TeamManifest } from "./types.js";

/** 機能 1 件の適用状況(atf status の 1 行) */
export interface FeatureStatus {
  /** 安定 id(--json 出力のキー。例: formal-spec) */
  id: string;
  /** 表示名 */
  name: string;
  /** このプロジェクトで有効になっているか(atf-settings.yaml の requirements が根拠) */
  enabled: boolean;
  /** 有効/無効の根拠になった設定の項目(例: requirements.formalSpec) */
  source: string;
  /** 有効時の実体(配置されたエージェント・ディレクトリ・記録件数・ゲートの状況) */
  details: string[];
  /**
   * 想定(atf-settings.yaml)と実体の食い違い。
   * 「有効なのに成果物がない」「無効なのに成果物が残っている」など、
   * 放置すると勘違いにつながるものを挙げる
   */
  issues: string[];
  /** 状況を詳しく見る / 実行するコマンド */
  commands: string[];
  /** 無効のときの有効化方法 */
  howToEnable?: string;
}

/** 導入されているエージェント 1 体の状況 */
export interface AgentStatus {
  name: string;
  /** .claude/agents/ の定義ファイル名 */
  file: string;
  /** frontmatter の description(役割) */
  description: string;
  /** 定義ファイルが実在するか */
  exists: boolean;
  /** 出自: プリセット由来か、機能に付随する共通エージェントか */
  origin: "preset" | "common";
}

/** 配布されているスキル 1 件の状況 */
export interface SkillStatus {
  /** カタログ id */
  id: string;
  /** インストール名(.claude/skills/<name>/) */
  name: string;
  /** 分類の表示名 */
  category: string;
  /** SKILL.md が実在するか */
  exists: boolean;
}

/** プロジェクト全体の適用状況 */
export interface ProjectFeatures {
  project: string;
  path: string;
  preset: string;
  presetName: string;
  teamSize: string;
  phase: string;
  focus: string[];
  githubRepo?: string;
  /** 設定に記録されたエージェントと、その実体 */
  agents: AgentStatus[];
  /** 設定にあるのに .claude/agents/ に実ファイルがないエージェント定義 */
  missingAgents: string[];
  /** 配布されているスキルと、その実体 */
  skills: SkillStatus[];
  /** 実行記録(runs.jsonl)の件数 */
  runs: number;
  /** チーム設定(atf-settings.yaml)のパス。有効/無効の判断根拠 */
  settingsPath: string;
  features: FeatureStatus[];
}

/** エージェント定義の実ファイルがあるか(手で消された場合の検出に使う) */
function agentExists(repoPath: string, file: string): boolean {
  return existsSync(join(repoPath, ".claude", "agents", file));
}

/** 設定から、エージェント名 → 定義ファイル名の対応を引く */
function agentFile(manifest: TeamManifest, name: string): string | undefined {
  return manifest.agents.find((a) => a.name === name)?.file;
}

/**
 * 有効な機能が「担当エージェントの定義ファイル」を伴っているかを点検する。
 * init 時に既存定義をスキップした場合や、ユーザーが手で削除した場合に食い違いが出る。
 */
function checkAgent(
  repoPath: string,
  manifest: TeamManifest,
  name: string,
  issues: string[],
  details: string[],
): void {
  const file = agentFile(manifest, name);
  if (!file) {
    issues.push(`担当エージェント ${name} が atf-settings.yaml の agents にいない(atf init で再導入が必要)`);
    return;
  }
  if (!agentExists(repoPath, file)) {
    issues.push(`${file} が .claude/agents/ にない(手で削除された? atf init --force で再導入)`);
    return;
  }
  details.push(`担当: ${name}(.claude/agents/${file})`);
}

/** ディレクトリが残っているか(無効なのに成果物がある場合の検出) */
function leftover(dir: string, label: string, issues: string[]): void {
  if (existsSync(dir)) {
    issues.push(`無効だが ${label} が残っている(過去に有効だった可能性: ${dir})`);
  }
}

/** Issue 駆動開発 */
function issueDrivenFeature(repoPath: string, manifest: TeamManifest): FeatureStatus {
  const enabled = manifest.requirements.issueDriven ?? false;
  const details: string[] = [];
  const issues: string[] = [];
  if (!enabled) {
    leftover(issuesDir(repoPath), "Issue ドラフトの置き場(.claude/atf-issues/)", issues);
  } else {
    checkAgent(repoPath, manifest, "issue-manager", issues, details);
    const drafts = loadTaskDrafts(repoPath);
    details.push(
      manifest.requirements.githubRepo
        ? `起票先: ${manifest.requirements.githubRepo}`
        : "起票先の GitHub リポジトリが未設定(gh の -R 指定がない状態)",
    );
    details.push(`Issue ドラフト: ${drafts.length} 件(.claude/atf-issues/)`);
    if (!manifest.requirements.githubRepo) {
      issues.push("GitHub リポジトリが未設定のまま Issue 駆動が有効(起票先が決まっていない)");
    }
  }
  return {
    id: "issue-driven",
    name: "Issue 駆動開発",
    enabled,
    source: "requirements.issueDriven",
    details,
    issues,
    commands: enabled ? ["atf report <project-dir>(タスク依存関係を再描画)"] : [],
    howToEnable: "atf apply issue <project-dir>(または init のヒアリングで yes)",
  };
}

/** PR フロー(ブランチ + Pull Request) */
function prFlowFeature(manifest: TeamManifest): FeatureStatus {
  const enabled = manifest.requirements.prFlow ?? false;
  const touchpoints = manifest.requirements.touchpoints ?? [];
  const details: string[] = [];
  const issues: string[] = [];
  if (enabled) {
    details.push(
      touchpoints.includes("pr-merge")
        ? "マージの実行主体: ユーザー(エージェントの gh pr merge は禁止)"
        : "マージの実行主体: エージェント(CI・レビュー通過を確認して実行)",
    );
    if (!manifest.requirements.githubRepo) {
      issues.push("GitHub リポジトリが未設定のまま PR フローが有効(push 先が決まっていない)");
    }
  }
  return {
    id: "pr-flow",
    name: "PR フロー(ブランチ・PR)",
    enabled,
    source: "requirements.prFlow",
    details,
    issues,
    commands: [],
    howToEnable:
      "GitHub リポジトリを設定したうえで、ヒアリングの「ブランチ + Pull Request のフローを含めますか?」に yes",
  };
}

/** 人間のタッチポイント */
function touchpointFeature(manifest: TeamManifest): FeatureStatus {
  const touchpoints = manifest.requirements.touchpoints ?? [];
  const label: Record<string, string> = {
    "issue-approval": "Issue 着手前にユーザーが承認する",
    "pr-merge": "PR のマージはユーザーが実行する",
  };
  return {
    id: "touchpoints",
    name: "人間のタッチポイント",
    enabled: touchpoints.length > 0,
    source: "requirements.touchpoints",
    details: touchpoints.map((t) => label[t] ?? t),
    issues: [],
    commands: [],
    howToEnable:
      "atf init <project-dir> でフロープレビューを確認したあとのタッチポイント選択で指定(選択なし = マージまで自動)",
  };
}

/** 形式仕様 + ADR(要件・仕様の単一情報源と実装前検証) */
function formalSpecFeature(repoPath: string, manifest: TeamManifest): FeatureStatus {
  const enabled = manifest.requirements.formalSpec ?? false;
  const details: string[] = [];
  const issues: string[] = [];
  const dir = specDir(repoPath);

  if (!enabled) {
    leftover(dir, "形式仕様の置き場(spec/)", issues);
    leftover(adrDir(repoPath), "ADR の置き場(docs/adr/)", issues);
  } else {
    checkAgent(repoPath, manifest, "spec-formalizer", issues, details);
    // 旧レイアウト(.claude/atf-specs/)の中身は apply / update が移すので、
    // ここに残るのは atf が移し先を判断できないファイルだけ
    const leftovers = legacySpecLeftovers(repoPath);
    if (leftovers.length > 0) {
      issues.push(
        `旧レイアウト(.claude/atf-specs/)に ${leftovers.join(", ")} が残っている(内容を spec/ か docs/adr/ に移してディレクトリを消す。atf が移せるファイルは atf apply formal で移動済み)`,
      );
    }
    const models = loadSpecModels(repoPath);
    const checks = loadSpecChecks(repoPath);
    const adrs = loadAdrs(repoPath);
    const commandCount = models.reduce((n, m) => n + m.commands.length, 0);
    const requirementCount = new Set(models.flatMap((m) => m.requirements.map((r) => r.id))).size;
    details.push(
      `モデル: ${models.length} 件 / 要件(@req): ${requirementCount} 件 / 検証コマンド: ${commandCount} 件 / ADR: ${adrs.length} 件`,
    );

    // 規約の機械検査(必須タグ・@req の重複と孤児・手書き文書への規範文の混入)
    const findings = lintFormal(repoPath);
    const errors = findings.filter((f) => f.severity === "error");
    const warns = findings.filter((f) => f.severity === "warn");
    details.push(
      errors.length === 0 && warns.length === 0
        ? "規約検査(atf lint): ✅ 違反なし"
        : `規約検査(atf lint): ${errors.length === 0 ? "⚠️" : "❌"} 違反 ${errors.length} 件 / 警告 ${warns.length} 件`,
    );
    for (const finding of errors.slice(0, 3)) {
      issues.push(`${finding.file}${finding.line ? `:${finding.line}` : ""} ${finding.message}(bash atf-bin/lint.sh)`);
    }
    if (errors.length > 3) issues.push(`ほか ${errors.length - 3} 件の規約違反(bash atf-bin/lint.sh)`);

    // 実装前ゲートの状況(集計は alloy.ts が単一情報源)
    const { satisfied, unsatisfied, unchecked, state } = specGateStatus(models, checks);
    details.push(
      state === "fail"
        ? `実装前ゲート: ❌ 未通過(未充足 ${unsatisfied} 件 / 充足 ${satisfied} 件 / 未検証 ${unchecked} 件)`
        : state === "pending"
          ? `実装前ゲート: ⬜ 未確認(未検証 ${unchecked} 件 / 充足 ${satisfied} 件)`
          : `実装前ゲート: ✅ 通過(充足 ${satisfied} 件)`,
    );

    // 反例が出たときの進め方(自動確定 / 常にユーザー確認)と、自動確定した仕様の記録
    const autoFix = manifest.requirements.specAutoFix ?? true;
    details.push(
      autoFix
        ? "反例への対処: 明白なものは自動確定(.als・ADR・実装を修正し decisions.jsonl に記録)"
        : "反例への対処: 常にユーザーへ確認(自動では修正しない)",
    );
    const decisions = loadSpecDecisions(repoPath);
    const unconfirmed = unconfirmedDecisions(decisions);
    if (decisions.length > 0) {
      details.push(`自動確定の記録: ${decisions.length} 件(ユーザー未確認 ${unconfirmed.length} 件)`);
    }
    if (unconfirmed.length > 0) {
      issues.push(
        `ユーザー未確認の自動確定が ${unconfirmed.length} 件ある(.claude/atf-formal/decisions.jsonl。確認したら status を confirmed / reverted にする)`,
      );
    }

    // 派生文書(docs/generated/)が .als に追随しているか
    const weave = planWeave(repoPath, manifest.project);
    details.push(
      weave.changed.length === 0 && weave.removed.length === 0
        ? "派生文書(docs/generated/): ✅ 最新"
        : `派生文書(docs/generated/): ⬜ 未生成・古いものが ${weave.changed.length + weave.removed.length} 件`,
    );
    if (weave.changed.length > 0 || weave.removed.length > 0) {
      issues.push(
        `docs/generated/ が .als に追随していない(bash atf-bin/weave.sh で再生成。生成物なので commit しない)`,
      );
    }

    const jar = resolveAlloyJar(repoPath);
    details.push(jar ? `Alloy jar: ${jar}` : "Alloy jar: 未検出(bash atf-bin/formal.sh を実行できない)");
    if (!jar) {
      issues.push(
        "Alloy の jar が見つからない(ALLOY_JAR 環境変数・tools/alloy.jar・~/.atf/alloy.jar のいずれかに配置)",
      );
    }
    if (commandCount === 0) {
      issues.push(
        "検証コマンド(check / run)が 1 つもない(spec-formalizer に spec/main.als の形式化を依頼)",
      );
    }
    if (unsatisfied > 0) {
      issues.push(
        `未充足の検証コマンドが ${unsatisfied} 件ある(実装前ゲート未通過。bash atf-bin/formal.sh で詳細)`,
      );
    }
  }

  return {
    id: "formal-spec",
    name: "形式仕様(Alloy)+ ADR",
    enabled,
    source: "requirements.formalSpec",
    details,
    issues,
    commands: enabled
      ? [
          "bash atf-bin/formal.sh(実装前ゲート)",
          "bash atf-bin/lint.sh(規約検査)",
          "bash atf-bin/weave.sh(自然言語化)",
        ]
      : [],
    howToEnable: "atf apply formal <project-dir>(または init のヒアリングで yes)",
  };
}

/** リバースドキュメント(コードから文書と図を起こす) */
function reverseDocsFeature(repoPath: string, manifest: TeamManifest): FeatureStatus {
  const enabled = manifest.requirements.reverseDocs ?? false;
  const details: string[] = [];
  const issues: string[] = [];
  const dir = docsDir(repoPath);

  if (!enabled) {
    leftover(dir, "リバースドキュメントの索引(.claude/atf-docs/)", issues);
  } else {
    checkAgent(repoPath, manifest, "doc-reverser", issues, details);
    const records = loadReverseDocs(repoPath);
    const statuses = reverseDocStatuses(repoPath, records);
    const stale = staleReverseDocs(statuses);
    const withDiagram = records.filter((r) => r.diagram).length;
    details.push(`文書: ${records.length} 件(図つき ${withDiagram} 件)`);
    details.push(
      stale.length > 0
        ? `鮮度: ⚠️ 要再生成 ${stale.length} 件(${stale.map((s) => s.record.path).join(", ")})`
        : records.length > 0
          ? "鮮度: ✅ 追随(文書・図・根拠コードが揃っている)"
          : "鮮度: ⬜ 未作成(doc-reverser にドキュメント化を依頼)",
    );

    // 図の生成に使うスキルが配置されているか(スキル本体のスクリプトまで必要)
    const skill = join(skillsDir(repoPath), "archify");
    const hasSkill = existsSync(join(skill, "SKILL.md"));
    const hasRunner = existsSync(join(skill, "bin", "archify.mjs"));
    details.push(
      hasSkill && hasRunner
        ? `図の生成: archify スキル(${skill})`
        : hasSkill
          ? "図の生成: archify の SKILL.md はあるがスクリプト(bin/)がない"
          : "図の生成: archify スキルが未配置(Mermaid で代替することになる)",
    );
    if (!hasSkill) {
      issues.push("archify スキルが .claude/skills/ にない(atf apply docs <project-dir> -f)");
    } else if (!hasRunner) {
      issues.push(
        "archify の bin/ がない(SKILL.md だけ配られた状態。atf apply docs <project-dir> -f)",
      );
    }
    if (records.length === 0) {
      issues.push("文書の記録が 1 件もない(doc-reverser にドキュメント化を依頼)");
    }
    if (stale.length > 0) {
      issues.push(
        `実装に追随していない文書が ${stale.length} 件ある(doc-reverser に差分更新を依頼。bash atf-bin/docs.sh で詳細)`,
      );
    }
  }

  return {
    id: "reverse-docs",
    name: "リバースドキュメント",
    enabled,
    source: "requirements.reverseDocs",
    details,
    issues,
    commands: enabled ? ["bash atf-bin/docs.sh(一覧と追随状況)"] : [],
    howToEnable: "atf apply docs <project-dir>(または init のヒアリングで yes)",
  };
}

/** アーキテクチャ適合検証(ArchUnit などのフィットネス関数) */
function archCheckFeature(repoPath: string, manifest: TeamManifest): FeatureStatus {
  const enabled = manifest.requirements.archCheck ?? false;
  const details: string[] = [];
  const issues: string[] = [];
  const dir = archDir(repoPath);

  if (!enabled) {
    leftover(dir, "アーキテクチャ規約の置き場(.claude/atf-arch/)", issues);
  } else {
    checkAgent(repoPath, manifest, "arch-guard", issues, details);
    const rules = loadArchRules(repoPath);
    const checks = loadArchChecks(repoPath);
    const gate = archGateStatus(rules, checks);
    details.push(
      `規約: ${rules?.rules.length ?? 0} 件 / レイヤ: ${rules?.layers.length ?? 0} 件` +
        (rules?.tool ? ` / ツール: ${rules.tool}` : " / ツール: 未設定"),
    );
    details.push(
      gate.ok
        ? `適合ゲート: ✅ 通過(適合 ${gate.passed} 件)`
        : gate.violated > 0
          ? `適合ゲート: ❌ 未通過(違反・エラー ${gate.violated} 件 / 適合 ${gate.passed} 件)`
          : `適合ゲート: ⬜ 未確認(未検証 ${gate.unchecked} 件)`,
    );
    details.push(`検証記録: ${checks.length} 件(${archChecksPath(repoPath)})`);

    if (!rules || rules.rules.length === 0) {
      issues.push(
        `規約が未定義(${archRulesPath(repoPath)})。arch-guard にレイヤ規約の定義を依頼`,
      );
    }
    const runner = archRunnerPath(repoPath);
    if (!existsSync(runner)) {
      issues.push(`検証スクリプトがない(${runner})。arch-guard に検証の実装を依頼`);
    } else if (isArchRunnerTemplate(repoPath)) {
      // atf が置いた雛形のまま = 検証ツールが未配線
      issues.push("検証スクリプトが雛形のまま(検証ツールが未配線。arch-guard に実装を依頼)");
    }
    if (!rules?.tool && rules?.rules.length) {
      issues.push("rules.json の tool が空(どのツールで検証しているか記録されていない)");
    }
    if (gate.violated > 0) {
      issues.push(
        `規約違反・検証エラーが ${gate.violated} 件残っている(適合ゲート未通過。bash atf-bin/arch.sh で詳細)`,
      );
    }
  }

  return {
    id: "arch-check",
    name: "アーキテクチャ適合検証",
    enabled,
    source: "requirements.archCheck",
    details,
    issues,
    commands: enabled ? ["bash atf-bin/arch.sh(実装後ゲート)"] : [],
    howToEnable: "atf apply arch <project-dir>(または init のヒアリングで yes)",
  };
}

/** ルーブリック評価(成果物の採点) */
function rubricEvalFeature(repoPath: string, manifest: TeamManifest): FeatureStatus {
  const enabled = manifest.requirements.rubricEval ?? false;
  const details: string[] = [];
  const issues: string[] = [];
  const dir = evalDir(repoPath);

  if (!enabled) {
    leftover(dir, "ルーブリック評価の置き場(.claude/atf-eval/)", issues);
  } else {
    checkAgent(repoPath, manifest, "evaluator", issues, details);
    const rubric = loadRubric(repoPath);
    const records = loadEvaluations(repoPath);
    const targets = evalTargetNames(manifest.requirements, manifest.agents);
    const off = manifest.agents
      .map((a) => a.name)
      .filter((name) => !NON_TARGET_AGENTS.includes(name) && !targets.includes(name));
    const gate = evalGateStatus(rubric, records, targets);

    const below = nextActionItems(rubric, records, targets, "below");
    details.push(
      `評価観点: ${rubric?.criteria.length ?? 0} 件 / 既定の閾値: ${passScoreOf(rubric)} 以上` +
        (hasNextActions(rubric) ? " / ネクストアクション: 設定あり" : " / ネクストアクション: 未設定") +
        (isRubricTemplate(repoPath, rubric) ? "(雛形のまま)" : ""),
    );
    if (below.length > 0) {
      details.push(`閾値未満の観点: ${below.length} 件(bash atf-bin/eval.sh に次の一手が出ます)`);
    }
    details.push(
      `評価対象: ${targets.length} 体(${targets.join(", ") || "なし"})` +
        (off.length > 0 ? ` / 対象外: ${off.join(", ")}` : ""),
    );
    details.push(
      gate.ok
        ? `評価ゲート: ✅ 通過(合格 ${gate.passed} 件)`
        : gate.failed > 0
          ? `評価ゲート: ❌ 未通過(未達 ${gate.failed} 件 / 合格 ${gate.passed} 件)`
          : `評価ゲート: ⬜ 未確認(未評価 ${gate.unevaluated.length} 体)`,
    );
    details.push(`評価記録: ${records.length} 件(${evaluationsPath(repoPath)})`);

    if (isRubricTemplate(repoPath, rubric)) {
      // atf が置いた雛形のまま = 評価基準が未整備(観点が空かどうかより先に判定する)
      issues.push(
        `rubric.json が雛形のまま("template": true が残っている)。evaluator に評価観点の作成を依頼(${rubricPath(repoPath)})`,
      );
    } else if (!rubric || rubric.criteria.length === 0) {
      issues.push(
        `評価観点が未定義(${rubricPath(repoPath)})。evaluator にルーブリックの作成を依頼`,
      );
    }
    if (targets.length === 0) {
      issues.push(
        "評価対象のエージェントが 1 体もない(requirements.evalTargets がすべて false。機能ごと外すなら atf remove eval)",
      );
    }
    if (gate.failed > 0) {
      issues.push(
        `未達(要改善・不合格)の成果物が ${gate.failed} 件残っている(評価ゲート未通過。bash atf-bin/eval.sh で詳細)`,
      );
    }
    // 閾値を設定したのに合否と食い違っている記録は、黙って通さない
    for (const { record, mismatch } of thresholdMismatches(rubric, records, targets).map((m) => ({
      record: m.record,
      mismatch: m.below.join(", "),
    }))) {
      issues.push(
        `${record.target} の ${record.artifact} は合格と記録されているが、閾値未満の観点がある(${mismatch})`,
      );
    }
    // 名前が一致しない記録はゲートに入らないため、黙って無視せず知らせる
    const unknownTargets = [
      ...new Set(
        records
          .map((r) => r.target)
          .filter((name) => !manifest.agents.some((a) => a.name === name)),
      ),
    ];
    if (unknownTargets.length > 0) {
      issues.push(
        `評価記録の target がチームにいない: ${unknownTargets.join(", ")}(ゲート判定に入らない。名前を agents に合わせる)`,
      );
    }
  }

  return {
    id: "rubric-eval",
    name: "ルーブリック評価",
    enabled,
    source: "requirements.rubricEval / requirements.evalTargets",
    details,
    issues,
    commands: enabled ? ["bash atf-bin/eval.sh(完了前ゲート)"] : [],
    howToEnable: "atf apply eval <project-dir>(または init のヒアリングで yes)",
  };
}

/** 最新機能スカウト(Claude Code / Codex の新機能調査) */
function capabilityScoutFeature(repoPath: string, manifest: TeamManifest): FeatureStatus {
  const enabled = manifest.requirements.capabilityScout ?? false;
  const details: string[] = [];
  const issues: string[] = [];

  if (!enabled) {
    leftover(capabilitiesDir(repoPath), "調査結果の置き場(.claude/atf-capabilities/)", issues);
  } else {
    checkAgent(repoPath, manifest, "capability-scout", issues, details);
    const findings = loadCapabilityFindings(repoPath);
    const plans = loadCapabilityPlans(repoPath);
    const adoptable = findings.filter((f) => isAdoptable(f.verdict)).length;
    details.push(`調査: ${findings.length} 件(組み込める ${adoptable} 件 / 計画書 ${plans.length} 通)`);
    if (findings.length === 0) {
      details.push("未調査(capability-scout に調査を依頼すると採否表が作られる)");
    }
  }

  return {
    id: "capability-scout",
    name: "最新機能スカウト",
    enabled,
    source: "requirements.capabilityScout",
    details,
    issues,
    commands: enabled ? ["atf report <project-dir>(採否表を再描画)"] : [],
    howToEnable: "ヒアリングの「最新機能を調査するエージェントを追加しますか?」に yes",
  };
}

/** デザインスキル(UI 実装時に読むスキル) */
function designSkillFeature(repoPath: string, manifest: TeamManifest): FeatureStatus {
  const skills = (manifest.skills ?? []).filter((s) => s.category !== "diagram");
  const details: string[] = [];
  const issues: string[] = [];
  for (const skill of skills) {
    const path = join(skillsDir(repoPath), skill.name, "SKILL.md");
    details.push(
      `${skill.name}(${SKILL_CATEGORY_LABEL[skill.category] ?? skill.category})` +
        (existsSync(path) ? "" : " — SKILL.md が見つからない"),
    );
    if (!existsSync(path)) {
      issues.push(`${skill.name} の SKILL.md がない(atf apply design <project-dir> で再適用)`);
    }
  }
  const aesthetic = skills.filter((s) => s.category === "aesthetic");
  if (aesthetic.length > 1) {
    issues.push(
      `見た目の方向性のスキルが ${aesthetic.length} 件ある(指示が衝突する。atf apply design で 1 つに絞る)`,
    );
  }
  return {
    id: "design-skills",
    name: "デザインスキル",
    enabled: skills.length > 0,
    source: "atf-settings.yaml の skills(分類 diagram 以外)",
    details,
    issues,
    commands: skills.length > 0 ? ["atf apply design <project-dir>(選び直す)"] : [],
    howToEnable: "重視観点に「UI/UX デザイン品質」を選ぶ、または atf apply design <project-dir>",
  };
}

/** 技術スタック(ヒアリングで選択した技術) */
function techStackFeature(manifest: TeamManifest): FeatureStatus {
  const lines = formatTechStack(loadTechStackCatalog(), manifest.requirements.techStack);
  return {
    id: "tech-stack",
    name: "技術スタック",
    enabled: lines.length > 0,
    source: "requirements.techStack",
    details: lines.map((l) => `${l.category}: ${l.items.join(", ")}`),
    issues: [],
    commands: [],
    howToEnable: "atf init <project-dir> のヒアリング(技術スタックのカテゴリ選択)",
  };
}

/** エージェントログ可視化(otel-desktop-viewer へのログ転送設定) */
function agentLogFeature(repoPath: string, manifest: TeamManifest): FeatureStatus {
  const enabled = manifest.requirements.agentLog ?? false;
  const status = agentLogStatus(repoPath);
  const details: string[] = [];
  const issues: string[] = [];
  if (!enabled) {
    // 設定が丸ごと残っているときだけ知らせる(ユーザー自身の OTel 設定を疑わない)
    if (status.missing.length === 0) {
      issues.push(
        `無効だがログ転送の設定が残っている(過去に有効だった可能性: ${status.path} の env)`,
      );
    }
  } else {
    details.push(`配布先: ${status.path}(env に OTel の環境変数)`);
    details.push(
      status.endpoint
        ? `転送先: ${status.endpoint}(otel-desktop-viewer。閲覧は ${AGENT_LOG_VIEWER_URL})`
        : "転送先(OTEL_EXPORTER_OTLP_ENDPOINT)が未設定",
    );
    details.push(
      status.service
        ? `Service 名: ${status.service}(ビューアの Service 列に出る)`
        : "Service 名(OTEL_SERVICE_NAME)が未設定",
    );
    if (status.missing.length > 0) {
      issues.push(
        `有効だが ${status.missing.join(", ")} が ${status.path} にない(atf apply agent-log で配り直す)`,
      );
    }
  }
  return {
    id: "agent-log",
    name: "エージェントログ可視化",
    enabled,
    source: "requirements.agentLog",
    details,
    issues,
    commands: enabled ? [`otel-desktop-viewer(閲覧は ${AGENT_LOG_VIEWER_URL})`] : [],
    howToEnable: "atf apply agent-log <project-dir>",
  };
}

/** UI 指差し確認(chrome-devtools MCP のサーバー定義の配布) */
function uiPointingFeature(repoPath: string, manifest: TeamManifest): FeatureStatus {
  const enabled = manifest.requirements.uiPointing ?? false;
  const status = uiPointingStatus(repoPath);
  const details: string[] = [];
  const issues: string[] = [];
  if (!enabled) {
    // 設定が揃って残っているときだけ知らせる(ユーザー自身が足した MCP 設定を疑わない)
    if (status.missing.length === 0) {
      issues.push(
        `無効だが ${CHROME_DEVTOOLS_SERVER} MCP の設定が残っている(過去に有効だった可能性: ${status.path})`,
      );
    }
  } else {
    details.push(`配布先: ${status.path}(mcpServers に ${CHROME_DEVTOOLS_SERVER})`);
    details.push(
      status.command
        ? `起動コマンド: ${status.command}`
        : `${CHROME_DEVTOOLS_SERVER} の起動コマンド(command)が未設定`,
    );
    if (status.missing.length > 0) {
      issues.push(
        `有効だが ${status.missing.join(", ")} が ${status.path} にない(atf apply ui-pointing で配り直す)`,
      );
    }
  }
  return {
    id: "ui-pointing",
    name: "UI 指差し確認",
    enabled,
    source: "requirements.uiPointing",
    details,
    issues,
    commands: enabled ? ["Claude Code の /mcp(MCP サーバーの接続状況)"] : [],
    howToEnable: "atf apply ui-pointing <project-dir>",
  };
}

/**
 * 導入済みチームに「いま何が適用されているか」を集める(atf status の単一情報源)。
 *
 * 判断の根拠は `atf-settings.yaml`(= 導入時の要件)で、
 * それに対応する**実体**(エージェント定義・成果物のディレクトリ・記録・ゲートの状況)を
 * 突き合わせて食い違い(issues)も返す。設定だけを見ると、
 * 手で消された定義や未配線の検証に気づけないため。
 */
export function collectProjectFeatures(
  repoPath: string,
  manifest: TeamManifest = loadTeamSettings(repoPath),
): ProjectFeatures {
  const features: FeatureStatus[] = [
    issueDrivenFeature(repoPath, manifest),
    prFlowFeature(manifest),
    touchpointFeature(manifest),
    formalSpecFeature(repoPath, manifest),
    reverseDocsFeature(repoPath, manifest),
    archCheckFeature(repoPath, manifest),
    rubricEvalFeature(repoPath, manifest),
    capabilityScoutFeature(repoPath, manifest),
    agentLogFeature(repoPath, manifest),
    uiPointingFeature(repoPath, manifest),
    designSkillFeature(repoPath, manifest),
    techStackFeature(manifest),
  ];

  return {
    project: manifest.project,
    path: repoPath,
    preset: manifest.preset,
    presetName: manifest.presetName,
    teamSize: manifest.requirements.teamSize,
    phase: manifest.requirements.phase,
    focus: manifest.requirements.focus,
    githubRepo: manifest.requirements.githubRepo,
    agents: manifest.agents.map((a) => ({
      name: a.name,
      file: a.file,
      description: a.description,
      exists: agentExists(repoPath, a.file),
      // 共通エージェント(env-builder・arch-guard など)はテンプレートの置き場で判別できる
      origin: existsSync(join(commonRoot(), a.file)) ? ("common" as const) : ("preset" as const),
    })),
    skills: (manifest.skills ?? []).map((skill) => ({
      id: skill.id,
      name: skill.name,
      category: SKILL_CATEGORY_LABEL[skill.category] ?? skill.category,
      exists: existsSync(join(skillsDir(repoPath), skill.name, "SKILL.md")),
    })),
    missingAgents: manifest.agents.filter((a) => !agentExists(repoPath, a.file)).map((a) => a.file),
    runs: loadRuns(repoPath).length,
    settingsPath: settingsPath(repoPath),
    features,
  };
}
