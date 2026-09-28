import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FEATURES, headingsOf } from "./apply.js";
import type { FeatureDef, FeatureId } from "./apply.js";
import { installAtfBin } from "./bin.js";
import { buildFlow } from "./generator.js";
import { loadPresets } from "./presets.js";
import {
  buildDashboardHtml,
  loadArchitectureState,
  loadEvaluationState,
  loadRuns,
  loadTaskDrafts,
} from "./report.js";
import { loadSpecState } from "./alloy.js";
import { loadCapabilityFindings, loadCapabilityPlans } from "./capabilities.js";
import { spliceSections } from "./sections.js";
import { loadTeamSettings, settingsPath, updateTeamSettings } from "./settings.js";
import { removeSkills } from "./skills.js";
import type { TeamManifest } from "./types.js";

/**
 * 撤去できる機能(= 有効/無効を requirements に持つ機能)。
 * ダッシュボード(report)はチームがあれば常に使えるため撤去の対象にしない。
 */
export const REMOVABLE_FEATURES: FeatureDef[] = FEATURES.filter((f) => f.flag !== undefined);

/** 撤去できる機能の id */
export const REMOVABLE_IDS: FeatureId[] = REMOVABLE_FEATURES.map((f) => f.id);

/** 撤去できる機能か */
export function findRemovable(id: string): FeatureDef | undefined {
  return REMOVABLE_FEATURES.find((f) => f.id === id);
}

export interface RemovedFeature {
  id: FeatureId;
  name: string;
  /** 実行前に有効だったか(無効なら後片付けだけを行う) */
  wasEnabled: boolean;
  /** 削除した担当エージェント定義 */
  agentFile?: string;
  /** 撤去したスキル(インストール名) */
  removedSkills: string[];
  /** 手が入っているため残したスキル */
  keptSkills: string[];
  /** 成果物の置き場(--purge を付けていれば削除済み) */
  artifactsDirs: string[];
  /** 成果物を削除したか */
  purged: boolean;
}

export interface RemoveResult {
  removed: RemovedFeature[];
  /** 存在しない・撤去できない機能 id */
  unknown: string[];
  /** 指示を更新したエージェント定義ファイル名 */
  agents: string[];
  binDir: string;
  binScripts: string[];
  dashboardPath: string;
  settingsPath: string;
}

/**
 * 導入済みチームから機能を撤去する(`atf apply <機能>` の逆操作)。
 *
 * - `atf-settings.yaml` の requirements を false にする(有効/無効の単一情報源)
 * - 担当エージェント定義を削除し、マニフェストの agents からも外す
 * - 残るエージェント定義から、その機能のセクションを取り除く
 * - 付随するスキルを撤去する(手編集されたものは残す)
 * - `atf-bin/<機能>.sh` を取り除き、ダッシュボードを更新する
 *
 * 成果物(`.claude/atf-arch/` の規約や `spec/` の .als・`docs/adr/` の ADR など、
 * ユーザーとエージェントが書いたもの)は既定で残す。`purge` を指定したときだけ削除する。
 */
export function removeFeatures(
  repoPath: string,
  ids: string[],
  opts: { purge?: boolean; force?: boolean } = {},
): RemoveResult {
  const manifest = loadTeamSettings(repoPath);
  const unknown = ids.filter((id) => !findRemovable(id));
  const features = ids
    .map((id) => findRemovable(id))
    .filter((f): f is FeatureDef => f !== undefined)
    .filter((f, i, all) => all.findIndex((x) => x.id === f.id) === i);

  const removed: RemovedFeature[] = [];
  const agents: string[] = [];
  if (features.length === 0) {
    return {
      removed,
      unknown,
      agents,
      binDir: join(repoPath, "atf-bin"),
      binScripts: [],
      dashboardPath: join(repoPath, ".claude", "atf-dashboard.html"),
      settingsPath: settingsPath(repoPath),
    };
  }

  const agentsDir = join(repoPath, ".claude", "agents");
  for (const feature of features) {
    const wasEnabled = feature.flag ? manifest.requirements[feature.flag] === true : false;
    if (feature.flag) manifest.requirements[feature.flag] = false;

    // 担当エージェントは atf が配ったもの。定義ファイルを消し、チーム構成からも外す
    let agentFile: string | undefined;
    if (feature.agentFile) {
      const dest = join(agentsDir, feature.agentFile);
      if (existsSync(dest)) {
        rmSync(dest);
        agentFile = feature.agentFile;
      }
      manifest.agents = manifest.agents.filter((a) => a.file !== feature.agentFile);
    }

    // 付随スキル(図の archify など)を撤去する。手編集されたものは残す
    const skills = (manifest.skills ?? []).filter((s) => feature.skills.includes(s.id));
    const result: { removed: string[]; kept: string[] } = skills.length
      ? removeSkills(
          repoPath,
          skills.map((s) => s.name),
          { force: opts.force, projectName: manifest.project },
        )
      : { removed: [], kept: [] };
    if (result.removed.length > 0) {
      manifest.skills = (manifest.skills ?? []).filter((s) => !result.removed.includes(s.name));
      if (manifest.skills.length === 0) delete manifest.skills;
    }

    // 成果物(規約・仕様・ADR・文書の記録)はユーザーとエージェントの作業結果なので既定で残す
    const artifactsDirs = (feature.artifacts?.(repoPath) ?? []).filter((dir) => existsSync(dir));
    const purge = opts.purge === true && artifactsDirs.length > 0;
    if (purge) {
      for (const dir of artifactsDirs) rmSync(dir, { recursive: true, force: true });
    }

    removed.push({
      id: feature.id,
      name: feature.name,
      wasEnabled,
      agentFile,
      removedSkills: result.removed,
      keptSkills: result.kept,
      // 削除した場合もパスは報告する(何を消したかが分かるように)
      artifactsDirs,
      purged: purge,
    });
  }

  // 残ったエージェント定義から、撤去した機能のセクションを取り除く
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const path = join(agentsDir, entry.name);
      const before = readFileSync(path, "utf8");
      let after = before;
      for (const feature of features) {
        if (!feature.sections) continue;
        after = spliceSections(after, headingsOf(feature), "");
      }
      if (after === before) continue;
      writeFileSync(path, after);
      agents.push(entry.name);
    }
  }

  // 実行スクリプトは requirements から組み立て直す(無効にした機能のぶんが消える)
  const bin = installAtfBin(repoPath, manifest.requirements);

  const preset = loadPresets().find((p) => p.id === manifest.preset);
  const firstAgent = manifest.agents[0]?.name;
  manifest.flow = buildFlow(preset?.flow, manifest.requirements, firstAgent);

  const settingsFile = updateTeamSettings(repoPath, manifest);
  const dashboardPath = writeDashboard(repoPath, manifest);

  return {
    removed,
    unknown,
    agents,
    binDir: bin.dir,
    binScripts: bin.removed,
    dashboardPath,
    settingsPath: settingsFile,
  };
}

/** ダッシュボードを現在の状態で書き直す */
function writeDashboard(repoPath: string, manifest: TeamManifest): string {
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
  return dashboardPath;
}
