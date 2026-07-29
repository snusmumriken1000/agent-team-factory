import { select, checkbox, confirm, input } from "@inquirer/prompts";
import { TRADEOFF_LABEL } from "./types.js";
import type { InceptionDeck, Requirements } from "./types.js";

const required = (v: string) => v.trim() !== "" || "入力してください";

/** カンマ(和文・欧文)区切りの入力をリストに分解する */
const splitList = (v: string): string[] =>
  v
    .split(/[、,]/)
    .map((s) => s.trim())
    .filter(Boolean);
const requiredList = (v: string) => splitList(v).length > 0 || "1件以上入力してください";
const tradeoffChoices: { name: string; value: InceptionDeck["tradeoffPriority"] }[] = [
  { name: TRADEOFF_LABEL.quality, value: "quality" },
  { name: TRADEOFF_LABEL.deadline, value: "deadline" },
  { name: TRADEOFF_LABEL.scope, value: "scope" },
  { name: TRADEOFF_LABEL.cost, value: "cost" },
];

/**
 * インセプションデッキ(何を作るかの合意)をヒアリングする。
 * 新規開発(greenfield)では作りたいものを明らかにする必要があるため、
 * アジャイル初期のインセプションデッキに相当する内容を対話で収集する。
 */
export async function hearInception(): Promise<InceptionDeck> {
  console.log("\n新規開発のため、インセプションデッキ(何を作るかの合意)をヒアリングします。");
  console.log("回答は .claude/inception-deck.md に書き出され、全エージェントの作業指針になります。\n");

  const purpose = await input({
    message: "なぜ作るのですか?(背景・解決したい課題)",
    validate: required,
  });
  const targetUsers = await input({
    message: "誰のためのプロダクトですか?(対象ユーザー)",
    validate: required,
  });
  const coreValue = await input({
    message: "中核となる価値は?(既存の代替手段との違い)",
    validate: required,
  });
  const mustHave = splitList(
    await input({
      message: "必ず実現することは?(カンマ区切りで複数可)",
      validate: requiredList,
    }),
  );
  const notList = splitList(
    await input({
      message: "やらないことリストは?(カンマ区切りで複数可。スコープ外を明確にします)",
      validate: requiredList,
    }),
  );
  const successCriteria = await input({
    message: "成功をどう判断しますか?(成功基準)",
    validate: required,
  });
  const risks = (
    await input({ message: "いちばん心配なこと(リスク)は?(空欄可)" })
  ).trim();
  const tradeoffPriority = await select<InceptionDeck["tradeoffPriority"]>({
    message: "トレードオフが必要になったとき、何を最優先しますか?",
    choices: tradeoffChoices,
  });

  return { purpose, targetUsers, coreValue, mustHave, notList, successCriteria, risks, tradeoffPriority };
}

/**
 * 対話ヒアリングで要件を収集する。
 * @param detectedGithubRepo 対象リポジトリの git remote から検出した GitHub リポジトリ(デフォルト値として提示)
 */
export async function hearRequirements(detectedGithubRepo?: string): Promise<Requirements> {
  const phase = await select({
    message: "プロジェクトの開発フェーズは?",
    choices: [
      { name: "新規開発(ゼロから立ち上げ)", value: "greenfield" },
      { name: "活発に開発中(機能追加が中心)", value: "active" },
      { name: "保守・運用(安定性が最優先)", value: "maintenance" },
    ],
  });

  // 新規開発では何を作りたいかを明らかにする必要があるため、インセプションデッキを先に作る
  const inception = phase === "greenfield" ? await hearInception() : undefined;

  const focus = await checkbox({
    message: "重視する観点を選んでください(複数可)",
    choices: [
      { name: "コード品質・レビュー", value: "quality" },
      { name: "セキュリティ", value: "security" },
      { name: "開発スピード", value: "speed" },
      { name: "テスト・QA", value: "testing" },
      { name: "バッチ処理・データパイプライン", value: "batch" },
      { name: "モバイルアプリ", value: "mobile" },
      { name: "インフラ・運用基盤", value: "infra" },
      { name: "ドキュメント", value: "docs" },
      { name: "新規サービスの企画・検討", value: "planning" },
    ],
    required: true,
  });

  const teamSize = await select({
    message: "チーム規模の希望は?",
    choices: [
      { name: "最小構成(2〜3 エージェント)", value: "minimal" },
      { name: "標準構成(4〜5 エージェント)", value: "standard" },
      { name: "フル構成(役割を細分化)", value: "full" },
    ],
  });

  // 検出値があっても必ず確認する(検出はヒューリスティックであり、別リポジトリを使う場合もあるため)
  const githubRepoInput = await input({
    message: "使用する GitHub リポジトリは?(owner/repo 形式。使わない場合は空欄)",
    default: detectedGithubRepo,
    validate: (v) =>
      v.trim() === "" ||
      /^[\w.-]+\/[\w.-]+$/.test(v.trim()) ||
      "owner/repo 形式で入力してください(例: octocat/hello-world)",
  });
  const githubRepo = githubRepoInput.trim() || undefined;

  const issueDriven = await confirm({
    message:
      "Issue 駆動で開発しますか?(GitHub Issues を起点にタスクを管理し、Issue マネージャーをチームに追加します)",
    default: true,
  });

  // PR フローは GitHub リポジトリが設定されている場合のみ意味を持つ
  let prFlow = false;
  if (githubRepo) {
    prFlow = await confirm({
      message:
        "ブランチ + Pull Request のフローを含めますか?(実装をブランチで行い、push して PR を作成・マージするまでを開発手順に組み込みます)",
      default: true,
    });
  }

  return { phase, focus, teamSize, issueDriven, githubRepo, prFlow, inception };
}

/**
 * 人間のタッチポイントをどこに設けるかを選択する。
 * フロープレビュー HTML(.claude/atf-flow-preview.html)の確認を促した後に呼ぶこと。
 * 選択なし = エージェントが最後まで自動で進める(PR マージも gh pr merge で実行)。
 */
export async function hearTouchpoints(requirements: Requirements): Promise<string[]> {
  const choices: { name: string; value: string; checked?: boolean }[] = [];
  if (requirements.issueDriven) {
    choices.push({
      name: "Issue 着手前(エージェントが起票した Issue をユーザーが確認・承認してから着手する)",
      value: "issue-approval",
    });
  }
  if (requirements.prFlow) {
    choices.push({
      name: "PR マージ(エージェントは PR 作成まで。マージはユーザーがレビューして実行する)",
      value: "pr-merge",
      checked: true,
    });
  }
  if (choices.length === 0) return [];
  return checkbox({
    message:
      "人間のタッチポイントをどこに設けますか?(選択なし = エージェントがマージまで自動で進めます)",
    choices,
  });
}
