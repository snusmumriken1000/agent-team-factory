import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { analyzeRepo, applyTechStack } from "./analyzer.js";
import { applyFeatures, FEATURES, findFeature, headingsOf } from "./apply.js";
import type { ApplyResult, FeatureDef, FeatureId, ManagedFile } from "./apply.js";
import { planAtfBin } from "./bin.js";
import { loadSpecState, EXPLAIN_TEMPLATE_FILE } from "./alloy.js";
import { runWeave } from "./weave.js";
import { loadCapabilityFindings, loadCapabilityPlans } from "./capabilities.js";
import { buildFlow } from "./generator.js";
import { loadPresets } from "./presets.js";
import {
  buildDashboardHtml,
  loadArchitectureState,
  loadEvaluationState,
  loadRuns,
  loadTaskDrafts,
} from "./report.js";
import { extractSections, spliceSections } from "./sections.js";
import { loadTeamSettings, settingsPath } from "./settings.js";
import { installSkills, loadSkillCatalog } from "./skills.js";
import type { SkillDef, SkillSource, TeamManifest } from "./types.js";

/**
 * 導入済みチームの「atf が配ったアセット」を、いまの atf の内容に更新する(`atf update`)。
 *
 * `apply` が**機能の導入**(requirements を有効にして一式を配る)なのに対し、
 * update は**すでに有効な機能だけ**を対象に、配布物を最新版へ入れ替える。
 * 有効/無効は変えないので、機能を足す・外すのは従来どおり `apply` / `remove` の仕事。
 *
 * 入れ替える対象は「atf が内容を決めるもの」に限る:
 *
 * - エージェント定義の atf セクション(`sections.ts` 経由なので手書きの節は残る)
 * - 足場のうち `FeatureDef.managed` に挙げたもの(書式ガイド・変換スクリプト・
 *   解説ページのテンプレート。テンプレートを入れ替えたら weave も再実行して派生物をそろえる)
 * - `atf-bin/*.sh`・ダッシュボード・チーム設定の記録
 * - 付随スキル(カタログの版が上がっているものだけ。手編集されたものは `--force` でのみ)
 *
 * ユーザーとエージェントが書いたもの(`rules.json` / `rubric.json` / `run-arch-check.sh` /
 * `run-alloy.sh` / `.als` / `*.jsonl` / Issue ドラフト)には触れない。
 */

/** 更新するアセットの種類 */
export type UpdateAssetKind =
  | "agent"
  | "section"
  | "scaffold"
  | "skill"
  | "bin"
  | "dashboard"
  | "settings";

/**
 * アセットごとの扱い。
 * `kept` は「更新できるが、手が入っているので据え置いた」(`--force` で入れ替わる)。
 */
export type UpdateAssetStatus = "create" | "update" | "remove" | "kept";

export interface UpdateAsset {
  kind: UpdateAssetKind;
  /** 表示用のラベル(リポジトリ相対パス、またはスキル名) */
  label: string;
  status: UpdateAssetStatus;
  /** 補足(版の変化・据え置きの理由など) */
  detail?: string;
}

export interface FeatureUpdate {
  id: FeatureId;
  name: string;
  /** 変化するアセットだけ(変わらないものは載せない) */
  assets: UpdateAsset[];
  /** 内容に変化がなかったアセットの件数 */
  unchanged: number;
  /** 入れ替えるスキルのカタログ id(実行時に force 付きで配り直す) */
  skillUpdates: string[];
}

export interface UpdatePlan {
  repoPath: string;
  project: string;
  /** 対象の機能 id(有効な機能 + 常に使えるダッシュボード) */
  ids: FeatureId[];
  features: FeatureUpdate[];
  /** 機能に属さない共通アセット(atf-bin・ダッシュボード・チーム設定) */
  common: UpdateAsset[];
  /** 更新するものがあるか(false なら承認を取らずに終えてよい) */
  hasChanges: boolean;
}

export interface UpdateResult {
  /** 機能の再適用の結果(担当エージェントの補完・指示の差し替え・atf-bin の配布) */
  apply: ApplyResult;
  /** 最新化した足場ファイル(リポジトリ相対パス) */
  managed: string[];
  /** 入れ替えたスキル名 */
  skills: string[];
  settingsPath: string;
  dashboardPath: string;
}

