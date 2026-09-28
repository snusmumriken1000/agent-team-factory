import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  designSkillInstruction,
  envBuilderSkillInstruction,
  orchestratorSkillInstruction,
} from "./generator.js";
import { installSkills, loadSkillCatalog, removeSkills } from "./skills.js";
import { sectionHeading, spliceSections, stripSections } from "./sections.js";
import {
  buildDashboardHtml,
  loadArchitectureState,
  loadEvaluationState,
  loadRuns,
  loadTaskDrafts,
} from "./report.js";
import { loadTeamSettings, updateTeamSettings } from "./settings.js";
import { loadSpecState } from "./alloy.js";
import { loadCapabilityFindings, loadCapabilityPlans } from "./capabilities.js";
import type { InstalledSkill, SkillDef } from "./types.js";

/**
 * デザインとして出し入れするスキルの分類。
 * これ以外(図の生成に使う diagram など、機能の選択で入るスキル)は
 * `atf apply design` の対象外として**撤去せずに残す**。
 */
const DESIGN_CATEGORIES = ["aesthetic", "workflow", "imagegen"];

/** デザインとして扱うスキルか(分類で判定する) */
export const isDesignSkill = (skill: { category: string }): boolean =>
  DESIGN_CATEGORIES.includes(skill.category);

/** 見出しの抽出用ダミー(指示文の 1 行目の見出しだけを取り出すために渡す) */
const SAMPLE_SKILL: InstalledSkill = {
  id: "_sample",
  name: "_sample",
  description: "_sample",
  category: "aesthetic",
};

/**
 * atf がエージェント定義に出し入れするデザイン関連セクションの見出し。
 * 指示文そのものから導出するので、generator.ts の文面を変えても追従する。
 */
export const DESIGN_SECTION_HEADINGS: string[] = [
  designSkillInstruction([SAMPLE_SKILL]),
  orchestratorSkillInstruction([SAMPLE_SKILL]),
  envBuilderSkillInstruction(),
].map(sectionHeading);

/** エージェント定義から既存のデザイン関連セクションだけを取り除く */
export function stripDesignSections(body: string): string {
  return stripSections(body, DESIGN_SECTION_HEADINGS);
}

/** エージェント定義のデザイン関連セクションを差し替える(再適用しても増殖しない) */
export function applyDesignSections(body: string, sections: string): string {
  return spliceSections(body, DESIGN_SECTION_HEADINGS, sections);
}

/** エージェント定義ファイルごとに付与するデザイン関連セクション */
function sectionsFor(agentFile: string, skills: InstalledSkill[]): string {
  if (skills.length === 0) return "";
  return (
    designSkillInstruction(skills) +
    (agentFile === "orchestrator.md" ? orchestratorSkillInstruction(skills) : "") +
    (agentFile === "env-builder.md" ? envBuilderSkillInstruction() : "")
  );
}

export interface ApplyDesignResult {
  /** スキルの配置先(.claude/skills/) */
  skillsDir: string;
  /** 適用後のデザイン(atf-settings.yaml に記録した内容。空なら未適用) */
  skills: InstalledSkill[];
  /** 新規に配置した SKILL.md のスキル名 */
  written: string[];
  /** カタログに存在しなかった id */
  unknown: string[];
  /** 選択から外れて取り除いたスキル名 */
  removed: string[];
  /** 選択から外れたが手編集のため残したスキル名 */
  kept: string[];
  /** 指示を更新したエージェント定義ファイル名 */
  agents: string[];
  dashboardPath: string;
}

/**
 * 導入済みのチームにデザイン(スキル + エージェントへの指示)を適用する。
 * `ids` は**適用後のデザインそのもの**として扱い、選択から外れたスキルは取り除く
 *
 * - `.claude/skills/<スキル名>/SKILL.md` を配置・撤去する
 * - `.claude/agents/*.md` のデザイン関連セクションを差し替える(再実行しても増殖しない)
 * - `atf-settings.yaml`(skills / requirements.designSkills)とダッシュボードを更新する
 */
