import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { commonRoot } from "./presets.js";
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

/** Issue 駆動開発が有効なとき、各エージェント定義に付与する指示 */
const issueDrivenInstruction = (githubRepo?: string) => `

## Issue 駆動開発

このプロジェクトは Issue 駆動で開発する${githubRepo ? `(使用するリポジトリ: ${githubRepo})` : ""}:

- 作業は必ず対応する GitHub Issue を起点に行い、Issue 番号(#123)を確認してから着手する${githubRepo ? `\n- Issue の起票・参照は ${githubRepo} に対して行う(gh CLI では \`-R ${githubRepo}\` を指定)` : ""}
- 対応する Issue がない作業を依頼されたら、先に issue-manager エージェントで Issue を起票することを提案する
- 成果物の報告・コミットメッセージには Issue 番号を含める
- 実行記録の JSON にも \`"issue": "#123"\` を含める
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
    githubRepo: requirements.githubRepo ?? "(未設定)",
  };

  const limit = TEAM_SIZE_LIMIT[requirements.teamSize] ?? Infinity;
  const selected = preset.agents.slice(0, limit);
  const written: string[] = [];
  const teamAgents: TeamAgent[] = [];
  const extraInstruction = requirements.issueDriven
    ? issueDrivenInstruction(requirements.githubRepo)
    : "";

  const writeAgent = (agentFile: string, srcDir: string) => {
    const template = readFileSync(join(srcDir, agentFile), "utf8");
    const meta = parseAgentMeta(template, agentFile.replace(/\.md$/, ""));
    teamAgents.push({ file: agentFile, ...meta });

    const dest = join(agentsDir, agentFile);
    if (existsSync(dest) && !opts.force) {
      return; // 既存のエージェント定義は尊重する
    }
    writeFileSync(dest, render(template, vars) + extraInstruction + runLogInstruction(meta.name));
    written.push(agentFile);
  };

  for (const agentFile of selected) {
    writeAgent(agentFile, join(preset.dir, "agents"));
  }

  // Issue 駆動なら issue-manager を追加(teamSize の枠は消費しない)し、
  // チームの先頭エージェントへタスクを流すフローを描く
  const flow = [...(preset.flow ?? [])];
  if (requirements.issueDriven) {
    const firstAgent = teamAgents[0]?.name;
    writeAgent("issue-manager.md", commonRoot());
    if (firstAgent) flow.push(["issue-manager", firstAgent]);
  }

  // チームのマニフェストを記録(再生成・ダッシュボード生成の入力)
  const manifest: TeamManifest = {
    generatedBy: "agent-team-factory",
    preset: preset.id,
    presetName: preset.name,
    project: profile.name,
    requirements,
    agents: teamAgents,
    flow,
  };
  writeFileSync(join(claudeDir, "team.json"), JSON.stringify(manifest, null, 2) + "\n");

  // ダッシュボードを生成(既存の実行記録があれば反映)
  const dashboardPath = join(claudeDir, "atf-dashboard.html");
  writeFileSync(dashboardPath, buildDashboardHtml(manifest, loadRuns(profile.path)));

  return { agentsDir, written, dashboardPath };
}
