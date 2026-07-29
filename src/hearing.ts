import { select, checkbox } from "@inquirer/prompts";
import type { Requirements } from "./types.js";

/** 対話ヒアリングで要件を収集する */
export async function hearRequirements(): Promise<Requirements> {
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

  return { phase, focus, teamSize };
}