export function applyDesign(
  repoPath: string,
  ids: string[],
  opts: { force?: boolean; catalog?: SkillDef[] } = {},
): ApplyDesignResult {
  const catalog = opts.catalog ?? loadSkillCatalog();
  const manifest = loadTeamSettings(repoPath);
  const previous = manifest.skills ?? [];
  // デザイン以外の目的で入っているスキル(リバースドキュメントの archify など)は
  // デザインの選択に関係なく維持する
  const retained = previous.filter((skill) => !isDesignSkill(skill));

  // 配置(選択されたスキル)
  const install = installSkills(repoPath, ids, {
    force: opts.force,
    catalog,
    projectName: manifest.project,
  });
  // 選択から外れたデザインスキルは取り除く(手を入れたものは残す)
  const dropped = previous
    .filter((skill) => isDesignSkill(skill))
    .filter((skill) => !install.installed.some((s) => s.id === skill.id))
    .map((skill) => skill.name);
  const remove = removeSkills(repoPath, dropped, {
    force: opts.force,
    catalog,
    projectName: manifest.project,
  });

  // 適用後のデザインは選択されたスキルそのもの。
  // 手編集のため削除できなかったスキル(remove.kept)はファイルだけ残る形になるので、
  // 指示・マニフェストには含めず CLI から警告する(見た目の方向性が二重になるのを避ける)
  const skills = install.installed.filter(isDesignSkill);

  // エージェント定義の指示を差し替える
  const agentsDir = join(repoPath, ".claude", "agents");
  const agents: string[] = [];
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const path = join(agentsDir, entry.name);
      const before = readFileSync(path, "utf8");
      const after = applyDesignSections(before, sectionsFor(entry.name, skills));
      if (after === before) continue;
      writeFileSync(path, after);
      agents.push(entry.name);
    }
  }

  // マニフェストを更新(未適用に戻した場合はデザイン関連のキーだけ落とす。
  // デザイン以外の目的で入っているスキルは維持する。--skill で明示的に
  // デザイン以外のスキルを渡された場合も記録から落とさない)
  const nonDesign = [
    ...retained,
    ...install.installed
      .filter((skill) => !isDesignSkill(skill))
      .filter((skill) => !retained.some((r) => r.id === skill.id)),
  ];
  const manifestSkills = [...skills, ...nonDesign];
  if (manifestSkills.length > 0) {
    manifest.skills = manifestSkills;
  } else {
    delete manifest.skills;
  }
  if (skills.length > 0) {
    manifest.requirements.designSkills = skills.map((s) => s.id);
  } else {
    delete manifest.requirements.designSkills;
  }
  updateTeamSettings(repoPath, manifest);

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
    skillsDir: install.dir,
    skills,
    written: install.written,
    unknown: install.unknown,
    removed: remove.removed,
    kept: remove.kept,
    agents,
    dashboardPath,
  };
}

/**
 * 現在適用されているデザイン(atf-settings.yaml の skills のうちデザイン分類のもの)を id で返す。
 * 図の生成など、デザイン以外の目的で入っているスキルは含めない。
 */
export function currentDesign(repoPath: string): string[] {
  const manifest = loadTeamSettings(repoPath);
  return (manifest.skills ?? []).filter(isDesignSkill).map((s) => s.id);
}

/**
 * カタログ id の重複を落とし、見た目の方向性が複数あれば先頭の 1 つに絞る。
 * カタログにない id はそのまま通し、applyDesign(installSkills)側で未知として報告させる。
 */
export function normalizeDesignIds(ids: string[], catalog: SkillDef[] = loadSkillCatalog()): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  let hasAesthetic = false;
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (catalog.find((s) => s.id === id)?.category === "aesthetic") {
      if (hasAesthetic) continue;
      hasAesthetic = true;
    }
    result.push(id);
  }
  return result;
}
