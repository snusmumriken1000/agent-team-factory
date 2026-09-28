import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { commonRoot } from "./presets.js";
import { parseFrontmatter } from "./frontmatter.js";
import {
  buildDashboardHtml,
  issuesDir,
  loadArchitectureState,
  loadEvaluationState,
  loadRuns,
  loadTaskDrafts,
} from "./report.js";
import { formalDir, loadSpecState, migrateLegacySpecs, specDir, ROOT_MODEL } from "./alloy.js";
import { adrDir } from "./adr.js";
import { runWeave } from "./weave.js";
import { capabilitiesDir, loadCapabilityFindings, loadCapabilityPlans } from "./capabilities.js";
import {
  ARCH_RUNNER_TEMPLATE_MARK,
  archDir,
  archReportJunitPath,
  archRulesPath,
  archRunnerPath,
} from "./arch.js";
import {
  archToolSummary,
  archToolsFor,
  formatArchTools,
  languageLabel,
  loadArchToolCatalog,
  recommendedArchTools,
} from "./archtools.js";
import { installAtfBin } from "./bin.js";
import {
  buildEvalTargets,
  DEFAULT_RUBRIC_ACTIONS,
  ensureRubricActions,
  evalDir,
  isEvalTargetAgent,
  rubricPath,
} from "./evaluate.js";
import { docsDir } from "./reverse.js";
import { bundledExplainTemplate, EXPLAIN_TEMPLATE_FILE } from "./specdoc.js";
import { saveTeamSettings } from "./settings.js";
import { installSkills } from "./skills.js";
import { formatTechStack, loadTechStackCatalog } from "./techstack.js";
import type {
  ArchTool,
  InstalledSkill,
  Preset,
  RepoProfile,
  Requirements,
  SpecFrame,
  TeamAgent,
  TeamManifest,
} from "./types.js";

/**
 * 図の生成に使うスキルのカタログ id(templates/skills/archify)。
 * リバースドキュメントモードで対象リポジトリに配る。
 */
export const DIAGRAM_SKILL_ID = "archify";

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
  return parseFrontmatter(template, fallbackName);
}

/** 各エージェント定義の末尾に付与する実行記録の指示(ダッシュボード可視化の入力になる) */
export const runLogInstruction = (agentName: string) => `

## 実行記録

作業を完了したら、リポジトリの \`.claude/atf-logs/runs.jsonl\` に以下形式の JSON を 1 行追記すること(ディレクトリがなければ作成する):

\`\`\`json
{"agent": "${agentName}", "task": "依頼内容の要約", "inputs": "受け取った主な入力", "outputs": "生成した主な成果物", "status": "success", "finishedAt": "<ISO 8601 形式の現在時刻>"}
\`\`\`

失敗して終了する場合は status を "failure" にする。この記録はチームダッシュボード(.claude/atf-dashboard.html)の可視化に使われる。
`;

/** Issue 駆動開発が有効なとき、各エージェント定義に付与する指示 */
export const issueDrivenInstruction = (githubRepo?: string, requireApproval = false) => `

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

/**
 * 形式仕様モードが有効なとき、各エージェント定義に付与する指示。
 * autoFix は requirements.specAutoFix(反例から仕様を自動確定してよいか)。
 */
export const formalSpecInstruction = (autoFix = true) => `

## 要件・仕様の単一情報源(形式仕様 + ADR)

このプロジェクトは、**要件と仕様を Alloy の形式仕様(\`spec/*.als\`)と ADR(\`docs/adr/\`)に置く**。自然言語の仕様書は書かず、必要になったときに \`bash atf-bin/weave.sh\` で生成する:

| 置き場 | 何が入るか | 誰が書くか |
| --- | --- | --- |
| \`spec/*.als\` | いまの仕様(構造・不変条件・状態遷移・権限)。宣言の直上の doc comment に日本語の要件 | spec-formalizer(手書き) |
| \`docs/adr/*.md\` | 決定の履歴(いつ・何を・なぜ決めたか・却下した案)。過去形・追記のみ | spec-formalizer(手書き) |
| \`docs/generated/\` | 仕様書・用語集・トレーサビリティ・解説ページ。**使い捨ての派生物**(.gitignore 対象) | atf(\`bash atf-bin/weave.sh\`) |

守るべき規約:

- **手書きの \`.md\` に仕様(規範文)を書かない**。「〜しなければならない」「〜すること」「〜してはならない」を書いてよいのは \`.als\` の doc comment だけで、ADR にも現行ルールを書かない(\`bash atf-bin/lint.sh\` が検出する)
- **\`docs/generated/\` を編集しない・commit しない**。読むのは自由だが、直すのは元の \`.als\`
- 実装に着手する前に、その作業がカバーする要件を \`spec/*.als\` で読む。数式が読みにくければ \`docs/generated/<モデル名>.explain.html\`(ユースケース図・検証事項・コード解説が 1 ページにまとまる)を開く
- 実装前に \`bash atf-bin/formal.sh\` で対象の \`check\` / \`run\` が充足していることを確認する。未形式化・未検証なら spec-formalizer に依頼し、**検証が通るまで実装を始めない**
- 反例(counterexample)や \`no instance found\`(制約の矛盾)が出ている要件は仕様の欠陥。実装で辻褄を合わせず、spec-formalizer と仕様を直してから着手する
- 実装は \`.als\` の制約(sig / fact / assert)と矛盾してはならない。実装の都合で仕様を変えたときは \`.als\` の更新・再検証と、必要なら ADR の追加を spec-formalizer に依頼する
- 形式化しない範囲(性能・UI 文言・外部サービスの挙動など)はルートモジュールの \`@out-of-scope\` に書いてある。そこはレビューとテストで担保する
${
  autoFix
    ? `- 反例から仕様を確定し直した記録は \`.claude/atf-formal/decisions.jsonl\` にある。**実装はこの決定に従う**。\`status\` が \`auto\` の行はユーザーがまだ確認していない決定なので、その要件に触れる作業の報告には「どの決定に沿って実装したか」を明記する
- spec-formalizer から「仕様を直したので実装も合わせてほしい」と依頼されたら、該当の \`.als\` と \`decisions.jsonl\` の行を読んでから直し、直したあとに \`bash atf-bin/formal.sh\` が充足していることを確認する`
    : `- 反例・充足不能が出たときの仕様変更は**ユーザーの判断待ち**になる(このプロジェクトは自動確定を無効にしている)。決着が付くまで、その要件に関わる実装を進めない`
}
`;

/** リバースドキュメントモードが有効なとき、各エージェント定義に付与する指示 */
export const reverseDocsInstruction = () => `

## リバースドキュメント(コードが単一情報源)

このプロジェクトはアーキテクチャの文書と図を**コードから起こして維持する**(担当: doc-reverser):