/** 更新の対象になる機能(有効な機能 + ダッシュボード。ダッシュボードはチームがあれば常に使える) */
export function updateTargets(manifest: TeamManifest): FeatureDef[] {
  return FEATURES.filter((f) => (f.flag ? manifest.requirements[f.flag] === true : true));
}

/** スキルの版(pin した commit、なければ同梱した版) */
function versionOf(source?: SkillSource): string | undefined {
  return source?.commit ?? source?.version;
}

/** 表示用にリポジトリ相対パスへ落とす */
function rel(repoPath: string, path: string): string {
  return relative(repoPath, path) || path;
}

/**
 * 付随スキルの更新計画。
 *
 * カタログの版(commit / version)がマニフェストの記録と違えば atf 側の更新とみなして入れ替える。
 * 版が同じなのに中身が違うものは手編集とみなして据え置く(`--force` でのみ入れ替える)。
 */
function planSkills(
  repoPath: string,
  manifest: TeamManifest,
  feature: FeatureDef,
  catalog: SkillDef[],
  force: boolean,
): { assets: UpdateAsset[]; updates: string[]; unchanged: number } {
  const assets: UpdateAsset[] = [];
  const updates: string[] = [];
  let unchanged = 0;

  for (const id of feature.skills) {
    const def = catalog.find((s) => s.id === id);
    if (!def) continue; // カタログから消えたスキルは update の対象にしない
    const dest = join(repoPath, ".claude", "skills", def.name, "SKILL.md");
    if (!existsSync(dest)) {
      assets.push({ kind: "skill", label: def.name, status: "create", detail: "未配置のため配る" });
      updates.push(id);
      continue;
    }

    const installedVersion = versionOf(manifest.skills?.find((s) => s.id === id)?.source);
    const catalogVersion = versionOf(def.source);
    if (catalogVersion !== undefined && catalogVersion !== installedVersion) {
      assets.push({
        kind: "skill",
        label: def.name,
        status: "update",
        detail: `版: ${installedVersion ?? "(記録なし)"} → ${catalogVersion}`,
      });
      updates.push(id);
      continue;
    }

    const same = readFileSync(dest, "utf8") === readFileSync(join(def.dir, "SKILL.md"), "utf8");
    if (same) {
      unchanged++;
      continue;
    }
    if (force) {
      assets.push({ kind: "skill", label: def.name, status: "update", detail: "手編集を入れ替える(--force)" });
      updates.push(id);
    } else {
      assets.push({
        kind: "skill",
        label: def.name,
        status: "kept",
        detail: "手が入っているため据え置き(--force で入れ替え)",
      });
    }
  }
  return { assets, updates, unchanged };
}

/**
 * 指示セクションの差し替えで内容が変わるエージェント定義を、機能ごとに割り出す。
 *
 * 1 機能ずつ `spliceSections` を試すと、他の機能の節との**並び**が変わるだけで
 * 差分ありに見えてしまう(差し込みは常に `## 実行記録` の直前のため)。
 * そこで「いま入っている節の中身」と「これから差し込む節」を見出し単位で比べ、
 * 中身が同じなら更新なしとする。並びだけが違う場合は、最初の機能にまとめて計上する。
 */
