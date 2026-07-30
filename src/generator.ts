import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { commonRoot } from "./presets.js";
import { buildDashboardHtml, loadRuns, loadTaskDrafts } from "./report.js";
import { TRADEOFF_LABEL } from "./types.js";
import type { InceptionDeck, Preset, RepoProfile, Requirements, TeamAgent, TeamManifest } from "./types.js";

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
const issueDrivenInstruction = (githubRepo?: string, requireApproval = false) => `

## Issue 駆動開発

このプロジェクトは Issue 駆動で開発する${githubRepo ? `(使用するリポジトリ: ${githubRepo})` : ""}:

- 作業は必ず対応する GitHub Issue を起点に行い、Issue 番号(#123)を確認してから着手する${githubRepo ? `\n- Issue の起票・参照は ${githubRepo} に対して行う(gh CLI では \`-R ${githubRepo}\` を指定)` : ""}
- 対応する Issue がない作業を依頼されたら、先に issue-manager エージェントで Issue を起票することを提案する${requireApproval ? "\n- エージェントが起票した Issue は、ユーザーが内容を確認・承認してから着手する(タッチポイント)。承認前に実装を始めない" : ""}
- 成果物の報告・コミットメッセージには Issue 番号を含める
- 実行記録の JSON にも \`"issue": "#123"\` を含める
`;

/** PR フローが有効なとき、各エージェント定義に付与する指示(userMerges でマージのタッチポイントが変わる) */
const prFlowInstruction = (githubRepo?: string, userMerges = true) => {
  const repoFlag = githubRepo ? ` -R ${githubRepo}` : "";
  const mergeLines = userMerges
    ? `- マージはユーザーが行う(タッチポイント): エージェントは PR 作成と報告までを担当し、\`gh pr merge\` を実行してはならない
- PR の URL をユーザーに提示し、レビューとマージを依頼する`
    : `- マージはエージェントが行う: CI とレビューの通過を確認したうえで \`gh pr merge${repoFlag} --squash --delete-branch\` でマージする
- CI やレビューが未完了・失敗の場合はマージせず、状況を報告する`;
  return `

## PR フロー(ブランチ・Pull Request)

変更はブランチ + Pull Request で行う${githubRepo ? `(使用するリポジトリ: ${githubRepo})` : ""}:

- デフォルトブランチでは直接作業せず、作業単位ごとにブランチを作成する(例: \`feature/issue-123-short-summary\`)
- 作業完了後にコミットしてブランチを push し、\`gh pr create${repoFlag}\` で Pull Request を作成する
- PR タイトル・本文には対応する Issue 番号を含める(本文に \`Closes #123\` を書く)
${mergeLines}
- 実行記録の outputs に PR の URL(または番号)を含める
`;
};

/** インセプションデッキの Markdown(.claude/inception-deck.md)を組み立てる */
export function buildInceptionDeckMarkdown(projectName: string, deck: InceptionDeck): string {
  const list = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
  return `# ${projectName} インセプションデッキ

agent-team-factory のヒアリングから生成した「何を作るか」の合意事項。
全エージェントはこの方向性に沿って作業すること。内容を変更したいときはユーザーと合意してから更新する。

## なぜ作るのか(背景・課題)

${deck.purpose}

## 誰のためのものか(対象ユーザー)

${deck.targetUsers}

## 中核となる価値(エレベーターピッチ)

${deck.targetUsers} のための「${projectName}」は、${deck.coreValue}

## 必ず実現すること

${list(deck.mustHave)}

## やらないことリスト

${list(deck.notList)}

## 成功の判断基準

${deck.successCriteria}

## 夜も眠れない問題(リスク)

${deck.risks || "(特になし)"}

## トレードオフの最優先

${TRADEOFF_LABEL[deck.tradeoffPriority] ?? deck.tradeoffPriority}
`;
}

/** オーケストレーターにのみ付与する、タッチポイントでの一時停止指示 */
const orchestratorTouchpointInstruction = (touchpoints: string[]) => {
  const stops: string[] = [];
  if (touchpoints.includes("issue-approval")) {
    stops.push(
      "- **Issue 承認**: Issue を起票したら内容をユーザーに提示して停止する。ユーザーの承認を得るまで実装エージェントに委譲しない",
    );
  }
  if (touchpoints.includes("pr-merge")) {
    stops.push(
      "- **PR マージ**: PR の作成と URL の提示までで停止する。マージはユーザーが実行するため、マージの完了を確認してから次の作業に進む",
    );
  }
  const body = stops.length
    ? `このチームには人間のタッチポイントが設定されている。開発は自動で推進してよいが、以下の地点では**必ずループを一時停止し、ユーザーの承認を得てから**先に進むこと。承認の省略・先回りをしてはならない:

${stops.join("\n")}`
    : "このチームに人間のタッチポイントは設定されていない(エージェントがマージまで自動で進めてよい)。ただしスコープの変更・破壊的な操作・仕様の判断が必要になったときは停止してユーザーに確認する。";
  return `

## タッチポイント(一時停止してユーザー承認を仰ぐ)

${body}
`;
};