- 実装に着手する前に、対象範囲のリバースドキュメント(\`docs/architecture/\` と索引 \`.claude/atf-docs/docs.jsonl\`。一覧と鮮度は \`bash atf-bin/docs.sh\`)を読み、現状の構造・依存の向きを把握する。該当する文書がなければ doc-reverser に作成を依頼する
- 構造・依存・処理フロー・データモデル・外部インターフェースを変える実装をしたら、**同じ作業単位のうちに** doc-reverser へ文書と図の更新を依頼する(\`docs.jsonl\` の \`sources\` に自分が触ったパスを含む文書が対象)
- 自分で文書を書き足す場合も「コードで裏が取れること」「根拠のパスを併記すること」を守る。確認できていないことは「未確認」と明記する(推測を書かない)
- 図は同梱の archify スキル(\`.claude/skills/archify/\`)で生成する。図を作る/直すときだけスキルを読み込む(それ以外では読み込まない)
`;

/** アーキテクチャ適合検証が有効なとき、各エージェント定義に付与する指示 */
export const archCheckInstruction = () => `

## アーキテクチャ適合検証(実装後に必ず通す)

このプロジェクトはレイヤ規約を機械検証する(担当: arch-guard。規約の単一情報源: \`.claude/atf-arch/rules.json\`):

- 着手前に \`rules.json\` のレイヤ定義と規約(\`ARCH-xx\`)を読み、依存の向きを守って設計する。規約が未定義なら arch-guard に定義を依頼する
- 実装・リファクタリングを終えたら \`bash atf-bin/arch.sh\`(リポジトリのどこからでも実行できる)で検証し、**違反が残っている状態で完了と報告しない**
- 違反は回避策(例外の追加・規約の書き換え・検証の無効化)で消さない。依存の向きを直すのが原則で、規約自体を変えるべきときは arch-guard 経由でユーザーの合意を取る
- 検証結果は \`.claude/atf-arch/checks.jsonl\` に記録される。結果を確認せずに「アーキテクチャに適合している」と書かない
`;

/**
 * ルーブリック評価が有効なとき、**評価対象のエージェント**にだけ付与する指示。
 * 対象かどうかは requirements.evalTargets(エージェントごとの ON/OFF)で決まる。
 */
export const rubricEvalInstruction = () => `

## ルーブリック評価(成果物は評価を通す)

このプロジェクトは成果物をルーブリックで採点する(担当: evaluator。基準の単一情報源: \`.claude/atf-eval/rubric.json\`):

- 着手前に \`rubric.json\` の評価観点(\`EVAL-xx\`)と水準を読み、**何が合格とされるか**を踏まえて作業する
- 成果物ができたら evaluator に評価を依頼する(依頼文に「対象の成果物のパス」と「依頼された完了条件」を添える)。自分で自分の成果物を採点しない
- 判定が \`revise\` / \`fail\` で返ってきたら、\`actions\` の指摘を直して**再評価を依頼する**。指摘を残したまま完了と報告しない
- 基準そのものに異論があるときは、成果物を直す前に evaluator 経由でユーザーと合意する(その場の裁量で基準を無視しない)
- 評価結果は \`.claude/atf-eval/evaluations.jsonl\` に記録される(集計は \`bash atf-bin/eval.sh\`)
`;

/**
 * ルーブリック評価のとき、evaluator にのみ付与する「閾値とネクストアクションの決め方」。
 *
 * エージェント定義の本文ではなく**管理セクション**として持つことで、
 * 既に evaluator.md が置かれているチームにも `atf apply eval` で届く
 * (本文は既存ファイルを尊重して上書きしないため、本文に書くと機能の追加が既存チームに伝わらない)。
 */
export const evaluatorActionsInstruction = () => `

## 閾値とネクストアクションの設定

スコアの基準だけでは「で、次に何をするのか」が評価のたびにぶれる。**閾値と、それを跨いだときの行動をセットで \`rubric.json\` に書く。**

| 項目 | 意味 |
| --- | --- |
| \`passScore\`(ルーブリック直下) | 全体の閾値。既定 3 |
| \`criteria[].passScore\` | **その観点だけの閾値**。「この観点だけは 4 以上を求める」ときに使う。省略時は全体の値 |
| \`actions.below\` | スコアが**閾値未満**のときにやること(差し戻しの手順) |
| \`actions.meets\` | スコアが**閾値以上**のときにやること(次に進む手順) |
| \`criteria[].actions\` | その観点だけのネクストアクション。省略時はルーブリック直下の \`actions\` を使う |

- **誰が何をするか**が分かる形で書く(「改善する」ではなく「不足しているテストを一覧にして test-engineer に差し戻す」)
- \`actions\` には atf が既定の文面を入れてある。**そのプロジェクトの言葉に書き換える**こと(既定のままにしない)
- 観点に固有の手順が要るものだけ \`criteria[].actions\` に書く。残りはルーブリック直下の既定に任せる(同じ文面を繰り返さない)
- 閾値を上げると既存の「合格」と食い違うことがある。\`bash atf-bin/eval.sh\` が食い違いを警告するので、**再評価するか閾値を戻すかをユーザーと決める**(判定を黙って書き換えない)
- 設定した内容は \`bash atf-bin/eval.sh\` の評価観点の表(「閾値未満のとき」「閾値以上のとき」列)と「次にやること」の表に出る。出ていなければ未設定
`;

/** ルーブリック評価のとき、evaluator にのみ付与する「誰を評価するか」の指示 */
export const evaluatorTargetsInstruction = (targets?: Record<string, boolean>) => {
  const entries = Object.entries(targets ?? {});
  const on = entries.filter(([, v]) => v !== false).map(([k]) => k);
  const off = entries.filter(([, v]) => v === false).map(([k]) => k);
  const list =
    entries.length === 0
      ? "- 評価対象: チームの全エージェント(evaluator 自身を除く)"
      : `- 評価する: ${on.length > 0 ? on.join(" / ") : "(なし)"}\n- 評価しない: ${off.length > 0 ? off.join(" / ") : "(なし)"}`;
  return `

## 評価対象のエージェント(設定に従う)

評価対象は \`atf-settings.yaml\` の \`requirements.evalTargets\`(エージェントごとの ON/OFF)で決まる。現在の設定:

${list}

- **評価しないエージェントの成果物は採点しない**(依頼されても、設定で対象外であることを伝えて断る)
- 設定にないエージェントは対象として扱う(新しく増えた担当が黙って評価から外れないようにするため)
- 対象を変えるのはユーザーの判断。\`atf-settings.yaml\` の \`evalTargets\` を書き換えて \`atf apply eval <project-dir>\` をやり直すよう案内する
`;
};

/**
 * ルーブリック評価のとき、そのエージェント定義に付与する指示。
 * **エージェントごとに内容が変わる**(評価対象かどうか / 評価する側かどうか)ため、
 * 全員共通の指示(buildCommonInstruction)とは別に組み立てる。
 * init(generateTeam)と apply(FEATURES)の両方がこれを使う。
 */
export function evalAgentInstruction(agentFile: string, requirements: Requirements): string {
  if (!requirements.rubricEval) return "";
  const name = agentFile.replace(/\.md$/, "");
  return (
    (isEvalTargetAgent(requirements, name) ? rubricEvalInstruction() : "") +
    (agentFile === "evaluator.md"
      ? evaluatorTargetsInstruction(requirements.evalTargets) + evaluatorActionsInstruction()
      : "")
  );
}

/** ルーブリック評価のとき、オーケストレーターにのみ付与するゲートの指示 */
export const orchestratorEvalGateInstruction = () => `

## ルーブリック評価ゲート(成果物を完了とする前に通す)

このチームは成果物をルーブリックで採点する。**どちらの動作モードでも**次を守ること:

1. 評価観点(\`.claude/atf-eval/rubric.json\`)が未整備(\`"template": true\` が残っている)なら、最初の評価より前に evaluator へ基準の作成を委譲する(根拠は重視観点・インセプションデッキ・既存の規約)
2. 実装エージェントへの依頼文には、**完了条件(Definition of Done)を必ず書く**(採点の基準になる)
3. 完了報告を受けたら evaluator に評価を委譲する。依頼文には対象エージェント名・成果物のパス・完了条件を含める
4. 判定が \`revise\` / \`fail\` のあいだは**完了としない**。\`actions\` を添えて担当エージェントに差し戻し、修正後に再評価を委譲する
5. \`bash atf-bin/eval.sh\` で評価ゲートの通過状況を確認する(実行できない場合は env-builder に atf の実行環境の整備を依頼する)
6. PR を作る場合は、評価の結果(判定・総合スコア)を PR 本文に書く

evaluator は実装しない。差し戻しの修正は必ず元の担当エージェントへ回すこと(評価者が直すと自己採点になる)。
`;

/** ルーブリック評価のとき、env-builder にのみ付与する整備指示 */
export const envBuilderEvalInstruction = () => `

## ルーブリック評価の実行環境

このチームは成果物をルーブリックで採点する。次を整備・点検すること:

- \`.claude/atf-eval/\`(README.md・rubric.json・evaluations.jsonl)が揃っているかを確認する
- \`rubric.json\` が雛形のまま(\`"template": true\` が残っている)なら、evaluator に評価観点の作成を依頼するよう報告する
- \`evaluations.jsonl\` の各行が正しい JSON かを検査し、\`target\` が \`atf-settings.yaml\` の \`agents\` にある名前と一致しているかを確認する(一致しない行はゲート判定に入らない)
- \`bash atf-bin/eval.sh\` が実行できるかを確認する。atf が見つからないエラーが出たら、\`atf-bin/README.md\` の解決順(環境変数 \`ATF\` / PATH / \`atf-bin/atf.local.sh\` の \`ATF_HOME_DIR\`)に沿って整備する
- 未達(要改善・不合格)のまま残っている成果物と、未評価の対象エージェントを一覧にして報告する(評価ゲートの未通過)
- CLAUDE.md のチームセクションに「成果物は evaluator の評価を通してから完了とする」ルールを明記する
`;

/** リバースドキュメントモードのとき、オーケストレーターにのみ付与する指示 */
export const orchestratorReverseInstruction = () => `

## リバースドキュメントの維持(doc-reverser の使い方)

このチームには doc-reverser(コードから文書と図を起こす役)がいる:

- **立ち上げ・引き継ぎ時**: 最初に doc-reverser へ全体像の作成を委譲し、実装エージェントがそれを読んでから実装に入るようにする
- **実装後**: 構造・依存・データモデルが変わった作業単位ごとに差分更新を委譲する。依頼文には前回の対象 commit と変更したパスを明記する
- 一度に大量の文書を作らせない(1 回の委譲で 1〜3 件)。図はノード 12 個以内に分割させる
- 文書更新を伴う作業は、\`bash atf-bin/docs.sh\` で対象の文書が「追随」と出ることを確認してから完了とする
- doc-reverser は実装しない。文書化の途中で見つかった不具合・設計の疑問は、実装エージェントへの別作業として切り出す
`;

/** Issue 駆動のとき、オーケストレーターにのみ付与する運用の指示 */
export const orchestratorIssueInstruction = (githubRepo?: string) => `

## Issue 駆動モードの運用(issue-manager の使い方)

このチームには issue-manager(Issue の起票・整理・クローズ判断を担う役)がいる${githubRepo ? `。起票先は ${githubRepo}(\`gh\` では \`-R ${githubRepo}\`)` : "(起票先の GitHub リポジトリは未設定。最初に起票するときユーザーに確認する)"}:

- **Issue 駆動モードで動くこと**を既定とする。ブートストラップモードで進めるのは、ユーザーがそう指示したときだけ
- 作業を始める前に、対応する Issue があるかを確認する。なければ issue-manager に起票を委譲し、**Issue 番号が決まってから**実装エージェントに委譲する
- 実装エージェントへの依頼文には Issue 番号(#123)と完了条件(Definition of Done)を明記する
- 完了報告を受けたら、完了条件を満たしているかの確認とクローズを issue-manager に委譲する(自分で \`gh issue close\` しない)
- 大きすぎる依頼は、issue-manager に分割して起票させてから着手する。1 Issue = 1 作業単位を保つ
- 起案段階のタスク(まだ起票しないもの)は \`.claude/atf-issues/\` のドラフトとして残させる。依存関係はダッシュボードのタスク依存グラフに表示される
`;

/** Issue 駆動のとき、env-builder にのみ付与する整備指示 */
export const envBuilderIssueInstruction = (githubRepo?: string) => `

## Issue 駆動の実行環境(gh CLI)

このチームは Issue を起点に開発する。次を整備・点検すること:

- \`gh --version\` と \`gh auth status\` を確認する。未導入・未認証ならユーザーに導入と \`gh auth login\` を依頼する(**認証操作はエージェントが代行しない**)
- ${githubRepo ? `\`gh issue list -R ${githubRepo} --limit 1\` が通るかを確認し、通らなければ権限と起票先をユーザーに確認する` : "起票先の GitHub リポジトリが未設定のため、ユーザーに確認して \`atf-settings.yaml\` の \`requirements.githubRepo\` に記録する"}
- \`.claude/atf-issues/\`(README.md とドラフト)が揃っているかを確認する
- ラベル・テンプレート(\`.github/ISSUE_TEMPLATE/\`)の有無を確認し、運用に必要なら整備をユーザーに提案する
- CLAUDE.md のチームセクションに「作業は Issue を起点に行う / Issue 番号をコミットメッセージに含める」ルールを明記する
`;

/** アーキテクチャ適合検証のとき、オーケストレーターにのみ付与するゲートの指示 */
export const orchestratorArchGateInstruction = () => `

## アーキテクチャ適合ゲート(実装を完了とする前に通す)

このチームはレイヤ規約をコードレベルで検証する。**どちらの動作モードでも**次を守ること:

1. 規約(\`.claude/atf-arch/rules.json\`)が未定義なら、最初の実装より前に arch-guard へ規約の定義を委譲する(根拠はリバースドキュメント・ユーザーへの確認)
2. 実装を委譲するときは、対象のレイヤと守るべき規約 ID(\`ARCH-xx\`)を依頼文に明記する
3. 実装完了の報告を受けたら \`bash atf-bin/arch.sh\` を実行して適合を確認する(実行できない場合は env-builder に atf の実行環境の整備を依頼する)
4. 違反または未検証の規約が残っているあいだは**完了としない**。実装の修正は実装エージェントへ、規約そのものの是非は arch-guard へ差し戻す
5. PR を作る場合は、検証の通過状況(適合・違反件数)を PR 本文に書く

違反を残したまま次の作業に進まない。規約を緩める判断はユーザーの合意が必要で、エージェントの裁量で行わない。
`;

/** リバースドキュメントモードのとき、env-builder にのみ付与する整備指示 */
export const envBuilderReverseInstruction = () => `

## リバースドキュメントと図の実行環境

このチームはコードから文書と図を起こす。次を整備・点検すること:

- \`node --version\`(18 以上)を確認する。図の生成は同梱の archify スキルが Node で動く
- \`.claude/skills/archify/\` の一式(\`bin/\` \`schemas/\` \`renderers/\` \`examples/\`)が揃っているかを確認し、\`cd .claude/skills/archify && node bin/archify.mjs guide "サンプル" --json\` が実行できるかを試す
- 文書と図の置き場(\`docs/architecture/\` と \`docs/architecture/diagrams/\`)を用意する。生成物(自己完結 HTML)をリポジトリに commit するかどうかの方針をユーザーに確認し、しない場合は \`.gitignore\` への追加を提案する
- \`.claude/atf-docs/\`(README.md・docs.jsonl)が揃っているかを確認し、\`docs.jsonl\` の各行が正しい JSON かを検査する
- \`bash atf-bin/docs.sh\` が実行できるかを確認し、実装に追随していない文書があれば一覧にして報告する
- CLAUDE.md のチームセクションに「構造を変える実装をしたら doc-reverser に文書・図の更新を依頼する」ルールを明記する
`;

/** アーキテクチャ適合検証のとき、env-builder にのみ付与する整備指示 */
export const envBuilderArchInstruction = () => `

## アーキテクチャ適合検証の実行環境

このチームはレイヤ規約を機械検証する。次を整備・点検すること:

- リポジトリの言語に応じた検証ツール(${archToolSummary(loadArchToolCatalog())})が導入されているかを確認する。**言語別の導入方法・実行コマンド・ARCH 行への変換方法は \`.claude/atf-arch/README.md\` に載っている**。未導入ならユーザーに導入を提案する(**依存の追加は必ず確認する**)
- \`.claude/atf-arch/\`(README.md・rules.json・run-arch-check.sh・report-junit.mjs)が揃っているか、\`run-arch-check.sh\` に実行権限があるかを点検する
- ArchUnit 系(テスト形式)のツールを使う場合は、テストランナーが JUnit XML を出す設定になっているかを確認する(Vitest: \`--reporter=junit --outputFile=\`、pytest: \`--junitxml=\`、Gradle: \`build/test-results/test/\`)。変換は \`node .claude/atf-arch/report-junit.mjs <XML>\` が担う
- \`bash .claude/atf-arch/run-arch-check.sh\` を実行し、\`rules.json\` の規約数と同じだけ \`ARCH <規約 id> <判定>\` の行が出るかを確認する。出ない場合は arch-guard に配線を依頼する
- \`bash atf-bin/arch.sh\` が実行できるかを確認する。atf が見つからないエラーが出たら、\`atf-bin/README.md\` の解決順(環境変数 \`ATF\` / PATH / \`atf-bin/atf.local.sh\` の \`ATF_HOME_DIR\`)に沿って整備する
- 検証がテスト実行(\`npm test\` / \`pytest\` / \`./gradlew test\` など)と CI(\`.github/workflows/\`)から実行されるかを確認し、なければ組み込みを提案する
- \`checks.jsonl\` の各行が正しい JSON かを検査し、違反・エラーが残っている規約を一覧にして報告する(適合ゲートの未通過)
`;

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
    ? `このチームには人間のタッチポイントが設定されている。開発は自動で推進してよいが、Issue・PR を扱う作業(Issue 駆動モード)では以下の地点で**必ずループを一時停止し、ユーザーの承認を得てから**先に進むこと。承認の省略・先回りをしてはならない:

${stops.join("\n")}`
    : "このチームに人間のタッチポイントは設定されていない(エージェントがマージまで自動で進めてよい)。ただしスコープの変更・破壊的な操作・仕様の判断が必要になったときは停止してユーザーに確認する。";
  return `

## タッチポイント(一時停止してユーザー承認を仰ぐ)

${body}
`;
};

/**
 * 形式仕様モードのとき、オーケストレーターにのみ付与する実装前ゲートの指示。
 * autoFix が true なら、反例が出たときの「自動確定 → 仕様・実装の修正 → 再検証」の段取りを含める。
 */
export const orchestratorSpecGateInstruction = (autoFix = true) => `

## 形式検証ゲート(実装前に必ず通す)

このチームは要件・仕様を \`spec/*.als\` と \`docs/adr/\` に置く(自然言語の仕様書は \`bash atf-bin/weave.sh\` の生成物)。**どちらの動作モードでも**、実装を委譲する前に次の順序を守ること:

1. これから作る作業単位が、どの要件(\`@req\` の ID)に対応するかを確認する
2. その要件が \`spec/*.als\` に形式化されていなければ、先に spec-formalizer へ形式化を委譲する。**自然言語の要件定義書を先に書かせない**(仕様の置き場を 2 つにしない)
3. \`bash atf-bin/lint.sh\` で規約違反(必須タグの欠落・\`@req\` の孤児・手書き文書への規範文の混入)がないことを確認する。違反があれば spec-formalizer に修正を委譲する
4. \`bash atf-bin/formal.sh\`(リポジトリのどこからでも実行できる)で Alloy を実行し、対象の \`check\` / \`run\` がすべて充足していることを確認する
5. 反例・充足不能・実行エラーが出たら**実装を委譲せず**、spec-formalizer に原因の切り分けを委譲する
${
  autoFix
    ? `6. spec-formalizer の判定に従って分岐する:
   - **自動確定できる**(修正の選択肢が実質 1 つに決まる)— spec-formalizer に \`.als\` の修正・ADR の追加・\`decisions.jsonl\` への記録を委譲し、再検証で充足を確認する。既存の実装が決定と食い違うなら、続けて実装エージェントに修正を委譲し、修正後にもう一度 \`bash atf-bin/formal.sh\` と既存のゲート(テスト・\`atf arch\` など)を通す
   - **設計判断が要る**(ビジネスルール・優先順位・UX の選択)— 実装を委譲せず、選択肢とそれぞれの影響・推奨案を添えてユーザーに確認し、**停止する**
7. 自動確定で進めた場合は、その作業単位の報告に「自動確定した仕様(要件 ID / 採用した仕様 / 根拠 / ADR 番号)」を必ず添える。ユーザーが覆せるようにするためで、黙って通さない
8. 充足を確認できてはじめて、実装エージェントに委譲する。委譲の依頼文には対応する要件 ID と \`spec/<モデル>.als\` のパスを明記する`
    : `6. このプロジェクトは自動確定を無効にしている(\`requirements.specAutoFix: false\`)。spec-formalizer に選択肢・影響・推奨案の提示までを委譲し、**仕様を決めるのはユーザー**。回答を得るまで実装を委譲せず停止する
7. 充足を確認できてはじめて、実装エージェントに委譲する。委譲の依頼文には対応する要件 ID と \`spec/<モデル>.als\` のパスを明記する`
}

