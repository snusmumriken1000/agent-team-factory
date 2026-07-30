#!/usr/bin/env node
import { Command } from "commander";
import { select, confirm } from "@inquirer/prompts";
import { analyzeRepo, applyTechStack } from "./analyzer.js";
import { hearRequirements, hearTouchpoints } from "./hearing.js";
import { loadPresets, scorePresets, uncoveredFocus } from "./presets.js";
import { generateTeam } from "./generator.js";
import { buildDashboardHtml, buildFlowPreviewHtml, loadRuns, loadTaskDrafts, loadTeamManifest } from "./report.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const program = new Command();

program
  .name("atf")
  .description("多種多様な要件にあわせたエージェントチームを、指定されたリポジトリに提供する CLI")
  .version("0.1.0");

program
  .command("analyze")
  .argument("<repo>", "対象リポジトリのパス")
  .description("対象リポジトリを解析してプロファイルを表示する")
  .action((repo: string) => {
    const profile = analyzeRepo(repo);
    console.log(JSON.stringify(profile, null, 2));
  });

program
  .command("list")
  .description("利用可能なチームプリセットを一覧表示する")
  .action(() => {
    const presets = loadPresets();
    if (presets.length === 0) {
      console.log("プリセットが見つかりません。");
      return;
    }
    for (const p of presets) {
      console.log(`${p.id.padEnd(20)} ${p.name} — ${p.description}`);
      console.log(`${"".padEnd(20)}   agents: ${p.agents.join(", ")}`);
    }
  });

