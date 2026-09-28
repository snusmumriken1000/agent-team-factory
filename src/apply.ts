import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeRepo, applyTechStack } from "./analyzer.js";
import { archDir, archReportJunitPath, isArchRunnerTemplate, loadArchRules } from "./arch.js";
import { atfBinDir, hasBinScript, installAtfBin, runBinScript } from "./bin.js";
import {
  buildEvalTargets,
  evalDir,
  evalTargetNames,
  isRubricTemplate,
  loadRubric,
} from "./evaluate.js";
import { docsDir, loadReverseDocs } from "./reverse.js";
import {
  archCheckInstruction,
  buildArchReadme,
  buildCommonInstruction,
  buildDocsReadme,
  buildEvalReadme,
  buildFlow,
  buildIssuesReadme,
  buildAdrReadme,
  buildSpecReadme,
  buildTemplateVars,
  DIAGRAM_SKILL_ID,
  REPORT_JUNIT_MJS,
  envBuilderArchInstruction,
  envBuilderReverseInstruction,
  envBuilderSpecInstruction,
  formalSpecInstruction,
  envBuilderEvalInstruction,
  envBuilderIssueInstruction,
  evalAgentInstruction,
  issueDrivenInstruction,
  orchestratorArchGateInstruction,
  orchestratorEvalGateInstruction,
  orchestratorIssueInstruction,
  orchestratorReverseInstruction,
  orchestratorSpecGateInstruction,
  specFormalizerInstruction,
  parseAgentMeta,
  render,
  reverseDocsInstruction,
  runLogInstruction,
  writeArchScaffold,
  writeDocsScaffold,
  writeEvalScaffold,
  writeIssuesScaffold,
  writeFormalScaffold,
} from "./generator.js";
import { commonRoot, loadPresets } from "./presets.js";
import {
  buildDashboardHtml,
  issuesDir,
  loadArchitectureState,
  loadEvaluationState,
  loadRuns,
  loadTaskDrafts,
} from "./report.js";
import { formalDir, loadSpecModels, loadSpecState, specDir, EXPLAIN_TEMPLATE_FILE } from "./alloy.js";
import { bundledExplainTemplate } from "./specdoc.js";
import { adrDir } from "./adr.js";
import { generatedDir } from "./weave.js";
import { loadCapabilityFindings, loadCapabilityPlans } from "./capabilities.js";
import { sectionHeading, spliceSections } from "./sections.js";
import { loadTeamSettings, settingsPath, updateTeamSettings } from "./settings.js";
import { installSkills } from "./skills.js";
import type { InstalledSkill, Requirements, TeamManifest } from "./types.js";

/** `atf apply <機能> <project-dir>` で導入できる機能の id(atf-bin に置かれるスクリプト名と揃える) */
export type FeatureId = "formal" | "arch" | "docs" | "issue" | "eval" | "report";

/**
 * atf が内容を決めるファイル(`atf update` が最新の内容に入れ替える対象)。
 *
 * ここに載せてよいのは **atf が全文を生成するもの**(書式ガイド・変換スクリプト・
 * 解説ページのテンプレート)だけ。ユーザーとエージェントが書くもの(`rules.json` /
 * `rubric.json` / `run-arch-check.sh` / `run-alloy.sh` / `.als` / `*.jsonl`)は入れてはいけない。
 * `explain-template.html` はカスタマイズできるファイルだが **update は基本上書き**で動く —
 * 手を入れたプロジェクトでは更新計画の差分に出るので、そこで承認を止められる。
 */
export interface ManagedFile {
  /** 絶対パス */
  path: string;
  content: string;
  mode?: number;
}