ユーザーから「仕様書がほしい」「要件をまとめて」と言われたら、文書を書き起こさず \`bash atf-bin/weave.sh\` を実行して \`docs/generated/\` を案内する(仕様の置き場を増やさない)。実装後に仕様が変わった場合も、\`.als\` の更新・再検証と ADR の追加を spec-formalizer に委譲してから完了とする。検証していない要件を「検証済み」として報告しない。
`;

/**
 * 形式仕様モードのとき、spec-formalizer にのみ付与する指示。
 *
 * - 反例が出たときに「自動で仕様を確定する」か「ユーザーに確認する」かの判断基準と手順
 *   (requirements.specAutoFix が単一情報源。false なら常にユーザー確認)
 * - 自然言語化(weave)と規約検査(lint)の扱い
 *
 * 見出しはどちらのモードでも同じにする(atf remove formal でセクションを取り除けるようにするため)。
 */
export function specFormalizerInstruction(requirements: Requirements): string {
  const autoFix = requirements.specAutoFix ?? true;
  const decide = autoFix
    ? `このプロジェクトは**自動確定を有効**にしている(\`atf-settings.yaml\` の \`requirements.specAutoFix: true\`)。反例(counterexample)・充足不能(no-instance)が出たら、次の順で進める:

1. **切り分け** — モデル化の誤りか、仕様の欠陥かを判断する。モデルの誤りなら \`.als\` を直して再検証する(仕様の意味は変えない)
2. **振り分け** — 仕様の欠陥なら、下の基準で「自動確定」と「ユーザー確認」に振り分ける
3. **実行** — 自動確定なら下の手順で \`.als\`・ADR・(必要なら)実装まで直す。ユーザー確認ならそこで停止して問いを立てる

### 自動確定してよい(圧倒的に推奨される仕様がある)

- 修正の選択肢が実質 1 つしかない(他の案は他の要件・既存実装と矛盾する)
- 規格・標準・フレームワークの規約で答えが決まっている(RFC・仕様書・言語やライブラリの約束)
- セキュリティ・データ整合性・法令順守の観点で、一方しか選べない(権限の穴・不整合データを許す案は採らない)
- 仕様の他の記述から一意に導ける(書き漏れの補完。仕様の意図を変えない)
- 既存の実装・データの既定に合わせるだけで済む(仕様だけが追いついていない)

### ユーザーに確認する(自動確定しない)

- ビジネスルール・料金・権限境界・優先順位の選択
- ユーザー体験の選択(どちらでも整合するが、体験・運用が変わる)
- 互換性を壊す変更・データ移行が必要になる変更
- 妥当な案が複数あり、決め手が「好み」に落ちるもの
- **判断に迷うもの**(迷ったら自動確定しない。この確認自体が形式化の価値)

### 自動確定の手順(この順序を守る)

1. \`.als\` を直す(doc comment の日本語も新しい仕様に書き換える。要件 ID は変えない)
2. \`bash atf-bin/formal.sh\` で再検証し、充足を確認する。充足しなければ確定を撤回してユーザーに確認する
3. **ADR を 1 件追加する**(\`docs/adr/NNNN-....md\`)。「YYYY-MM-DD に〜と決定した」「却下した案」「\`Refs:\` に要件 ID」。既存の ADR は書き換えない
4. \`.claude/atf-formal/decisions.jsonl\` に 1 行追記する(書式は \`spec/README.md\`)
5. \`bash atf-bin/lint.sh\` と \`bash atf-bin/weave.sh\` を通す(孤児参照がないか・派生文書が最新か)
6. 既存の実装が決定と食い違うなら、orchestrator に実装修正の委譲を依頼する(自分ではアプリケーションコードを書かない)
7. 報告に「採用した仕様 / 根拠 / 採らなかった案 / 直したファイル / ADR 番号」を必ず載せる。**黙って通さない**

- \`status\`: \`auto\`(自動確定・ユーザー未確認)/ \`confirmed\`(ユーザーが了承)/ \`reverted\`(ユーザーが差し戻し)
- ユーザーが決定を覆したら、その行を書き換えず \`status\` を \`reverted\` にした行と新しい決定を追記し、ADR も新しく起こして古い ADR に \`Status: superseded by ADR-NNNN\` を付す(履歴を消さない)
- 同じ要件で 3 回目の自動確定が必要になったら、仕様の理解が足りていない兆候。自動確定せずユーザーに確認する`
    : `このプロジェクトは**自動確定を無効**にしている(\`atf-settings.yaml\` の \`requirements.specAutoFix: false\`)。反例(counterexample)・充足不能(no-instance)が出たら、モデル化の誤りだけを自分で直し(\`.als\` の修正 → 再検証)、**仕様の変更はユーザーの判断を待つ**:

1. 何が破れたのか(どの値の組み合わせで要件が成り立たないか)を日本語で説明する。反例の読み下しは \`.claude/atf-formal/narration/\` に書いてよい(commit しない)
2. 考えられる修正案を 2〜3 件挙げ、それぞれの影響(他の要件・既存実装・移行)を書く
3. 推奨案とその根拠を示し、**そこで停止してユーザーに確認する**(実装を進めない)
4. 回答を得たら \`.als\` を直して再検証し、ADR を 1 件追加して \`.claude/atf-formal/decisions.jsonl\` に \`"status": "confirmed"\` で記録する

自動確定を有効にしたい場合は \`requirements.specAutoFix\` を \`true\` にして \`atf apply formal <project-dir>\` をやり直すようユーザーに案内する(判断基準つきの手順に入れ替わる)。`;

  return `

## 反例が出たときの進め方(自動確定の判断)

${decide}

## 自然言語化(weave)と規約検査(lint)

仕様の正は \`spec/*.als\` と \`docs/adr/\` で、読み物は**そこから生成する**。自然言語の仕様書を手で書かないこと。

- ユーザーから「仕様書がほしい」「要件一覧を出して」と言われたら、\`bash atf-bin/weave.sh\` を実行して \`docs/generated/\` を案内する(\`overview.md\` / \`spec.md\` / \`glossary.md\` / \`traceability.md\` / \`<モデル名>.explain.html\`)
- **生成物を手で編集しない・commit しない**(\`docs/generated/\` は \`.gitignore\` 対象)。読みにくければ直すのは \`.als\` の doc comment
- 生成は決定的(同じ入力なら同じ出力)。反例の読み下しのような LLM 生成は \`.claude/atf-formal/narration/\` に分けて出す
- \`.als\` を変えたら **\`bash atf-bin/lint.sh\` を必ず通す**。検出するのは次の違反:
  - ルートモジュール(\`spec/main.als\`)の \`@title\` / \`@scope\` / \`@out-of-scope\` / \`@stakeholder\` の欠落
  - 要件の文が 2 か所以上で定義されている / \`check\` に \`@req\` がない / 無名の \`check\` \`run\`
  - \`@usecase\` が参照するアクターに \`@actor\` の定義がない(警告。ユースケース図の入力)
  - ADR の \`Refs:\` が \`.als\` に無い要件 ID を指している(孤児)
  - 手書きの \`.md\`(\`docs/\` 配下。ADR と生成物を除く)に規範文が混ざっている
  - \`.als\` の doc comment に履歴(過去形)が混ざっている(警告。ADR に切り出す)
- ページの形式(見出し・並び・配色・タブ構成)を変えたいときは \`.claude/atf-formal/explain-template.html\` を編集する(差し込み口 \`{{...}}\` と繰り返し雛形 \`<!-- atf:block ... -->\` の説明はテンプレート冒頭のコメントにある)
- 検証を終えたら、関係者に「\`docs/generated/\` のどれを見れば分かるか」を伝える(非エンジニアのレビュー窓口になる)
`;
}

/** 形式仕様モードのとき、env-builder にのみ付与する Alloy 実行環境の整備指示 */
export const envBuilderSpecInstruction = () => `

## 形式仕様(Alloy)の実行環境

このチームは要件・仕様を \`spec/*.als\` と \`docs/adr/\` に置き、実装前に Alloy で検証する。次を整備・点検すること:

- \`java -version\`(17 以上)と Alloy の jar が使えるかを確認する。jar は \`ALLOY_JAR\` 環境変数・\`tools/alloy.jar\`・\`~/.atf/alloy.jar\` の順に探される
- jar がなければ入手方法(https://github.com/AlloyTools/org.alloytools.alloy/releases)と配置先をユーザーに案内する。jar をリポジトリに置く場合は \`.gitignore\` への追加を提案する
- \`spec/\`(README.md・main.als・run-alloy.sh)と \`docs/adr/README.md\`、\`.claude/atf-formal/\` が揃っているか確認し、\`run-alloy.sh\` に実行権限があるかを点検する
- **\`.gitignore\` に \`docs/generated/\`・\`spec/.alloy-out/\`・\`.claude/atf-formal/narration/\` が入っているか**を確認する(生成物と非決定的な出力を commit しないため。atf が追記するが、消されていないかを見る)
- \`bash atf-bin/formal.sh\` / \`weave.sh\` / \`lint.sh\` が実行できるかを確認する。atf が見つからないエラーが出たら、\`atf-bin/README.md\` の解決順(環境変数 \`ATF\` / PATH / \`atf-bin/atf.local.sh\` の \`ATF_HOME_DIR\`)に沿って整備する
- **CI に \`bash atf-bin/lint.sh\` と \`bash atf-bin/formal.sh\` を組み込む**(規約は人のレビューではなく CI で落とす)。\`.github/workflows/\` があれば追加を提案する
- \`checks.jsonl\` の各行が正しい JSON かを検査し、反例(counterexample)・充足不能(no-instance)が残っている要件があれば一覧にして報告する(実装前ゲートの未通過)
- \`decisions.jsonl\`(反例から確定した仕様の記録)の各行が正しい JSON かを検査し、\`status\` が \`auto\`(ユーザー未確認)のまま残っている決定を一覧にして報告する
- \`explain-template.html\` から差し込み口(\`{{blocks}}\` など)が消えていたらユーザーに知らせる
- CLAUDE.md のチームセクションに「仕様は \`spec/*.als\` が正・実装前に \`bash atf-bin/formal.sh\` を通す・自然言語の仕様書は手で書かない」を明記する
`;

/** 最新機能スカウトが有効なとき、オーケストレーターにのみ付与する取り込みループの指示 */
const orchestratorCapabilityScoutInstruction = () => `

## 最新機能の取り込み(capability-scout の使い方)

このチームには capability-scout(Claude Code / Codex / Claude API の新機能を調査し、取り込み計画を立てる役)がいる。次のときに調査を委譲すること:

- 開発の区切り(まとまった機能の完了時)・Claude Code / Codex の新しい版が出たとき・ユーザーから開発体験の改善を求められたとき
- 委譲の依頼文には、前回の調査結果(\`.claude/atf-capabilities/findings.jsonl\`)以降の差分を調べるよう明記する

調査結果の扱い:

1. capability-scout は「組み込めるもの / 組み込めないもの」を 1 つの表にまとめ、組み込めるものには計画書(\`.claude/atf-capabilities/plan-<id>.md\`)を書く
2. **どれを組み込むかはユーザーが決める**。表と計画書を提示して承認を得るまで、取り込みの実装を委譲しない
3. 承認された計画書は「手順」の各段階を作業単位に分解して実装エージェントに委譲する(Issue 駆動モードなら issue-manager に起票を委譲する)
4. 取り込みが完了したら \`atf report <リポジトリのパス>\` でダッシュボードを更新する

新機能の取り込みは開発そのものより優先しない。ユーザーの依頼と進行中の作業を止めてまで調査を始めないこと。
`;

/** 最新機能スカウトが有効なとき、env-builder にのみ付与する調査環境の整備指示 */
const envBuilderCapabilityInstruction = () => `

## 最新機能の調査環境

このチームには capability-scout がいる。調査が空振りしないよう、次を整備・点検すること:

- \`claude --version\` / \`codex --version\` が実行できるかを確認し、使えない場合は導入方法をユーザーに案内する(版が分からないと機能の有無を判定できない)
- \`.claude/atf-capabilities/\`(README.md・findings.jsonl)が揃っているかを確認する
- \`findings.jsonl\` の各行が正しい JSON かを検査し、壊れた行があれば報告する
- 一次情報(公式ドキュメント・CHANGELOG)を参照できるか(ネットワーク・権限)を確認し、参照できない場合はその制約を capability-scout に伝える

`;

/** デザインスキルを導入したとき、各エージェント定義に付与する指示 */
export const designSkillInstruction = (skills: InstalledSkill[]) => {
  const style = skills.filter((s) => s.category === "aesthetic");
  const others = skills.filter((s) => s.category !== "aesthetic");
  const line = (s: InstalledSkill) => `- \`${s.name}\` — ${s.description}`;
  return `

## デザインスキル(UI 実装時に使う)

このプロジェクトには UI の品質を担保するスキルが \`.claude/skills/\` に導入されている。
**UI・画面・スタイル(HTML / CSS / コンポーネント / レイアウト / タイポグラフィ / モーション)を実装・変更するときは、
着手する前に該当スキルを読み込み、その指示に従うこと**:

${[...style, ...others].map(line).join("\n")}

${
  style.length > 0
    ? `- 見た目の方向性は \`${style[0].name}\` に統一する。他の方向性のスキルを併用してはならない(指示が衝突する)
`
    : ""
}- UI に関係しない作業(バックエンド・CI・ドキュメントなど)では読み込まなくてよい。スキル本文は長いため、必要になったときだけ読む
- スキルの指示と、このプロジェクトの既存のデザイン方針(デザインシステム・ブランド・アクセシビリティ要件)が衝突する場合は、**既存の方針を優先**し、判断に迷えばユーザーに確認する
- 成果物の報告には、どのスキルに従って実装したかを書く
`;
};

/** デザインスキルを導入したとき、オーケストレーターにのみ付与する指示 */
export const orchestratorSkillInstruction = (skills: InstalledSkill[]) => `

