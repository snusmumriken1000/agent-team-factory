import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Preset, RepoProfile, Requirements, RunRecord, TaskDraft, TeamManifest } from "./types.js";

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

/**
 * .claude/atf-issues/ の Issue ドラフト(タスク)を読み、依存関係を抽出する(なければ空)。
 * 依存は `<!-- depends: draft-01, draft-02 -->` コメントで明示するのが第一。
 * コメントがないドラフトは、本文中で他ドラフトの ref(draft-01 など)に言及していれば
 * それを依存とみなす(issue-manager が本文で「draft-01 の上に」と書く運用に対応)。
 */
export function loadTaskDrafts(repoPath: string): TaskDraft[] {
  const issuesDir = join(repoPath, ".claude", "atf-issues");
  if (!existsSync(issuesDir)) return [];

  const raw = readdirSync(issuesDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => {
      const id = file.replace(/\.md$/, "");
      const content = readFileSync(join(issuesDir, file), "utf8");
      const title = content.match(/^#\s+(.+)$/m)?.[1].trim() ?? id;
      // ファイル名先頭の「英字列-数字列」を参照用の短い ID とする(例: draft-01)
      const ref = id.match(/^([A-Za-z]+-\d+)/)?.[1] ?? id;
      return { id, ref, file, title, content };
    });

  return raw.map(({ id, ref, file, title, content }) => {
    const explicit = content.match(/<!--\s*depends:\s*([^>]+?)\s*-->/);
    let dependsOn: string[];
    if (explicit) {
      dependsOn = explicit[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      // 本文が言及している他ドラフトの ref を依存とみなす
      dependsOn = raw
        .filter((other) => other.ref !== ref && content.includes(other.ref))
        .map((other) => other.ref);
    }
    return { id, ref, file, title, dependsOn };
  });
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

/** タスク(Issue ドラフト)依存関係の Mermaid フローチャートを組み立てる */
function buildTaskGraph(tasks: TaskDraft[]): string {
  const lines = ["flowchart TD"];
  for (const t of tasks) {
    // タイトルはエージェント由来の文字列なので必ずエスケープする
    lines.push(`  ${mermaidSafe(t.id)}["${escapeHtml(`${t.ref}: ${t.title}`)}"]`);
  }
  for (const t of tasks) {
    for (const depRef of t.dependsOn) {
      for (const dep of tasks.filter((o) => o.ref === depRef)) {
        lines.push(`  ${mermaidSafe(dep.id)} --> ${mermaidSafe(t.id)}`);
      }
    }
  }
  return lines.join("\n");
}

/** タスク依存関係セクション(ドラフトがなければ案内のみ) */
function buildTaskSection(tasks: TaskDraft[]): string {
  if (tasks.length === 0) {
    return `<p class="note">タスクドラフトはまだありません(issue-manager が <code>.claude/atf-issues/</code> に起案すると依存関係グラフが表示されます)。</p>`;
  }
  return `<pre class="mermaid">
${buildTaskGraph(tasks)}
</pre>
<p class="note">出典: <code>.claude/atf-issues/</code> の ${tasks.length} 件。矢印は「依存元 → 依存先(先に依存元を完了)」。依存は <code>&lt;!-- depends: draft-01 --&gt;</code> コメントまたは本文中の参照から抽出。</p>`;
}

/** teamSize → 表示用ラベル */
const TEAM_SIZE_LABEL: Record<string, string> = {
  minimal: "最小構成(最大 3 体)",
  standard: "標準構成(最大 5 体)",
  full: "フル構成(上限なし)",
};

/** タッチポイント → 表示用ラベル */
const TOUCHPOINT_LABEL: Record<string, string> = {
  "issue-approval": "Issue 着手前のユーザー承認",
  "pr-merge": "PR マージはユーザーが実行",
};

/** focus 値 → 表示用ラベル(hearing.ts の選択肢と対応) */
const FOCUS_LABEL: Record<string, string> = {
  quality: "コード品質・レビュー",
  security: "セキュリティ",
  speed: "開発スピード",
  testing: "テスト・QA",
  batch: "バッチ処理・データパイプライン",
  mobile: "モバイルアプリ",
  infra: "インフラ・運用基盤",
  docs: "ドキュメント",
  planning: "新規サービスの企画・検討",
};

/**
 * この実行環境に導入されている仕組みを、ハーネス / ガードレール / フィードバックループの
 * 3 要素に分類したカードを組み立てる。項目はマニフェストと実行記録から動的に導出し、
 * Issue 駆動が無効な場合は関連項目を「未導入」として薄く表示する。
 */
function buildMechanismSection(manifest: TeamManifest, runs: RunRecord[]): string {
  const issueDriven = manifest.requirements.issueDriven ?? false;
  const prFlow = manifest.requirements.prFlow ?? false;
  const touchpoints = manifest.requirements.touchpoints ?? [];
  const failureCount = runs.filter((r) => r.status === "failure").length;
  const flowCount = manifest.flow.filter(
    ([from, to]) =>
      manifest.agents.some((a) => a.name === from) && manifest.agents.some((a) => a.name === to),
  ).length;
  const teamSizeLabel = TEAM_SIZE_LABEL[manifest.requirements.teamSize] ?? manifest.requirements.teamSize;

  const item = (
    title: string,
    body: string,
    enabled = true,
    offLabel = "未導入(Issue 駆動を有効にすると追加)",
  ) =>
    enabled
      ? `<li><b>${title}</b> — ${body}</li>`
      : `<li class="off"><b>${title}</b> — ${body}<span class="off-label">${offLabel}</span></li>`;

  const harness = [
    item(
      "エージェント定義",
      `<code>.claude/agents/</code> に ${manifest.agents.length} 体。プリセット「${escapeHtml(manifest.presetName)}」を ${escapeHtml(manifest.project)} 向けにカスタマイズ`,
    ),
    item("入出力フロー", `エージェント間の受け渡し経路を ${flowCount} 本定義(下の構成図に対応)`),
    item("チームマニフェスト", `<code>.claude/team.json</code> がチーム構成の単一情報源(再生成・可視化の入力)`),
    item(
      "Issue 起点のタスク供給",
      `issue-manager が GitHub Issue${manifest.requirements.githubRepo ? `(${escapeHtml(manifest.requirements.githubRepo)})` : ""} を起票・整理し、各エージェントへ振り分け`,
      issueDriven,
    ),
    item(
      "PR ベースの変更フロー",
      `ブランチ作成 → push → <code>gh pr create</code> で変更を Pull Request 化(Issue 番号を紐付け)`,
      prFlow,
      "未導入(PR フローを有効にすると追加)",
    ),
  ];

  const guardrails = [
    item("役割スコープの限定", `各エージェントは定義された責務の範囲でのみ作業(構成は上のカード参照)`),
    item("チーム規模の上限", `${escapeHtml(teamSizeLabel)}でエージェント数を制御`),
    item("既存定義の保護", `導入時に既存の <code>.claude/agents/</code> を上書きしない(上書きは <code>--force</code> 必須)`),
    item(
      "Issue 起点の着手制限",
      `対応する Issue のない作業には着手せず、先に Issue の起票を提案`,
      issueDriven,
    ),
    item(
      "人間のタッチポイント",
      touchpoints.length > 0
        ? touchpoints.map((t) => escapeHtml(TOUCHPOINT_LABEL[t] ?? t)).join(" / ")
        : `設定なし(エージェントが最後まで自動で進める)`,
    ),
    item(
      "マージの実行主体",
      touchpoints.includes("pr-merge")
        ? `エージェントは PR 作成まで。マージはユーザーがレビューして実行`
        : `CI・レビュー通過を確認してエージェントがマージ(<code>gh pr merge</code>)`,
      prFlow,
      "未導入(PR フローを有効にすると追加)",
    ),
  ];

  const feedback = [
    item(
      "実行記録の自己申告",
      `全エージェントが作業完了時に <code>.claude/atf-logs/runs.jsonl</code> へ 1 行追記(現在 ${runs.length} 件)`,
    ),
    item("失敗の可視化", `status: failure の記録を実行記録テーブルに ❌ 表示(現在 ${failureCount} 件)`),
    item("ダッシュボード再生成", `<code>atf report</code> で最新の実行記録を反映した本ページを再生成`),
    item(
      "Issue へのトレース",
      `実行記録・コミットメッセージに Issue 番号を残し、進捗を Issue 上で追跡`,
      issueDriven,
    ),
    item(
      "PR へのトレース",
      `実行記録の outputs に PR の URL を残し、変更を PR 単位でレビュー・追跡`,
      prFlow,
      "未導入(PR フローを有効にすると追加)",
    ),
  ];

  return `<div class="mechanisms">
  <div class="mech mech-harness">
    <h3>🛠 ハーネス</h3>
    <p class="mech-sub">エージェントを動かす骨組み</p>
    <ul>
${harness.join("\n")}
    </ul>
  </div>
  <div class="mech mech-guardrail">
    <h3>🚧 ガードレール</h3>
    <p class="mech-sub">逸脱を防ぐ制約</p>
    <ul>
${guardrails.join("\n")}
    </ul>
  </div>
  <div class="mech mech-feedback">
    <h3>🔄 フィードバックループ</h3>
    <p class="mech-sub">結果を観測して改善につなげる仕組み</p>
    <ul>
${feedback.join("\n")}
    </ul>
  </div>
</div>`;
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

/** チーム構成 + タスク依存関係 + 実行記録を可視化する自己完結 HTML を組み立てる */
export function buildDashboardHtml(
  manifest: TeamManifest,
  runs: RunRecord[],
  tasks: TaskDraft[] = [],
): string {
  const issueDriven = manifest.requirements.issueDriven ?? false;
  const prFlow = manifest.requirements.prFlow ?? false;
  const touchpoints = manifest.requirements.touchpoints ?? [];
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
  .note { color: #888; font-size: .8rem; }
  .note code { background: #eeeefa; border-radius: 3px; padding: 0 .3rem; }
  .badge { background: #3b3b8f; color: #fff; border-radius: 4px; padding: .1rem .5rem; font-size: .8rem; }
  .mermaid { background: #fafaff; border: 1px solid #e0e0ef; border-radius: 8px; padding: 1rem; }
  .bar-row { display: flex; align-items: center; gap: .6rem; margin: .3rem 0; }
  .bar-label { width: 160px; font-size: .85rem; text-align: right; }
  .bar { height: 16px; background: #6c6cd9; border-radius: 3px; min-width: 2px; }
  .bar-count { font-size: .85rem; color: #666; }
  .mechanisms { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem; }
  .mech { border: 1px solid #e0e0ef; border-top: 4px solid #999; border-radius: 8px; padding: 1rem; background: #fafaff; }
  .mech-harness { border-top-color: #3b3b8f; }
  .mech-guardrail { border-top-color: #d98a2b; }
  .mech-feedback { border-top-color: #2b9d5c; }
  .mech h3 { margin: 0; font-size: 1rem; }
  .mech-sub { margin: .2rem 0 .6rem; font-size: .8rem; color: #888; }
  .mech ul { margin: 0; padding-left: 1.2rem; }
  .mech li { font-size: .85rem; line-height: 1.6; margin-bottom: .5rem; }
  .mech li.off { color: #aaa; }
  .mech li.off b { color: #aaa; }
  .off-label { display: block; font-size: .75rem; color: #bbb; }
  .mech code { background: #eeeefa; border-radius: 3px; padding: 0 .3rem; font-size: .8rem; }
</style>
</head>
<body>
<h1>${escapeHtml(manifest.project)} — ${escapeHtml(manifest.presetName)}</h1>
<p class="meta">
  <span>プリセット: ${escapeHtml(manifest.preset)}</span>
  <span>フェーズ: ${escapeHtml(manifest.requirements.phase)}</span>
  <span>重視観点: ${escapeHtml(manifest.requirements.focus.join(", "))}</span>
  <span>開発スタイル: ${issueDriven ? "Issue 駆動" : "通常"}</span>
  <span>PR フロー: ${prFlow ? (touchpoints.includes("pr-merge") ? "あり(マージ: ユーザー)" : "あり(マージ: エージェント)") : "なし"}</span>
  <span>タッチポイント: ${touchpoints.length > 0 ? escapeHtml(touchpoints.map((t) => TOUCHPOINT_LABEL[t] ?? t).join(" / ")) : "なし"}</span>
  <span>GitHub: ${escapeHtml(manifest.requirements.githubRepo ?? "(未設定)")}</span>
  <span>実行記録: ${runs.length} 件</span>
</p>

<h2>実行環境の仕組み</h2>
${buildMechanismSection(manifest, runs)}

<h2>チーム構成・入出力フロー</h2>
<pre class="mermaid">
${buildFlowChart(manifest)}
</pre>

<h2>エージェント</h2>
<div class="cards">
${agentCards}
</div>

<h2>タスク依存関係</h2>
${buildTaskSection(tasks)}

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

/** 開発フロー(Issue → ブランチ → 実装 → PR → マージ)の Mermaid チャートを組み立てる */
function buildDevFlowChart(requirements: Requirements): string {
  const issueDriven = requirements.issueDriven ?? false;
  const prFlow = requirements.prFlow ?? false;

  const nodes: { id: string; label: string; touchpoint?: boolean }[] = [];
  if (issueDriven) {
    nodes.push({ id: "issue", label: "Issue 起票", touchpoint: true });
  }
  if (prFlow) {
    nodes.push({ id: "branch", label: "ブランチ作成" });
  }
  nodes.push({ id: "impl", label: "実装・テスト" });
  if (prFlow) {
    nodes.push({ id: "pr", label: "PR 作成" });
    nodes.push({ id: "merge", label: "マージ", touchpoint: true });
  } else {
    nodes.push({ id: "commit", label: "コミット" });
  }

  const lines = ["flowchart LR"];
  for (const n of nodes) {
    lines.push(`  ${n.id}["${n.label}${n.touchpoint ? "<br/>(タッチポイント候補)" : ""}"]`);
  }
  for (let i = 0; i + 1 < nodes.length; i++) {
    lines.push(`  ${nodes[i].id} --> ${nodes[i + 1].id}`);
  }
  const touchIds = nodes.filter((n) => n.touchpoint).map((n) => n.id);
  if (touchIds.length > 0) {
    lines.push("  classDef touch fill:#fff3d6,stroke:#d98a2b;");
    lines.push(`  class ${touchIds.join(",")} touch`);
  }
  return lines.join("\n");
}

/**
 * チーム構築時にユーザーへ確認を促す開発フロープレビュー HTML を組み立てる。
 * 重視観点・開発フロー(ブランチ / Issue / PR がどのように作成されるか)・
 * チーム構成(予定)・タッチポイント候補を提示し、このあと CLI で
 * 人間のタッチポイントをどこに設けるかを問い合わせる前提の資料となる。
 */
export function buildFlowPreviewHtml(
  preset: Preset,
  profile: RepoProfile,
  requirements: Requirements,
): string {
  const issueDriven = requirements.issueDriven ?? false;
  const prFlow = requirements.prFlow ?? false;
  const repo = requirements.githubRepo;
  const repoFlag = repo ? ` -R ${escapeHtml(repo)}` : "";

  const focusItems = requirements.focus
    .map((f) => `<li><b>${escapeHtml(FOCUS_LABEL[f] ?? f)}</b><span class="focus-raw">(${escapeHtml(f)})</span></li>`)
    .join("\n");

  const artifactRows = [
    [
      "Issue",
      issueDriven
        ? `issue-manager が <code>gh issue create${repoFlag}</code> で起票(タイトル・背景・完了条件を明記)。各エージェントは Issue 番号を確認してから着手`
        : "Issue 駆動は無効(ユーザーからの直接依頼を起点に作業)",
    ],
    [
      "ブランチ",
      prFlow
        ? `作業単位ごとに <code>feature/issue-&lt;番号&gt;-&lt;要約&gt;</code> 形式で作成。デフォルトブランチでは直接作業しない`
        : "PR フローが無効のためブランチ運用の指示なし(デフォルトブランチで作業)",
    ],
    [
      "PR",
      prFlow
        ? `ブランチを push 後、<code>gh pr create${repoFlag}</code> で作成。本文の <code>Closes #&lt;番号&gt;</code> で Issue に紐付け`
        : "PR フローは無効(PR は作成しない)",
    ],
    [
      "マージ",
      prFlow
        ? `<b>このあとのタッチポイント選択で決定</b>: ユーザーがレビューしてマージする / エージェントが CI・レビュー通過を確認して <code>gh pr merge</code> まで実行する`
        : "対象外",
    ],
  ]
    .map(([k, v]) => `    <tr><th>${k}</th><td>${v}</td></tr>`)
    .join("\n");

  const teamChart =
    preset.flow && preset.flow.length > 0
      ? `<pre class="mermaid">
flowchart LR
${preset.flow.map(([from, to]) => `  ${mermaidSafe(from)}["${escapeHtml(from)}"] --> ${mermaidSafe(to)}["${escapeHtml(to)}"]`).join("\n")}
</pre>`
      : `<p class="note">このプリセットにはフロー定義がありません。エージェント: ${preset.agents.map((a) => escapeHtml(a.replace(/\.md$/, ""))).join(", ")}</p>`;

  const touchpointCandidates = [
    issueDriven
      ? `<li><b>Issue 着手前</b> — エージェントが起票した Issue をユーザーが確認・承認してから実装に着手する</li>`
      : "",
    prFlow
      ? `<li><b>PR マージ</b> — エージェントは PR 作成まで。マージはユーザーがレビューして実行する(未選択ならエージェントがマージまで自動実行)</li>`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${escapeHtml(profile.name)} — 開発フロープレビュー</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<style>
  body { font-family: -apple-system, "Hiragino Sans", sans-serif; margin: 2rem auto; max-width: 900px; padding: 0 1rem; color: #1a1a2e; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 2px solid #e0e0ef; padding-bottom: .4rem; }
  .meta { color: #666; font-size: .9rem; }
  .meta span { margin-right: 1.2rem; }
  .mermaid { background: #fafaff; border: 1px solid #e0e0ef; border-radius: 8px; padding: 1rem; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { border: 1px solid #e0e0ef; padding: .5rem .7rem; text-align: left; vertical-align: top; }
  th { background: #f0f0fa; width: 7rem; }
  ul { line-height: 1.9; }
  code { background: #eeeefa; border-radius: 3px; padding: 0 .3rem; }
  .note { color: #888; font-size: .85rem; }
  .focus-raw { color: #999; font-size: .8rem; margin-left: .4rem; }
  .next { background: #fff3d6; border: 1px solid #d98a2b; border-radius: 8px; padding: .8rem 1rem; font-size: .9rem; }
</style>
</head>
<body>
<h1>${escapeHtml(profile.name)} — 開発フロープレビュー</h1>
<p class="meta">
  <span>プリセット: ${escapeHtml(preset.name)}</span>
  <span>フェーズ: ${escapeHtml(requirements.phase)}</span>
  <span>開発スタイル: ${issueDriven ? "Issue 駆動" : "通常"}</span>
  <span>PR フロー: ${prFlow ? "あり" : "なし"}</span>
  <span>GitHub: ${escapeHtml(repo ?? "(未設定)")}</span>
</p>

<h2>重視している観点</h2>
<ul>
${focusItems}
</ul>

<h2>開発フロー(Issue・ブランチ・PR がどのように作成されるか)</h2>
<pre class="mermaid">
${buildDevFlowChart(requirements)}
</pre>
<table>
  <tbody>
${artifactRows}
  </tbody>
</table>

<h2>チーム構成(予定)</h2>
${teamChart}

<h2>人間のタッチポイント候補</h2>
${touchpointCandidates ? `<ul>\n${touchpointCandidates}\n</ul>` : `<p class="note">Issue 駆動・PR フローがともに無効のため、選択できるタッチポイントはありません。</p>`}
<p class="next">このプレビューを確認したら CLI に戻ってください。人間のタッチポイントをどこに設けるかを続けて質問します。選択しない場合、エージェントがマージまで自動で進めます。</p>

<script>mermaid.initialize({ startOnLoad: true, theme: "neutral" });</script>
</body>
</html>
`;
}