function changedSections(
  repoPath: string,
  targets: FeatureDef[],
  manifest: TeamManifest,
  skip: Set<string>,
): Map<FeatureId, Array<{ file: string; detail?: string }>> {
  const changed = new Map<FeatureId, Array<{ file: string; detail?: string }>>();
  const agentsDir = join(repoPath, ".claude", "agents");
  if (!existsSync(agentsDir)) return changed;
  const withSections = targets.filter((f) => f.sections !== undefined);

  const add = (id: FeatureId, file: string, detail?: string) => {
    const list = changed.get(id) ?? [];
    list.push({ file, detail });
    changed.set(id, list);
  };

  for (const entry of readdirSync(agentsDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    // これから作り直す定義は「追加」として報告するので、指示の更新には数えない
    if (skip.has(entry.name)) continue;
    const before = readFileSync(join(agentsDir, entry.name), "utf8");

    // applyFeatures と同じ順で通して、ファイル全体が変わるかを見る
    let after = before;
    for (const feature of withSections) {
      after = spliceSections(
        after,
        headingsOf(feature),
        feature.sections!(entry.name, manifest.requirements),
      );
    }
    if (after === before) continue;

    let attributed = false;
    for (const feature of withSections) {
      const current = extractSections(before, headingsOf(feature)).trim();
      const next = feature.sections!(entry.name, manifest.requirements).trim();
      if (current === next) continue;
      add(feature.id, entry.name, current === "" ? "指示が入っていない" : undefined);
      attributed = true;
    }
    if (!attributed && withSections[0]) add(withSections[0].id, entry.name, "節の並びを整える");
  }
  return changed;
}

/** atf が内容を決める足場ファイルのうち、いま書き換わるもの */
function changedManaged(
  repoPath: string,
  files: ManagedFile[],
): { assets: UpdateAsset[]; unchanged: number } {
  const assets: UpdateAsset[] = [];
  let unchanged = 0;
  for (const file of files) {
    const label = rel(repoPath, file.path);
    if (!existsSync(file.path)) {
      assets.push({ kind: "scaffold", label, status: "create" });
      continue;
    }
    if (readFileSync(file.path, "utf8") === file.content) unchanged++;
    else assets.push({ kind: "scaffold", label, status: "update" });
  }
  return { assets, unchanged };
}

/**
 * 書き込まずに、いま `atf update` を実行したら何が変わるかを調べる。
 * ユーザーへの提示(承認を得る材料)と、実行時の判断(どのスキルを入れ替えるか)の両方に使う。
 */
export function planUpdate(repoPath: string, opts: { force?: boolean } = {}): UpdatePlan {
  const manifest = loadTeamSettings(repoPath);
  const force = opts.force === true;
  const catalog = loadSkillCatalog();
  const targets = updateTargets(manifest);

  // 検出値は最新のものを使う(導入後に言語・フレームワークが増えていることがある)
  const detected = analyzeRepo(repoPath);
  const profile = manifest.requirements.techStack
    ? applyTechStack(detected, manifest.requirements.techStack)
    : detected;

  // 足場・指示文は「チーム構成から導く設定」を反映したあとの requirements から組み立てる
  // (applyFeatures と同じ順序。評価対象の一覧など)
  const before = JSON.stringify(manifest.requirements);
  for (const feature of targets) feature.prepare?.(manifest);
  const requirementsChanged = JSON.stringify(manifest.requirements) !== before;

  // 欠けている担当エージェント定義は、この update で作り直される
  const agentsDir = join(repoPath, ".claude", "agents");
  const missingAgents = new Set(
    targets
      .map((f) => f.agentFile)
      .filter((file): file is string => file !== undefined && !existsSync(join(agentsDir, file))),
  );

  const sections = changedSections(repoPath, targets, manifest, missingAgents);

  const features: FeatureUpdate[] = [];
  for (const feature of targets) {
    const assets: UpdateAsset[] = [];
    let unchanged = 0;

    if (feature.agentFile && missingAgents.has(feature.agentFile)) {
      assets.push({
        kind: "agent",
        label: rel(repoPath, join(agentsDir, feature.agentFile)),
        status: "create",
        detail: "担当エージェント定義が欠けているため雛形から作り直す",
      });
    }
    for (const { file, detail } of sections.get(feature.id) ?? []) {
      assets.push({
        kind: "section",
        label: rel(repoPath, join(agentsDir, file)),
        status: "update",
        detail,
      });
    }
    const managed = changedManaged(
      repoPath,
      feature.managed?.(repoPath, manifest, profile.languages) ?? [],
    );
    assets.push(...managed.assets);
    unchanged += managed.unchanged;

    const skills = planSkills(repoPath, manifest, feature, catalog, force);
    assets.push(...skills.assets);
    unchanged += skills.unchanged;

    features.push({
      id: feature.id,
      name: feature.name,
      assets,
      unchanged,
      skillUpdates: skills.updates,
    });
  }

  // 共通アセット(機能に属さないもの)
  const common: UpdateAsset[] = [];
  const bin = planAtfBin(repoPath, manifest.requirements);
  for (const file of bin.changed) {
    common.push({ kind: "bin", label: rel(repoPath, join(bin.dir, file)), status: "update" });
  }
  for (const file of bin.removed) {
    common.push({
      kind: "bin",
      label: rel(repoPath, join(bin.dir, file)),
      status: "remove",
      detail: "無効な機能・旧名のスクリプト",
    });
  }

  const preset = loadPresets().find((p) => p.id === manifest.preset);
  const rebuiltFlow = buildFlow(preset?.flow, manifest.requirements, manifest.agents[0]?.name);
  const flowChanged =
    preset !== undefined && JSON.stringify(rebuiltFlow) !== JSON.stringify(manifest.flow);
  if (requirementsChanged || flowChanged) {
    common.push({
      kind: "settings",
      label: rel(repoPath, settingsPath(repoPath)),
      status: "update",
      detail: [requirementsChanged ? "requirements の記録" : "", flowChanged ? "構成図の辺" : ""]
        .filter((s) => s !== "")
        .join(" / "),
    });
  }

  const dashboardPath = join(repoPath, ".claude", "atf-dashboard.html");
  const dashboard = buildDashboardHtml(
    { ...manifest, flow: preset ? rebuiltFlow : manifest.flow },
    loadRuns(repoPath),
    loadTaskDrafts(repoPath),
    loadSpecState(repoPath),
    { findings: loadCapabilityFindings(repoPath), plans: loadCapabilityPlans(repoPath) },
    loadArchitectureState(repoPath),
    loadEvaluationState(repoPath),
  );
  const dashboardChanged =
    !existsSync(dashboardPath) ||
    readFileSync(dashboardPath, "utf8") !== dashboard ||
    // 担当エージェントを作り直すとチーム構成図が変わる
    missingAgents.size > 0;
  if (dashboardChanged) {
    common.push({
      kind: "dashboard",
      label: rel(repoPath, dashboardPath),
      status: existsSync(dashboardPath) ? "update" : "create",
    });
  }

  // 据え置き(kept)は「実行しても変わらないもの」なので、更新の有無には数えない
  const hasChanges =
    features.some((f) => f.assets.some((a) => a.status !== "kept")) || common.length > 0;

  return {
    repoPath,
    project: manifest.project,
    ids: targets.map((f) => f.id),
    features,
    common,
    hasChanges,
  };
}

/** atf が内容を決める足場ファイルを書き出す(既存は無条件に入れ替える) */
function writeManagedFiles(repoPath: string, manifest: TeamManifest, languages: string[]): string[] {
  const written: string[] = [];
  for (const id of updateTargets(manifest).map((f) => f.id)) {
    const feature = findFeature(id);
    for (const file of feature?.managed?.(repoPath, manifest, languages) ?? []) {
      if (existsSync(file.path) && readFileSync(file.path, "utf8") === file.content) continue;
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content);
      if (file.mode !== undefined) chmodSync(file.path, file.mode);
      written.push(rel(repoPath, file.path));
    }
  }
  return written;
}