export interface FeatureDef {
  id: FeatureId;
  /** 表示名 */
  name: string;
  /**
   * atf-settings.yaml の requirements 上のキー(有効/無効の単一情報源)。
   * 常に使える機能(ダッシュボードなど)は持たない
   */
  flag?: "formalSpec" | "archCheck" | "reverseDocs" | "issueDriven" | "rubricEval";
  /** 機能を担当する共通エージェント定義(templates/common)。担当を持たない機能は undefined */
  agentFile?: string;
  /** 併せて配るスキルのカタログ id */
  skills: string[];
  /** 導入後にユーザーへ案内する次の一手 */
  next: string;
  /** エージェント定義ごとに出し入れするセクション(指示を持たない機能は undefined) */
  sections?: (agentFile: string, requirements: Requirements) => string;
  /**
   * requirements を有効にした直後、指示文・足場を組み立てる前に呼ばれる準備処理。
   * チーム構成から導く設定(ルーブリック評価の評価対象一覧など)を requirements に反映する。
   */
  prepare?: (manifest: TeamManifest) => void;
  /**
   * 機能の中身(検証・点検の対象)が担当エージェントによって用意されているか。
   * 導入直後は必ず未整備なので、スモーク実行(`--run`)はこれを見て
   * 「ゲート未通過」ではなく「未整備(想定どおり)」と判定する。
   * 常に実行できる機能(ダッシュボード)は持たない。
   */
  ready?: (repoPath: string) => boolean;
  /** 成果物の置き場を用意する */
  scaffold: (repoPath: string, manifest: TeamManifest, languages: string[]) => string;
  /**
   * 足場のうち atf が内容を決めるファイル(`atf update` で最新化する)。
   * `scaffold` は既存を壊さない(writeIfAbsent)ため、書式ガイドや変換スクリプトは古いまま残る。
   * update はここに挙げたものだけを入れ替える。
   */
  managed?: (repoPath: string, manifest: TeamManifest, languages: string[]) => ManagedFile[];
  /** 撤去(atf remove)したときに残る成果物の置き場。ない機能は undefined */
  artifacts?: (repoPath: string) => string[];
}