## デザインスキルの配分

このチームには UI の品質を担保するスキル(${skills.map((s) => `\`${s.name}\``).join(" / ")})が導入されている。

- UI・画面・スタイルを含む作業を委譲するときは、**依頼文に使うスキル名を明記する**(例: 「\`${skills[0].name}\` に従って実装すること」)
- UI に関係しない作業ではスキルを指定しない(不要な読み込みでコンテキストを消費させない)
- UI の見え方はユーザーの好みに強く依存する。最初の画面ができた時点で一度ユーザーに見せ、方向性の合意を取ってから量産に進む
`;

/** デザインスキルを導入したとき、env-builder にのみ付与する指示 */
export const envBuilderSkillInstruction = () => `

## デザインスキルの実行環境

このチームは \`.claude/skills/\` のスキルを使って UI を実装する。次を整備・点検すること:

- \`.claude/skills/<スキル名>/SKILL.md\` が揃っているか、frontmatter(name / description)が壊れていないかを確認する
- Claude Code がスキルを認識しているか(\`/skills\` などで一覧に出るか)を確認し、出ない場合は配置先と版をユーザーに報告する
- CLAUDE.md のチームセクションに「UI・画面・スタイルを実装するときは該当スキルに従う」ルールと、スキル名の一覧を明記する
- 導入したスキルの出典・ライセンスは \`.claude/skills/README.md\` にある。リポジトリを公開する場合はこの表示を残すこと
`;

/**
 * ヒアリングで選択された技術スタックを、各エージェント定義に付与する指示。
 * DB のマイグレーションツールやスキーマドキュメント生成など、コードから検出しにくい
 * 選択も含めて明示し、勝手な技術の持ち込みを防ぐ。
 */
const techStackInstruction = (lines: { category: string; items: string[] }[]) => `

## 技術スタック

このプロジェクトで使う技術は以下のとおり(ヒアリングでユーザーが選択したもの)。

${lines.map((l) => `- ${l.category}: ${l.items.join(", ")}`).join("\n")}

ここにない技術を新たに導入する場合は、理由を添えてユーザーに確認してから使う。
`;

/** 形式仕様モードで用意する Alloy 実行スクリプト(jar の場所を探して java に渡すだけの薄いラッパ) */
const RUN_ALLOY_SH = `#!/usr/bin/env bash
# Alloy モデル(.als)を CLI で検証する。
#   使い方: ./run-alloy.sh <model.als> [alloy exec への追加引数]
# jar の場所は ALLOY_JAR で指定できる(未指定なら下の候補を順に探す)。
# jar は https://github.com/AlloyTools/org.alloytools.alloy/releases から入手できる。
set -euo pipefail

model="\${1:-}"
if [ -z "$model" ]; then
  echo "usage: $0 <model.als> [args...]" >&2
  exit 2
fi

jar="\${ALLOY_JAR:-}"
if [ -z "$jar" ]; then
  for candidate in ./tools/alloy.jar ./alloy.jar "$HOME/.atf/alloy.jar" "$HOME/alloy.jar"; do
    if [ -f "$candidate" ]; then jar="$candidate"; break; fi
  done
fi
if [ -z "$jar" ]; then
  echo "Alloy の jar が見つかりません。ALLOY_JAR に jar のパスを設定するか、tools/alloy.jar か ~/.atf/alloy.jar に配置してください。" >&2
  exit 127
fi

# ソリューション(反例のインスタンスなど)は .alloy-out/<モデル名>/ に書き出す
# (指定しないとカレントディレクトリにモデル名のディレクトリが作られるため)
out="$(dirname "$model")/.alloy-out/$(basename "\${model%.als}")"
exec java -jar "$jar" exec -f -o "$out" "$@"
`;

/** 形式仕様モードで用意する spec/README.md(書式と実行方法の単一情報源) */
export function buildSpecReadme(projectName: string): string {
  return `# ${projectName} 形式仕様(Alloy)

**要件と仕様の単一情報源**。自然言語の仕様書を書いてから形式化するのではなく、\`.als\` を直接書き、
自然言語が必要になったときに \`bash atf-bin/weave.sh\` で生成する(\`docs/generated/\`)。
形式化と検証は spec-formalizer エージェントが担当する。

## どこに何を書くか

| 置き場 | 内容 | 扱い |
| --- | --- | --- |
| \`spec/*.als\` | **いまの仕様**(構造・不変条件・状態遷移・権限) | 手書き。ここが正 |
| \`docs/adr/*.md\` | **決定の履歴**(いつ・何を・なぜ決めたか・却下した案) | 手書き。過去形・追記のみ |
| \`docs/generated/\` | 仕様書・用語集・トレーサビリティ・解説ページ | 生成物。編集も commit もしない |
| \`.claude/atf-formal/\` | 検証記録・仕様判断の記録・解説ページの形式 | atf とエージェントの記録 |

判断に迷ったら:**その宣言を削除したとき、そのテキストも一緒に消えるか**。
消えるなら \`.als\` の doc comment、残るなら(= 独立した履歴)ADR。
1 宣言あたり 3〜8 行の \`@rationale\` は健全で、15 行を超えたら履歴が混ざっている合図。

**手書きの \`.md\` に規範文(「〜しなければならない」「〜すること」「〜してはならない」)を書かない。**
\`docs/spec.md\` や \`docs/overview.md\` を手で作らないこと(\`.als\` と内容領域が競合する)。

## ファイル

| パス | 内容 |
| --- | --- |
| \`spec/main.als\` | ルートモジュール。\`@title\` / \`@scope\` / \`@out-of-scope\` / \`@stakeholder\` を持つ |
| \`spec/<関心事>.als\` | 1 モジュール = 1 関心事 |
| \`spec/run-alloy.sh\` | Alloy CLI の薄いラッパ(jar を探して \`java -jar ... exec\` を実行) |
| \`docs/adr/README.md\` | ADR の書式 |
| \`.claude/atf-formal/checks.jsonl\` | 検証結果の記録(1 行 1 コマンド) |
| \`.claude/atf-formal/decisions.jsonl\` | 反例から確定した仕様の記録(1 行 1 判断) |
| \`.claude/atf-formal/explain-template.html\` | 解説ページの形式。ここを編集すると生成物の形式が変わる |
| \`.claude/atf-formal/narration/\` | 反例の自然言語化(LLM 生成・非決定的)。commit しない |

## 書式(doc comment とタグ)

\`/** ... */\` を宣言の**直上**に置く。これだけが注釈として読まれる(行コメント \`--\` は読み飛ばす)。

\`\`\`alloy
/**
 * @title  ${projectName} の仕様
 * @scope  注文と出荷の状態遷移。
 * @out-of-scope 認証、決済ゲートウェイの内部、通知の文面。
 * @stakeholder プロダクトオーナー (承認: YYYY-MM-DD)
 * @tradeoff 品質(品質を落としてまで期日を守らない)
 */
module main

open order
\`\`\`

\`\`\`alloy
/**
 * @module order
 * @scope  注文の状態と、出荷との関係。
 */
module order

/**
 * 顧客。
 * @actor 顧客 注文を出す人
 */
sig Customer {}

/**
 * 注文。顧客ごとに 1 件ずつ作られる。
 * @term 注文 / Order
 * @rationale 下書き状態を別 sig にすると状態遷移が二重化するため、状態はフィールドで表す。
 * @adr docs/adr/0003-order-state.md
 */
sig Order {
  /** @term 注文者 / Customer */
  customer: one Customer,
  state: one State
}

/**
 * @req R-014  キャンセル済みの注文は出荷されない
 * @usecase 顧客 注文をキャンセルする
 */
fact CancelledIsNeverShipped { all s: Shipment | s.of.state != Cancelled }

/**
 * @req R-014
 * @validation 在庫と請求の整合性に対する機械的証拠
 * @relaxed スコープ 5 での有限検査。無限モデルの保証はない。
 */
check NoShipmentForCancelled for 5

/**
 * 制約全体が矛盾していないことの確認。
 * @req R-000  仕様は充足可能である
 */
run Consistent for 5
\`\`\`

タグ語彙:

| タグ | 付ける先 | 必須 | 意味 |
| --- | --- | --- | --- |
| \`@title\` | ルートモジュール | ○ | 仕様全体の名称 |
| \`@scope\` | ルート / 各モジュール | ○ | 対象範囲 |
| \`@out-of-scope\` | ルートモジュール | ○ | 意図的に扱わない範囲(複数可) |
| \`@stakeholder\` | ルートモジュール | ○ | 承認者と承認日 |
| \`@tradeoff\` | ルートモジュール | 推奨 | トレードオフ時に最優先するもの(評価の基準になる) |
| \`@module\` | 各モジュール | ○ | モジュール識別子 |
| \`@term\` | sig / フィールド | 推奨 | 業務用語との対応(用語集の生成元) |
| \`@rationale\` | 任意 | 任意 | なぜ**現在**この形なのか(現在形のみ) |
| \`@relaxed\` | fact / pred / check | 任意 | 意図的に緩くしてある点とその代償 |
| \`@req\` | check / run / fact | ○(check) | 業務要件 ID(\`@req R-014  要件の文\`) |
| \`@validation\` | check | 推奨 | この検証が何の機械的証拠になるか |
| \`@adr\` | 任意 | 任意 | 関連する ADR へのパス |
| \`@actor\` | sig(人・外部システム) | 推奨 | ユースケース図のアクター(\`@actor <名前> <説明>\`) |
| \`@usecase\` | pred / assert / run | 推奨 | 誰が何をするか(\`@usecase <アクター> <ユースケース名>\`。複数可) |

- \`@actor\` / \`@usecase\` は**解説ページのユースケース図の唯一の情報源**(Alloy にアクターの概念がないため、atf は推測しない)。\`@usecase\` が参照するアクターに \`@actor\` の定義がないと \`atf lint\` が警告する
- 要件の**文を書けるのは 1 か所だけ**。他の宣言からは \`@req R-014\` と ID だけで参照する
- \`check\` には必ず \`@req\` を付ける(業務ルールと「機械検証済みの主張」を結ぶ線がトレーサビリティの本体)
- \`check\` / \`run\` は必ず名前付きにする(無名コマンドは記録・追跡できない)
- 制約が矛盾していないことを確認する \`run\` を必ず 1 つ以上入れる
- **履歴を \`.als\` に書かない**。過去形(「〜と決定した」「旧仕様では〜」)と却下案は ADR へ
- コメントアウトした宣言を残さない(削除は git 履歴に任せる)

## 実行

\`\`\`bash
bash atf-bin/formal.sh   # 全 .als を検証し、結果を checks.jsonl に追記(実装前ゲート)
bash atf-bin/weave.sh    # docs/generated/ に仕様書・用語集・トレーサビリティ・解説を生成
bash atf-bin/lint.sh     # 規約の機械検査(必須タグ・@req の重複と孤児・規範文の混入)
./spec/run-alloy.sh spec/order.als   # 単一モデルを直接実行して出力を読む
\`\`\`

Alloy 6 の CLI は 1 コマンド 1 行の表で結果を出す。**充足性は SAT / UNSAT で表される**:

\`\`\`
00. check CancelledIsNeverShipped     0       UNSAT   ← 反例なし(表明は成立)
01. run   Consistent               0    1/1     SAT   ← インスタンスあり(充足可能)
02. check AllCancelled             0    1/1     SAT   ← 反例あり(仕様の欠陥)
\`\`\`

\`check\` は UNSAT が合格、\`run\` は SAT が合格(意味が逆になることに注意)。
反例・インスタンスの中身は \`spec/.alloy-out/<モデル名>/<コマンド名>-solution-0.md\` に書き出されるので、
そこを読んで「どういう状況で要件が破れるか」を日本語で説明する。
Alloy は反例が見つかっても終了コード 0 で終わるため、結果は必ず出力(または checks.jsonl)で判断する。

Alloy の jar は \`ALLOY_JAR\` 環境変数・\`tools/alloy.jar\`・\`~/.atf/alloy.jar\` の順に探す。
jar は https://github.com/AlloyTools/org.alloytools.alloy/releases から入手できる(java 17 以上が必要)。

## 検証記録(.claude/atf-formal/checks.jsonl)の形式

\`\`\`json
{"model": "order.als", "command": "NoShipmentForCancelled", "kind": "check", "result": "pass", "detail": "No counterexample found.", "checkedAt": "2026-01-01T00:00:00Z", "agent": "spec-formalizer"}
\`\`\`

\`result\`: \`pass\`(check で反例なし)/ \`counterexample\`(反例あり)/ \`instance\`(run で充足)/
\`no-instance\`(充足不能)/ \`error\`(実行エラー)。

反例・充足不能が残っている要件は**仕様の欠陥**であり、実装に進んではならない。

## 反例が出たあとの決着(.claude/atf-formal/decisions.jsonl)

反例・充足不能が出たときの進め方は \`atf-settings.yaml\` の \`requirements.specAutoFix\` で切り替わる:

- \`true\`(既定)— 修正の選択肢が実質 1 つに決まるもの(規格で決まっている・整合性の観点で一方しか選べない・仕様の他の記述から一意に導ける など)は spec-formalizer が \`.als\`・必要なら実装まで直し、根拠を \`decisions.jsonl\` と ADR に記録する。ビジネスルール・体験・互換性の選択、判断に迷うものはユーザーに確認する
- \`false\` — 常にユーザーに選択肢と推奨案を提示して判断を待つ(自動では直さない)

\`\`\`json
{"requirement": "R-014", "model": "order.als", "finding": "キャンセル済みの注文に出荷が紐づく反例が出た", "decision": "出荷済みの注文はキャンセルできない", "rationale": "他の案は在庫と請求の整合性を崩す", "alternatives": ["キャンセル時に出荷を取り消す"], "changed": ["spec/order.als", "docs/adr/0004-cancel-policy.md"], "reverified": true, "decidedAt": "2026-01-01T00:00:00Z", "agent": "spec-formalizer", "status": "auto"}
\`\`\`

\`status\`: \`auto\`(自動確定・ユーザー未確認)/ \`confirmed\`(了承)/ \`reverted\`(差し戻し)。
\`auto\` のまま残っている決定は \`atf status\` とダッシュボードが「要確認」として出す。

## 自然言語化(weave)

\`bash atf-bin/weave.sh\` は \`.als\` と ADR から次を生成する(**決定的**。同じ入力なら同じ出力):

| 生成物 | 内容 |
| --- | --- |
| \`docs/generated/overview.md\` | ルートモジュールの名称・対象範囲・対象外・承認 |
| \`docs/generated/spec.md\` | 全モジュールの doc comment + 宣言シグネチャ |
| \`docs/generated/glossary.md\` | \`@term\` から作る用語集 |
| \`docs/generated/traceability.md\` | \`@req\` × \`check\` × ADR の対応表 |
| \`docs/generated/<モデル名>.explain.html\` | ユースケース図・検証事項・Alloy コード解説を 1 ページにまとめたもの |

反例の自然言語化(LLM が書く説明)は**非決定的**なので weave には混ぜず、
\`.claude/atf-formal/narration/\` にオンデマンドで出す(commit しない)。

## 適用範囲

全面適用しない。コアの不変条件・状態遷移・権限モデルを形式化し、周辺は
ルートモジュールの \`@out-of-scope\` に明記して自然言語のまま残す。カバレッジを欲張ると破綻する。
`;
}

/** 形式仕様モードで用意する docs/adr/README.md(ADR の書式と規約) */
export function buildAdrReadme(projectName: string): string {
  return `# ${projectName} ADR(決定の記録)

**決定の履歴**の置き場。現在の仕様は \`spec/*.als\` が単一情報源なので、
ここには「いつ・何を・なぜ決めたか」と「却下した案」だけを書く。

## 規約(守らないと SSOT が割れる)

1. **過去形・日付必須**。「〜する」ではなく「YYYY-MM-DD に〜と決定した」
2. **追記のみ**。決定を変えるときは新しい ADR を作り、古い ADR に \`Status: superseded by ADR-0012\` を付す。**既存 ADR の本文は書き換えない**
3. **現行ルールを書かない**。書くのは差分と却下案だけ。いまどうなっているかは \`spec/*.als\` を参照させる
4. \`Refs:\` に関係する要件 ID(\`@req\` の ID)を列挙する。\`bash atf-bin/lint.sh\` が \`.als\` に無い ID(孤児)を検出する
5. ファイル名は \`NNNN-短い見出し.md\`(連番 4 桁)

## テンプレート

\`\`\`markdown
# ADR-0007: サービスアカウントを Principal に統合

Status: accepted
Date: 2026-08-14
Refs: R-014, R-021

## 決定

サービスアカウント専用の sig を設けないと決定した。

## 却下した案

- 別 sig として分離 — 権限判定が二重化し、R-021 の check が分岐するため却下した。

## 前提

決定時点でサービスアカウント固有の制約は存在しなかった。
\`\`\`

## どちらに書くか

> その宣言を削除したとき、そのテキストも一緒に消えるか。

- **消える**(宣言に付随する情報)→ \`.als\` の doc comment(\`@rationale\`)
- **残る**(宣言に依存しない独立した事実 = 履歴)→ ここ

却下した案は、貼り付ける宣言がそもそも存在しないので必ず ADR に書く。
`;
}

/** 最新機能スカウトで用意する .claude/atf-capabilities/README.md(書式と手順の単一情報源) */
export function buildCapabilitiesReadme(projectName: string, focus: string[] = []): string {
  return `# ${projectName} 最新機能の取り込み(Claude Code / Codex)

Claude Code・Codex・Claude API に入った新機能を調査し、**このプロジェクトに組み込めるか**を検証して、
採否表と組み込み計画書を残す置き場。調査と計画は capability-scout エージェントが担当する
(組み込みの実装は、ユーザーが承認したあと orchestrator が実装エージェントに配分する)。

## ファイル

| パス | 内容 |
| --- | --- |
| \`findings.jsonl\` | 調査した機能 1 件 = 1 行の採否記録(採否表の単一情報源) |
| \`plan-<id>.md\` | 組み込み計画書(判定が組み込める機能ごとに 1 通) |
| \`README.md\` | このファイル(書式と手順) |

## 判定の意味

| 判定 | 意味 |
| --- | --- |
| \`adopt\` | 組み込める(前提を満たし、効果を説明でき、計画書がある) |
| \`trial\` | 組み込める見込み(まず小さく試して効果を測る) |
| \`hold\` | 条件付き(版・プラン・権限などの前提が満たされれば組み込める) |
| \`reject\` | 組み込めない(前提を満たせない・プロジェクトに合わない・既存構成と衝突) |

判定の観点は「前提条件 / 実際に動くか / 既存構成との衝突 / 効果${focus.length > 0 ? `(重視観点: ${focus.join(", ")})` : ""} / コスト」の 5 点。

## findings.jsonl の形式(1 行 1 機能)

\`\`\`json
{"id": "cc-example-feature", "product": "claude-code", "name": "機能名", "summary": "何ができる機能か", "verdict": "adopt", "reason": "組み込める / 組み込めないと判断した根拠", "evidence": "確かめた方法(実行して確認 / ドキュメントのみ)", "docUrl": "https://…", "version": "claude-code 2.x.y", "effort": "M", "plan": "plan-cc-example-feature.md", "surveyedAt": "2026-01-01T00:00:00Z", "agent": "capability-scout"}
\`\`\`

- \`id\` は機能ごとの安定した識別子(\`cc-\` = Claude Code / \`cx-\` = Codex / \`api-\` = Claude API)。
  **同じ \`id\` の行は後勝ち**で最新の判定として扱われるため、再調査時は同じ \`id\` で追記する
- \`version\` は判定した時点で確認した版。機能の有無は版に依存するため必須
- \`plan\` は判定が \`adopt\` / \`trial\` のときだけ書く(このディレクトリからの相対パス)

## 表示

\`\`\`bash
atf report <このリポジトリのパス>   # ダッシュボードに「最新機能の取り込み」表を再生成
\`\`\`

組み込めるもの・組み込めないものは**同じ 1 つの表**に並べて表示される(見比べられることが価値のため、表を分けない)。

## 一次情報

| 対象 | URL |
| --- | --- |
| Claude Code ドキュメント | https://docs.claude.com/en/docs/claude-code/overview |
| Claude Code リリースノート | https://docs.claude.com/en/release-notes/claude-code |
| Claude Code CHANGELOG | https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md |
| Claude API リリースノート | https://docs.claude.com/en/release-notes/api |
| Codex | https://developers.openai.com/codex/ |

手元の版で実際に使えるかは \`claude --help\` / \`codex --help\` が最終的な根拠になる(ドキュメントより手元の版を優先)。
`;
}

/** リバースドキュメントモードで用意する .claude/atf-docs/README.md(書式と記録形式の単一情報源) */
export function buildIssuesReadme(projectName: string, githubRepo?: string): string {
  const repoFlag = githubRepo ? ` -R ${githubRepo}` : "";
  return `# ${projectName} Issue ドラフト

起案段階のタスクの置き場。起票・整理・クローズ判断は issue-manager エージェントが担当する
(起票先: ${githubRepo ?? "未設定 — 最初の起票前にユーザーへ確認すること"})。

## 使い方

- 作業は GitHub Issue を起点に行う。**ここに置くのは起票前の下書きと、起票済みタスクの依存関係の記録**
- 起票は \`gh issue create${repoFlag}\` で行い、起票したら本文の先頭に Issue 番号(\`#123\`)を追記する
- ここのドラフトはダッシュボード(\`.claude/atf-dashboard.html\`)の**タスク依存関係グラフ**の入力になる

## ドラフトの形式(1 ファイル 1 タスク)

ファイル名は \`draft-01-short-summary.md\` のように **\`英字-数字\` で始める**(先頭の \`draft-01\` が参照用の短い ID になる)。

\`\`\`markdown
# ログイン画面の実装

<!-- depends: draft-01 -->

## 背景
...

## 完了条件(Definition of Done)
- [ ] ...
\`\`\`

- 1 行目の \`# タイトル\` がグラフのラベルになる
- \`<!-- depends: draft-01, draft-02 -->\` で依存(先に終わらせるタスク)を明示する。書かない場合は本文中の \`draft-01\` への言及から推定される
- 1 ドラフト = 1 作業単位。大きすぎるものは分割する
- 起票してクローズまで終わったドラフトは削除してよい(記録は GitHub 側に残る)
`;
}

export function buildDocsReadme(projectName: string): string {
  return `# ${projectName} リバースドキュメント

**コードから起こした**アーキテクチャ文書と図の索引。文書の作成・更新は doc-reverser エージェントが担当する
(図の生成には同梱の archify スキル \`.claude/skills/archify/\` を使う)。

## 置き場

| パス | 内容 |
| --- | --- |
| \`docs/architecture/*.md\` | 文書本体(既にドキュメントの置き場があるプロジェクトではそちらに合わせる) |
| \`docs/architecture/diagrams/*.html\` | 図(archify が生成する自己完結 HTML)。隣に JSON 仕様も残す |
| \`docs.jsonl\` | 文書 ↔ 根拠コードの対応記録(1 行 1 文書)。ダッシュボードの入力 |
| \`README.md\` | このファイル(書式と記録形式) |

## 原則

- **コードが単一情報源**。設計書の「あるべき姿」ではなく、いま動いている実装を記述する
- 書いたことはコードで裏が取れること。節ごとに根拠のパス(必要なら行番号)を併記する
- 確認できなかったことは「未確認・注意点」として残す(推測で埋めない)
- 一度に全部作らない。全体像 → 主要フロー → 個別モジュールの順に、1 回 1〜3 件ずつ仕上げる

## docs.jsonl の形式(1 行 1 文書)

\`\`\`json
{"path": "docs/architecture/overview.md", "title": "システム全体像", "kind": "overview", "sources": ["src/cli.ts", "src/server/"], "diagram": "docs/architecture/diagrams/overview.html", "diagramType": "architecture", "summary": "CLI とサーバの責務分割、外部依存の境界", "commit": "a1b2c3d", "generatedAt": "2026-01-01T00:00:00Z", "agent": "doc-reverser"}
\`\`\`

- \`kind\`: \`overview\`(全体像)/ \`structure\`(構造・依存)/ \`flow\`(処理フロー)/ \`data\`(データ)/ \`api\`(インターフェース)/ \`ops\`(運用)/ \`decision\`(コードから読み取れる設計判断)
- \`sources\` は**根拠にしたコードのパス**。「実装が変わったらどの文書を直すか」の索引になるため省略しない
- \`commit\` は \`git rev-parse --short HEAD\`。文書がどの時点の実装を写したものかを示す
- 同じ \`path\` の行は**後勝ち**。更新時は同じ \`path\` で追記する(履歴は生ファイルに残る)

## 図の生成(archify)

\`\`\`bash
cd .claude/skills/archify
node bin/archify.mjs validate architecture <候補>.json --quality showcase --json
node bin/archify.mjs deliver  architecture <候補>.json <出力先>.html --quality showcase --json
\`\`\`

図の種類は \`architecture\`(構成)/ \`workflow\`(処理・CI)/ \`sequence\`(呼び出し列)/
\`dataflow\`(パイプライン)/ \`lifecycle\`(状態遷移)から選ぶ。着手前に \`SKILL.md\` を読むこと。
ノードは 12 個以内に抑え、多い場合は図を分割する。

## 表示

\`\`\`bash
atf report <このリポジトリのパス>   # ダッシュボードに「リバースドキュメント」表を再生成
\`\`\`

ダッシュボードは記録と実ファイルを突き合わせ、**文書・図が欠けているもの / 根拠にしたコードが消えているもの**
(= 実装に追随していない疑いのある文書)を「要再生成」として表示する。
`;
}

/**
 * 検証ツールの案内(言語別)。カタログ(templates/arch-tools.json)から組み立てるので、
 * ツールを増やすときは JSON に 1 エントリ足すだけでよい。
 * 検出された言語のツールは配線に必要な情報まで、それ以外は一覧だけを出す。
 */
export function buildArchToolGuide(languages: string[] = []): string {
  const catalog = loadArchToolCatalog();
  if (catalog.length === 0) return "";
  const matched = archToolsFor(catalog, languages);
  const others = formatArchTools(catalog.filter((t) => !matched.includes(t)));

  const detail = (tool: ArchTool) =>
    [
      `### ${tool.name}${tool.recommended ? "(推奨)" : ""} — ${tool.languages.map(languageLabel).join(" / ")}`,
      "",
      ...(tool.url ? [`- 参照: ${tool.url}`] : []),
      ...(tool.install ? [`- 導入: ${tool.install}`] : []),
      ...(tool.config ? [`- 規約を書く場所: ${tool.config}`] : []),
      ...(tool.run ? [`- 実行: \`${tool.run}\``] : []),
      ...(tool.report ? [`- ARCH 行への変換: ${tool.report}`] : []),
      ...(tool.notes ? [`- 注意: ${tool.notes}`] : []),
    ].join("\n");

  const table = (groups: { languages: string[]; tools: string[] }[]) =>
    [
      "| 言語・環境 | ツール |",
      "| --- | --- |",
      ...groups.map(
        (g) => `| ${g.languages.map(languageLabel).join(" / ")} | ${g.tools.join(" / ")} |`,
      ),
    ].join("\n");

  return `## 検証ツール(言語別)

${
  matched.length > 0
    ? `このリポジトリの言語で使えるツール(**推奨のものから検討する**。依存の追加は必ずユーザーに確認する):

${matched.map(detail).join("\n\n")}

${others.length > 0 ? `<details><summary>その他の言語のツール</summary>\n\n${table(others)}\n\n</details>` : ""}`
    : table(others)
}

### テスト形式のツール(ArchUnit 系)を使うときの共通の約束

ArchUnit / ArchUnitTS / ArchUnitPython / NetArchTest は**規約 1 件 = テスト 1 件**として書く。
テスト名の先頭を規約 id(\`ARCH-01\`。\`test_arch_01_...\` のように \`_\` 区切りでもよい)にしておけば、
テストランナーが出す JUnit XML を同梱の変換スクリプトでそのまま ARCH 行にできる:

\`\`\`bash
node .claude/atf-arch/report-junit.mjs .arch/junit.xml            # XML → ARCH 行
node .claude/atf-arch/report-junit.mjs build/test-results/test/*.xml
\`\`\`

規約 id を含まないテストは無視されるので、アーキテクチャ以外のテストが混ざっていても問題ない。
`;
}

/** アーキテクチャ適合検証で用意する .claude/atf-arch/README.md(規約と検証の単一情報源) */
export function buildArchReadme(projectName: string, languages: string[] = []): string {
  const detected = languages.length > 0 ? languages.join(", ") : "(未検出)";
  return `# ${projectName} アーキテクチャ適合検証

文書化したアーキテクチャを**レイヤ規約**に落とし、コードが規約を守っているかを機械検証するための置き場。
規約の定義と検証の実装は arch-guard エージェントが担当する。

検出された言語: ${detected}

## ファイル

| パス | 内容 |
| --- | --- |
| \`rules.json\` | レイヤと規約の定義(**規約の単一情報源**) |
| \`run-arch-check.sh\` | 検証の実行スクリプト(言語ごとのツールを呼び、共通形式で結果を出す) |
| \`checks.jsonl\` | 検証結果の記録(1 行 1 規約)。ダッシュボードの入力 |
| \`README.md\` | このファイル(書式と実行方法) |

## rules.json の形式

\`\`\`json
{
  "project": "${projectName}",
  "tool": "dependency-cruiser",
  "command": "npx depcruise --config .dependency-cruiser.js src",
  "layers": [
    { "id": "domain", "name": "ドメイン", "patterns": ["src/domain/**"] },
    { "id": "infra", "name": "インフラ", "patterns": ["src/infra/**"] }
  ],
  "rules": [
    { "id": "ARCH-01", "kind": "forbid", "from": "domain", "to": ["infra"], "description": "ドメインはインフラに依存しない", "tool": "no-domain-to-infra", "source": "docs/architecture/overview.md" }
  ],
  "notes": ["機械判定できない申し合わせ(レビューで担保するもの)"]
}
\`\`\`

- \`id\` は \`ARCH-01\` 形式の安定 id。**一度振ったら変えない**(検証記録との対応が切れる)
- \`kind\`: \`forbid\`(依存の禁止)/ \`allow-only\`(依存先の限定)/ \`no-cycle\`(循環依存の禁止)/ \`naming\`(命名・配置)/ \`custom\`
- \`tool\` にはその規約を実際に検証しているテスト名・ルール名を書く(空の規約 = 検証していない規約)
- **検証できない規約は \`rules\` に書かない**。\`notes\` に回してレビューで担保する

${buildArchToolGuide(languages)}
どれも導入できない場合は、import を集計して禁止された組み合わせを探す小さなスクリプトを書く。

## run-arch-check.sh の出力規約

規約ごとに 1 行、次の形式で出力する(atf はこの形式だけを解釈する):

\`\`\`
ARCH <規約 id> <PASS|VIOLATION|ERROR> [違反件数] [詳細]
\`\`\`

\`\`\`
ARCH ARCH-01 PASS
ARCH ARCH-02 VIOLATION 3 src/app/service.ts が src/web/ に依存している 他 2 件
ARCH ARCH-03 ERROR dependency-cruiser が未導入
\`\`\`

\`rules.json\` のすべての規約について 1 行を出すこと(行がない規約は「未検証」として適合ゲートを通さない)。

## 検証(実装後ゲート)

\`\`\`bash
bash atf-bin/arch.sh                     # 検証を実行し、結果を checks.jsonl に追記
bash .claude/atf-arch/run-arch-check.sh   # 出力を直接確認する
\`\`\`

## checks.jsonl の形式

\`\`\`json
{"rule": "ARCH-01", "result": "pass", "violations": 0, "detail": "", "tool": "dependency-cruiser", "checkedAt": "2026-01-01T00:00:00Z", "agent": "arch-guard"}
\`\`\`

\`result\`: \`pass\`(違反なし)/ \`violation\`(違反あり)/ \`error\`(検証自体が実行できない)/ \`unknown\`(判定不能)。

違反が残っている規約は**実装が設計から外れている**状態。回避策で消さず、依存の向きを直すか、
規約の変更をユーザーと合意してから \`rules.json\` と根拠ドキュメントの両方を更新する。
`;
}

/** ルーブリック評価の書式ガイド(.claude/atf-eval/README.md) */
export function buildEvalReadme(projectName: string, targets: string[] = []): string {
  return `# ${projectName} ルーブリック評価

チームの各エージェントが出した成果物を、合意した基準(ルーブリック)で採点する。
採点するのは evaluator エージェントで、**atf は記録の集計とゲート判定だけ**を担う。

## 置き場

| パス | 内容 |
| --- | --- |
| \`rubric.json\` | 評価観点と水準の定義(**評価基準の単一情報源**) |
| \`evaluations.jsonl\` | 評価記録(1 行 1 成果物)。ダッシュボードとゲート判定の入力 |
| \`README.md\` | このファイル(書式と運用) |

## 評価対象の ON/OFF

評価対象は **\`atf-settings.yaml\` の \`requirements.evalTargets\`**(エージェント名 → true/false)で決まる。
${
  targets.length > 0
    ? `現在の対象: ${targets.join(" / ")}`
    : "設定がなければチームの全エージェント(evaluator 自身を除く)が対象になる。"
}

\`\`\`yaml
requirements:
  rubricEval: true        # 機能全体の ON/OFF
  evalTargets:
    implementer: true     # 評価する
    docs-writer: false    # 評価しない
\`\`\`

書き換えたら \`atf apply eval <project-dir>\` をやり直すと、各エージェント定義の指示が設定に合わせて入れ替わる
(\`false\` にしたエージェントからは評価の指示が外れる)。機能ごと外すときは \`atf remove eval <project-dir>\`。

## rubric.json の形式

\`\`\`json
{
  "project": "${projectName}",
  "passScore": 3,
  "actions": {
    "below": ["担当エージェントに改善指示を添えて差し戻し、修正後に再評価する"],
    "meets": ["orchestrator に合格を報告し、次の作業へ進む"]
  },
  "criteria": [
    {
      "id": "EVAL-01",
      "name": "要求の充足",
      "description": "依頼された完了条件を満たしているか",
      "weight": 2,
      "passScore": 3,
      "appliesTo": ["*"],
      "actions": {
        "below": ["満たせていない完了条件を洗い出し、担当エージェントに一覧で差し戻す"],
        "meets": ["完了条件の充足を PR 本文に記載する"]
      },
      "levels": [
        { "score": 4, "label": "優秀", "description": "完了条件をすべて満たし、境界条件・異常系も扱っている" },
        { "score": 3, "label": "合格", "description": "完了条件をすべて満たしている" },
        { "score": 2, "label": "要改善", "description": "満たせていない完了条件が 1〜2 件ある" },
        { "score": 1, "label": "不可", "description": "主要な完了条件を満たしていない" }
      ]
    }
  ],
  "notes": ["機械判定も観察もできない申し合わせはここに書き、人のレビューで担保する"]
}
\`\`\`

- \`id\` は \`EVAL-01\` のように連番の安定 id。**一度振ったら変えない**(評価記録との対応が切れる)
- \`levels\` はスコアの降順で、各水準を**観察できる事実**で書く(主観語を使わない)
- \`passScore\`(既定 3)以上が合格。重要な観点には \`weight\`(既定 1)を付ける
- 特定のエージェントにだけ効く観点は \`appliesTo\` にエージェント名を書く(省略 / \`["*"]\` は全員)
- 観点は 4〜7 件に抑える。多すぎる基準は採点が形骸化する
- 雛形のままであることを示す \`"template": true\` は、観点を書き起こしたら**削除する**

### 閾値とネクストアクション

スコアだけでなく、**閾値を跨いだときに何をするか**も基準の側に書いておく。差し戻しの指示が評価のたびにぶれなくなる。

| 項目 | 意味 |
| --- | --- |
| \`passScore\`(ルーブリック直下) | 全体の閾値。既定 3 |
| \`criteria[].passScore\` | **その観点だけの閾値**(「この観点は 4 以上を求める」)。省略時は全体の値 |
| \`actions.below\` | スコアが**閾値未満**のときにやること(差し戻しの手順) |
| \`actions.meets\` | スコアが**閾値以上**のときにやること(次に進む手順) |
| \`criteria[].actions\` | その観点だけのネクストアクション。省略時はルーブリック直下の \`actions\` を使う |

\`bash atf-bin/eval.sh\` は採点結果を観点ごとの閾値と突き合わせ、**該当するネクストアクションを一覧**にして出す。
evaluator は未達の観点の \`below\` を評価記録の \`actions\` に写し、そこへ成果物固有の具体を足すこと。

## evaluations.jsonl の形式(1 行 1 成果物)

\`\`\`json
{"target": "implementer", "artifact": "src/order.ts", "task": "#123 在庫引当の実装", "scores": [{"id": "EVAL-01", "score": 3, "comment": "完了条件 3 件を満たす(src/order.ts:42-88)"}], "total": 3, "verdict": "pass", "actions": [], "evaluatedAt": "2026-01-01T00:00:00Z", "agent": "evaluator", "issue": "#123"}
\`\`\`

- \`target\` は \`atf-settings.yaml\` の \`agents\` にある名前と一致させる(一致しない行はゲート判定に入らない)
- \`verdict\`: \`pass\`(合格)/ \`revise\`(要改善)/ \`fail\`(不合格)/ \`unknown\`(判定不能)
- 同じ \`target\` + \`artifact\` の行は**後勝ち**。再評価すると最新の判定に置き換わる(履歴は生ファイルに残る)
- \`total\` は省略可(省略時は \`scores\` を \`weight\` で加重平均した値を使う)
- \`revise\` / \`fail\` のときは \`actions\` に「何をどう直すか」を具体的に書く

## 実行

\`\`\`bash
bash atf-bin/eval.sh     # 評価の集計と評価ゲートの通過状況(リポジトリのどこからでも実行できる)
bash atf-bin/report.sh   # ダッシュボードに「ルーブリック評価」表を再生成
\`\`\`

評価ゲートは「評価観点が定義されている」「対象エージェントがすべて評価済み」
「未達(要改善・不合格・判定不能)の成果物が 1 件も残っていない」の 3 つが揃ったときに通過する。
`;
}

/** ルーブリック評価で用意する rubric.json の雛形(evaluator が中身を埋める) */
export function buildRubricTemplate(projectName: string): string {
  return (
    JSON.stringify(
      {
        $comment:
          "評価基準の単一情報源。evaluator が重視観点・インセプションデッキ・既存の規約をもとに criteria を埋め、埋めたら template を削除する。id(EVAL-01 …)は一度振ったら変えない。",
        project: projectName,
        template: true,
        passScore: 3,
        // 空で配ると「設定できること自体に気づかれない」ため、動く既定を入れておく
        actions: DEFAULT_RUBRIC_ACTIONS,
        criteria: [],
        notes: [],
      },
      null,
      2,
    ) + "\n"
  );
}

/** アーキテクチャ適合検証で用意する rules.json の雛形(arch-guard が中身を埋める) */
export function buildArchRulesTemplate(projectName: string): string {
  return (
    JSON.stringify(
      {
        $comment:
          "アーキテクチャ規約の単一情報源。arch-guard がリバースドキュメントとユーザーへの確認をもとに layers / rules を埋める。id(ARCH-01 …)は一度振ったら変えない。",
        project: projectName,
        tool: "",
        command: "",
        layers: [],
        rules: [],
        notes: [],
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * JUnit XML を ARCH 行に変換するスクリプト(.claude/atf-arch/report-junit.mjs)。
 * ArchUnit 系のツールは「規約 1 件 = テスト 1 件」で書けるため、テスト名の先頭を規約 id にすれば
 * 言語を問わずこの 1 本で配線できる(Java / TypeScript / Python / .NET)。
 */
export const REPORT_JUNIT_MJS = `#!/usr/bin/env node
// JUnit XML(テストランナーの出力)を、atf arch が解釈する ARCH 行に変換する。
//
//   node .claude/atf-arch/report-junit.mjs .arch/junit.xml
//   node .claude/atf-arch/report-junit.mjs build/test-results/test/*.xml
//
// テスト形式のアーキテクチャ検証ツール(ArchUnit / ArchUnitTS / ArchUnitPython /
// NetArchTest など)は「規約 1 件 = テスト 1 件」で書けるので、
// **テスト名の先頭に規約 id を入れておく**だけでこのスクリプトが対応づけられる:
//
//   ARCH-01: domain must not depend on infra   (Java / TypeScript)
//   test_arch_01_domain_must_not_depend_on_infra  (Python。_ 区切りでよい)
//
// 規約 id を含まないテストは無視するので、他のテストが混ざっていてもよい。
import { readFileSync, existsSync } from "node:fs";

const files = process.argv.slice(2).filter((f) => existsSync(f));
if (files.length === 0) {
  console.error("使い方: node report-junit.mjs <JUnit XML> [...]  (読めるファイルがありません)");
  process.exit(2);
}

/**
 * テスト名から規約 id を取り出す(ARCH-01 / arch_01 / ARCH 01 を ARCH-01 に正規化する)。
 * 規約 id は連番(ARCH-01 …)を前提にしており、数字で始まらないものは拾わない
 * — \`test_architecture\` のような普通の名前を規約と誤認しないため。
 */
function ruleIdOf(name) {
  const m = /(?:^|[^A-Za-z])ARCH[-_ ]?(\\d[A-Za-z0-9-]*)/i.exec(name);
  return m ? \`ARCH-\${m[1].toUpperCase()}\` : undefined;
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, " ")
    .replace(/&amp;/g, "&");
}

function attr(tag, key) {
  const m = new RegExp(\`\\\\b\${key}="([^"]*)"\`).exec(tag);
  return m ? unescapeXml(m[1]) : "";
}

/** 詳細は 1 行に畳む(ARCH 行は 1 規約 1 行のため) */
function oneLine(text, limit = 200) {
  const flat = text.replace(/\\s+/g, " ").trim();
  return flat.length > limit ? \`\${flat.slice(0, limit)}…\` : flat;
}

// 規約 id → 集計(同じ規約に複数のテストがぶら下がってもよい)
const byRule = new Map();

for (const file of files) {
  const xml = readFileSync(file, "utf8");
  // <testcase .../> と <testcase ...>…</testcase> の両方を拾う
  const cases = xml.matchAll(/<testcase\\b([^>]*?)(\\/>|>([\\s\\S]*?)<\\/testcase>)/g);
  for (const [, rawAttrs, closing, body = ""] of cases) {
    const tag = \`<testcase \${rawAttrs}>\`;
    const rule = ruleIdOf(\`\${attr(tag, "classname")} \${attr(tag, "name")}\`);
    if (!rule) continue;

    const entry = byRule.get(rule) ?? { violations: 0, errors: 0, skipped: 0, total: 0, detail: "" };
    entry.total += 1;

    const inner = closing === "/>" ? "" : body;
    const failure = /<(failure|error|skipped)\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/\\1>)/.exec(inner);
    if (failure) {
      const [, kind, failAttrs, text = ""] = failure;
      if (kind === "failure") entry.violations += 1;
      else if (kind === "error") entry.errors += 1;
      else entry.skipped += 1;
      if (!entry.detail) {
        const message = attr(\`<x \${failAttrs}>\`, "message") || unescapeXml(text);
        entry.detail = oneLine(message);
      }
    }
    byRule.set(rule, entry);
  }
}

if (byRule.size === 0) {
  console.error(
    "規約 id を含むテストが見つかりません。テスト名の先頭を ARCH-01 のようにしてください " +
      \`(読んだファイル: \${files.join(", ")})\`,
  );
  process.exit(1);
}

for (const [rule, e] of [...byRule].sort(([a], [b]) => a.localeCompare(b))) {
  if (e.errors > 0) console.log(\`ARCH \${rule} ERROR \${e.detail || "テストがエラーで終了した"}\`);
  else if (e.violations > 0) console.log(\`ARCH \${rule} VIOLATION \${e.violations} \${e.detail}\`.trimEnd());
  else if (e.skipped === e.total) console.log(\`ARCH \${rule} ERROR \${e.detail || "テストがスキップされた(未検証)"}\`);
  else console.log(\`ARCH \${rule} PASS\`);
}
`;

/**
 * アーキテクチャ検証の実行スクリプトの雛形。
 * 検証の実体は言語ごとのツール(ArchUnit など)なので、atf は**出力形式だけ**を決め、
 * 中身は arch-guard が埋める(未設定のままでも「未設定」と分かる行を出して終わる)。
 * 検出した言語の推奨ツールの実行例をコメントで入れておくので、arch-guard はそれを外して配線する
 * (実装例の単一情報源はカタログ = templates/arch-tools.json)。
 */
export function buildRunArchCheckSh(languages: string[] = []): string {
  const recommended = recommendedArchTools(loadArchToolCatalog(), languages);
  const examples =
    recommended.length > 0
      ? recommended
          .map((tool) =>
            [
              `#   # ${tool.languages.map(languageLabel).join(" / ")}: ${tool.name}`,
              ...(tool.run ? [`#   ${tool.run}`] : []),
              ...(tool.report ? [`#   # → ${tool.report}`] : []),
            ].join("\n"),
          )
          .join("\n#\n")
      : [
          "#   # Java / Kotlin / Scala: ArchUnit(テスト名の先頭を規約 id にして JUnit XML を変換する)",
          "#   ./gradlew test --tests '*ArchitectureTest*' || true",
          "#   node .claude/atf-arch/report-junit.mjs build/test-results/test/*.xml",
          "#",
          "#   # TypeScript: dependency-cruiser(ルール名を規約 id に対応させる)",
          "#   npx depcruise --config .dependency-cruiser.js --output-type json src > /tmp/dc.json",
        ].join("\n");

  return `#!/usr/bin/env bash
# アーキテクチャ適合検証を実行する。
#   使い方: bash .claude/atf-arch/run-arch-check.sh
#
# 出力規約(atf arch が解釈する形式。規約ごとに 1 行):
#   ARCH <規約 id> <PASS|VIOLATION|ERROR> [違反件数] [詳細]
#
# .claude/atf-arch/rules.json に定義したすべての規約について 1 行を出すこと。
# 行がない規約は「未検証」として適合ゲートを通らない。
#
# テスト形式のツール(ArchUnit / ArchUnitTS / ArchUnitPython / NetArchTest)は、
# テスト名の先頭を規約 id にしておけば JUnit XML をそのまま変換できる:
#   node .claude/atf-arch/report-junit.mjs <JUnit XML ...>
#
# 実装例(コメントを外して、このリポジトリに合わせて書き換える。詳しくは README.md):
#
${examples}
#
set -uo pipefail

echo "ARCH (未設定) ERROR ${ARCH_RUNNER_TEMPLATE_MARK}"
exit 2
`;
}

/** エージェント定義の {{placeholder}} に渡す値 */
export function buildTemplateVars(
  profile: RepoProfile,
  requirements: Requirements,
): Record<string, string> {
  // 技術スタックはカテゴリ付きの表示名で扱う(liquibase → Liquibase(マイグレーション))
  const techStackLines = formatTechStack(loadTechStackCatalog(), requirements.techStack);
  return {
    projectName: profile.name,
    languages: profile.languages.join(", ") || "(未検出)",
    frameworks: profile.frameworks.join(", ") || "(未検出)",
    techStack:
      techStackLines.map((l) => `${l.category}: ${l.items.join(", ")}`).join(" / ") || "(未設定)",
    phase: requirements.phase,
    focus: requirements.focus.join(", "),
    githubRepo: requirements.githubRepo ?? "(未設定)",
  };
}

/** 全エージェント定義に付与する、有効な機能ぶんの指示 */
export function buildCommonInstruction(
  requirements: Requirements,
  designSkills: InstalledSkill[] = [],
): string {
  const techStackLines = formatTechStack(loadTechStackCatalog(), requirements.techStack);
  const touchpoints = requirements.touchpoints ?? [];
  return (
    (techStackLines.length > 0 ? techStackInstruction(techStackLines) : "") +
    (requirements.issueDriven
      ? issueDrivenInstruction(requirements.githubRepo, touchpoints.includes("issue-approval"))
      : "") +
    (requirements.prFlow
      ? prFlowInstruction(requirements.githubRepo, touchpoints.includes("pr-merge"))
      : "") +
    (requirements.formalSpec
      ? formalSpecInstruction(requirements.specAutoFix ?? true)
      : "") +
    (requirements.reverseDocs ? reverseDocsInstruction() : "") +
    (requirements.archCheck ? archCheckInstruction() : "") +
    (designSkills.length > 0 ? designSkillInstruction(designSkills) : "")
  );
}

/** env-builder にのみ付与する整備指示 */
export function buildEnvBuilderInstruction(
  requirements: Requirements,
  designSkills: InstalledSkill[] = [],
): string {
  return (
    (requirements.issueDriven ? envBuilderIssueInstruction(requirements.githubRepo) : "") +
    (requirements.formalSpec ? envBuilderSpecInstruction() : "") +
    (requirements.capabilityScout ? envBuilderCapabilityInstruction() : "") +
    (requirements.reverseDocs ? envBuilderReverseInstruction() : "") +
    (requirements.archCheck ? envBuilderArchInstruction() : "") +
    (requirements.rubricEval ? envBuilderEvalInstruction() : "") +
    (designSkills.length > 0 ? envBuilderSkillInstruction() : "")
  );
}

/** オーケストレーターにのみ付与する、タッチポイントとゲートの指示 */
export function buildOrchestratorInstruction(
  requirements: Requirements,
  designSkills: InstalledSkill[] = [],
): string {
  return (
    orchestratorTouchpointInstruction(requirements.touchpoints ?? []) +
    (requirements.issueDriven ? orchestratorIssueInstruction(requirements.githubRepo) : "") +
    (requirements.formalSpec
      ? orchestratorSpecGateInstruction(requirements.specAutoFix ?? true)
      : "") +
    (requirements.reverseDocs ? orchestratorReverseInstruction() : "") +
    (requirements.archCheck ? orchestratorArchGateInstruction() : "") +
    (requirements.rubricEval ? orchestratorEvalGateInstruction() : "") +
    (requirements.capabilityScout ? orchestratorCapabilityScoutInstruction() : "") +
    (designSkills.length > 0 ? orchestratorSkillInstruction(designSkills) : "")
  );
}

/**
 * ダッシュボードの構成図に描く辺を組み立てる。
 * プリセットの辺に、有効な機能ぶんのエージェント(teamSize の枠外で追加されるもの)を足す。
 */
export function buildFlow(
  presetFlow: string[][] | undefined,
  requirements: Requirements,
  firstAgent?: string,
): string[][] {
  const flow = [...(presetFlow ?? [])];
  if (requirements.reverseDocs && firstAgent) {
    // 現状の構造を示す文書 → 実装
    flow.push(["doc-reverser", firstAgent]);
  }
  if (requirements.archCheck && firstAgent) {
    // 実装 → 適合検証
    flow.push([firstAgent, "arch-guard"]);
    // 文書化したアーキテクチャ → 規約化
    if (requirements.reverseDocs) flow.push(["doc-reverser", "arch-guard"]);
  }
  // 形式仕様モードでは、タスクの供給元と実装エージェントのあいだに検証ゲートが入る
  if (requirements.formalSpec && firstAgent) flow.push(["spec-formalizer", firstAgent]);

  const implEntry = requirements.formalSpec ? "spec-formalizer" : firstAgent;
  if (requirements.issueDriven && implEntry) flow.push(["issue-manager", implEntry]);

  const entryAgent = requirements.issueDriven ? "issue-manager" : implEntry;
  if (entryAgent) flow.push(["orchestrator", entryAgent]);

  if (requirements.capabilityScout) flow.push(["capability-scout", "orchestrator"]);

  // ルーブリック評価では、実装の成果物が evaluator に渡り、判定がまとめ役に返る
  if (requirements.rubricEval && firstAgent) {
    flow.push([firstAgent, "evaluator"]);
    flow.push(["evaluator", "orchestrator"]);
  }
  return flow;
}

/** 既存ファイルを壊さずに足場を書き出す(--force なしでは上書きしない) */
function writeScaffold(dest: string, content: string, force?: boolean, mode?: number): void {
  if (existsSync(dest) && !force) return;
  writeFileSync(dest, content);
  if (mode !== undefined) chmodSync(dest, mode);
}

/**
 * ルートモジュール(spec/main.als)の雛形。
 *
 * 必須タグは値を埋めずに `TODO:` で置く。`atf lint` が「ルートモジュールに @title がない」
 * ではなく「TODO のまま」を目に見える形で残せるようにするためで、
 * **何を作るかの合意はここをユーザーと埋めるところから始まる**(旧インセプションデッキの役割)。
 */
export function buildRootModel(projectName: string, frame?: SpecFrame): string {
  // 新規開発のヒアリングで枠が決まっていれば埋め、なければ TODO のまま配る
  // (TODO は「何を作るかの合意がまだ無い」という状態で、atf lint が違反として報告する)
  const outOfScope = (frame?.outOfScope ?? []).filter((s) => s.trim() !== "");
  const tags = frame
    ? [
        `@title  ${frame.title}`,
        `@scope  ${frame.scope}`,
        ...(outOfScope.length > 0
          ? outOfScope.map((s) => `@out-of-scope ${s}`)
          : ["@out-of-scope TODO: 意図的に扱わない範囲(性能・UI 文言・外部サービスの挙動など)"]),
        `@stakeholder ${frame.stakeholder}`,
        `@tradeoff ${frame.tradeoff}`,
      ]
    : [
        "@title  TODO: 仕様全体の名称",
        "@scope  TODO: この仕様が扱う範囲(何の構造・不変条件・状態遷移を決めるのか)",
        "@out-of-scope TODO: 意図的に扱わない範囲(性能・UI 文言・外部サービスの挙動など。複数行に分けてよい)",
        "@stakeholder TODO: 承認者 (承認: YYYY-MM-DD)",
        "@tradeoff TODO: トレードオフが必要になったときに最優先するもの(品質 / 期日 / スコープ / コスト)",
      ];

  // atf からの案内は行コメントで書く。doc comment の散文は weave の生成物に
  // 「仕様の説明」として出るので、プロダクトの話だけを入れる
  const guide = frame
    ? `// ${projectName} の形式仕様。**ここが要件・仕様の単一情報源**です。
// 枠(名称・範囲・扱わない範囲・承認・トレードオフ)はヒアリングで決めました。
// ここから関心事ごとにモジュールを足していきます(担当: spec-formalizer)。
// 書式とタグ語彙は spec/README.md を参照。自然言語の文書は bash atf-bin/weave.sh で生成します。`
    : `// ${projectName} の形式仕様。**ここが要件・仕様の単一情報源**です。
// まず下の TODO をユーザーと埋めるところから始めます(担当: spec-formalizer)。
// 埋まるまで bash atf-bin/lint.sh は通りません。
// 書式とタグ語彙は spec/README.md を参照。自然言語の文書は bash atf-bin/weave.sh で生成します。`;

  return `${guide}

/**
${tags.map((t) => ` * ${t}`).join("\n")}
 */
module main

// 関心事ごとのモジュールをここで open する
// open order
`;
}

/**
 * 形式仕様モードの足場。
 *
 * - `spec/` … 仕様(手書き。ここが正)。書式ガイド・ルートモジュールの雛形・Alloy 実行スクリプト
 * - `docs/adr/` … 決定の履歴(手書き)。書式ガイド
 * - `.claude/atf-formal/` … 検証記録と解説ページの形式(atf とエージェントの記録)
 *
 * 生成物(`docs/generated/`)はここでは作らない。`atf weave` の仕事。
 */
export function writeFormalScaffold(
  repoPath: string,
  projectName: string,
  opts: { force?: boolean; specFrame?: SpecFrame } = {},
): string {
  // 旧レイアウト(.claude/atf-specs/)が残っていれば、いまの置き場へ移してから配る
  migrateLegacySpecs(repoPath);

  const dir = specDir(repoPath);
  mkdirSync(dir, { recursive: true });
  writeScaffold(join(dir, "README.md"), buildSpecReadme(projectName), opts.force);
  writeScaffold(join(dir, "run-alloy.sh"), RUN_ALLOY_SH, opts.force, 0o755);
  // ルートモジュールは仕様そのもの。既にあれば絶対に上書きしない(--force でも触らない)
  if (!existsSync(join(dir, ROOT_MODEL))) {
    writeFileSync(join(dir, ROOT_MODEL), buildRootModel(projectName, opts.specFrame));
  }

  const adr = adrDir(repoPath);
  mkdirSync(adr, { recursive: true });
  writeScaffold(join(adr, "README.md"), buildAdrReadme(projectName), opts.force);

  const records = formalDir(repoPath);
  mkdirSync(records, { recursive: true });
  // 解説ページのテンプレート。プロジェクトで形式を変えられるように配り、
  // init / apply では --force なしで上書きしない(atf update は基本上書きで最新版に入れ替える)
  writeScaffold(join(records, EXPLAIN_TEMPLATE_FILE), bundledExplainTemplate(), opts.force);

  // 派生文書を .als と対の状態にしておく(生成物なので毎回作り直してよい)
  runWeave(repoPath, projectName);
  return dir;
}

/** リバースドキュメントの足場(索引の置き場と書式ガイド) */
export function writeDocsScaffold(
  repoPath: string,
  projectName: string,
  opts: { force?: boolean } = {},
): string {
  const dir = docsDir(repoPath);
  mkdirSync(dir, { recursive: true });
  writeScaffold(join(dir, "README.md"), buildDocsReadme(projectName), opts.force);
  return dir;
}

/** Issue 駆動の足場(ドラフトの置き場と書式ガイド) */
export function writeIssuesScaffold(
  repoPath: string,
  projectName: string,
  githubRepo?: string,
  opts: { force?: boolean } = {},
): string {
  const dir = issuesDir(repoPath);
  mkdirSync(dir, { recursive: true });
  writeScaffold(join(dir, "README.md"), buildIssuesReadme(projectName, githubRepo), opts.force);
  return dir;
}

/** アーキテクチャ適合検証の足場(書式ガイド・規約の雛形・検証スクリプト) */
export function writeArchScaffold(
  repoPath: string,
  projectName: string,
  languages: string[] = [],
  opts: { force?: boolean } = {},
): string {
  const dir = archDir(repoPath);
  mkdirSync(dir, { recursive: true });
  writeScaffold(join(dir, "README.md"), buildArchReadme(projectName, languages), opts.force);
  // 規約は arch-guard が埋める。雛形は上書きしない(手で書いた規約を壊さない)
  writeScaffold(archRulesPath(repoPath), buildArchRulesTemplate(projectName), opts.force);
  writeScaffold(archRunnerPath(repoPath), buildRunArchCheckSh(languages), opts.force, 0o755);
  // ArchUnit 系のツール(テスト形式)を 1 本で配線するための変換スクリプト。
  // テスト名の先頭を規約 id にすれば言語を問わず使える
  writeScaffold(archReportJunitPath(repoPath), REPORT_JUNIT_MJS, opts.force, 0o755);
  return dir;
}

/** ルーブリック評価の足場(書式ガイドと評価基準の雛形) */
export function writeEvalScaffold(
  repoPath: string,
  projectName: string,
  targets: string[] = [],
  opts: { force?: boolean } = {},
): string {
  const dir = evalDir(repoPath);
  mkdirSync(dir, { recursive: true });
  writeScaffold(join(dir, "README.md"), buildEvalReadme(projectName, targets), opts.force);
  // 評価観点は evaluator が埋める。雛形は上書きしない(手で書いた基準を壊さない)
  writeScaffold(rubricPath(repoPath), buildRubricTemplate(projectName), opts.force);
  // ネクストアクションは後から足した項目なので、それ以前のルーブリックには存在しない。
  // 観点・水準には触れず、欠けている actions だけを既定で補う
  ensureRubricActions(repoPath);
  return dir;
}

/** 最新機能スカウトの足場(調査結果・計画書の置き場と書式ガイド) */
export function writeCapabilitiesScaffold(
  repoPath: string,
  projectName: string,
  focus: string[] = [],
  opts: { force?: boolean } = {},
): string {
  const dir = capabilitiesDir(repoPath);
  mkdirSync(dir, { recursive: true });
  writeScaffold(join(dir, "README.md"), buildCapabilitiesReadme(projectName, focus), opts.force);
  return dir;
}

export interface GenerateResult {
  agentsDir: string;
  written: string[];
  dashboardPath: string;
  /** 形式仕様モードのとき、.als を置くディレクトリ(spec/) */
  specDir?: string;
  /** 最新機能スカウトのとき、調査結果と組み込み計画書を置くディレクトリ */
  capabilitiesDir?: string;
  /** リバースドキュメントモードのとき、文書の索引を置くディレクトリ */
  docsDir?: string;
  /** Issue 駆動のとき、Issue ドラフトを置くディレクトリ */
  issuesDir?: string;
  /** アーキテクチャ適合検証のとき、規約と検証記録を置くディレクトリ */
  archDir?: string;
  /** ルーブリック評価のとき、評価基準と評価記録を置くディレクトリ */
  evalDir?: string;
  /** デザインスキルを導入したとき、スキルを置いたディレクトリ */
  skillsDir?: string;
  /** atf を呼ぶ実行スクリプトを置いたディレクトリ(プロジェクト直下の atf-bin) */
  binDir: string;
  /** チーム設定(atf-settings.yaml)のパス。チーム構成の単一情報源 */
  settingsPath: string;
}

/**
 * プリセットのエージェント定義を対象リポジトリの .claude/agents/ に書き込み、
 * チーム設定(atf-settings.yaml)とダッシュボード(.claude/atf-dashboard.html)を生成する。
 * 既存のエージェント定義は force 指定がない限り上書きしない。
 */
export function generateTeam(
  preset: Preset,
  profile: RepoProfile,
  requirements: Requirements,
  opts: { force?: boolean; specFrame?: SpecFrame } = {},
): GenerateResult {
  const claudeDir = join(profile.path, ".claude");
  const agentsDir = join(claudeDir, "agents");
  mkdirSync(agentsDir, { recursive: true });

  const techStackLines = formatTechStack(loadTechStackCatalog(), requirements.techStack);
  const vars = buildTemplateVars(profile, requirements);

  // スキルは対象リポジトリの .claude/skills/ に配置する。
  // デザインスキル(ヒアリングで選択)に加えて、リバースドキュメントモードでは
  // 図の生成に使う archify を同じ仕組みで配る(分類 diagram で区別する)
  const skillIds = [
    ...(requirements.designSkills ?? []),
    ...(requirements.reverseDocs ? [DIAGRAM_SKILL_ID] : []),
  ];
  const skillResult = skillIds.length
    ? installSkills(profile.path, skillIds, {
        force: opts.force,
        projectName: profile.name,
      })
    : undefined;
  const installedSkills = skillResult?.installed ?? [];
  // エージェント定義への指示は「実際に配置できたスキル」だけを対象にする。
  // UI 実装時の指示(designSkillInstruction)は図のスキルを含めない
  const designSkills = installedSkills.filter((s) => s.category !== "diagram");

  const limit = TEAM_SIZE_LIMIT[requirements.teamSize] ?? Infinity;
  const selected = preset.agents.slice(0, limit);
  const written: string[] = [];
  const teamAgents: TeamAgent[] = [];
  const touchpoints = requirements.touchpoints ?? [];
  const extraInstruction = buildCommonInstruction(requirements, designSkills);

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
      render(template, vars) +
        extraInstruction +
        evalAgentInstruction(agentFile, requirements) +
        extra +
        runLogInstruction(meta.name),
    );
    written.push(agentFile);
  };

  for (const agentFile of selected) {
    writeAgent(agentFile, join(preset.dir, "agents"));
  }

  // 実行環境(ハーネス・ガードレール・フィードバックループ)の整備役は
  // 全チーム共通で追加する(teamSize の枠は消費しない)
  writeAgent("env-builder.md", commonRoot(), buildEnvBuilderInstruction(requirements, designSkills));

  // リバースドキュメントモードなら doc-reverser を追加(teamSize の枠は消費しない)。
  // 文書はチームの共通の前提になるため、実装エージェントへ流れる辺を描く
  if (requirements.reverseDocs) {
    writeAgent("doc-reverser.md", commonRoot());
  }
  // アーキテクチャ適合検証なら arch-guard を追加(teamSize の枠は消費しない)。
  // 実装の後段に入り、規約違反を検出するゲートになる
  if (requirements.archCheck) {
    writeAgent("arch-guard.md", commonRoot());
  }

  // 形式仕様モードなら spec-formalizer を追加(teamSize の枠は消費しない)。
  // タスクの供給元と実装エージェントのあいだに入り、実装前の検証ゲートになる
  const firstAgent = teamAgents[0]?.name;
  if (requirements.formalSpec) {
    writeAgent("spec-formalizer.md", commonRoot(), specFormalizerInstruction(requirements));
  }

  // Issue 駆動なら issue-manager を追加(teamSize の枠は消費しない)し、
  // チームの入口(形式仕様モードなら spec-formalizer)へタスクを流すフローを描く
  if (requirements.issueDriven) {
    writeAgent("issue-manager.md", commonRoot());
  }
  const flow = buildFlow(preset.flow, requirements, firstAgent);

  // チーム全体をまとめ上げるオーケストレーターを全チーム共通で追加する(teamSize の枠外)。
  // タッチポイントでの一時停止指示・形式検証ゲートはオーケストレーターにのみ付与する
  writeAgent(
    "orchestrator.md",
    commonRoot(),
    buildOrchestratorInstruction(requirements, designSkills),
  );

  // 最新機能スカウトを追加(teamSize の枠外)。調査結果(採否表・組み込み計画書)は
  // オーケストレーターに渡り、ユーザーの承認を経てタスクになる
  if (requirements.capabilityScout) {
    writeAgent("capability-scout.md", commonRoot());
  }

  // ルーブリック評価なら evaluator を追加(teamSize の枠外)。
  // 評価対象のエージェントごとの ON/OFF は、ここまでに確定したチーム構成から表にして
  // atf-settings.yaml に書き出す(ユーザーが false に変えて外せるようにするため)
  if (requirements.rubricEval) {
    requirements.evalTargets = buildEvalTargets(teamAgents, requirements.evalTargets);
    writeAgent("evaluator.md", commonRoot());
  }

  // チーム設定を記録(再生成・ダッシュボード生成の入力になる単一情報源)
  const manifest: TeamManifest = {
    generatedBy: "agent-team-factory",
    preset: preset.id,
    presetName: preset.name,
    project: profile.name,
    requirements,
    agents: teamAgents,
    flow,
    ...(installedSkills.length > 0 ? { skills: installedSkills } : {}),
  };
  // 設定はプロジェクトのルートに置く(人が requirements を読み書きするファイルのため)。
  // 旧 .claude/team.json が残っていれば、ここで移行して消える
  const settingsFile = saveTeamSettings(profile.path, manifest);

  // 機能ごとの足場を用意する(既存ファイルは --force なしでは上書きしない)
  const specsPath = requirements.formalSpec
    ? writeFormalScaffold(profile.path, profile.name, opts)
    : undefined;
  const capabilitiesPath = requirements.capabilityScout
    ? writeCapabilitiesScaffold(profile.path, profile.name, requirements.focus, opts)
    : undefined;
  const docsPath = requirements.reverseDocs
    ? writeDocsScaffold(profile.path, profile.name, opts)
    : undefined;
  const issuesPath = requirements.issueDriven
    ? writeIssuesScaffold(profile.path, profile.name, requirements.githubRepo, opts)
    : undefined;
  const archPath = requirements.archCheck
    ? writeArchScaffold(profile.path, profile.name, profile.languages, opts)
    : undefined;
  const evalPath = requirements.rubricEval
    ? writeEvalScaffold(
        profile.path,
        profile.name,
        Object.entries(requirements.evalTargets ?? {})
          .filter(([, on]) => on !== false)
          .map(([name]) => name),
        opts,
      )
    : undefined;

  // ゲート・点検コマンドの入口(atf-bin/*.sh)を用意する。
  // atf が内容を決めるファイルなので毎回上書きする(手で編集する前提のスクリプトは置かない)
  const bin = installAtfBin(profile.path, requirements);

  // ダッシュボードを生成(既存の実行記録・タスクドラフト・形式仕様があれば反映)
  const dashboardPath = join(claudeDir, "atf-dashboard.html");
  writeFileSync(
    dashboardPath,
    buildDashboardHtml(
      manifest,
      loadRuns(profile.path),
      loadTaskDrafts(profile.path),
      loadSpecState(profile.path),
      {
        findings: loadCapabilityFindings(profile.path),
        plans: loadCapabilityPlans(profile.path),
      },
      loadArchitectureState(profile.path),
      loadEvaluationState(profile.path),
    ),
  );

  return {
    agentsDir,
    written,
    dashboardPath,
    specDir: specsPath,
    capabilitiesDir: capabilitiesPath,
    docsDir: docsPath,
    issuesDir: issuesPath,
    archDir: archPath,
    evalDir: evalPath,
    skillsDir: installedSkills.length > 0 ? skillResult?.dir : undefined,
    binDir: bin.dir,
    settingsPath: settingsFile,
  };
}