/**
 * 計画したアセットの更新を実行する。
 *
 * 実処理は `applyFeatures`(有効な機能の再適用)に任せ、update はその前後で
 * 「版が上がったスキルの入れ替え」と「atf が内容を決める足場の最新化」を足す。
 * apply と同じ関数を通すので、指示文・フロー・atf-bin の内容が update だけずれることはない。
 */
export function runUpdate(
  repoPath: string,
  plan: UpdatePlan,
  opts: { force?: boolean } = {},
): UpdateResult {
  // 1. 版が上がったスキル(--force 指定時は手編集されたものも)を先に入れ替える。
  //    applyFeatures の installSkills は既存を上書きしないため、ここで決着をつける
  const skillIds = plan.features.flatMap((f) => f.skillUpdates);
  const skills = skillIds.length
    ? installSkills(repoPath, skillIds, { force: true, projectName: plan.project }).installed.map(
        (s) => s.name,
      )
    : [];

  // 2. 有効な機能を再適用する(担当エージェントの補完・指示セクションの差し替え・
  //    足場・atf-bin・フロー・チーム設定・ダッシュボード)
  const apply = applyFeatures(repoPath, plan.ids, { force: opts.force });

  // 3. scaffold は既存を壊さない(writeIfAbsent)ため、atf が内容を決めるものはここで入れ替える
  const manifest = loadTeamSettings(repoPath);
  const detected = analyzeRepo(repoPath);
  const profile = manifest.requirements.techStack
    ? applyTechStack(detected, manifest.requirements.techStack)
    : detected;
  const managed = writeManagedFiles(repoPath, manifest, profile.languages);

  // 4. 解説ページのテンプレートを入れ替えたら、派生物(docs/generated/)を新しい形式で作り直す
  //    (applyFeatures の weave は入れ替え前の旧テンプレートで走っているため)
  if (managed.some((path) => path.endsWith(EXPLAIN_TEMPLATE_FILE))) {
    runWeave(repoPath, manifest.project);
  }

  return {
    apply,
    managed,
    skills,
    settingsPath: apply.settingsPath,
    dashboardPath: apply.dashboardPath,
  };
}