export const FEATURES: FeatureDef[] = [
  {
    id: "formal",
    name: "形式仕様(Alloy)+ ADR による要件・仕様の単一情報源",
    flag: "formalSpec",
    agentFile: "spec-formalizer.md",
    skills: [],
    next:
      "spec-formalizer に `spec/main.als` の TODO(@title / @scope / @out-of-scope / @stakeholder)を" +
      "ユーザーと埋めるところから依頼し、`bash atf-bin/lint.sh` と `bash atf-bin/formal.sh` を通してください。",
    // 雛形(main.als)だけでは検証対象がない。check / run が 1 つでもあれば整備済みとみなす
    ready: (repoPath) => loadSpecModels(repoPath).some((m) => m.commands.length > 0),
    sections: (agentFile, requirements) =>
      formalSpecInstruction(requirements.specAutoFix ?? true) +
      // 反例が出たときの判断(自動確定 / ユーザー確認)と weave・lint の扱いは spec-formalizer の担当
      (agentFile === "spec-formalizer.md" ? specFormalizerInstruction(requirements) : "") +
      (agentFile === "orchestrator.md"
        ? orchestratorSpecGateInstruction(requirements.specAutoFix ?? true)
        : "") +
      (agentFile === "env-builder.md" ? envBuilderSpecInstruction() : ""),
    scaffold: (repoPath, manifest) => writeFormalScaffold(repoPath, manifest.project),
    // .als・ADR・run-alloy.sh は手で書くものなので対象にしない。
    // 解説ページのテンプレートは atf が全文を配る既定形式なので update で入れ替える
    // (手でカスタマイズしたプロジェクトでは更新計画の差分に出る)
    managed: (repoPath, manifest) => [
      { path: join(specDir(repoPath), "README.md"), content: buildSpecReadme(manifest.project) },
      { path: join(adrDir(repoPath), "README.md"), content: buildAdrReadme(manifest.project) },
      { path: join(formalDir(repoPath), EXPLAIN_TEMPLATE_FILE), content: bundledExplainTemplate() },
    ],
    // 仕様・履歴・記録・生成物。--purge のときだけ消える
    artifacts: (repoPath) => [
      specDir(repoPath),
      adrDir(repoPath),
      formalDir(repoPath),
      generatedDir(repoPath),
    ],
  },
  {
    id: "arch",
    name: "アーキテクチャ適合検証",
    flag: "archCheck",
    agentFile: "arch-guard.md",
    skills: [],
    next: "arch-guard にレイヤ規約の定義と検証の実装を依頼し、`bash atf-bin/arch.sh` で検証してください。",
    // 規約が未定義、または検証スクリプトが雛形のまま(ツール未配線)なら検証できない
    ready: (repoPath) =>
      (loadArchRules(repoPath)?.rules.length ?? 0) > 0 && !isArchRunnerTemplate(repoPath),
    sections: (agentFile) =>
      archCheckInstruction() +
      (agentFile === "orchestrator.md" ? orchestratorArchGateInstruction() : "") +
      (agentFile === "env-builder.md" ? envBuilderArchInstruction() : ""),
    scaffold: (repoPath, manifest, languages) =>
      writeArchScaffold(repoPath, manifest.project, languages),
    // 規約(rules.json)と検証スクリプト(run-arch-check.sh)は arch-guard が書くので対象にしない
    managed: (repoPath, manifest, languages) => [
      {
        path: join(archDir(repoPath), "README.md"),
        content: buildArchReadme(manifest.project, languages),
      },
      { path: archReportJunitPath(repoPath), content: REPORT_JUNIT_MJS, mode: 0o755 },
    ],
    artifacts: (repoPath) => [archDir(repoPath)],
  },
  {
    id: "docs",
    name: "リバースドキュメント",
    flag: "reverseDocs",
    agentFile: "doc-reverser.md",
    // 図の生成に使う archify は、この機能に付随して配る
    skills: [DIAGRAM_SKILL_ID],
    next: "doc-reverser にドキュメント化を依頼し、`bash atf-bin/docs.sh` で追随状況を確認してください。",
    // 文書の記録が 1 件もなければ点検対象がない
    ready: (repoPath) => loadReverseDocs(repoPath).length > 0,
    sections: (agentFile) =>
      reverseDocsInstruction() +
      (agentFile === "orchestrator.md" ? orchestratorReverseInstruction() : "") +
      (agentFile === "env-builder.md" ? envBuilderReverseInstruction() : ""),
    scaffold: (repoPath, manifest) => writeDocsScaffold(repoPath, manifest.project),
    managed: (repoPath, manifest) => [
      { path: join(docsDir(repoPath), "README.md"), content: buildDocsReadme(manifest.project) },
    ],
    artifacts: (repoPath) => [docsDir(repoPath)],
  },
  {
    id: "issue",
    name: "Issue 駆動開発",
    flag: "issueDriven",
    agentFile: "issue-manager.md",
    skills: [],
    // 実行スクリプト(atf-bin/issue.sh)は持たない。ゲートではなく「進め方」の機能のため
    next:
      "issue-manager に作業の Issue 化を依頼してください" +
      "(起票先は atf-settings.yaml の requirements.githubRepo。未設定なら先に記入してください)。",
    sections: (agentFile, requirements) =>
      issueDrivenInstruction(
        requirements.githubRepo,
        (requirements.touchpoints ?? []).includes("issue-approval"),
      ) +
      (agentFile === "orchestrator.md" ? orchestratorIssueInstruction(requirements.githubRepo) : "") +
      (agentFile === "env-builder.md" ? envBuilderIssueInstruction(requirements.githubRepo) : ""),
    scaffold: (repoPath, manifest) =>
      writeIssuesScaffold(repoPath, manifest.project, manifest.requirements.githubRepo),
    // ドラフト(draft-*.md)はチームの成果物。書式ガイドだけが atf の管理対象
    managed: (repoPath, manifest) => [
      {
        path: join(issuesDir(repoPath), "README.md"),
        content: buildIssuesReadme(manifest.project, manifest.requirements.githubRepo),
      },
    ],
    artifacts: (repoPath) => [issuesDir(repoPath)],
  },
  {
    id: "eval",
    name: "ルーブリック評価",
    flag: "rubricEval",
    agentFile: "evaluator.md",
    skills: [],
    next:
      "evaluator に評価観点(rubric.json)の作成を依頼し、成果物ごとに評価を依頼してください" +
      "(評価するエージェントは atf-settings.yaml の requirements.evalTargets で個別に ON/OFF できます)。",
    // 評価観点が雛形のままなら採点の基準がない
    ready: (repoPath) => {
      const rubric = loadRubric(repoPath);
      return (rubric?.criteria.length ?? 0) > 0 && !isRubricTemplate(repoPath, rubric);
    },
    // 評価対象のエージェント一覧はチーム構成から導く(ユーザーが false にした分は残す)
    prepare: (manifest) => {
      manifest.requirements.evalTargets = buildEvalTargets(
        manifest.agents,
        manifest.requirements.evalTargets,
      );
    },
    sections: (agentFile, requirements) =>
      // 評価対象かどうかでエージェントごとに内容が変わる(generator と同じ組み立てを使う)
      evalAgentInstruction(agentFile, { ...requirements, rubricEval: true }) +
      (agentFile === "orchestrator.md" ? orchestratorEvalGateInstruction() : "") +
      (agentFile === "env-builder.md" ? envBuilderEvalInstruction() : ""),
    scaffold: (repoPath, manifest) =>
      writeEvalScaffold(
        repoPath,
        manifest.project,
        evalTargetNames(manifest.requirements, manifest.agents),
      ),
    // 評価観点(rubric.json)は evaluator とユーザーが書くので対象にしない
    managed: (repoPath, manifest) => [
      {
        path: join(evalDir(repoPath), "README.md"),
        content: buildEvalReadme(
          manifest.project,
          evalTargetNames(manifest.requirements, manifest.agents),
        ),
      },
    ],
    artifacts: (repoPath) => [evalDir(repoPath)],
  },
  {
    id: "report",
    name: "ダッシュボード(チーム構成と実行記録の可視化)",
    // requirements を持たない。チームがあれば常に使えるため、配るのは実行スクリプトだけ
    skills: [],
    next: "`bash atf-bin/report.sh` で再生成できます(ブラウザで .claude/atf-dashboard.html を開いてください)。",
    scaffold: (repoPath) => join(repoPath, ".claude", "atf-dashboard.html"),
  },
];

