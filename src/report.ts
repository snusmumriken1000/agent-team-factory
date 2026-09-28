import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  isSatisfied,
  latestSpecCheck,
  specGateStatus,
  tagValues,
  SPEC_RESULT_LABEL,
} from "./alloy.js";
import {
  ARCH_RESULT_LABEL,
  ARCH_RULE_KIND_LABEL,
  archGateStatus,
  isArchPass,
  latestArchCheck,
  loadArchChecks,
  loadArchRules,
} from "./arch.js";
import {
  agentEvalStatuses,
  criteriaFor,
  criterionPassScore,
  defaultNextActions,
  EVAL_VERDICT_LABEL,
  evalGateStatus,
  evalTargetNames,
  hasNextActions,
  isEvalPass,
  latestEvaluations,
  loadEvaluations,
  loadRubric,
  nextActionItems,
  ownNextActions,
  passScoreOf,
  thresholdMismatches,
  totalScore,
} from "./evaluate.js";
import { REVERSE_DOC_KIND_LABEL, reverseDocStatuses } from "./reverse.js";
import { isAdoptable, VERDICT_LABEL } from "./capabilities.js";
import { resolveSkills, SKILL_CATEGORY_LABEL } from "./skills.js";
import { formatTechStack, loadTechStackCatalog } from "./techstack.js";
import type {
  ArchCheckRecord,
  ArchResult,
  ArchRuleSet,
  CapabilityFinding,
  CapabilityPlan,
  EvalVerdict,
  EvaluationRecord,
  InstalledSkill,
  Preset,
  RepoProfile,
  Requirements,
  ReverseDocStatus,
  Rubric,
  RunRecord,
  SpecCheckRecord,
  SpecDecisionRecord,
  SpecModel,
  SpecResult,
  TaskDraft,
  TeamManifest,
  TechStack,
} from "./types.js";

/** ダッシュボードに渡すルーブリック評価の状態(評価基準 + 評価記録) */
export interface EvaluationState {
  rubric?: Rubric;
  records: EvaluationRecord[];
}

/** ルーブリックと評価記録をまとめて読む(ダッシュボードを生成するすべての入口で同じ状態を使う) */
export function loadEvaluationState(repoPath: string): EvaluationState {
  return { rubric: loadRubric(repoPath), records: loadEvaluations(repoPath) };
}

/** ダッシュボードに渡すアーキテクチャ関連の状態(リバースドキュメント + 規約 + 検証記録) */
export interface ArchitectureState {
  docs: ReverseDocStatus[];
  rules?: ArchRuleSet;
  checks: ArchCheckRecord[];
}

/**
 * リバースドキュメントの記録とアーキテクチャ規約・検証記録をまとめて読む。
 * ダッシュボードを生成するすべての入口(init / report / apply)で同じ状態を使う。
 */
