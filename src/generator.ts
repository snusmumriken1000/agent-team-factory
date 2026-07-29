import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildDashboardHtml, loadRuns } from "./report.js";
import type { Preset, RepoProfile, Requirements, TeamAgent, TeamManifest } from "./types.js";

/** teamSize → エージェント数の上限 */
const TEAM_SIZE_LIMIT: Record<string, number> = {
  minimal: 3,
  standard: 5,
  full: Infinity,
};

/** {{key}} 形式のプレースホルダを置換する */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

/** エージェント定義の frontmatter から name / description を抜き出す */
export function parseAgentMeta(template: string, fallbackName: string): Omit<TeamAgent, "file"> {
  const fm = template.match(/^---\n([\s\S]*?)\n---/);
  const meta: Record<string, string> = {};
  for (const line of fm?.[1].split("\n") ?? []) {
    const m = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { name: meta.name ?? fallbackName, description: meta.description ?? "" };
}

/** 各エージェント定義の末尾に付与する実行記録の指示(ダッシュボード可視化の入力になる) */
const runLogInstruction = (agentName: string) => `

## 実行記録

作業を完了したら、リポジトリの \`.claude/atf-logs/runs.jsonl\` に以下形式の JSON を 1 行追記すること(ディレクトリがなければ作成する):

\`\`\`json
{"agent": "${agentName}", "task": "依頼内容の要約", "inputs": "受け取った主な入力", "outputs": "生成した主な成果物", "status": "success", "finishedAt": "<ISO 8601 形式の現在時刻>"}
\`\`\`

失敗して終了する場合は status を "failure" にする。この記録はチームダッシュボード(.claude/atf-dashboard.html)の可視化に使われる。
`;

export interface GenerateResult {
  agentsDir: string;
  written: string[];
  dashboardPath: string;
}

/**
 * プリセットのエージェント定義を対象リポジトリの .claude/agents/ に書き込み、
 * チームマニフェスト(.claude/team.json)とダッシュボード(.claude/atf-dashboard.html)を生成する。
 * 既存のエージェント定義は force 指定がない限り上書きしない。
 */
export function generateTeam(
  preset: Preset,
  profile: RepoProfile,
  requirements: Requirements,
  opts: { force?: boolean } = {},
): GenerateResult {
  const claudeDir = join(profile.path, ".claude");
  const agentsDir = join(claudeDir, "agents");
  mkdirSync(agentsDir, { recursive: true });

  const vars: Record<string, string> = {
    projectName: profile.name,
    languages: profile.languages.join(", ") || "(未検出)",
    frameworks: profile.frameworks.join(", ") || "(未検出)",
    phase: requirements.phase,
    focus: requirements.focus.join(", "),
  };

  const limit = TEAM_SIZE_LIMIT[requirements.teamSize] ?? Infinity;
  const selected = preset.agents.slice(0, limit);
  const written: string[] = [];
  const teamAgents: TeamAgent[] = [];

  for (const agentFile of selected) {
    const template = readFileSync(join(preset.dir, "agents", agentFile), "utf8");
    const meta = parseAgentMeta(template, agentFile.replace(/\.md$/, ""));
    teamAgents.push({ file: agentFile, ...meta });

    const dest = join(agentsDir, agentFile);
    if (existsSync(dest) && !opts.force) {
      continue; // 既存のエージェント定義は尊重する
    }
    writeFileSync(dest, render(template, vars) + runLogInstruction(meta.name));
    written.push(agentFile);
  }

  // チームのマニフェストを記録(再生成・ダッシュボード生成の入力)
  const manifest: TeamManifest = {
    generatedBy: "agent-team-factory",
    preset: preset.id,
    presetName: preset.name,
    project: profile.name,
    requirements,
    agents: teamAgents,
    flow: preset.flow ?? [],
  };
  writeFileSync(join(claudeDir, "team.json"), JSON.stringify(manifest, null, 2) + "\n");

  // ダッシュボードを生成(既存の実行記録があれば反映)
  const dashboardPath = join(claudeDir, "atf-dashboard.html");
  writeFileSync(dashboardPath, buildDashboardHtml(manifest, loadRuns(profile.path)));

  return { agentsDir, written, dashboardPath };
}
