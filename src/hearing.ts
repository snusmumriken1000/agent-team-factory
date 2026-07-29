import { select, checkbox, confirm, input } from "@inquirer/prompts";
import type { Requirements } from "./types.js";

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

  return { phase, focus, teamSize, issueDriven, githubRepo };
}