export function loadArchitectureState(repoPath: string): ArchitectureState {
  return {
    docs: reverseDocStatuses(repoPath),
    rules: loadArchRules(repoPath),
    checks: loadArchChecks(repoPath),
  };
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

/** Issue ドラフト(起案段階のタスク)の置き場 */
export function issuesDir(repoPath: string): string {
  return join(repoPath, ".claude", "atf-issues");
}

/**
 * .claude/atf-issues/ の Issue ドラフト(タスク)を読み、依存関係を抽出する(なければ空)。
 * 依存は `<!-- depends: draft-01, draft-02 -->` コメントで明示するのが第一。
 * コメントがないドラフトは、本文中で他ドラフトの ref(draft-01 など)に言及していれば
 * それを依存とみなす(issue-manager が本文で「draft-01 の上に」と書く運用に対応)。
 */
export function loadTaskDrafts(repoPath: string): TaskDraft[] {
  const dir = issuesDir(repoPath);
  if (!existsSync(dir)) return [];

  const raw = readdirSync(dir)
    // README.md は atf が置く書式ガイド。ドラフトではないので数えない
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((file) => {
      const id = file.replace(/\.md$/, "");
      const content = readFileSync(join(dir, file), "utf8");
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

/**
 * ダッシュボードとフロープレビューで共有するスタイル(minimalist-ui スキルに沿う)。
 * ウォームモノクロ + 1px 罫線 + 余白でコントラストを作り、
 * 影・グラデーション・外部フォント・絵文字は使わない(印刷とオフラインでも崩れないため)。
 * 状態の色は「淡いパステル背景 + 濃い同系色の文字」で統一する(--red / --blue / --green / --yellow)。
 */
const BASE_STYLE = `  :root {
    color-scheme: light;
    --canvas: #f7f6f3; --surface: #fff; --surface-alt: #f9f9f8;
    --line: #eaeaea; --ink: #2f3437; --ink-strong: #111; --muted: #787774; --faint: #9b9a95;
    --red-bg: #fdebec; --red-ink: #9f2f2d;
    --blue-bg: #e1f3fe; --blue-ink: #1f6c9f;
    --green-bg: #edf3ec; --green-ink: #346538;
    --yellow-bg: #fbf3db; --yellow-ink: #956400;
    --sans: ui-sans-serif, -apple-system, "SF Pro Text", "Helvetica Neue", "Hiragino Sans", "Yu Gothic UI", sans-serif;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body { font-family: var(--sans); margin: 0 auto; padding: 5rem 2rem 7rem; min-height: 100vh; background: var(--canvas); color: var(--ink); line-height: 1.7; -webkit-font-smoothing: antialiased; }
  body::before { content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none; background: radial-gradient(52rem 34rem at 10% -8%, rgba(149,100,0,.05), transparent 70%); }
  h1 { margin: 0; color: var(--ink-strong); font-size: clamp(1.8rem, 4vw, 2.5rem); font-weight: 600; line-height: 1.15; letter-spacing: -.03em; }
  h1::before { display: block; margin-bottom: .9rem; color: var(--muted); font-family: var(--mono); font-size: .7rem; letter-spacing: .18em; }
  h2 { margin: 4rem 0 1.2rem; padding-top: 1.7rem; border-top: 1px solid var(--line); color: var(--ink-strong); font-size: 1.05rem; font-weight: 600; letter-spacing: -.01em; }
  h3 { margin: 2.4rem 0 .8rem; color: var(--ink-strong); font-size: .92rem; font-weight: 600; }
  .meta { display: flex; flex-wrap: wrap; gap: .4rem; margin: 1.5rem 0 0; color: var(--muted); font-size: .8rem; }
  .meta span { display: inline-flex; align-items: center; min-height: 1.9rem; padding: .18rem .7rem; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); }
  .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
  table { width: 100%; border-spacing: 0; font-size: .84rem; }
  th, td { border-bottom: 1px solid var(--line); padding: .8rem .9rem; text-align: left; vertical-align: top; }
  th { background: var(--surface-alt); color: var(--muted); font-family: var(--mono); font-size: .72rem; font-weight: 500; letter-spacing: .05em; }
  td:first-child { white-space: nowrap; }
  td code { overflow-wrap: break-word; }
  tr:last-child th, tr:last-child td { border-bottom: 0; }
  tbody tr:hover td { background: #fbfbfa; }
  code { border-radius: 4px; padding: .08rem .38rem; background: var(--blue-bg); color: var(--blue-ink); font-family: var(--mono); font-size: .82rem; }
  a { color: var(--blue-ink); text-underline-offset: .2em; }
  ul { padding-left: 1.2rem; }
  li::marker { color: var(--faint); }
  .note { color: var(--muted); font-size: .82rem; }
  .empty { padding: 1.6rem; color: var(--faint); text-align: center; }
  .mermaid { overflow-x: auto; margin: 0; border: 1px solid var(--line); border-radius: 12px; padding: 1.75rem; background: var(--surface); }
  .chip { display: inline-flex; align-items: center; border-radius: 999px; padding: .12rem .62rem; background: var(--surface-alt); color: var(--muted); font-family: var(--mono); font-size: .73rem; letter-spacing: .03em; white-space: nowrap; }
  .chip-ok { background: var(--green-bg); color: var(--green-ink); box-shadow: inset 0 0 0 1px rgba(52,101,56,.25); }
  .chip-ng { background: var(--red-bg); color: var(--red-ink); box-shadow: inset 0 0 0 1px rgba(159,47,45,.25); }
  .chip-warn { background: var(--yellow-bg); color: var(--yellow-ink); box-shadow: inset 0 0 0 1px rgba(149,100,0,.25); }
  .reveal { opacity: 0; transform: translateY(12px); }
  .reveal-in { opacity: 1; transform: none; transition: opacity .6s cubic-bezier(.16,1,.3,1), transform .6s cubic-bezier(.16,1,.3,1); transition-delay: calc(var(--index, 0) * 80ms); }
  @media (max-width: 700px) { body { padding: 3rem 1.1rem 4.5rem; } h2 { margin-top: 3rem; } .meta span { width: 100%; } }
  @media print { body { max-width: none; padding: 0; background: #fff; } body::before { display: none; } .reveal { opacity: 1; transform: none; } .card, .mech, .mermaid, .table-wrap, .meta { break-inside: avoid; } }`;

/** ページ固有のスタイルを足して <style> ブロックにする(eyebrow = h1 の上に出す小見出し) */
function pageStyle(eyebrow: string, extra: string): string {
  return `<style>
${BASE_STYLE}
  h1::before { content: "${eyebrow}"; }
${extra}
</style>`;
}

/** Mermaid の初期化(図の配色も本文のウォームモノクロに合わせる) */
const MERMAID_INIT = `<script>mermaid.initialize({ startOnLoad: true, theme: "base", themeVariables: { primaryColor: "#f9f9f8", primaryTextColor: "#2f3437", primaryBorderColor: "#d9d8d4", secondaryColor: "#f7f6f3", tertiaryColor: "#ffffff", lineColor: "#a5a39e", fontSize: "13px", fontFamily: "ui-sans-serif, -apple-system, 'Helvetica Neue', 'Hiragino Sans', sans-serif" } });</script>`;

/**
 * 主要ブロックに控えめなフェードインを付ける。
 * クラスは JS が付けるので、JS が動かない・動きを減らす設定のときは静止したまま表示される。
 * スクロール連動にはしない(ページ全体のスクリーンショットや PDF 保存で
 * 画面外のブロックが未表示のまま写るため)。読み込み直後に順番に現れて終わる。
 */
const REVEAL_SCRIPT = `<script>
(function () {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var blocks = Array.prototype.filter.call(document.body.children, function (el) {
    return !/^(H1|SCRIPT|STYLE)$/.test(el.tagName);
  });
  blocks.forEach(function (el) { el.classList.add("reveal"); });
  requestAnimationFrame(function () {
    blocks.forEach(function (el, i) {
      el.style.setProperty("--index", Math.min(i, 10));
      el.classList.add("reveal-in");
    });
  });
})();
</script>`;

/** ダッシュボード固有のスタイル */
const DASHBOARD_STYLE = `  body { max-width: 1120px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(268px, 1fr)); gap: .9rem; }
  .card, .mech { border: 1px solid var(--line); border-radius: 12px; padding: 1.5rem; background: var(--surface); transition: box-shadow .2s ease; }
  .card:hover, .mech:hover { box-shadow: 0 2px 8px rgba(0,0,0,.04); }
  .card h3 { margin: 0 0 .5rem; font-size: .95rem; }
  .card p { margin: 0; color: var(--muted); font-size: .85rem; line-height: 1.75; }
  .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: .12rem .62rem; background: var(--blue-bg); color: var(--blue-ink); font-family: var(--mono); font-size: .73rem; letter-spacing: .03em; white-space: nowrap; }
  .bar-row { display: grid; grid-template-columns: minmax(100px, 165px) minmax(40px, 1fr) 2rem; align-items: center; gap: .8rem; margin: .6rem 0; }
  .bar-label { overflow: hidden; color: var(--muted); font-size: .82rem; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
  .bar { height: 8px; min-width: 2px; border-radius: 2px; background: var(--ink); }
  .bar-count { color: var(--muted); font-family: var(--mono); font-size: .78rem; font-variant-numeric: tabular-nums; }
  .mechanisms { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: .9rem; }
  .mech { padding-top: 1.4rem; border-top-width: 2px; }
  .mech-harness { border-top-color: var(--blue-ink); }
  .mech-guardrail { border-top-color: var(--yellow-ink); }
  .mech-feedback { border-top-color: var(--green-ink); }
  .mech h3 { margin: 0; font-size: .95rem; }
  .mech-sub { margin: .2rem 0 .9rem; color: var(--faint); font-size: .78rem; }
  .mech ul { margin: 0; padding-left: 1.1rem; }
  .mech li { margin-bottom: .55rem; font-size: .84rem; line-height: 1.7; }
  .mech li.off, .mech li.off b { color: var(--faint); }
  .off-label { display: block; color: var(--faint); font-size: .73rem; }
  .gate { margin: 0 0 .9rem; border: 1px solid var(--line); border-left: 3px solid var(--faint); border-radius: 8px; padding: .85rem 1.1rem; background: var(--surface); font-size: .87rem; }
  .gate-ok { border-color: rgba(52,101,56,.22); border-left-color: var(--green-ink); background: var(--green-bg); color: var(--green-ink); }
  .gate-ng { border-color: rgba(159,47,45,.22); border-left-color: var(--red-ink); background: var(--red-bg); color: var(--red-ink); }
  .gate-todo { border-color: rgba(149,100,0,.22); border-left-color: var(--yellow-ink); background: var(--yellow-bg); color: var(--yellow-ink); }
  .informal { margin: .4rem 0 0; padding-left: 1.2rem; color: var(--muted); font-size: .84rem; }
  tbody tr.spec-ng td, tbody tr.arch-ng td, tbody tr.doc-ng td, tbody tr.eval-ng td { background: var(--red-bg); }
  tbody tr.cap-ok td { background: var(--green-bg); }
  tbody tr.cap-hold td { background: var(--yellow-bg); }
  tbody tr.cap-ng td, tbody tr.spec-todo td, tbody tr.arch-todo td, tbody tr.eval-todo td { color: var(--muted); }
  code.missing { background: var(--red-bg); color: var(--red-ink); text-decoration: line-through; }
  @media (max-width: 700px) { .bar-row { grid-template-columns: 90px minmax(40px, 1fr) 1.6rem; } }`;

/** フロープレビュー固有のスタイル */
const FLOW_PREVIEW_STYLE = `  body { max-width: 940px; }
  table { margin-top: 1rem; font-size: .86rem; }
  th { width: 7rem; }
  ul { line-height: 1.95; }
  .focus-raw { margin-left: .45rem; color: var(--faint); font-family: var(--mono); font-size: .76rem; }
  .next { margin-top: 3rem; border: 1px solid rgba(149,100,0,.22); border-radius: 8px; padding: 1.1rem 1.2rem; background: var(--yellow-bg); color: var(--yellow-ink); font-size: .87rem; }
  .next::before { content: "NEXT"; display: block; margin-bottom: .4rem; font-family: var(--mono); font-size: .68rem; letter-spacing: .16em; opacity: .75; }`;

/** 状態ラベルの先頭に付く絵文字(ターミナル表示と共用のため定義側には残す) */
const STATUS_EMOJI = /^[^\p{L}\p{N}(]+/u;

/**
 * 状態をチップで表示する。ラベルは CLI と共用で先頭に絵文字が付くため、
 * HTML では絵文字を落とし、色(tone)で状態を示す。
 */
function chip(label: string, tone: "ok" | "ng" | "warn" | "idle" = "idle"): string {
  const text = label.replace(STATUS_EMOJI, "").trim();
  return `<span class="chip${tone === "idle" ? "" : ` chip-${tone}`}">${escapeHtml(text)}</span>`;
}

/** 形式仕様の検証結果 → チップの色(実行エラー・判定不能は違反と分けて警告色にする) */
const specTone = (result: SpecResult): "ok" | "ng" | "warn" =>
  isSatisfied(result) ? "ok" : result === "error" || result === "unknown" ? "warn" : "ng";

/** アーキテクチャ検証結果 → チップの色 */
const evalTone = (verdict: EvalVerdict): "ok" | "ng" | "warn" =>
  verdict === "pass" ? "ok" : verdict === "revise" ? "warn" : "ng";

const archTone = (result: ArchResult): "ok" | "ng" | "warn" =>
  isArchPass(result) ? "ok" : result === "violation" ? "ng" : "warn";

/**
 * 表を横スクロールできるラッパで包む。
 * 列の多い表(リバースドキュメントなど)でパスを途中で折らずに見せつつ、
 * ページ全体が横スクロールしないようにする。ページ組み立ての最後に 1 回だけ通す。
 */
const wrapTables = (html: string): string =>
  html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");


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

/** モデル + コマンドに対する最新の検証記録(checks.jsonl は追記順とみなし、最後の 1 件を採用) */
/** ダッシュボードに渡す形式仕様の状態(alloy.ts の loadSpecState が作る) */
export interface SpecState {
  models: SpecModel[];
  checks: SpecCheckRecord[];
  /** 反例から自動確定した仕様の記録(なければ空) */
  decisions?: SpecDecisionRecord[];
}

/** 形式仕様(Alloy)セクション: 形式化した要件・検証コマンド・最新結果・非形式要件 */
export function buildSpecSection(
  models: SpecModel[],
  checks: SpecCheckRecord[],
  decisions: SpecDecisionRecord[] = [],
): string {
  if (models.length === 0) {
    return `<p class="note">Alloy モデルはまだありません(spec-formalizer が <code>spec/*.als</code> に仕様を書くと、要件と検証結果がここに表示されます)。</p>`;
  }

  const rows: string[] = [];
  // ゲートの集計は alloy.ts(CLI・解説 HTML と共通)。行の描画だけここで行う
  const { satisfied, unsatisfied: violated, unchecked, state } = specGateStatus(models, checks);

  for (const model of models) {
    const reqText = new Map(model.requirements.map((r) => [r.id, r.text]));
    if (model.commands.length === 0) {
      rows.push(`<tr>
        <td><code>${escapeHtml(model.file)}</code></td>
        <td colspan="3" class="note">検証コマンド(check / run)が定義されていません</td>
        <td>${chip("未検証")}</td><td>-</td>
      </tr>`);
      continue;
    }
    for (const cmd of model.commands) {
      const check = latestSpecCheck(checks, model.file, cmd.name);
      const resultCell = check
        ? `${chip(SPEC_RESULT_LABEL[check.result] ?? check.result, specTone(check.result))}${check.detail ? `<br><span class="note">${escapeHtml(check.detail)}</span>` : ""}`
        : chip("未検証");
      const requirement =
        cmd.requirements.length > 0
          ? cmd.requirements
              .map((id) => `<b>${escapeHtml(id)}</b> ${escapeHtml(reqText.get(id) ?? "")}`)
              .join("<br>")
          : `<span class="note">(@req なし)</span>`;
      rows.push(`<tr class="${check ? (isSatisfied(check.result) ? "spec-ok" : "spec-ng") : "spec-todo"}">
        <td><code>${escapeHtml(model.file)}</code></td>
        <td>${requirement}</td>
        <td><code>${escapeHtml(cmd.kind)} ${escapeHtml(cmd.name)}</code>${cmd.scope ? ` <span class="note">${escapeHtml(cmd.scope)}</span>` : ""}</td>
        <td>${cmd.kind === "check" ? "表明の反証探索" : "充足可能性"}</td>
        <td>${resultCell}</td>
        <td>${escapeHtml(check?.checkedAt ?? "-")}</td>
      </tr>`);
    }
  }

  // 意図的に扱わない範囲(ルートモジュールの @out-of-scope)
  const outOfScope = models.flatMap((m) =>
    tagValues(m.doc, "out-of-scope").map((text) => ({ file: m.file, text })),
  );
  const informalBlock =
    outOfScope.length > 0
      ? `<p class="note">意図的に扱わない範囲(<code>@out-of-scope</code>)— レビュー・テストで担保する:</p>
<ul class="informal">
${outOfScope.map((i) => `  <li>${escapeHtml(i.text)} <span class="note">(${escapeHtml(i.file)})</span></li>`).join("\n")}
</ul>`
      : "";

  const gate =
    state === "fail"
      ? `<p class="gate gate-ng">実装前ゲート: <b>未通過</b> — 反例・充足不能・実行エラーが ${violated} 件あります。仕様(.als)を修正して再検証するまで実装に進みません。</p>`
      : state === "pending"
        ? `<p class="gate gate-todo">実装前ゲート: <b>未確認</b> — 未検証の検証コマンドが ${unchecked} 件あります(<code>bash atf-bin/formal.sh</code> で検証してください)。</p>`
        : `<p class="gate gate-ok">実装前ゲート: <b>通過</b> — ${satisfied} 件の検証コマンドがすべて充足しています。</p>`;

  return `${gate}
<table>
  <thead>
    <tr><th>モデル</th><th>要件</th><th>コマンド</th><th>検証の種類</th><th>最新結果</th><th>検証時刻</th></tr>
  </thead>
  <tbody>
${rows.join("\n")}
  </tbody>
</table>
${informalBlock}
${buildSpecExplainLinks(models)}
${buildSpecDecisionBlock(decisions)}
<p class="note">出典: <code>spec/*.als</code>(モデル ${models.length} 件 / 検証記録 ${checks.length} 件)。要件は doc comment の <code>@req</code>、結果は <code>.claude/atf-formal/checks.jsonl</code> の最新行から抽出。</p>`;
}

/** モデルごとの解説ページ(.als から生成した HTML)へのリンク */
function buildSpecExplainLinks(models: SpecModel[]): string {
  if (models.length === 0) return "";
  const links = models
    .map((m) => {
      const href = `../docs/generated/${encodeURI(m.file.replace(/\.als$/, ""))}.explain.html`;
      return `<li><a href="${href}">${escapeHtml(m.file)} の解説</a> <span class="note">要件 ${m.requirements.length} 件 / 検証コマンド ${m.commands.length} 件</span></li>`;
    })
    .join("\n");
  return `<p class="note">モデルごとの解説ページ(数式の意味と検証状況を日本語でまとめたもの。<code>bash atf-bin/weave.sh</code> が <code>docs/generated/</code> に生成):</p>
<ul>
${links}
</ul>`;
}

/** 反例から確定した仕様(decisions.jsonl)の表。未確認のものは警告色で出す */
function buildSpecDecisionBlock(decisions: SpecDecisionRecord[]): string {
  if (decisions.length === 0) return "";
  const rows = decisions
    .slice()
    .reverse()
    .map((d) => {
      const status = d.status ?? "auto";
      const label =
        status === "confirmed" ? "確認済み" : status === "reverted" ? "差し戻し" : "未確認";
      return `<tr>
        <td>${chip(label, status === "confirmed" ? "ok" : status === "reverted" ? "ng" : "warn")}<br><span class="note">${escapeHtml(d.decidedAt ?? "-")}</span></td>
        <td><b>${escapeHtml(d.requirement)}</b>${d.model ? `<br><span class="note">${escapeHtml(d.model)}</span>` : ""}</td>
        <td>${escapeHtml(d.decision)}<br><span class="note">${escapeHtml(d.finding)}</span></td>
        <td>${escapeHtml(d.rationale)}${d.alternatives?.length ? `<br><span class="note">採らなかった案: ${escapeHtml(d.alternatives.join(" / "))}</span>` : ""}</td>
        <td>${d.changed?.length ? d.changed.map((c) => `<code>${escapeHtml(c)}</code>`).join("<br>") : `<span class="note">-</span>`}</td>
      </tr>`;
    })
    .join("\n");
  const unconfirmed = decisions.filter((d) => (d.status ?? "auto") === "auto").length;
  return `<p class="note">反例から確定した仕様(<code>decisions.jsonl</code>)— ${decisions.length} 件のうち<b>ユーザー未確認 ${unconfirmed} 件</b>。覆すときは新しい行を追記します(履歴は消しません):</p>
<table>
  <thead>
    <tr><th>状態</th><th>要件</th><th>採用した仕様 / 検出</th><th>根拠</th><th>直したファイル</th></tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

/** 採否の表示順(組み込めるものから並べる) */
const VERDICT_ORDER: Record<string, number> = { adopt: 0, trial: 1, hold: 2, reject: 3 };

/**
 * 最新機能の取り込みセクション: 調査した機能の採否を **1 つの表**にまとめる。
 * 組み込めるもの・組み込めないものを分けずに並べるのは、見比べられること自体が
 * 調査の価値だから(capability-scout にも同じ規約を指示している)。
 */
export function buildCapabilitySection(
  findings: CapabilityFinding[],
  plans: CapabilityPlan[] = [],
): string {
  if (findings.length === 0) {
    return `<p class="note">最新機能の調査結果はまだありません(capability-scout が <code>.claude/atf-capabilities/findings.jsonl</code> に記録すると、組み込めるもの / 組み込めないものの採否表がここに表示されます)。</p>`;
  }

  const planFiles = new Set(plans.map((p) => p.file));
  const sorted = findings
    .slice()
    .sort(
      (a, b) =>
        (VERDICT_ORDER[a.verdict] ?? 9) - (VERDICT_ORDER[b.verdict] ?? 9) ||
        a.product.localeCompare(b.product) ||
        a.name.localeCompare(b.name),
    );

  const rows = sorted
    .map((f) => {
      const adoptable = isAdoptable(f.verdict);
      const planCell = f.plan
        ? planFiles.has(f.plan)
          ? `<a href="atf-capabilities/${encodeURI(f.plan)}">${escapeHtml(f.plan)}</a>`
          : `${escapeHtml(f.plan)} <span class="note">(未作成)</span>`
        : adoptable
          ? `<span class="note">未作成</span>`
          : "-";
      const nameCell = f.docUrl
        ? `<a href="${escapeHtml(f.docUrl)}">${escapeHtml(f.name)}</a>`
        : escapeHtml(f.name);
      return `<tr class="${adoptable ? "cap-ok" : f.verdict === "reject" ? "cap-ng" : "cap-hold"}">
        <td>${chip(VERDICT_LABEL[f.verdict] ?? f.verdict, adoptable ? "ok" : f.verdict === "reject" ? "ng" : "warn")}</td>
        <td>${escapeHtml(f.product)}</td>
        <td>${nameCell}<br><span class="note">${escapeHtml(f.summary)}</span></td>
        <td>${escapeHtml(f.reason)}${f.evidence ? `<br><span class="note">${escapeHtml(f.evidence)}</span>` : ""}</td>
        <td>${escapeHtml(f.version ?? "-")}</td>
        <td>${escapeHtml(f.effort ?? "-")}</td>
        <td>${planCell}</td>
        <td>${escapeHtml(f.surveyedAt ?? "-")}</td>
      </tr>`;
    })
    .join("\n");

  const adoptable = findings.filter((f) => isAdoptable(f.verdict)).length;
  const hold = findings.filter((f) => f.verdict === "hold").length;
  const reject = findings.filter((f) => f.verdict === "reject").length;
  const planned = findings.filter((f) => f.plan && planFiles.has(f.plan)).length;
  const summary =
    adoptable === 0
      ? `<p class="gate gate-todo">取り込み候補: <b>なし</b> — 調査した ${findings.length} 件はいずれも現時点では組み込めません(条件付き ${hold} 件 / 組み込めない ${reject} 件)。</p>`
      : `<p class="gate gate-ok">取り込み候補: <b>${adoptable} 件</b>(計画書あり ${planned} 件)— 条件付き ${hold} 件 / 組み込めない ${reject} 件。組み込むかどうかはユーザーが決めます。</p>`;

  const orphanPlans = plans.filter((p) => !findings.some((f) => f.plan === p.file));
  const planList =
    plans.length > 0
      ? `<p class="note">組み込み計画書(${plans.length} 件):</p>
<ul class="informal">
${plans.map((p) => `  <li><a href="atf-capabilities/${encodeURI(p.file)}">${escapeHtml(p.title)}</a> <span class="note">(${escapeHtml(p.file)}${orphanPlans.includes(p) ? " / 採否記録なし" : ""})</span></li>`).join("\n")}
</ul>`
      : "";

  return `${summary}
<table>
  <thead>
    <tr><th>判定</th><th>プロダクト</th><th>機能</th><th>根拠(検証結果)</th><th>確認した版</th><th>工数</th><th>計画書</th><th>調査日時</th></tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>
${planList}
<p class="note">出典: <code>.claude/atf-capabilities/</code>(調査 ${findings.length} 件 / 計画書 ${plans.length} 件)。同じ機能を再調査した記録は最新の 1 行だけを表示しています。</p>`;
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

/** デザインスキルのセクション: 導入したスキルと出典を一覧する */
/**
 * ヒアリングで選択された技術スタックをカテゴリ別の表にする。
 * 選択がなければ空文字を返す(呼び出し側で見出しごと省略する)。
 */
export function buildTechStackSection(stack: TechStack | undefined): string {
  const lines = formatTechStack(loadTechStackCatalog(), stack);
  if (lines.length === 0) return "";
  const rows = lines
    .map(
      (l) => `      <tr>
        <th>${escapeHtml(l.category)}</th>
        <td>${l.items.map((i) => `<code>${escapeHtml(i)}</code>`).join(" ")}</td>
      </tr>`,
    )
    .join("\n");
  return `<table>
  <tbody>
${rows}
  </tbody>
</table>`;
}

export function buildSkillSection(skills: InstalledSkill[]): string {
  if (skills.length === 0) {
    return `<p class="note">デザインスキルは導入されていません(<code>atf catalog</code> で一覧、<code>atf apply design &lt;repo&gt;</code> で適用できます)。</p>`;
  }
  const rows = skills
    .map((s) => {
      const source = s.source
        ? `<a href="${escapeHtml(s.source.homepage ?? `https://github.com/${s.source.repo}`)}">${escapeHtml(s.source.repo)}</a><br><span class="note">${escapeHtml(s.source.commit?.slice(0, 10) ?? s.source.version ?? "")}${s.source.license ? ` / ${escapeHtml(s.source.license)}` : ""}</span>`
        : `<span class="note">agent-team-factory</span>`;
      return `      <tr>
        <td><code>${escapeHtml(s.name)}</code></td>
        <td>${escapeHtml(SKILL_CATEGORY_LABEL[s.category] ?? s.category)}</td>
        <td>${escapeHtml(s.description)}</td>
        <td>${source}</td>
      </tr>`;
    })
    .join("\n");
  return `<p class="note">エージェントは UI・画面・スタイルを実装するときに <code>.claude/skills/</code> のスキルを読み込む(それ以外の作業では読み込まない)。</p>
<table>
  <thead>
    <tr><th>スキル名</th><th>分類</th><th>内容</th><th>出典</th></tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

/**
 * リバースドキュメントのセクション: コードから起こした文書 ↔ 根拠コード ↔ 図の対応表。
 * 記録と実ファイルを突き合わせ、追随できていない文書(本体・図が欠けている /
 * 根拠にしたコードが消えている)を「要再生成」として目立たせる。
 */
export function buildReverseSection(statuses: ReverseDocStatus[]): string {
  if (statuses.length === 0) {
    return `<p class="note">リバースドキュメントはまだありません(doc-reverser が <code>docs/architecture/</code> に文書と図を起こし、<code>.claude/atf-docs/docs.jsonl</code> に記録すると、ここに文書 ↔ コードの対応表が表示されます)。</p>`;
  }

  let stale = 0;
  const rows = statuses
    .map(({ record, docExists, diagramExists, missingSources }) => {
      const problems: string[] = [];
      if (!docExists) problems.push("文書が見つからない");
      if (diagramExists === false) problems.push("図が見つからない");
      if (missingSources.length > 0)
        problems.push(`根拠のコードが消えている(${missingSources.join(", ")})`);
      if (problems.length > 0) stale++;
      const state =
        problems.length > 0
          ? `${chip("要再生成", "warn")}<br><span class="note">${escapeHtml(problems.join(" / "))}</span>`
          : chip("追随", "ok");
      const diagram = record.diagram
        ? `<code>${escapeHtml(record.diagram)}</code>${record.diagramType ? `<br><span class="note">${escapeHtml(record.diagramType)}</span>` : ""}`
        : `<span class="note">(図なし)</span>`;
      const sources =
        (record.sources ?? []).length > 0
          ? (record.sources ?? [])
              .map(
                (src) =>
                  `<code${missingSources.includes(src) ? ' class="missing"' : ""}>${escapeHtml(src)}</code>`,
              )
              .join(" ")
          : `<span class="note">(未記録)</span>`;
      return `      <tr class="${problems.length > 0 ? "doc-ng" : "doc-ok"}">
        <td>${escapeHtml(REVERSE_DOC_KIND_LABEL[record.kind] ?? record.kind)}</td>
        <td><code>${escapeHtml(record.path)}</code><br><b>${escapeHtml(record.title)}</b>${record.summary ? `<br><span class="note">${escapeHtml(record.summary)}</span>` : ""}</td>
        <td>${sources}</td>
        <td>${diagram}</td>
        <td>${escapeHtml(record.commit ?? "-")}<br><span class="note">${escapeHtml(record.generatedAt ?? "")}</span></td>
        <td>${state}</td>
      </tr>`;
    })
    .join("\n");

  const gate =
    stale > 0
      ? `<p class="gate gate-todo">ドキュメントの鮮度: <b>要再生成 ${stale} 件</b> — 文書・図が欠けている、または根拠にしたコードが消えています(doc-reverser に差分更新を依頼してください)。</p>`
      : `<p class="gate gate-ok">ドキュメントの鮮度: <b>追随</b> — ${statuses.length} 件すべての文書・図と根拠コードが揃っています。</p>`;

  return `${gate}
<table>
  <thead>
    <tr><th>種類</th><th>文書</th><th>根拠にしたコード</th><th>図</th><th>生成(commit / 時刻)</th><th>状態</th></tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>
<p class="note">出典: <code>.claude/atf-docs/docs.jsonl</code>(${statuses.length} 件)。コードが単一情報源で、文書は doc-reverser がコードから起こす。図は同梱の archify スキルで生成。</p>`;
}

/**
 * アーキテクチャ適合検証のセクション: レイヤ定義・規約 ↔ 最新の検証結果・機械判定できない申し合わせ。
 * 判定は arch.ts の archGateStatus と同じ規則(CLI・orchestrator の説明と一致させる)。
 */
export function buildArchSection(
  rules: ArchRuleSet | undefined,
  checks: ArchCheckRecord[],
): string {
  if (!rules || rules.rules.length === 0) {
    return `<p class="note">アーキテクチャ規約はまだ定義されていません(arch-guard が <code>.claude/atf-arch/rules.json</code> にレイヤと規約を定義すると、規約 ↔ 検証結果の表がここに表示されます)。</p>`;
  }

  const layerName = (id?: string) =>
    id ? (rules.layers.find((l) => l.id === id)?.name ?? id) : "-";
  const { violated, unchecked, passed, ok } = archGateStatus(rules, checks);

  const layerRows = rules.layers
    .map(
      (l) => `      <tr>
        <th>${escapeHtml(l.name)}</th>
        <td><code>${escapeHtml(l.id)}</code></td>
        <td>${l.patterns.map((pt) => `<code>${escapeHtml(pt)}</code>`).join(" ")}</td>
        <td>${escapeHtml(l.description ?? "")}</td>
      </tr>`,
    )
    .join("\n");

  const ruleRows = rules.rules
    .map((rule) => {
      const check = latestArchCheck(checks, rule.id);
      const result = check
        ? `${chip(ARCH_RESULT_LABEL[check.result] ?? check.result, archTone(check.result))}${check.violations ? ` <b>${check.violations} 件</b>` : ""}${check.detail ? `<br><span class="note">${escapeHtml(check.detail)}</span>` : ""}`
        : chip("未検証");
      const dependency =
        rule.from || rule.to
          ? `${escapeHtml(layerName(rule.from))} → ${(rule.to ?? []).map((t) => escapeHtml(layerName(t))).join(", ") || "-"}`
          : `<span class="note">-</span>`;
      const state = check ? (isArchPass(check.result) ? "arch-ok" : "arch-ng") : "arch-todo";
      return `      <tr class="${state}">
        <td><code>${escapeHtml(rule.id)}</code></td>
        <td>${escapeHtml(rule.description)}${rule.source ? `<br><span class="note">根拠: ${escapeHtml(rule.source)}</span>` : ""}</td>
        <td>${escapeHtml(ARCH_RULE_KIND_LABEL[rule.kind] ?? rule.kind)}<br><span class="note">${dependency}</span></td>
        <td>${rule.tool ? `<code>${escapeHtml(rule.tool)}</code>` : `<span class="note">(検証未実装)</span>`}</td>
        <td>${result}</td>
        <td>${escapeHtml(check?.checkedAt ?? "-")}</td>
      </tr>`;
    })
    .join("\n");

  const notes =
    (rules.notes ?? []).length > 0
      ? `<p class="note">機械判定できない申し合わせ(レビューで担保する):</p>
<ul class="informal">
${(rules.notes ?? []).map((n) => `  <li>${escapeHtml(n)}</li>`).join("\n")}
</ul>`
      : "";

  const gate = ok
    ? `<p class="gate gate-ok">適合ゲート: <b>通過</b> — ${passed} 件の規約がすべて適合しています。</p>`
    : violated > 0
      ? `<p class="gate gate-ng">適合ゲート: <b>未通過</b> — 違反・検証エラーが ${violated} 件あります。実装の修正(または規約の見直し)まで完了としません。</p>`
      : `<p class="gate gate-todo">適合ゲート: <b>未確認</b> — 未検証の規約が ${unchecked} 件あります(<code>bash atf-bin/arch.sh</code> で検証してください)。</p>`;

  return `${gate}
${
    rules.layers.length > 0
      ? `<table>
  <thead>
    <tr><th>レイヤ</th><th>id</th><th>対象パターン</th><th>役割</th></tr>
  </thead>
  <tbody>
${layerRows}
  </tbody>
</table>
`
      : `<p class="note">レイヤが定義されていません(規約の from / to が解決できません)。</p>
`
  }<table>
  <thead>
    <tr><th>規約</th><th>内容</th><th>種類 / 依存</th><th>検証の実体</th><th>最新結果</th><th>検証時刻</th></tr>
  </thead>
  <tbody>
${ruleRows}
  </tbody>
</table>
${notes}
<p class="note">出典: <code>.claude/atf-arch/rules.json</code>(規約 ${rules.rules.length} 件${rules.tool ? ` / ツール: ${escapeHtml(rules.tool)}` : ""})と <code>checks.jsonl</code>(記録 ${checks.length} 件)。結果は規約ごとの最新行から抽出。</p>`;
}

/**
 * ルーブリック評価のセクション: 評価観点 ↔ 水準・エージェントごとの評価状況・成果物ごとの最新判定。
 * 判定は evaluate.ts の evalGateStatus と同じ規則(CLI・orchestrator の説明と一致させる)。
 */
export function buildEvalSection(
  rubric: Rubric | undefined,
  records: EvaluationRecord[],
  targets: string[],
): string {
  if (!rubric || rubric.criteria.length === 0) {
    return `<p class="note">評価観点はまだ定義されていません(evaluator が <code>.claude/atf-eval/rubric.json</code> に観点と水準を定義すると、観点 ↔ 評価結果の表がここに表示されます)。</p>`;
  }

  const pass = passScoreOf(rubric);
  const gate = evalGateStatus(rubric, records, targets);
  const latest = latestEvaluations(records).filter((r) => targets.includes(r.target));
  // ネクストアクションが 1 つも設定されていなければ、その列自体を出さない
  const showActions = hasNextActions(rubric);
  const below = nextActionItems(rubric, records, targets, "below");
  const mismatches = thresholdMismatches(rubric, records, targets);

  // 行は「評価対象のエージェント × そのエージェントに適用される観点」。
  // CLI(atf eval)の評価観点の表と同じ並べ方にそろえる
  const criteriaRows = targets
    .flatMap((agent) => {
      const applied = criteriaFor(rubric, agent);
      if (applied.length === 0) {
        return [
          `      <tr>
        <th>${escapeHtml(agent)}</th>
        <td colspan="${showActions ? 6 : 4}"><span class="note">適用される観点がありません(appliesTo を確認してください)</span></td>
      </tr>`,
        ];
      }
      return applied.map((c, i) => {
        const levels = [...c.levels]
          .sort((a, b) => b.score - a.score)
          .map(
            (l) =>
              `<b>${l.score}</b> ${escapeHtml(l.label)}: ${escapeHtml(l.description)}`,
          )
          .join("<br>");
        const threshold = criterionPassScore(c, rubric);
        // 観点固有の手順だけを出し、ルーブリック直下の既定が効くものは表の下に 1 度だけ出す
        // (同じ文面が行数ぶん繰り返されるのを避ける)
        const actionList = (kind: "below" | "meets") => {
          const own = ownNextActions(c, kind);
          if (own.length > 0) {
            return `<ul class="informal">${own.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>`;
          }
          return defaultNextActions(rubric, kind).length > 0
            ? `<span class="note">(既定)</span>`
            : `<span class="note">(未設定)</span>`;
        };
        return `      <tr>
        <th>${i === 0 ? `<span class="badge">${escapeHtml(agent)}</span>` : ""}</th>
        <td><code>${escapeHtml(c.id)}</code> <b>${escapeHtml(c.name)}</b><br><span class="note">${escapeHtml(c.description)}</span></td>
        <td>${c.weight ?? 1}</td>
        <td><b>${threshold}</b> 以上</td>
        <td><span class="note">${levels}</span></td>
${showActions ? `        <td>${actionList("below")}</td>\n        <td>${actionList("meets")}</td>` : ""}
      </tr>`;
      });
    })
    .join("\n");

  // 「(既定)」の中身は表の下に 1 度だけ展開する
  const defaultActionNote = showActions
    ? `<p class="note">ネクストアクションは観点の <code>actions</code> を優先し、<b>(既定)</b> はルーブリック直下の <code>actions</code>:
<ul class="informal">
  <li>閾値未満: ${defaultNextActions(rubric, "below").map((a) => escapeHtml(a)).join(" / ") || "(未設定)"}</li>
  <li>閾値以上: ${defaultNextActions(rubric, "meets").map((a) => escapeHtml(a)).join(" / ") || "(未設定)"}</li>
</ul></p>`
    : "";

  // 「どのエージェントの成果物を、どの観点で採点しているか」の行列。
  // 列は rubric の観点と同じ並びで、セルはその観点の平均スコア
  const agentRows = agentEvalStatuses(targets, records, rubric)
    .map((status) => {
      const state =
        status.evaluated === 0
          ? chip("未評価")
          : status.failed > 0
            ? chip(`未達 ${status.failed} 件`, "ng")
            : chip(`合格 ${status.passed} 件`, "ok");
      const score =
        typeof status.averageScore === "number"
          ? `${status.averageScore}${status.averageScore >= pass ? "" : " <span class=\"note\">(合格線未満)</span>"}`
          : `<span class="note">-</span>`;
      const cells = status.cells
        .map((cell) => {
          if (!cell.applies) return `        <td><span class="note">対象外</span></td>`;
          if (typeof cell.score !== "number") {
            return `        <td><span class="note">未採点</span></td>`;
          }
          return `        <td><b>${cell.score}</b>${cell.score < pass ? ` <span class="note">(合格線未満)</span>` : ""}</td>`;
        })
        .join("\n");
      return `      <tr class="${status.evaluated === 0 ? "eval-todo" : status.failed > 0 ? "eval-ng" : "eval-ok"}">
        <td><span class="badge">${escapeHtml(status.agent)}</span></td>
        <td>${status.evaluated}</td>
${cells}
        <td>${score}</td>
        <td>${state}</td>
        <td>${escapeHtml(status.latest?.evaluatedAt ?? "-")}</td>
      </tr>`;
    })
    .join("\n");
  const agentHeader = rubric.criteria
    .map((c) => `<th>${escapeHtml(c.id)}</th>`)
    .join("");

  const evaluationRows =
    latest.length === 0
      ? `      <tr><td colspan="6" class="empty">評価記録はまだありません(evaluator が <code>.claude/atf-eval/evaluations.jsonl</code> に追記すると表示されます)</td></tr>`
      : latest
          .slice()
          .sort((a, b) => (a.evaluatedAt ?? "").localeCompare(b.evaluatedAt ?? ""))
          .map((record) => {
            const total = totalScore(record, rubric);
            const scores = (record.scores ?? [])
              .map(
                (sc) =>
                  `<code>${escapeHtml(sc.id)}</code> ${sc.score}${sc.comment ? `<br><span class="note">${escapeHtml(sc.comment)}</span>` : ""}`,
              )
              .join("<br>");
            const actions = (record.actions ?? []).length
              ? `<ul class="informal">${(record.actions ?? []).map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>`
              : `<span class="note">-</span>`;
            return `      <tr class="${isEvalPass(record.verdict) ? "eval-ok" : "eval-ng"}">
        <td><span class="badge">${escapeHtml(record.target)}</span></td>
        <td><code>${escapeHtml(record.artifact)}</code>${record.task ? `<br><span class="note">${escapeHtml(record.task)}</span>` : ""}</td>
        <td>${scores || `<span class="note">-</span>`}</td>
        <td>${typeof total === "number" ? `<b>${total}</b>` : "-"}</td>
        <td>${chip(EVAL_VERDICT_LABEL[record.verdict] ?? record.verdict, evalTone(record.verdict))}</td>
        <td>${actions}</td>
      </tr>`;
          })
          .join("\n");

  const notes =
    (rubric.notes ?? []).length > 0
      ? `<p class="note">ルーブリックに落とせなかった申し合わせ(人のレビューで担保する):</p>
<ul class="informal">
${(rubric.notes ?? []).map((n) => `  <li>${escapeHtml(n)}</li>`).join("\n")}
</ul>`
      : "";

  const gateHtml = gate.ok
    ? `<p class="gate gate-ok">評価ゲート: <b>通過</b> — 対象 ${gate.targets} 体の成果物 ${gate.passed} 件がすべて合格しています。</p>`
    : gate.failed > 0
      ? `<p class="gate gate-ng">評価ゲート: <b>未通過</b> — 未達(要改善・不合格)の成果物が ${gate.failed} 件あります。指摘の修正と再評価まで完了としません。</p>`
      : `<p class="gate gate-todo">評価ゲート: <b>未確認</b> — 未評価の対象が ${gate.unevaluated.length} 体あります(${gate.unevaluated.map((a) => escapeHtml(a)).join(", ") || "-"})。</p>`;

  return `${gateHtml}
<h3>評価観点(評価対象のエージェントごと)</h3>
<table>
  <thead>
    <tr><th>エージェント</th><th>観点</th><th>重み</th><th>閾値</th><th>水準</th>${showActions ? "<th>閾値未満のとき</th><th>閾値以上のとき</th>" : ""}</tr>
  </thead>
  <tbody>
${criteriaRows}
  </tbody>
</table>
<p class="note">観点の適用範囲は <code>rubric.json</code> の <code>appliesTo</code>(省略 / <code>["*"]</code> で全エージェント)で決まる。</p>
${defaultActionNote}
<h3>評価対象 × 観点(誰の成果物を、どの観点で採点しているか)</h3>
<table>
  <thead>
    <tr><th>エージェント</th><th>評価済みの成果物</th>${agentHeader}<th>総合</th><th>状態</th><th>最終評価</th></tr>
  </thead>
  <tbody>
${agentRows}
  </tbody>
</table>
<p class="note">セルは観点ごとの平均スコア。<b>対象外</b> = その観点の <code>appliesTo</code> から外れている / <b>未採点</b> = 観点は適用されるが、まだ採点した成果物がない。評価対象のエージェントは <code>atf-settings.yaml</code> の <code>requirements.evalTargets</code> で 1 体ずつ ON/OFF できる。</p>
${
    below.length > 0
      ? `<h3>次にやること(閾値未満の観点)</h3>
<table>
  <thead>
    <tr><th>対象</th><th>成果物</th><th>観点</th><th>スコア</th><th>ネクストアクション</th></tr>
  </thead>
  <tbody>
${below
  .map(
    (item) => `      <tr class="eval-ng">
        <td><span class="badge">${escapeHtml(item.agent)}</span></td>
        <td><code>${escapeHtml(item.artifact)}</code></td>
        <td><code>${escapeHtml(item.criterion)}</code><br><span class="note">${escapeHtml(item.criterionName)}</span></td>
        <td><b>${item.score}</b> <span class="note">/ 閾値 ${item.threshold}</span></td>
        <td><ul class="informal">${item.actions.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul></td>
      </tr>`,
  )
  .join("\n")}
  </tbody>
</table>
<p class="note">出典: <code>rubric.json</code> の <code>actions.below</code>(観点に指定がなければルーブリック直下の既定)。スコアが閾値を下回った観点ごとに、あらかじめ決めた次の一手を出している。</p>`
      : ""
  }
${
    mismatches.length > 0
      ? `<p class="gate gate-todo">合格と記録されているが、閾値未満の観点が残っている評価が ${mismatches.length} 件あります(${mismatches
          .map((m) => `${escapeHtml(m.record.target)} / ${escapeHtml(m.record.artifact)}: ${m.below.map((b) => escapeHtml(b)).join(", ")}`)
          .join(" / ")})。evaluator に再評価を依頼するか、閾値が妥当かを確認してください。</p>`
      : ""
  }
<h3>成果物ごとの最新の判定</h3>
<table>
  <thead>
    <tr><th>対象</th><th>成果物</th><th>観点ごとの採点</th><th>総合</th><th>判定</th><th>改善指示</th></tr>
  </thead>
  <tbody>
${evaluationRows}
  </tbody>
</table>
${notes}
<p class="note">出典: <code>.claude/atf-eval/rubric.json</code>(観点 ${rubric.criteria.length} 件 / 合格線 ${pass})と <code>evaluations.jsonl</code>(記録 ${records.length} 件)。判定は対象 + 成果物ごとの最新行から抽出。評価対象は <code>atf-settings.yaml</code> の <code>requirements.evalTargets</code> で切り替える。</p>`;
}

/**
 * この実行環境に導入されている仕組みを、ハーネス / ガードレール / フィードバックループの
 * 3 要素に分類したカードを組み立てる。項目はマニフェストと実行記録から動的に導出し、
 * Issue 駆動が無効な場合は関連項目を「未導入」として薄く表示する。
 */
function buildMechanismSection(
  manifest: TeamManifest,
  runs: RunRecord[],
  specs: SpecState = { models: [], checks: [], decisions: [] },
  capabilities: { findings: CapabilityFinding[]; plans: CapabilityPlan[] } = {
    findings: [],
    plans: [],
  },
  architecture: ArchitectureState = { docs: [], checks: [] },
  evaluation: EvaluationState = { records: [] },
): string {
  const issueDriven = manifest.requirements.issueDriven ?? false;
  const prFlow = manifest.requirements.prFlow ?? false;
  const formalSpec = manifest.requirements.formalSpec ?? false;
  const capabilityScout = manifest.requirements.capabilityScout ?? false;
  const reverseDocs = manifest.requirements.reverseDocs ?? false;
  const archCheck = manifest.requirements.archCheck ?? false;
  const rubricEval = manifest.requirements.rubricEval ?? false;
  const evalTargets = evalTargetNames(manifest.requirements, manifest.agents);
  const evalGate = evalGateStatus(evaluation.rubric, evaluation.records, evalTargets);
  const archGate = archGateStatus(architecture.rules, architecture.checks);
  const staleDocs = architecture.docs.filter(
    (d) => !d.docExists || d.diagramExists === false || d.missingSources.length > 0,
  ).length;
  const adoptable = capabilities.findings.filter((f) => isAdoptable(f.verdict)).length;
  const specCommandCount = specs.models.reduce((n, m) => n + m.commands.length, 0);
  const specViolations = specs.checks.filter((c) => !isSatisfied(c.result)).length;
  const touchpoints = manifest.requirements.touchpoints ?? [];
  const skills = manifest.skills ?? [];
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
    item("チーム設定", `<code>atf-settings.yaml</code> がチーム構成の単一情報源(再生成・可視化の入力)`),
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
    item(
      "形式仕様(Alloy)+ ADR",
      `要件・仕様の単一情報源が <code>spec/*.als</code> と <code>docs/adr/</code>(モデル ${specs.models.length} 件 / 検証コマンド ${specCommandCount} 件)`,
      formalSpec,
      "未導入(形式仕様モードを有効にすると追加)",
    ),
    item(
      "最新機能スカウト",
      `capability-scout が Claude Code / Codex の新機能を調査し、<code>.claude/atf-capabilities/</code> に採否表と組み込み計画書を蓄積(調査 ${capabilities.findings.length} 件)`,
      capabilityScout,
      "未導入(最新機能スカウトを有効にすると追加)",
    ),
    item(
      "リバースドキュメント",
      `doc-reverser がコードから文書と図を起こし、<code>.claude/atf-docs/docs.jsonl</code> に文書 ↔ 根拠コードの対応を蓄積(文書 ${architecture.docs.length} 件)`,
      reverseDocs,
      "未導入(リバースドキュメントモードを有効にすると追加)",
    ),
    item(
      "アーキテクチャ規約",
      `<code>.claude/atf-arch/rules.json</code> がレイヤと規約の単一情報源(レイヤ ${architecture.rules?.layers.length ?? 0} 件 / 規約 ${architecture.rules?.rules.length ?? 0} 件)`,
      archCheck,
      "未導入(アーキテクチャ適合検証を有効にすると追加)",
    ),
    item(
      "評価基準(ルーブリック)",
      `<code>.claude/atf-eval/rubric.json</code> が評価基準の単一情報源(観点 ${evalGate.criteria} 件 / 評価対象 ${evalGate.targets} 体)`,
      rubricEval,
      "未導入(ルーブリック評価を有効にすると追加)",
    ),
    item(
      "デザインスキル",
      `<code>.claude/skills/</code> に ${skills.length} 件。UI・画面・スタイルを実装するときにエージェントが読み込む${skills.length > 0 ? `(${skills.map((s) => escapeHtml(s.name)).join(" / ")})` : ""}`,
      skills.length > 0,
      "未導入(重視観点に「UI/UX デザイン品質」を選ぶと追加)",
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
      "見た目の方向性の統一",
      skills.some((sk) => sk.category === "aesthetic")
        ? `見た目の方向性は <code>${escapeHtml(skills.find((sk) => sk.category === "aesthetic")!.name)}</code> の 1 つに統一(他の方向性のスキルは併用しない)`
        : `方向性を指定するスキルは未選択(スキルの一般的な指針のみ適用)`,
      skills.length > 0,
      "未導入(重視観点に「UI/UX デザイン品質」を選ぶと追加)",
    ),
    item(
      "実装前の形式検証ゲート",
      `対応する要件の <code>check</code> / <code>run</code> が充足するまで実装に着手しない(<code>bash atf-bin/formal.sh</code>)`,
      formalSpec,
      "未導入(形式仕様モードを有効にすると追加)",
    ),
    item(
      "アーキテクチャ適合ゲート",
      `レイヤ規約の違反・未検証が残っているあいだは実装を完了としない(<code>bash atf-bin/arch.sh</code>。違反 ${archGate.violated} 件 / 未検証 ${archGate.unchecked} 件)`,
      archCheck,
      "未導入(アーキテクチャ適合検証を有効にすると追加)",
    ),
    item(
      "ルーブリック評価ゲート",
      `未達(要改善・不合格)の成果物が残っているあいだは完了としない(<code>bash atf-bin/eval.sh</code>。未達 ${evalGate.failed} 件 / 未評価 ${evalGate.unevaluated.length} 体)`,
      rubricEval,
      "未導入(ルーブリック評価を有効にすると追加)",
    ),
    item(
      "推測の禁止(文書化)",
      `文書はコードで裏が取れる記述だけ。確認できないことは「未確認」として残す(コードが単一情報源)`,
      reverseDocs,
      "未導入(リバースドキュメントモードを有効にすると追加)",
    ),
    item(
      "取り込みの承認",
      `新機能の組み込みは計画書の提示とユーザーの承認が前提(capability-scout は調査と計画までで実装しない)`,
      capabilityScout,
      "未導入(最新機能スカウトを有効にすると追加)",
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
    item("失敗の可視化", `status: failure の記録を実行記録テーブルに失敗として表示(現在 ${failureCount} 件)`),
    item("ダッシュボード再生成", `<code>atf report</code> で最新の実行記録を反映した本ページを再生成`),
    item(
      "Issue へのトレース",
      `実行記録・コミットメッセージに Issue 番号を残し、進捗を Issue 上で追跡`,
      issueDriven,
    ),
    item(
      "反例による設計の差し戻し",
      `Alloy の反例・充足不能を <code>checks.jsonl</code> に記録し、設計の修正にフィードバック(未充足 ${specViolations} 件)`,
      formalSpec,
      "未導入(形式仕様モードを有効にすると追加)",
    ),
    item(
      "ドキュメントの鮮度検知",
      `記録と実ファイルを突き合わせ、根拠コードが消えた文書・欠けた図を「要再生成」として検出(現在 ${staleDocs} 件)`,
      reverseDocs,
      "未導入(リバースドキュメントモードを有効にすると追加)",
    ),
    item(
      "規約違反による差し戻し",
      `検証結果を <code>.claude/atf-arch/checks.jsonl</code> に記録し、違反は実装の修正(または規約の見直し)へ差し戻す(適合 ${archGate.passed} 件)`,
      archCheck,
      "未導入(アーキテクチャ適合検証を有効にすると追加)",
    ),
    item(
      "評価による差し戻し",
      `成果物の判定を <code>.claude/atf-eval/evaluations.jsonl</code> に記録し、要改善・不合格は改善指示を添えて担当エージェントへ差し戻す(合格 ${evalGate.passed} 件)`,
      rubricEval,
      "未導入(ルーブリック評価を有効にすると追加)",
    ),
    item(
      "PR へのトレース",
      `実行記録の outputs に PR の URL を残し、変更を PR 単位でレビュー・追跡`,
      prFlow,
      "未導入(PR フローを有効にすると追加)",
    ),
    item(
      "開発環境そのものの更新",
      `新機能の採否を <code>findings.jsonl</code> に蓄積し、取り込み候補(現在 ${adoptable} 件)をチーム構成の改善に還元`,
      capabilityScout,
      "未導入(最新機能スカウトを有効にすると追加)",
    ),
  ];

  return `<div class="mechanisms">
  <div class="mech mech-harness">
    <h3>ハーネス</h3>
    <p class="mech-sub">エージェントを動かす骨組み</p>
    <ul>
${harness.join("\n")}
    </ul>
  </div>
  <div class="mech mech-guardrail">
    <h3>ガードレール</h3>
    <p class="mech-sub">逸脱を防ぐ制約</p>
    <ul>
${guardrails.join("\n")}
    </ul>
  </div>
  <div class="mech mech-feedback">
    <h3>フィードバックループ</h3>
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
      const status = chip(r.status ?? "success", r.status === "failure" ? "ng" : "ok");
      const issueCell = issueDriven ? `\n        <td>${escapeHtml(r.issue ?? "-")}</td>` : "";
      return `<tr>
        <td>${escapeHtml(r.finishedAt ?? "-")}</td>
        <td><span class="badge">${escapeHtml(r.agent)}</span></td>${issueCell}
        <td>${escapeHtml(r.task ?? "-")}</td>
        <td>${escapeHtml(r.inputs ?? "-")}</td>
        <td>${escapeHtml(r.outputs ?? "-")}</td>
        <td>${status}</td>
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
  specs: SpecState = { models: [], checks: [], decisions: [] },
  capabilities: { findings: CapabilityFinding[]; plans: CapabilityPlan[] } = {
    findings: [],
    plans: [],
  },
  architecture: ArchitectureState = { docs: [], checks: [] },
  evaluation: EvaluationState = { records: [] },
): string {
  const issueDriven = manifest.requirements.issueDriven ?? false;
  const prFlow = manifest.requirements.prFlow ?? false;
  const formalSpec = manifest.requirements.formalSpec ?? false;
  const capabilityScout = manifest.requirements.capabilityScout ?? false;
  const reverseDocs = manifest.requirements.reverseDocs ?? false;
  const archCheck = manifest.requirements.archCheck ?? false;
  const rubricEval = manifest.requirements.rubricEval ?? false;
  const evalTargets = evalTargetNames(manifest.requirements, manifest.agents);
  const touchpoints = manifest.requirements.touchpoints ?? [];
  const skills = manifest.skills ?? [];
  const agentCards = manifest.agents
    .map(
      (a) => `
      <div class="card">
        <h3>${escapeHtml(a.name)}</h3>
        <p>${escapeHtml(a.description)}</p>
      </div>`,
    )
    .join("\n");

  return wrapTables(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(manifest.project)} — エージェントチームダッシュボード</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
${pageStyle("ATF / TEAM DASHBOARD", DASHBOARD_STYLE)}
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
  <span>形式仕様: ${formalSpec ? `Alloy(モデル ${specs.models.length} 件)` : "なし"}</span>
  <span>最新機能スカウト: ${capabilityScout ? `あり(調査 ${capabilities.findings.length} 件)` : "なし"}</span>
  <span>リバースドキュメント: ${reverseDocs ? `あり(文書 ${architecture.docs.length} 件)` : "なし"}</span>
  <span>アーキテクチャ検証: ${archCheck ? `あり(規約 ${architecture.rules?.rules.length ?? 0} 件)` : "なし"}</span>
  <span>ルーブリック評価: ${rubricEval ? `あり(対象 ${evalTargets.length} 体 / 記録 ${evaluation.records.length} 件)` : "なし"}</span>
  <span>デザインスキル: ${skills.length > 0 ? `${skills.length} 件` : "なし"}</span>
  <span>実行記録: ${runs.length} 件</span>
</p>

<h2>実行環境の仕組み</h2>
${buildMechanismSection(manifest, runs, specs, capabilities, architecture, evaluation)}

<h2>チーム構成・入出力フロー</h2>
<pre class="mermaid">
${buildFlowChart(manifest)}
</pre>

<h2>エージェント</h2>
<div class="cards">
${agentCards}
</div>

${(() => {
    const tech = buildTechStackSection(manifest.requirements.techStack);
    return tech ? `<h2>技術スタック</h2>\n${tech}` : "";
  })()}

${skills.length > 0 ? `<h2>デザインスキル</h2>\n${buildSkillSection(skills)}` : ""}

${formalSpec ? `<h2>形式仕様(Alloy)と実装前検証</h2>\n${buildSpecSection(specs.models, specs.checks, specs.decisions ?? [])}` : ""}

${reverseDocs ? `<h2>リバースドキュメント(コードから起こした文書と図)</h2>\n${buildReverseSection(architecture.docs)}` : ""}

${archCheck ? `<h2>アーキテクチャ適合検証</h2>\n${buildArchSection(architecture.rules, architecture.checks)}` : ""}

${rubricEval ? `<h2>ルーブリック評価</h2>\n${buildEvalSection(evaluation.rubric, evaluation.records, evalTargets)}` : ""}

${capabilityScout ? `<h2>最新機能の取り込み(Claude Code / Codex)</h2>\n${buildCapabilitySection(capabilities.findings, capabilities.plans)}` : ""}

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

${MERMAID_INIT}
${REVEAL_SCRIPT}
</body>
</html>
`);
}

/** 開発フロー(Issue → ブランチ → 実装 → PR → マージ)の Mermaid チャートを組み立てる */
function buildDevFlowChart(requirements: Requirements): string {
  const issueDriven = requirements.issueDriven ?? false;
  const prFlow = requirements.prFlow ?? false;

  const formalSpec = requirements.formalSpec ?? false;
  const reverseDocs = requirements.reverseDocs ?? false;
  const archCheck = requirements.archCheck ?? false;
  const rubricEval = requirements.rubricEval ?? false;

  const nodes: { id: string; label: string; touchpoint?: boolean; gate?: boolean }[] = [];
  if (issueDriven) {
    nodes.push({ id: "issue", label: "Issue 起票", touchpoint: true });
  }
  if (reverseDocs) {
    nodes.push({ id: "docs", label: "現状の文書化・図<br/>(doc-reverser)" });
  }
  if (formalSpec) {
    nodes.push({ id: "spec", label: "spec/*.als に仕様を書く<br/>決定は docs/adr/ へ" });
    nodes.push({ id: "verify", label: "lint + Alloy 検証<br/>(実装前ゲート)", gate: true });
  }
  if (prFlow) {
    nodes.push({ id: "branch", label: "ブランチ作成" });
  }
  nodes.push({ id: "impl", label: "実装・テスト" });
  if (archCheck) {
    nodes.push({ id: "arch", label: "アーキテクチャ検証<br/>(適合ゲート)", gate: true });
  }
  if (reverseDocs) {
    nodes.push({ id: "docsupd", label: "文書・図の更新<br/>(doc-reverser)" });
  }
  if (rubricEval) {
    nodes.push({ id: "eval", label: "ルーブリック評価<br/>(評価ゲート)", gate: true });
  }
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
  // 検証で反例が出たら実装に進まず形式化・設計修正に戻る
  if (formalSpec) {
    lines.push("  verify -- 反例・充足不能 --> spec");
  }
  // 規約違反が出たら実装の修正に戻る(違反を残して次へ進まない)
  if (archCheck) {
    lines.push("  arch -- 規約違反 --> impl");
  }
  // 要改善・不合格なら改善指示を添えて実装に差し戻す
  if (rubricEval) {
    lines.push("  eval -- 要改善・不合格 --> impl");
  }
  const touchIds = nodes.filter((n) => n.touchpoint).map((n) => n.id);
  if (touchIds.length > 0) {
    lines.push("  classDef touch fill:#fbf3db,stroke:#956400,color:#956400;");
    lines.push(`  class ${touchIds.join(",")} touch`);
  }
  const gateIds = nodes.filter((n) => n.gate).map((n) => n.id);
  if (gateIds.length > 0) {
    lines.push("  classDef gate fill:#edf3ec,stroke:#346538,color:#346538;");
    lines.push(`  class ${gateIds.join(",")} gate`);
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
  const formalSpec = requirements.formalSpec ?? false;
  const capabilityScout = requirements.capabilityScout ?? false;
  const reverseDocs = requirements.reverseDocs ?? false;
  const archCheck = requirements.archCheck ?? false;
  const rubricEval = requirements.rubricEval ?? false;
  const repo = requirements.githubRepo;
  const repoFlag = repo ? ` -R ${escapeHtml(repo)}` : "";
  // 導入予定のスキルを、チーム構築を確定する前にユーザーへ提示する
  const designSkills = resolveSkills(requirements.designSkills ?? []);
  // 選択した技術スタックも、確定前に確認できるよう提示する
  const techStackSection = buildTechStackSection(requirements.techStack);

  const focusItems = requirements.focus
    .map((f) => `<li><b>${escapeHtml(FOCUS_LABEL[f] ?? f)}</b><span class="focus-raw">(${escapeHtml(f)})</span></li>`)
    .join("\n");

  const artifactRows = [
    [
      "要件・仕様",
      formalSpec
        ? `spec-formalizer がユーザーと対話して <code>spec/*.als</code> に直接書く(宣言の直上の doc comment に日本語の要件、<code>@req</code> で要件 ID)。決定の履歴は <code>docs/adr/</code>。自然言語の仕様書は手で書かず <code>bash atf-bin/weave.sh</code> で <code>docs/generated/</code> に生成する`
        : "形式仕様モードは無効(要件は自然言語のまま扱う)",
    ],
    [
      "実装前の検証",
      formalSpec
        ? `<b>実装に着手する前に</b> <code>bash atf-bin/lint.sh</code>(規約検査)と <code>bash atf-bin/formal.sh</code>(Alloy)を通し、<code>check</code>(反例探索)と <code>run</code>(充足可能性)がすべて充足することを確認する。反例・充足不能が出たら実装せず仕様を修正する`
        : "対象外",
    ],
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
    [
      "リバースドキュメント",
      reverseDocs
        ? `doc-reverser がコードを解析して <code>docs/architecture/</code> に文書を起こし、図は同梱の archify スキルで生成する(<code>docs/architecture/diagrams/*.html</code>)。文書 ↔ 根拠コードの対応は <code>.claude/atf-docs/docs.jsonl</code> に記録され、実装で構造が変わるたびに差分更新される`
        : "リバースドキュメントモードは無効(コードからの文書化・図の生成は行わない)",
    ],
    [
      "アーキテクチャ規約",
      archCheck
        ? `arch-guard が文書化したアーキテクチャを <code>.claude/atf-arch/rules.json</code> のレイヤ規約(<code>ARCH-xx</code>)に落とし、言語に応じた検証ツール(ArchUnit / ArchUnitTS / ArchUnitPython / go-arch-lint など)で機械検証する`
        : "アーキテクチャ適合検証は無効(依存の向き・レイヤ違反の機械検証は行わない)",
    ],
    [
      "実装後の適合検証",
      archCheck
        ? `実装を終えたら <code>bash atf-bin/arch.sh</code> で検証し、<b>違反・未検証が残っているあいだは完了としない</b>。違反は回避策で消さず、依存の向きの修正か規約の見直し(ユーザー合意)で解消する`
        : "対象外",
    ],
    [
      "ルーブリック評価",
      rubricEval
        ? `evaluator が評価観点(<code>EVAL-xx</code>)を <code>.claude/atf-eval/rubric.json</code> に定義し、各エージェントの成果物を水準に照らして採点する。<b>要改善・不合格のあいだは完了としない</b>(改善指示を添えて担当に差し戻す)。評価するエージェントは <code>atf-settings.yaml</code> の <code>requirements.evalTargets</code> で個別に ON/OFF できる`
        : "ルーブリック評価は無効(成果物の採点・差し戻しは行わない)",
    ],
    [
      "デザインスキル",
      designSkills.length > 0
        ? `<code>.claude/skills/</code> に ${designSkills.length} 件配置(${designSkills.map((sk) => `<code>${escapeHtml(sk.name)}</code>`).join(" / ")})。エージェントは UI・画面・スタイルを実装するときにこのスキルを読み込み、その指示に従う`
        : "デザインスキルは導入しない(重視観点に「UI/UX デザイン品質」を選ぶと選択できる)",
    ],
    [
      "最新機能の取り込み",
      capabilityScout
        ? `capability-scout が Claude Code / Codex の新機能を一次情報から調査し、組み込めるもの・組み込めないものを 1 つの表(<code>.claude/atf-capabilities/findings.jsonl</code>)にまとめる。組み込めるものには計画書(<code>plan-&lt;id&gt;.md</code>)を作成。<b>取り込むかどうかはユーザーが承認して決める</b>`
        : "最新機能スカウトは無効(新機能の調査・取り込み計画は作成しない)",
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

  return wrapTables(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(profile.name)} — 開発フロープレビュー</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
${pageStyle("ATF / FLOW PREVIEW", FLOW_PREVIEW_STYLE)}
</head>
<body>
<h1>${escapeHtml(profile.name)} — 開発フロープレビュー</h1>
<p class="meta">
  <span>プリセット: ${escapeHtml(preset.name)}</span>
  <span>フェーズ: ${escapeHtml(requirements.phase)}</span>
  <span>開発スタイル: ${issueDriven ? "Issue 駆動" : "通常"}</span>
  <span>PR フロー: ${prFlow ? "あり" : "なし"}</span>
  <span>形式仕様: ${formalSpec ? "Alloy で実装前検証" : "なし"}</span>
  <span>リバースドキュメント: ${reverseDocs ? "あり(archify で図を生成)" : "なし"}</span>
  <span>アーキテクチャ検証: ${archCheck ? "あり(実装後ゲート)" : "なし"}</span>
  <span>ルーブリック評価: ${rubricEval ? "あり(成果物の採点ゲート)" : "なし"}</span>
  <span>最新機能スカウト: ${capabilityScout ? "あり" : "なし"}</span>
  <span>GitHub: ${escapeHtml(repo ?? "(未設定)")}</span>
</p>

<h2>重視している観点</h2>
<ul>
${focusItems}
</ul>

${techStackSection ? `<h2>技術スタック</h2>\n<p class="note">ヒアリングで選択した技術です。各エージェント定義にも明記され、ここにない技術を導入するときはユーザーに確認します。</p>\n${techStackSection}` : ""}

<h2>開発フロー(Issue・ブランチ・PR がどのように作成されるか)</h2>
<pre class="mermaid">
${buildDevFlowChart(requirements)}
</pre>
<table>
  <tbody>
${artifactRows}
  </tbody>
</table>

${
    formalSpec
      ? `<h2>形式仕様(Alloy)+ ADR を要件・仕様の単一情報源にする</h2>
<p class="note">自然言語の要件定義書を書いてから形式化するのではなく、<b>形式仕様を直接書き</b>、自然言語が必要になったときに生成します。手で書くのは <code>spec/*.als</code>(いまの仕様)と <code>docs/adr/*.md</code>(決定の履歴)の 2 種類だけです。</p>
<ul>
  <li><b>いまの仕様</b> — <code>spec/*.als</code>。宣言の直上の doc comment に日本語の要件(<code>@req</code>)・用語(<code>@term</code>)・理由(<code>@rationale</code>)を書きます</li>
  <li><b>決定の履歴</b> — <code>docs/adr/</code>。過去形・追記のみで、現行ルールは書きません(<code>.als</code> と内容が競合しないため)</li>
  <li><b>扱わない範囲</b> — 性能・可用性・UI 文言・外部サービスの挙動など。ルートモジュールの <code>@out-of-scope</code> に明記し、レビューとテストで担保します</li>
  <li><b>自然言語化</b> — <code>bash atf-bin/weave.sh</code> が <code>docs/generated/</code> に仕様書・用語集・トレーサビリティ・解説ページを生成します(<b>使い捨ての派生物</b>。commit しません)</li>
  <li><b>ゲート</b> — <code>check</code> に反例が出た / <code>run</code> でインスタンスが見つからない(制約が矛盾)場合は<b>実装に進まず</b>、仕様を修正して再検証します</li>
  <li><b>規約の強制</b> — <code>bash atf-bin/lint.sh</code> が必須タグの欠落・要件 ID の重複と孤児・手書き文書への規範文の混入を検出します(CI で落とします)</li>
  <li><b>担当</b> — spec-formalizer エージェント(チーム規模の枠外で追加)。結果は <code>.claude/atf-formal/checks.jsonl</code> に記録され、ダッシュボードに表示されます</li>
</ul>
<p class="note">Alloy の実行には jar が必要です(<code>ALLOY_JAR</code> 環境変数・<code>tools/alloy.jar</code>・<code>~/.atf/alloy.jar</code> の順に探索)。未導入の場合は env-builder が導入を案内します。</p>`
      : ""
  }

${
    reverseDocs
      ? `<h2>リバースドキュメント(コードから文書と図を起こす)</h2>
<p class="note">設計書ではなく<b>コードを単一情報源</b>として、いま動いている実装の構造・処理フローを文書と図に起こします。既存コードの把握・引き継ぎ・ドキュメントの陳腐化対策に効きます。</p>
<ul>
  <li><b>起こす</b> — エントリポイントから依存を追い、全体像 → 主要フロー → 個別モジュールの順に 1 回 1〜3 件ずつ文書化します(<code>docs/architecture/</code>)</li>
  <li><b>図にする</b> — 同梱の archify スキルで構成図・処理フロー・シーケンス・データフロー・状態遷移の図(自己完結 HTML)を生成します</li>
  <li><b>追随させる</b> — <code>.claude/atf-docs/docs.jsonl</code> に「文書 ↔ 根拠にしたコード」を記録し、実装で構造が変わった作業単位ごとに該当文書だけを差分更新します</li>
  <li><b>鮮度を可視化</b> — 根拠コードが消えた文書・欠けた図はダッシュボードで「要再生成」として表示されます</li>
  <li><b>担当</b> — doc-reverser エージェント(チーム規模の枠外で追加)。実装はせず、見つけた不具合・疑問は報告に回します</li>
</ul>`
      : ""
  }

${
    archCheck
      ? `<h2>アーキテクチャ適合検証(ArchUnit などのフィットネス関数)</h2>
<p class="note">文書で決めたアーキテクチャが<b>コードで実際に守られているか</b>を機械判定します。レビューの目視に頼らず、依存の向きの逸脱を検出します。</p>
<ul>
  <li><b>規約化</b> — レイヤ(ドメイン / アプリケーション / インフラ など)と規約(<code>ARCH-01</code>: 依存の禁止・依存先の限定・循環依存の禁止 …)を <code>.claude/atf-arch/rules.json</code> に定義します</li>
  <li><b>検証</b> — 言語に応じたツール(Java/Kotlin/Scala: ArchUnit / TypeScript: ArchUnitTS・dependency-cruiser / Python: ArchUnitPython / Go: go-arch-lint / PHP: deptrac など)で検証し、<code>bash atf-bin/arch.sh</code> から実行・記録します</li>
  <li><b>ゲート</b> — 違反または未検証の規約が残っているあいだは実装を<b>完了としません</b>。違反は依存の向きを直して解消し、規約自体を変えるときはユーザーの合意を取ります</li>
  <li><b>既存違反の扱い</b> — 既存コードの違反はベースラインとして件数を凍結し、<b>増やさない</b>ことを保証します(規約を緩めない)</li>
  <li><b>担当</b> — arch-guard エージェント(チーム規模の枠外で追加)。検証ツールの導入で依存が増える場合はユーザーに確認します</li>
</ul>`
      : ""
  }

${
    rubricEval
      ? `<h2>ルーブリック評価(成果物の採点)</h2>
<p class="note">チームの成果物を、合意した基準(ルーブリック)で採点します。感想ではなく観察できる事実で判定し、未達には「何をどう直すか」を添えて差し戻します。</p>
<ul>
  <li><b>基準</b> — evaluator が重視観点・インセプションデッキ・既存の規約をもとに、観点(<code>EVAL-xx</code>)と水準を <code>.claude/atf-eval/rubric.json</code> に定義します(観点は 4〜7 件に抑えます)</li>
  <li><b>採点</b> — 成果物ごとに観点別のスコアと根拠を付け、<code>pass</code> / <code>revise</code> / <code>fail</code> を判定して <code>.claude/atf-eval/evaluations.jsonl</code> に記録します</li>
  <li><b>ゲート</b> — 未達の成果物が残っているあいだは<b>完了としません</b>。evaluator は実装せず、改善指示を添えて担当エージェントに差し戻します</li>
  <li><b>対象の ON/OFF</b> — 評価するエージェントは <code>atf-settings.yaml</code> の <code>requirements.evalTargets</code> で個別に切り替えられます(<code>false</code> にしたエージェントからは評価の指示が外れます)</li>
  <li><b>担当</b> — evaluator エージェント(チーム規模の枠外で追加)。集計と評価ゲートの状況は <code>bash atf-bin/eval.sh</code> で確認できます</li>
</ul>`
      : ""
  }

${
    capabilityScout
      ? `<h2>最新機能の取り込み(Claude Code / Codex)</h2>
<p class="note">開発の区切りや新しい版が出たときに、capability-scout が公式ドキュメント・リリースノートなどの一次情報を調べ、このプロジェクトに組み込めるかを検証します。</p>
<ul>
  <li><b>調査</b> — Claude Code / Codex / Claude API の新機能を一次情報から収集し、手元の版(<code>claude --help</code> など)で実際に使えるかを確認します</li>
  <li><b>検証</b> — 前提条件・実際に動くか・既存構成との衝突・効果(重視観点に照らして)・コストの 5 点で判定します</li>
  <li><b>採否表</b> — 組み込めるもの / 組み込めないものを<b>同じ 1 つの表</b>にまとめ、ダッシュボードに表示します(<code>.claude/atf-capabilities/findings.jsonl</code>)</li>
  <li><b>計画書</b> — 組み込めるものは、目的・変更点・手順・検証方法・ロールバック・工数を書いた計画書(<code>plan-&lt;id&gt;.md</code>)を作成します</li>
  <li><b>承認</b> — capability-scout は<b>実装しません</b>。どれを組み込むかはユーザーが決め、承認後に orchestrator がタスクとして配分します</li>
</ul>`
      : ""
  }

<h2>チーム構成(予定)</h2>
${teamChart}

<h2>人間のタッチポイント候補</h2>
${touchpointCandidates ? `<ul>\n${touchpointCandidates}\n</ul>` : `<p class="note">Issue 駆動・PR フローがともに無効のため、選択できるタッチポイントはありません。</p>`}
<p class="next">このプレビューを確認したら CLI に戻ってください。人間のタッチポイントをどこに設けるかを続けて質問します。選択しない場合、エージェントがマージまで自動で進めます。</p>

${MERMAID_INIT}
${REVEAL_SCRIPT}
</body>
</html>
`);
}