program
  .command("generate")
  .argument("<repo>", "対象リポジトリのパス")
  .description("解析 + ヒアリングでエージェントチームを構成し、対象リポジトリに導入する")
  .option("-p, --preset <id>", "プリセットを直接指定(ヒアリング後の選択をスキップ)")
  .option("-f, --force", "既存のエージェント定義を上書きする")
  .action(async (repo: string, opts: { preset?: string; force?: boolean }) => {
    // 1. 自動解析
    let profile = analyzeRepo(repo);
    console.log(`\n対象: ${profile.name} (${profile.path})`);
    console.log(`  言語: ${profile.languages.join(", ") || "(未検出)"}`);
    console.log(`  フレームワーク: ${profile.frameworks.join(", ") || "(未検出)"}`);
    console.log(`  CI: ${profile.hasCI ? "あり" : "なし"} / テスト: ${profile.hasTests ? "あり" : "なし"}`);
    console.log(`  GitHub: ${profile.githubRepo ?? "(未検出)"}\n`);

    // 2. ヒアリング(GitHub リポジトリは検出値をデフォルトに必ず確認する。
    //    新規開発では技術スタックも選択させ、検出値を初期チェックとして提示する)
    const requirements = await hearRequirements(profile.githubRepo, {
      languages: profile.languages,
      frameworks: profile.frameworks,
    });
    if (requirements.techStack) {
      profile = applyTechStack(profile, requirements.techStack);
      console.log(
        `\n技術スタック: ${profile.languages.join(", ") || "(未定)"}` +
          (profile.frameworks.length > 0 ? ` / ${profile.frameworks.join(", ")}` : ""),
      );
    }

    // 3. プリセット選定(スコア上位を提示して確定)
    const presets = loadPresets();
    if (presets.length === 0) {
      console.error("プリセットが見つかりません。templates/presets を確認してください。");
      process.exitCode = 1;
      return;
    }

    let preset = opts.preset ? presets.find((p) => p.id === opts.preset) : undefined;
    if (opts.preset && !preset) {
      console.error(`プリセットが見つかりません: ${opts.preset}`);
      process.exitCode = 1;
      return;
    }

    // 重視観点がどのプリセットにもカバーされない場合は、不適切なチームを
    // 導入せず中断する(--preset での明示指定時はユーザーの判断を尊重して確認しない)
    if (!opts.preset) {
      const uncovered = uncoveredFocus(presets, requirements);
      if (uncovered.length === requirements.focus.length) {
        console.error(`\n選択された重視観点(${uncovered.join(", ")})に対応するチームテンプレートが用意されていません。`);
        console.error("管理者に新しいテンプレート(プリセット)の作成を問い合わせてください。");
        console.error("処理を中断しました(エージェントチームは導入されていません)。");
        process.exitCode = 1;
        return;
      }
      if (uncovered.length > 0) {
        console.warn(`注意: 重視観点のうち ${uncovered.join(", ")} に対応するテンプレートはありません。他の観点に基づいてチームを提案します。`);
      }
    }
    if (!preset) {
      const ranked = scorePresets(presets, profile, requirements);
      preset = await select({
        message: "適用するチームプリセットを選んでください(推奨順)",
        choices: ranked.map(({ preset, score }) => ({
          name: `${preset.name} (score: ${score}) — ${preset.description}`,
          value: preset,
        })),
      });
    }

    // 4. 開発フロープレビューを生成し、ユーザーに HTML の確認を促す
    //    (開発フロー・ブランチ / Issue / PR がどのように作成されるか・重視観点を提示)
    const claudeDir = join(profile.path, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const previewPath = join(claudeDir, "atf-flow-preview.html");
    writeFileSync(previewPath, buildFlowPreviewHtml(preset, profile, requirements));
    console.log(`\n開発フロープレビューを生成しました: ${previewPath}`);
    console.log("ブラウザで開き、開発フロー(ブランチ・Issue・PR がどのように作成されるか)と重視観点を確認してください。");
    const reviewed = await confirm({
      message: "プレビューを確認しましたか?(続行すると人間のタッチポイントの選択に進みます)",
      default: true,
    });
    if (!reviewed) {
      console.log("中止しました(プレビューを確認してから再実行してください)。");
      return;
    }

    // 5. 人間のタッチポイントをどこに設けるかを問い合わせる
    requirements.touchpoints = await hearTouchpoints(requirements);

    // 6. 確認して導入
    const ok = await confirm({
      message: `${preset.name} を ${profile.path}/.claude/agents/ に導入します。よろしいですか?`,
    });
    if (!ok) {
      console.log("中止しました。");
      return;
    }

    const result = generateTeam(preset, profile, requirements, { force: opts.force });
    if (result.written.length === 0) {
      console.log("新規に書き込んだファイルはありません(既存定義をスキップ。上書きは --force)。");
    } else {
      console.log(`\n導入完了: ${result.agentsDir}`);
      for (const f of result.written) console.log(`  + ${f}`);
    }
    if (requirements.prFlow) {
      console.log(
        `PR フロー: 有効(マージ: ${requirements.touchpoints?.includes("pr-merge") ? "ユーザーが実行" : "エージェントが実行"})`,
      );
    }
    if (requirements.touchpoints && requirements.touchpoints.length > 0) {
      console.log(`人間のタッチポイント: ${requirements.touchpoints.join(", ")}`);
    }
    if (result.inceptionDeckPath) {
      console.log(`インセプションデッキ: ${result.inceptionDeckPath}`);
    }
    console.log(`ダッシュボード: ${result.dashboardPath}(ブラウザで開くと構成図を確認できます)`);
  });

program
  .command("report")
  .argument("<repo>", "対象リポジトリのパス")
  .description("導入済みチームの構成と実行記録を可視化した HTML ダッシュボードを再生成する")
  .option("-o, --output <file>", "出力先(デフォルト: <repo>/.claude/atf-dashboard.html)")
  .action((repo: string, opts: { output?: string }) => {
    const repoPath = resolve(repo);
    const manifest = loadTeamManifest(repoPath);
    const runs = loadRuns(repoPath);
    const tasks = loadTaskDrafts(repoPath);
    const output = opts.output
      ? resolve(opts.output)
      : join(repoPath, ".claude", "atf-dashboard.html");
    writeFileSync(output, buildDashboardHtml(manifest, runs, tasks));
    console.log(`ダッシュボードを生成しました: ${output}(実行記録 ${runs.length} 件 / タスクドラフト ${tasks.length} 件)`);
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