/** 機能の一覧(CLI のヘルプ・引数検証に使う) */
export const FEATURE_IDS: FeatureId[] = FEATURES.map((f) => f.id);

/** id から機能定義を引く */
export function findFeature(id: string): FeatureDef | undefined {
  return FEATURES.find((f) => f.id === id);
}

/**
 * atf が出し入れする、その機能のセクション見出し。
 * 指示文そのものから導出するので、generator.ts の文面を変えても追従する。
 */
export function headingsOf(feature: FeatureDef): string[] {
  if (!feature.sections) return [];
  const sample: Requirements = { phase: "growth", focus: [], teamSize: "standard" };
  const sections = feature.sections;
  // 担当エージェント(spec-formalizer など)だけに付く節も撤去できるように、その定義ファイルも見る
  return ["", "orchestrator.md", "env-builder.md", "evaluator.md", feature.agentFile ?? ""]
    .map((file) => sections(file, sample))
    .flatMap((text) => text.split(/(?=\n## )/))
    .map(sectionHeading)
    .filter((h) => h !== "");
}

export interface AppliedFeature {
  id: FeatureId;
  name: string;
  /** 実行前から有効だったか(足場の修復だけを行う) */
  alreadyEnabled: boolean;
  /** 追加したエージェント定義(既にあれば undefined) */
  agentFile?: string;
  /** 成果物の置き場 */
  scaffoldDir: string;
  /** 次の一手の案内 */
  next: string;
}

export interface ApplyResult {
  applied: AppliedFeature[];
  /** 存在しない機能 id */
  unknown: string[];
  /** 指示を更新したエージェント定義ファイル名 */
  agents: string[];
  /** 配置したスキル */
  skills: InstalledSkill[];
  /** atf-bin に書き出したファイル */
  binDir: string;
  binScripts: string[];
  /** 取り除いた実行スクリプト(無効にした機能・旧名のスクリプト) */
  removedBinScripts: string[];
  dashboardPath: string;
  settingsPath: string;
}

/**
 * 導入済みのチームに機能(形式仕様 / アーキテクチャ適合検証 / リバースドキュメント)を後追いで導入する。
 *
 * - `atf-settings.yaml` の requirements を有効にする(有効/無効の単一情報源)
 * - 担当エージェント定義を `.claude/agents/` に追加する(既存定義は上書きしない)
 * - 既存の全エージェント定義に、その機能のセクションを差し込む(再実行しても増殖しない)
 * - 成果物の置き場と `atf-bin/<機能>.sh` を用意し、ダッシュボードを更新する
 */
export function applyFeatures(
  repoPath: string,
  ids: string[],
  opts: { specAutoFix?: boolean; force?: boolean } = {},
): ApplyResult {
  const manifest = loadTeamSettings(repoPath);
  const unknown = ids.filter((id) => !findFeature(id));
  const features = ids
    .map((id) => findFeature(id))
    .filter((f): f is FeatureDef => f !== undefined)
    // 同じ機能を 2 回渡されても 1 回だけ処理する
    .filter((f, i, all) => all.findIndex((x) => x.id === f.id) === i);

  const applied: AppliedFeature[] = [];
  if (features.length === 0) {
    return {
      applied,
      unknown,
      agents: [],
      skills: [],
      binDir: atfBinDir(repoPath),
      binScripts: [],
      removedBinScripts: [],
      dashboardPath: join(repoPath, ".claude", "atf-dashboard.html"),
      settingsPath: settingsPath(repoPath),
    };
  }

  // 検出値は最新のものを使う(導入後に言語・フレームワークが増えていることがある)
  const detected = analyzeRepo(repoPath);
  const profile = manifest.requirements.techStack
    ? applyTechStack(detected, manifest.requirements.techStack)
    : detected;

  // 1. 有効/無効の単一情報源(requirements)を先に更新する。
  //    指示文・フローは更新後の requirements から組み立てる
  // requirements を持たない機能(ダッシュボード)は、実行スクリプトの有無を導入済みの目印にする
  const wasEnabled = new Map(
    features.map((f) => [
      f.id,
      f.flag
        ? manifest.requirements[f.flag] === true
        : existsSync(join(atfBinDir(repoPath), `${f.id}.sh`)),
    ]),
  );
  for (const feature of features) {
    if (feature.flag) manifest.requirements[feature.flag] = true;
  }
  // 反例が出たときの進め方(自動確定 / 常にユーザー確認)。指定がなければ既存の設定を保つ
  if (opts.specAutoFix !== undefined) {
    manifest.requirements.specAutoFix = opts.specAutoFix;
  }

  // 2. 付随するスキル(図の生成に使う archify など)を配る
  const skillIds = features.flatMap((f) => f.skills);
  const install = skillIds.length
    ? installSkills(repoPath, skillIds, { force: opts.force, projectName: manifest.project })
    : undefined;
  const installed = install?.installed ?? [];
  const designSkills = (manifest.skills ?? []).filter((s) => s.category !== "diagram");

  // 3. 担当エージェント定義を追加する(既存定義は尊重して上書きしない)
  const agentsDir = join(repoPath, ".claude", "agents");
  const vars = buildTemplateVars(profile, manifest.requirements);
  const addedAgents = new Set<string>();
  // チーム構成から導く設定(評価対象の一覧)は、今回増える担当エージェントも含めて決めたいので、
  // 先にマニフェストへ登録してから prepare を呼ぶ(登録より前に呼ぶと新しい担当が漏れる)
  const templates = new Map<string, string>();
  for (const feature of features) {
    if (!feature.agentFile) continue;
    const template = readFileSync(join(commonRoot(), feature.agentFile), "utf8");
    templates.set(feature.agentFile, template);
    if (manifest.agents.some((a) => a.file === feature.agentFile)) continue;
    manifest.agents.push({
      file: feature.agentFile,
      ...parseAgentMeta(template, feature.agentFile.replace(/\.md$/, "")),
    });
  }
  // 指示文・足場・フローは、ここまでで確定した requirements から組み立てる
  for (const feature of features) feature.prepare?.(manifest);

  for (const feature of features) {
    if (!feature.agentFile) continue;
    const dest = join(agentsDir, feature.agentFile);
    const template = templates.get(feature.agentFile) ?? "";
    const meta = parseAgentMeta(template, feature.agentFile.replace(/\.md$/, ""));
    if (existsSync(dest)) continue;
    writeFileSync(
      dest,
      render(template, vars) +
        buildCommonInstruction(manifest.requirements, designSkills) +
        evalAgentInstruction(feature.agentFile, manifest.requirements) +
        runLogInstruction(meta.name),
    );
    addedAgents.add(feature.agentFile);
  }

  // 4. 全エージェント定義に、その機能のセクションを差し込む(見出し単位の差し替えなので
  //    3 で書いたばかりの定義を通しても増殖せず、担当エージェント固有の節はここで入る)
  const agents: string[] = [];
  for (const entry of readdirSync(agentsDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = join(agentsDir, entry.name);
    const before = readFileSync(path, "utf8");
    let after = before;
    for (const feature of features) {
      if (!feature.sections) continue;
      after = spliceSections(
        after,
        headingsOf(feature),
        feature.sections(entry.name, manifest.requirements),
      );
    }
    if (after === before) continue;
    writeFileSync(path, after);
    // 3 で追加した定義は「追加」として報告するので、更新一覧には並べない
    if (!addedAgents.has(entry.name)) agents.push(entry.name);
  }

  // 5. 成果物の置き場と実行スクリプトを用意する
  for (const feature of features) {
    applied.push({
      id: feature.id,
      name: feature.name,
      alreadyEnabled: wasEnabled.get(feature.id) === true,
      agentFile:
        feature.agentFile && addedAgents.has(feature.agentFile) ? feature.agentFile : undefined,
      scaffoldDir: feature.scaffold(repoPath, manifest, profile.languages),
      next: feature.next,
    });
  }
  const bin = installAtfBin(repoPath, manifest.requirements);

  // 6. 構成図の辺を組み直す(プリセットが見つからない場合は既存の辺に足す)
  const preset = loadPresets().find((p) => p.id === manifest.preset);
  const firstAgent = manifest.agents[0]?.name;
  const rebuilt = buildFlow(preset?.flow, manifest.requirements, firstAgent);
  manifest.flow = preset
    ? rebuilt
    : [...manifest.flow, ...rebuilt].filter(
        (edge, i, all) => all.findIndex((e) => e[0] === edge[0] && e[1] === edge[1]) === i,
      );

  if (installed.length > 0) {
    const merged = [...(manifest.skills ?? [])];
    for (const skill of installed) {
      const index = merged.findIndex((s) => s.id === skill.id);
      if (index >= 0) merged[index] = skill;
      else merged.push(skill);
    }
    manifest.skills = merged;
  }
  // 既存の atf-settings.yaml(コメントや手で足した項目)を残し、変わった箇所だけ書き換える
  const settingsFile = updateTeamSettings(repoPath, manifest);

  const dashboardPath = join(repoPath, ".claude", "atf-dashboard.html");
  writeFileSync(
    dashboardPath,
    buildDashboardHtml(
      manifest,
      loadRuns(repoPath),
      loadTaskDrafts(repoPath),
      loadSpecState(repoPath),
      { findings: loadCapabilityFindings(repoPath), plans: loadCapabilityPlans(repoPath) },
      loadArchitectureState(repoPath),
      loadEvaluationState(repoPath),
    ),
  );

  return {
    applied,
    unknown,
    agents,
    skills: installed,
    binDir: bin.dir,
    binScripts: bin.written.filter((f) => f.endsWith(".sh")),
    removedBinScripts: bin.removed,
    dashboardPath,
    settingsPath: settingsFile,
  };
}

/**
 * スモーク実行の判定。
 *
 * - `pass` / `fail` … 中身が揃っていて、ゲートを通った / 通らなかった
 * - `pending` … 中身がまだない(導入直後の正常な状態。担当エージェントの出番)
 * - `unresolved` … スクリプトから atf を解決できなかった(配線の不備)
 * - `missing` … スクリプトが配られていない(ダッシュボードなど、スクリプトを持つ機能でのみ起きる)
 */
export type SmokeVerdict = "pass" | "fail" | "pending" | "unresolved" | "missing";

export interface SmokeResult {
  feature: FeatureId;
  /** 実行したスクリプトのパス */
  script: string;
  verdict: SmokeVerdict;
  /** 終了コード(起動できなければ undefined) */
  code?: number;
  /** スクリプトの出力(標準出力 + 標準エラー) */
  output: string;
  /** 未整備のときにユーザーへ案内する次の一手 */
  next: string;
}

/**
 * 導入した機能を 1 度だけ実行して、配線(スクリプト・atf の解決)が生きているかを確かめる。
 *
 * 導入直後は中身(.als / 規約 / 文書の記録)が未整備でゲートは必ず落ちるため、
 * **未整備を失敗として扱わない**。確認したいのは「実行できる状態で配られたか」。
 */
export function smokeRun(
  repoPath: string,
  id: FeatureId,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): SmokeResult | undefined {
  const feature = findFeature(id);
  // 実行スクリプトを持たない機能(Issue 駆動)は、走らせるものがないので対象外
  if (!feature || !hasBinScript(id)) return undefined;

  const run = runBinScript(repoPath, id, opts);
  const base = { feature: id, script: run.script, code: run.code, output: run.output, next: feature.next };
  if (run.missing) return { ...base, verdict: "missing" };
  if (run.unresolved) return { ...base, verdict: "unresolved" };
  if (feature.ready && !feature.ready(repoPath)) return { ...base, verdict: "pending" };
  return { ...base, verdict: run.code === 0 ? "pass" : "fail" };
}

/** 現在有効な機能の id(requirements を持たない機能は常に有効として扱わない) */
export function enabledFeatures(manifest: TeamManifest): FeatureId[] {
  return FEATURES.filter((f) => f.flag && manifest.requirements[f.flag] === true).map((f) => f.id);
}

/** 機能の一覧(id・表示名・担当エージェント・スキルを配るか)を返す。CLI のヘルプと案内に使う */
export function featureSummaries(): Array<{
  id: FeatureId;
  name: string;
  agent?: string;
  installsSkills: boolean;
  /** atf-bin に実行スクリプトを持つか(持たない機能はスモーク実行もできない) */
  hasScript: boolean;
}> {
  return FEATURES.map((f) => ({
    id: f.id,
    name: f.name,
    agent: f.agentFile?.replace(/\.md$/, ""),
    installsSkills: f.skills.length > 0,
    hasScript: hasBinScript(f.id),
  }));
}
