import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RunRecord, TeamManifest } from "./types.js";

/** 対象リポジトリの .claude/team.json を読む */
export function loadTeamManifest(repoPath: string): TeamManifest {
  const manifestPath = join(repoPath, ".claude", "team.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `チームが導入されていません(${manifestPath} がありません)。先に atf generate を実行してください。`,
    );
  }
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

/** .claude/atf-logs/runs.jsonl から実行記録を読む(なければ空) */
export function loadRuns(repoPath: string): RunRecord[] {
  const logPath = join(repoPath, ".claude", "atf-logs", "runs.jsonl");
  if (!existsSync(logPath)) return [];
  const runs: RunRecord[] = [];
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      runs.push(JSON.parse(trimmed));
    } catch {
      // 壊れた行は無視(エージェントの自己申告のため寛容に扱う)
    }
  }
  return runs;
}

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Mermaid のノード ID・ラベルとして安全な文字列にする */
const mermaidSafe = (s: string): string => s.replace(/[^\w-]/g, "_");

/** チーム構成の Mermaid フローチャートを組み立てる */
function buildFlowChart(manifest: TeamManifest): string {
  const lines = ["flowchart LR"];
  const agentNames = new Set(manifest.agents.map((a) => a.name));
  for (const a of manifest.agents) {
    lines.push(`  ${mermaidSafe(a.name)}["${a.name}"]`);
  }
  for (const [from, to] of manifest.flow) {
    // teamSize 制限で除外されたエージェントへの辺は描かない
    if (!agentNames.has(from) || !agentNames.has(to)) continue;
    lines.push(`  ${mermaidSafe(from)} --> ${mermaidSafe(to)}`);
  }
  return lines.join("\n");
}

/** エージェントごとの実行記録テーブル行 */
function buildRunRows(runs: RunRecord[], issueDriven: boolean): string {
  const columns = issueDriven ? 7 : 6;
  if (runs.length === 0) {
    return `<tr><td colspan="${columns}" class="empty">実行記録はまだありません(各エージェントが作業完了時に .claude/atf-logs/runs.jsonl へ追記します)</td></tr>`;
  }
  return runs
    .slice()
    .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""))
    .map((r) => {
      const status = r.status === "failure" ? "❌ failure" : "✅ " + (r.status ?? "success");
      const issueCell = issueDriven ? `\n        <td>${escapeHtml(r.issue ?? "-")}</td>` : "";
      return `<tr>
        <td>${escapeHtml(r.finishedAt ?? "-")}</td>
        <td><span class="badge">${escapeHtml(r.agent)}</span></td>${issueCell}
        <td>${escapeHtml(r.task ?? "-")}</td>
        <td>${escapeHtml(r.inputs ?? "-")}</td>
        <td>${escapeHtml(r.outputs ?? "-")}</td>
        <td>${escapeHtml(status)}</td>
      </tr>`;
    })
    .join("\n");
}

/** エージェント別の実行回数バー */
function buildActivityBars(manifest: TeamManifest, runs: RunRecord[]): string {
  const counts = new Map<string, number>(manifest.agents.map((a) => [a.name, 0]));
  for (const r of runs) {
    counts.set(r.agent, (counts.get(r.agent) ?? 0) + 1);
  }
  const max = Math.max(1, ...counts.values());
  return [...counts.entries()]
    .map(
      ([name, count]) => `
      <div class="bar-row">
        <span class="bar-label">${escapeHtml(name)}</span>
        <div class="bar" style="width: ${(count / max) * 100}%"></div>
        <span class="bar-count">${count}</span>
      </div>`,
    )
    .join("\n");
}

/** チーム構成 + 実行記録を可視化する自己完結 HTML を組み立てる */
export function buildDashboardHtml(manifest: TeamManifest, runs: RunRecord[]): string {
  const issueDriven = manifest.requirements.issueDriven ?? false;
  const agentCards = manifest.agents
    .map(
      (a) => `
      <div class="card">
        <h3>${escapeHtml(a.name)}</h3>
        <p>${escapeHtml(a.description)}</p>
      </div>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${escapeHtml(manifest.project)} — エージェントチームダッシュボード</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<style>
  body { font-family: -apple-system, "Hiragino Sans", sans-serif; margin: 2rem auto; max-width: 1100px; padding: 0 1rem; color: #1a1a2e; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.15rem; margin-top: 2.5rem; border-bottom: 2px solid #e0e0ef; padding-bottom: .4rem; }
  .meta { color: #666; font-size: .9rem; }
  .meta span { margin-right: 1.2rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1rem; }
  .card { border: 1px solid #e0e0ef; border-radius: 8px; padding: 1rem; background: #fafaff; }
  .card h3 { margin: 0 0 .5rem; font-size: 1rem; color: #3b3b8f; }
  .card p { margin: 0; font-size: .85rem; line-height: 1.6; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { border: 1px solid #e0e0ef; padding: .5rem .7rem; text-align: left; vertical-align: top; }
  th { background: #f0f0fa; }
  .empty { color: #999; text-align: center; }
  .badge { background: #3b3b8f; color: #fff; border-radius: 4px; padding: .1rem .5rem; font-size: .8rem; }
  .mermaid { background: #fafaff; border: 1px solid #e0e0ef; border-radius: 8px; padding: 1rem; }
  .bar-row { display: flex; align-items: center; gap: .6rem; margin: .3rem 0; }
  .bar-label { width: 160px; font-size: .85rem; text-align: right; }
  .bar { height: 16px; background: #6c6cd9; border-radius: 3px; min-width: 2px; }
  .bar-count { font-size: .85rem; color: #666; }
</style>
</head>
<body>
<h1>${escapeHtml(manifest.project)} — ${escapeHtml(manifest.presetName)}</h1>
<p class="meta">
  <span>プリセット: ${escapeHtml(manifest.preset)}</span>
  <span>フェーズ: ${escapeHtml(manifest.requirements.phase)}</span>
  <span>重視観点: ${escapeHtml(manifest.requirements.focus.join(", "))}</span>
  <span>開発スタイル: ${issueDriven ? "Issue 駆動" : "通常"}</span>
  <span>実行記録: ${runs.length} 件</span>
</p>

<h2>チーム構成・入出力フロー</h2>
<pre class="mermaid">
${buildFlowChart(manifest)}
</pre>

<h2>エージェント</h2>
<div class="cards">
${agentCards}
</div>

<h2>エージェント別 実行回数</h2>
${buildActivityBars(manifest, runs)}

<h2>実行記録</h2>
<table>
  <thead>
    <tr><th>完了時刻</th><th>エージェント</th>${issueDriven ? "<th>Issue</th>" : ""}<th>タスク</th><th>入力</th><th>出力</th><th>結果</th></tr>
  </thead>
  <tbody>
${buildRunRows(runs, issueDriven)}
  </tbody>
</table>

<script>mermaid.initialize({ startOnLoad: true, theme: "neutral" });</script>
</body>
</html>
`;
}