/** インセプションデッキがあるとき、各エージェント定義に付与する指示 */
const inceptionInstruction = (deck: InceptionDeck) => `

## プロダクトの方向性(インセプションデッキ)

新規開発プロジェクトのため、以下の合意に沿って作業する(全文: \`.claude/inception-deck.md\`):

- 目的: ${deck.purpose}
- 対象ユーザー: ${deck.targetUsers}
- 中核価値: ${deck.coreValue}
- 必ず実現すること: ${deck.mustHave.join(" / ")}
- やらないこと: ${deck.notList.join(" / ")}(該当する実装・提案はしない)
- 成功基準: ${deck.successCriteria}
- トレードオフの最優先: ${TRADEOFF_LABEL[deck.tradeoffPriority] ?? deck.tradeoffPriority}

判断に迷ったらインセプションデッキに立ち返り、逸脱しそうな場合はユーザーに確認する。
`;

export interface GenerateResult {
  agentsDir: string;
  written: string[];
  dashboardPath: string;
  /** インセプションデッキを書き出した場合のパス */
  inceptionDeckPath?: string;
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
  const touchpoints = requirements.touchpoints ?? [];
  const extraInstruction =
    (requirements.inception ? inceptionInstruction(requirements.inception) : "") +
    (requirements.issueDriven
      ? issueDrivenInstruction(requirements.githubRepo, touchpoints.includes("issue-approval"))
      : "") +
    (requirements.prFlow
      ? prFlowInstruction(requirements.githubRepo, touchpoints.includes("pr-merge"))
      : "");

  const writeAgent = (agentFile: string, srcDir: string, extra = "") => {
    const template = readFileSync(join(srcDir, agentFile), "utf8");
    const meta = parseAgentMeta(template, agentFile.replace(/\.md$/, ""));
    teamAgents.push({ file: agentFile, ...meta });

    const dest = join(agentsDir, agentFile);
    if (existsSync(dest) && !opts.force) {
      return; // 既存のエージェント定義は尊重する
    }
    writeFileSync(
      dest,
      render(template, vars) + extraInstruction + extra + runLogInstruction(meta.name),
    );
    written.push(agentFile);
  };

  for (const agentFile of selected) {
    writeAgent(agentFile, join(preset.dir, "agents"));
  }

  // 実行環境(ハーネス・ガードレール・フィードバックループ)の整備役は
  // 全チーム共通で追加する(teamSize の枠は消費しない)
  writeAgent("env-builder.md", commonRoot());

  // Issue 駆動なら issue-manager を追加(teamSize の枠は消費しない)し、
  // チームの先頭エージェントへタスクを流すフローを描く
  const flow = [...(preset.flow ?? [])];
  const firstAgent = teamAgents[0]?.name;
  if (requirements.issueDriven) {
    writeAgent("issue-manager.md", commonRoot());
    if (firstAgent) flow.push(["issue-manager", firstAgent]);
  }

  // チーム全体をまとめ上げるオーケストレーターを全チーム共通で追加する(teamSize の枠外)。
  // タッチポイントでの一時停止指示はオーケストレーターにのみ付与する
  writeAgent("orchestrator.md", commonRoot(), orchestratorTouchpointInstruction(touchpoints));
  const entryAgent = requirements.issueDriven ? "issue-manager" : firstAgent;
  if (entryAgent) flow.push(["orchestrator", entryAgent]);

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

  // 新規開発の合意事項を、人間とエージェントが参照できる独立した文書にする
  let inceptionDeckPath: string | undefined;
  if (requirements.inception) {
    inceptionDeckPath = join(claudeDir, "inception-deck.md");
    writeFileSync(
      inceptionDeckPath,
      buildInceptionDeckMarkdown(profile.name, requirements.inception),
    );
  }

  // ダッシュボードを生成(既存の実行記録・タスクドラフトがあれば反映)
  const dashboardPath = join(claudeDir, "atf-dashboard.html");
  writeFileSync(
    dashboardPath,
    buildDashboardHtml(manifest, loadRuns(profile.path), loadTaskDrafts(profile.path)),
  );

  return { agentsDir, written, dashboardPath, inceptionDeckPath };
}
