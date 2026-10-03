#!/usr/bin/env node
import { Command } from "commander";
import { select, confirm } from "@inquirer/prompts";
import { analyzeRepo, applyTechStack } from "./analyzer.js";
import { hearDesignSkills, hearRequirements, hearSpecFrame, hearTouchpoints } from "./hearing.js";
import { loadPresets, scorePresets, uncoveredFocus } from "./presets.js";
import { loadCapabilityFindings, loadCapabilityPlans } from "./capabilities.js";
import { loadSkillCatalog, SKILL_CATEGORY_LABEL } from "./skills.js";
import { formatTechStack, loadTechStackCatalog } from "./techstack.js";
import { generateTeam } from "./generator.js";
import { applyDesign, isDesignSkill, normalizeDesignIds } from "./design.js";
import { applyFeatures, featureSummaries, smokeRun } from "./apply.js";
import { hasBinScript } from "./bin.js";
import { findRemovable, removeFeatures, REMOVABLE_FEATURES } from "./remove.js";
import { planUpdate, runUpdate } from "./update.js";
import type { FeatureId, SmokeResult } from "./apply.js";
import type { UpdateAsset } from "./update.js";
import {
  buildDashboardHtml,
  buildFlowPreviewHtml,
  loadArchitectureState,
  loadEvaluationState,
  loadRuns,
  loadTaskDrafts,
} from "./report.js";
import {
  ARCH_RESULT_LABEL,
  ARCH_RUNNER_HELP,
  archChecksPath,
  archRulesPath,
  isArchPass,
  loadArchRules,
  verifyArch,
} from "./arch.js";
import { docsIndexPath, loadReverseDocs, reverseDocStatuses, staleReverseDocs } from "./reverse.js";
import {
  agentEvalStatuses,
  criteriaFor,
  criterionPassScore,
  EVAL_VERDICT_SHORT,
  evalGateStatus,
  evalTargetNames,
  evaluationsPath,
  hasNextActions,
  latestEvaluations,
  loadEvaluations,
  loadRubric,
  defaultNextActions,
  nextActionItems,
  ownNextActions,
  passScoreOf,
  rubricPath,
  thresholdMismatches,
  totalScore,
} from "./evaluate.js";
import { collectProjectFeatures } from "./features.js";
import {
  hasTeamSettings,
  legacyManifestPath,
  loadTeamSettings,
  settingsPath,
} from "./settings.js";
import { renderTable } from "./table.js";
import type { TeamManifest } from "./types.js";
import {
  ALLOY_JAR_HELP,
  checksPath,
  isSatisfied,
  loadSpecModels,
  loadSpecState,
  specDir,
  SPEC_RESULT_LABEL,
  verifySpecs,
} from "./alloy.js";
import { hasLintErrors, lintFormal } from "./lint.js";
import { generatedDir, planWeave, runWeave } from "./weave.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const program = new Command();

/**
 * 導入済みチームの設定(atf-settings.yaml)を読む。
 * 未導入・壊れている場合はその場で報告して undefined を返す(呼び出し側は中断する)。
 * 旧 .claude/team.json しかなければ移行し、移行したことをユーザーに伝える。
 */
function requireTeam(projectPath: string): TeamManifest | undefined {
  if (!hasTeamSettings(projectPath)) {
    console.error(`チームが導入されていません: ${projectPath}`);
    console.error("先に `atf init <project-dir>` を実行してください。");
    process.exitCode = 1;
    return undefined;
  }
  try {
    const legacy = existsSync(legacyManifestPath(projectPath));
    const manifest = loadTeamSettings(projectPath);
    if (legacy) {
      console.log(
        `旧 .claude/team.json を ${settingsPath(projectPath)} に移行しました(team.json は削除しました)。`,
      );
    }
    return manifest;
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return undefined;
  }
}

/**
 * 生成物の見出しに使うプロジェクト名。
 * atf-bin から呼ばれる実行系(formal など)はチーム未導入でも動くため、
 * 設定が読めない場合はディレクトリ名で代用する。
 */
function projectNameOf(projectPath: string): string {
  if (hasTeamSettings(projectPath)) {
    try {
      return loadTeamSettings(projectPath).project;
    } catch {
      // 壊れた設定でも解説 HTML の生成は止めない
    }
  }
  return basename(projectPath);
}

program
  // help サブコマンドは出さない(--help / -h で足りる)
  .helpCommand(false)
  .name("atf")
  .description("多種多様な要件にあわせたエージェントチームを、指定されたプロジェクトディレクトリに提供する CLI")
  .version("0.1.0");

/** 説明文の 1 文目だけを取り出す(表の幅に収めるため。全文は定義ファイル・SKILL.md にある) */
const firstSentence = (text: string) => text.split(/[。.]\s?/)[0];

/** 同梱しているチームプリセットを一覧表示する */
function printPresets(): void {
  const presets = loadPresets();
  if (presets.length === 0) {
    console.log("プリセットが見つかりません。templates/presets を確認してください。");
    return;
  }
  console.log(
    renderTable(
      ["id", "名前", "内容", "エージェント"],
      presets.map((preset) => [
        preset.id,
        preset.name,
        firstSentence(preset.description),
        preset.agents.map((a) => a.replace(/\.md$/, "")).join("\n"),
      ]),
      { indent: "  " },
    ),
  );
  console.log("\n`atf init <project-dir>` のヒアリング後に推奨順で提示されます(`-p <id>` で直接指定)。");
}

/** 同梱しているスキルを分類ごとに一覧表示する */
function printSkills(): void {
  const catalog = loadSkillCatalog();
  if (catalog.length === 0) {
    console.log("スキルが見つかりません。templates/skills を確認してください。");
    return;
  }
  // 分類ごとに表を分ける(併用の可否など、選び方の条件が分類ごとに違うため)
  for (const category of [...new Set(catalog.map((s) => s.category))]) {
    const skills = catalog.filter((s) => s.category === category);
    console.log(`\n  [${SKILL_CATEGORY_LABEL[category] ?? category}]`);
    console.log(
      renderTable(
        ["推奨", "カタログ id", "インストール名", "内容"],
        skills.map((skill) => [
          skill.recommended ? "⭐" : "",
          skill.id,
          skill.name,
          firstSentence(skill.description),
        ]),
        { indent: "  " },
      ),
    );
  }
  console.log(
    "\n`atf apply design <project-dir>` で導入済みチームのデザインを選び直せます(エージェントへの指示も更新)。",
  );
  console.log("スキルは、それを使う機能の導入で配られます(デザイン: `atf apply design` / 図: `atf apply docs`)。");
}

program
  .command("catalog")
  .description("同梱しているチームプリセットとデザインスキルを一覧表示する")
  .action(() => {
    console.log("\nプリセット:");
    printPresets();
    console.log("\nスキル:");
    printSkills();
  });

program
  .command("init")
  .argument("<project-dir>", "対象プロジェクトのディレクトリパス")
  .description("解析 + ヒアリングでエージェントチームを構成し、対象プロジェクトに導入する")
  .option("-p, --preset <id>", "プリセットを直接指定(ヒアリング後の選択をスキップ)")
  .option("-f, --force", "既存のエージェント定義を上書きする")
  .action(async (projectDir: string, opts: { preset?: string; force?: boolean }) => {
    // 1. 自動解析
    let profile = analyzeRepo(projectDir);
    console.log(`\n対象: ${profile.name} (${profile.path})`);
    console.log(`  言語: ${profile.languages.join(", ") || "(未検出)"}`);
    console.log(`  フレームワーク: ${profile.frameworks.join(", ") || "(未検出)"}`);
    console.log(`  CI: ${profile.hasCI ? "あり" : "なし"} / テスト: ${profile.hasTests ? "あり" : "なし"}`);
    console.log(`  GitHub: ${profile.githubRepo ?? "(未検出)"}\n`);

    // 2. ヒアリング(GitHub リポジトリは検出値をデフォルトに必ず確認する。
    //    技術スタックはカテゴリごとに選択させ、検出値を初期チェックとして提示する)
    const requirements = await hearRequirements(profile.githubRepo, {
      languages: profile.languages,
      frameworks: profile.frameworks,
    });
    if (requirements.techStack) {
      profile = applyTechStack(profile, requirements.techStack);
      const picked = formatTechStack(loadTechStackCatalog(), requirements.techStack);
      if (picked.length > 0) {
        console.log("\n技術スタック:");
        for (const line of picked) {
          console.log(`  ${line.category}: ${line.items.join(", ")}`);
        }
      }
    }

    // 2-b. 新規開発では「何を作るか / 作らないか」の枠を聞き、spec/main.als に書き込む。
    //      既存プロジェクトでは聞かない(コードと運用に答えがあるので spec-formalizer が読み取る)。
    //      結果は .als にだけ入れる = 仕様の置き場を 2 つにしない
    const specFrame =
      requirements.formalSpec && requirements.phase === "greenfield"
        ? await hearSpecFrame(profile.name)
        : undefined;

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

    const result = generateTeam(preset, profile, requirements, { force: opts.force, specFrame });
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
    if (result.capabilitiesDir) {
      console.log(`最新機能スカウト: ${result.capabilitiesDir}`);
      console.log(
        "  capability-scout に調査を依頼すると、組み込めるもの / 組み込めないものの採否表と組み込み計画書が作成されます。",
      );
    }
    if (result.skillsDir) {
      const names = (loadTeamSettings(profile.path).skills ?? []).map((s) => s.name);
      console.log(`デザインスキル: ${result.skillsDir}(${names.length} 件: ${names.join(", ")})`);
      console.log(
        "  エージェントは UI・画面・スタイルを実装するときにこのスキルを読み込みます。出典とライセンスは .claude/skills/README.md を参照してください。",
      );
    }
    if (result.docsDir) {
      console.log(`リバースドキュメント: ${result.docsDir}`);
      console.log(
        "  doc-reverser にドキュメント化を依頼すると、コードから文書と図(archify)を起こし docs.jsonl に記録します。",
      );
    }
    if (result.issuesDir) {
      console.log(`Issue ドラフト: ${result.issuesDir}`);
      console.log(
        "  issue-manager が起票前のタスクを起案します(依存関係はダッシュボードのタスクグラフに表示されます)。",
      );
    }
    if (result.archDir) {
      console.log(`アーキテクチャ適合検証: ${result.archDir}`);
      console.log(
        "  arch-guard にレイヤ規約の定義と検証の実装を依頼してください。検証は `bash atf-bin/arch.sh` で実行します。",
      );
    }
    if (result.evalDir) {
      console.log(`ルーブリック評価: ${result.evalDir}`);
      console.log(
        "  evaluator に評価観点(rubric.json)の作成を依頼してください。集計は `bash atf-bin/eval.sh` で実行します。",
      );
      const targets = Object.entries(requirements.evalTargets ?? {});
      console.log(
        `  評価対象: ${targets.filter(([, on]) => on !== false).map(([name]) => name).join(", ") || "(なし)"}` +
          "(atf-settings.yaml の requirements.evalTargets でエージェントごとに ON/OFF できます)",
      );
    }
    if (result.specDir) {
      console.log(`形式仕様(Alloy)+ ADR: ${result.specDir} / ${join(profile.path, "docs", "adr")}`);
      console.log(
        "  要件・仕様の単一情報源は spec/*.als と docs/adr/ です(自然言語の仕様書は手で書かず `bash atf-bin/weave.sh` で生成)。",
      );
      console.log(
        specFrame
          ? "  ヒアリングした枠(名称・範囲・扱わない範囲・承認・トレードオフ)は spec/main.als に書き込みました。次は spec-formalizer に要件の形式化を依頼してください。"
          : "  まず spec-formalizer に spec/main.als の TODO(@title / @scope / @out-of-scope / @stakeholder)をユーザーと埋めるよう依頼してください。",
      );
    }
    console.log(`実行スクリプト: ${result.binDir}(atf が管理する入口。commit してください)`);
    console.log(
      "  ゲートと点検は `bash atf-bin/<コマンド>.sh` で実行します(リポジトリのどこからでも可)。マシン固有の atf.local.sh は .gitignore に追加済みです。",
    );
    console.log(`ダッシュボード: ${result.dashboardPath}(ブラウザで開くと構成図を確認できます)`);
    console.log(`チーム設定: ${result.settingsPath}(チーム構成の単一情報源)`);
    console.log(
      "  requirements(ヒアリング結果)を書き換えて `atf init` をやり直すと構成に反映されます。`atf status` はこの設定と実体を突き合わせます。",
    );
    console.log(
      `適用された機能の一覧は \`atf status ${projectDir}\` で確認できます(有効/無効と未整備の点検)。`,
    );
  });

/** `atf apply <機能> <project-dir>` の実処理(機能ごとの差は apply.ts の FEATURES に持たせる) */
async function runApply(
  feature: FeatureId,
  projectDir: string,
  opts: {
    force?: boolean;
    yes?: boolean;
    run?: boolean;
    autoFix?: boolean;
    askOnly?: boolean;
  },
): Promise<void> {
  const projectPath = resolve(projectDir);
  const manifest = requireTeam(projectPath);
  if (!manifest) return;

  if (!opts.yes) {
    const ok = await confirm({
      message: `${feature} を ${projectPath} に導入します(エージェント定義に指示を追記し、atf-bin にスクリプトを配ります)。よろしいですか?`,
    });
    if (!ok) {
      console.log("中止しました。");
      return;
    }
  }

  // ネクストアクションは後から足した項目なので、既存のルーブリックには無いことがある。
  // 足場の用意で補われるため、補ったかどうかを前後で見てユーザーに知らせる
  const hadActions = feature === "eval" ? hasNextActions(loadRubric(projectPath)) : true;

  const result = applyFeatures(projectPath, [feature], {
    // 指定がなければ現在の設定(atf-settings.yaml)をそのまま使う
    specAutoFix: opts.askOnly ? false : opts.autoFix ? true : undefined,
    force: opts.force,
  });

  if (feature === "eval" && !hadActions && hasNextActions(loadRubric(projectPath))) {
    console.log(
      `\n既存の rubric.json に閾値のネクストアクション(actions)がなかったため、既定を補いました: ${rubricPath(projectPath)}`,
    );
    console.log(
      "  評価観点・水準・評価記録は変更していません。文面はプロジェクトに合わせて書き換えてください(evaluator に依頼できます)。",
    );
  }
  for (const applied of result.applied) {
    console.log(`\n${applied.alreadyEnabled ? "点検" : "導入"}: ${applied.name}(${applied.id})`);
    if (applied.agentFile) console.log(`  + 担当エージェント: ${applied.agentFile}`);
    console.log(`  成果物: ${applied.scaffoldDir}`);
    console.log(`  次の一手: ${applied.next}`);
  }
  if (result.skills.length > 0) {
    console.log(`\nスキルを配置しました: ${result.skills.map((s) => s.name).join(", ")}`);
  }
  console.log(
    result.agents.length > 0
      ? `\nエージェント定義の指示を更新: ${result.agents.join(", ")}`
      : "\nエージェント定義の指示に変更はありませんでした。",
  );
  console.log(`実行スクリプト: ${result.binDir}(${result.binScripts.join(", ")})`);
  if (result.removedBinScripts.length > 0) {
    // 旧名(verify.sh → formal.sh)や、無効にした機能のスクリプトはここで消える
    console.log(`  取り除いたスクリプト: ${result.removedBinScripts.join(", ")}`);
  }
  console.log(`チーム設定: ${result.settingsPath}`);
  console.log(`ダッシュボード: ${result.dashboardPath}`);
  console.log(
    `\n適用状況は \`atf status ${projectDir}\` または \`bash atf-bin/status.sh\` で確認できます。`,
  );

  // 起票先が決まっていないと issue-manager が動けないため、その場で知らせる
  if (feature === "issue" && !manifest.requirements.githubRepo) {
    console.warn(
      "\n注意: 起票先の GitHub リポジトリが未設定です(requirements.githubRepo)。" +
        "\n  atf-settings.yaml に `githubRepo: owner/repo` を記入してから `atf apply issue` をやり直すと、" +
        "\n  各エージェントの指示に起票先(gh の -R 指定)が入ります。",
    );
  }

  if (opts.run) reportSmokeRun(feature, projectPath);
}

/**
 * 導入した機能を 1 度だけ実行して結果を表示する(`atf apply <機能> --run`)。
 *
 * 導入直後は中身(.als / 規約 / 文書の記録)が未整備なので、確認しているのは
 * 「スクリプトが配られ、そこから atf を解決できるか」という配線の健全性。
 * 未整備は想定どおりの状態として警告扱いにし、終了コードを汚さない。
 */
function reportSmokeRun(feature: FeatureId, projectPath: string): void {
  console.log(`\n--- スモーク実行: bash atf-bin/${feature}.sh ---`);
  const result = smokeRun(projectPath, feature);
  if (!result) return;
  if (result.output) console.log(indent(result.output));

  console.log(`\n${SMOKE_LABEL[result.verdict]}`);
  switch (result.verdict) {
    case "missing":
      console.error(
        `  ${result.script} がありません。\`atf apply ${feature} ${projectPath}\` をやり直してください。`,
      );
      process.exitCode = 1;
      break;
    case "unresolved":
      console.error(
        "  スクリプトから atf を解決できません(atf-bin/README.md の解決順を参照)。" +
          "\n  PATH に通す / 環境変数 ATF を設定する / atf-bin/atf.local.sh の ATF_HOME_DIR を直す、" +
          "のいずれかで解決してください(env-builder に整備を依頼することもできます)。",
      );
      process.exitCode = 1;
      break;
    case "pending":
      console.log(`  配線は正常です(スクリプトから atf を実行できました)。`);
      console.log(`  次の一手: ${result.next}`);
      break;
    case "pass":
      break;
    case "fail":
      console.error(`  終了コード ${result.code ?? "不明"}。上の出力を確認してください。`);
      process.exitCode = 1;
      break;
  }
}

/** スモーク実行の判定 → 表示ラベル */
const SMOKE_LABEL: Record<SmokeResult["verdict"], string> = {
  pass: "✅ 実行できました(ゲート通過)",
  fail: "❌ 実行できましたが、ゲートを通りませんでした",
  pending: "⬜ 未整備(導入直後は想定どおり。検証・点検の対象がまだありません)",
  unresolved: "⚠️ 実行できません(atf を解決できませんでした)",
  missing: "⚠️ 実行スクリプトが見つかりません",
};

/** スクリプトの出力を字下げして表示する */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n");
}

/**
 * 補足を括弧でくくる(中身が無ければ括弧も出さない)。
 * 担当エージェントも実行スクリプトも持たない機能(設定を配るだけの agent-log / ui-pointing)で
 * 空の括弧「()」がヘルプに残らないようにするため。
 */
function parenthesize(parts: string[]): string {
  return parts.length === 0 ? "" : `(${parts.join(" / ")})`;
}

/** ヘルプに出すサブコマンドの一覧(機能テーブルから組み立てるので、機能を増やせば自動で載る) */
const applyIds = [...featureSummaries().map((f) => f.id), "design"].join(" | ");
const removeIds = [...REMOVABLE_FEATURES.map((f) => f.id), "design"].join(" | ");

const apply = program
  .command("apply")
  .helpCommand(false)
  .description(`導入済みチームに機能を導入し、実行用スクリプト(atf-bin)を配る(${applyIds})`);

// サブコマンドは apply.ts の FEATURES から組み立てる(機能を増やしてもここは変更不要)
for (const feature of featureSummaries()) {
  const command = apply
    .command(feature.id)
    .argument("<project-dir>", "対象プロジェクトのディレクトリパス")
    .description(
      `${feature.name}を導入する` +
        parenthesize(
          [
            feature.agent ? `担当: ${feature.agent}` : "",
            feature.hasScript ? `実行: bash atf-bin/${feature.id}.sh` : "",
          ].filter((part) => part !== ""),
        ),
    )
    .option("-y, --yes", "確認プロンプトをスキップする");
  // 実行スクリプトを持たない機能(Issue 駆動)は走らせるものがないので --run を出さない
  if (feature.hasScript) {
    command.option("-r, --run", `導入直後に bash atf-bin/${feature.id}.sh を 1 度実行して配線を確かめる`);
  }
  if (feature.id === "formal") {
    command.option(
      "--auto-fix",
      "反例が出たとき、選択肢が実質 1 つに決まる仕様は自動で確定して .als・設計書・実装まで直す(既定)",
    );
    command.option(
      "--ask-only",
      "反例が出たら必ずユーザーに選択肢と推奨案を提示して確認する(自動で確定しない)",
    );
  }
  if (feature.installsSkills) {
    command.option("-f, --force", "配るスキルの既存ファイルを上書きする(欠けた・壊れたスキルの修復)");
  }
  command.action(
    (
      projectDir: string,
      opts: {
        force?: boolean;
        yes?: boolean;
        run?: boolean;
        autoFix?: boolean;
        askOnly?: boolean;
      },
    ) => runApply(feature.id, projectDir, opts),
  );
}

apply.addHelpText(
  "after",
  [
    "",
    "導入すると次が揃います:",
    "  - atf-settings.yaml の requirements を有効化(有効/無効の単一情報源)",
    "  - 担当エージェント定義の追加と、既存エージェント定義への指示の差し込み(何度実行しても増えません)",
    "  - 成果物の置き場と atf-bin/<機能>.sh の配布、ダッシュボードの更新",
    "",
    "design だけは対話でスキルを選ぶ形式で、atf-bin のスクリプトは配りません",
    "(何も選ばずに進めると解除になります)。",
    "",
    "-r/--run を付けると導入直後に bash atf-bin/<機能>.sh を 1 度実行し、配線(スクリプトと",
    "atf の解決)を確かめます。中身(.als / 規約 / 文書の記録)は担当エージェントがこれから",
    "作るため、導入直後の「未整備」は失敗ではありません。",
    "",
    "例:",
    "  atf apply arch ../my-project",
    "  atf apply arch ../my-project --run",
    "  atf apply formal ../my-project --ask-only",
    "  atf apply design ../my-project",
  ].join("\n"),
);

// デザインは atf-bin のスクリプトを持たず、適用内容を対話で受け取るため
// FEATURES(機械的に組み立てるサブコマンド)ではなく個別に定義する。実処理は design.ts
apply
  .command("design")
  .argument("<project-dir>", "対象プロジェクトのディレクトリパス")
  .description("デザイン(スキル + エージェントへの指示)を対話で選んで適用する")
  .option("-f, --force", "既存の SKILL.md を上書きし、手編集されたスキルも撤去する")
  .option("-y, --yes", "確認プロンプトをスキップする")
  .action(
    async (projectDir: string, opts: { force?: boolean; yes?: boolean }) => {
      const projectPath = resolve(projectDir);
      const manifest = requireTeam(projectPath);
      if (!manifest) return;
      const catalog = loadSkillCatalog();
      if (catalog.length === 0) {
        console.error("スキルが見つかりません。templates/skills を確認してください。");
        process.exitCode = 1;
        return;
      }

      // デザイン以外の目的で入っているスキル(図の生成に使う archify など)は
      // デザインの選択対象ではないため現状から除く
      const current = (manifest.skills ?? []).filter(isDesignSkill).map((s) => s.id);
      const nameOf = (id: string) => catalog.find((s) => s.id === id)?.name ?? id;
      console.log(`\n対象: ${manifest.project} (${projectPath})`);
      console.log(
        `現在のデザイン: ${current.length > 0 ? current.map(nameOf).join(", ") : "(未適用)"}`,
      );

      // 適用するデザインは対話で決める(すべて選ばなければ解除になる)。
      // 既定値の提示には現在の技術スタックを使う
      let profile = analyzeRepo(projectPath);
      if (manifest.requirements.techStack) {
        profile = applyTechStack(profile, manifest.requirements.techStack);
      }
      const ids = normalizeDesignIds(
        await hearDesignSkills({
          phase: manifest.requirements.phase,
          focus: manifest.requirements.focus,
          frameworks: profile.frameworks,
          // 未適用なら現状を渡さず、推奨値・ヒューリスティックを初期値にする
          current: current.length > 0 ? current : undefined,
          catalog,
        }),
        catalog,
      );

      // 差分を提示して確認する
      const added = ids.filter((id) => !current.includes(id));
      const dropped = current.filter((id) => !ids.includes(id));
      const unchanged = ids.filter((id) => current.includes(id));
      console.log("");
      if (added.length > 0) console.log(`  + ${added.map(nameOf).join(", ")}`);
      if (dropped.length > 0) console.log(`  - ${dropped.map(nameOf).join(", ")}`);
      if (unchanged.length > 0) console.log(`  = ${unchanged.map(nameOf).join(", ")}(維持)`);
      if (added.length === 0 && dropped.length === 0) {
        console.log(
          ids.length > 0
            ? "  (デザインの内容は変わりません。エージェント定義への指示だけ再適用します)"
            : "  (デザインは適用されていません)",
        );
      }
      if (!opts.yes) {
        const ok = await confirm({
          message:
            ids.length === 0
              ? `デザインを解除します(スキルを撤去し、エージェント定義のデザイン節を削除)。よろしいですか?`
              : `このデザインを適用します(エージェント定義の指示も更新します)。よろしいですか?`,
          default: true,
        });
        if (!ok) {
          console.log("中止しました。");
          return;
        }
      }

      const result = applyDesign(projectPath, ids, { force: opts.force, catalog });

      if (result.skills.length === 0) {
        console.log("\nデザインを解除しました(エージェントはスキルを参照しなくなります)。");
      } else {
        console.log(`\nデザインを適用しました: ${result.skillsDir}`);
        for (const skill of result.skills) {
          console.log(
            `  ${skill.name}(${SKILL_CATEGORY_LABEL[skill.category] ?? skill.category})`,
          );
        }
        if (result.written.length < result.skills.length) {
          console.log("  (既存の SKILL.md はそのまま使います。上書きは --force)");
        }
        console.log(
          "  エージェントは UI・画面・スタイルを実装するときにこのスキルを読み込みます。出典とライセンスは .claude/skills/README.md を参照してください。",
        );
      }
      if (result.removed.length > 0) {
        console.log(`撤去したスキル: ${result.removed.join(", ")}`);
      }
      if (result.kept.length > 0) {
        console.warn(
          `注意: 手が入っているため残したスキル: ${result.kept.join(", ")}(デザインからは外れています)`,
        );
        console.warn(
          "  残っているとエージェントが読み込む可能性があります。.claude/skills/<スキル名>/ を手で削除するか、--force で撤去してください。",
        );
      }
      console.log(
        result.agents.length > 0
          ? `エージェント定義の指示を更新: ${result.agents.join(", ")}`
          : "エージェント定義の指示に変更はありませんでした。",
      );
      console.log(`ダッシュボード: ${result.dashboardPath}`);
    },
  );

/** `atf remove <機能> <project-dir>` の実処理 */
async function runRemove(
  feature: FeatureId,
  projectDir: string,
  opts: { purge?: boolean; force?: boolean; yes?: boolean },
): Promise<void> {
  const projectPath = resolve(projectDir);
  const manifest = requireTeam(projectPath);
  if (!manifest) return;

  const target = findRemovable(feature);
  if (!target) return;
  const artifacts = (target.artifacts?.(projectPath) ?? []).filter((dir) => existsSync(dir));
  console.log(`\n対象: ${manifest.project}(${projectPath})`);
  console.log(`撤去する機能: ${target.name}(${feature})`);
  if (target.agentFile) console.log(`  - 担当エージェント定義を削除: .claude/agents/${target.agentFile}`);
  console.log("  - 残るエージェント定義から、この機能の指示を取り除く");
  if (hasBinScript(feature)) console.log(`  - atf-bin/${feature}.sh を取り除く`);
  for (const dir of artifacts) {
    console.log(
      opts.purge
        ? `  - 成果物を削除: ${dir}(--purge。元に戻せません)`
        : `  - 成果物は残す: ${dir}(削除するには --purge)`,
    );
  }
  // 形式仕様を外すと、要件・仕様の置き場がプロジェクトから無くなる
  if (feature === "formal") {
    console.warn(
      "\n注意: 形式仕様モードを外すと、要件・仕様の単一情報源(spec/*.als と docs/adr/)を参照する指示が" +
        "\n  全エージェントから外れます。何を作るかの合意を別の形で残す必要があります" +
        (manifest.requirements.phase === "greenfield"
          ? "(このプロジェクトは新規開発フェーズです)。"
          : "。"),
    );
  }

  if (!opts.yes) {
    const ok = await confirm({
      message: opts.purge
        ? "上記を実行します(成果物も削除します)。よろしいですか?"
        : "上記を実行します。よろしいですか?",
      default: !opts.purge,
    });
    if (!ok) {
      console.log("中止しました。");
      return;
    }
  }

  const result = removeFeatures(projectPath, [feature], { purge: opts.purge, force: opts.force });
  for (const item of result.removed) {
    console.log(`\n撤去しました: ${item.name}(${item.id})`);
    if (!item.wasEnabled) console.log("  (もともと無効でした。後片付けだけ行いました)");
    if (item.agentFile) console.log(`  - 削除した定義: ${item.agentFile}`);
    if (item.removedSkills.length > 0) console.log(`  - 撤去したスキル: ${item.removedSkills.join(", ")}`);
    if (item.keptSkills.length > 0) {
      console.warn(`  注意: 手が入っているため残したスキル: ${item.keptSkills.join(", ")}`);
    }
    if (item.purged) console.log(`  - 削除した成果物: ${item.artifactsDirs.join(", ") || "(なし)"}`);
    else if (item.artifactsDirs.length > 0) {
      console.log(`  - 残した成果物: ${item.artifactsDirs.join(", ")}`);
      console.log("    (atf status は「無効だが成果物が残っている」と報告します。不要なら手で削除するか --purge)");
    }
  }
  console.log(
    result.agents.length > 0
      ? `\nエージェント定義から指示を削除: ${result.agents.join(", ")}`
      : "\nエージェント定義の指示に変更はありませんでした。",
  );
  if (result.binScripts.length > 0) {
    console.log(`取り除いた実行スクリプト: ${result.binScripts.join(", ")}`);
  }
  console.log(`チーム設定: ${result.settingsPath}`);
  console.log(`ダッシュボード: ${result.dashboardPath}`);
  // Issue 承認のタッチポイントは Issue 駆動が前提なので、撤去すると宙に浮く
  if (feature === "issue" && (manifest.requirements.touchpoints ?? []).includes("issue-approval")) {
    console.warn(
      "\n注意: タッチポイント issue-approval(Issue 着手前のユーザー承認)は Issue 駆動が前提です。" +
        "\n  不要なら atf-settings.yaml の requirements.touchpoints から外してください。",
    );
  }
  console.log(`\n戻すときは \`atf apply ${feature} ${projectDir}\` を実行してください。`);
}

const removeCmd = program
  .command("remove")
  .helpCommand(false)
  .description(`導入済みチームから機能を撤去する(apply の逆操作。${removeIds})`);

// サブコマンドは apply と同じ機能テーブルから組み立てる(report は常に使えるため対象外)
for (const feature of REMOVABLE_FEATURES) {
  removeCmd
    .command(feature.id)
    .argument("<project-dir>", "対象プロジェクトのディレクトリパス")
    .description(`${feature.name}を撤去する`)
    .option("--purge", "成果物(規約・仕様・文書の記録)も削除する")
    .option("-f, --force", "手編集されたスキルも撤去する")
    .option("-y, --yes", "確認プロンプトをスキップする")
    .action((projectDir: string, opts: { purge?: boolean; force?: boolean; yes?: boolean }) =>
      runRemove(feature.id, projectDir, opts),
    );
}

removeCmd
  .command("design")
  .argument("<project-dir>", "対象プロジェクトのディレクトリパス")
  .description("デザイン(スキル + エージェントへの指示)を解除する")
  .option("-f, --force", "手編集されたスキルも撤去する")
  .option("-y, --yes", "確認プロンプトをスキップする")
  .action(async (projectDir: string, opts: { force?: boolean; yes?: boolean }) => {
    const projectPath = resolve(projectDir);
    const manifest = requireTeam(projectPath);
    if (!manifest) return;

    const current = (manifest.skills ?? []).filter(isDesignSkill);
    if (current.length === 0) {
      console.log("デザインは適用されていません。");
      return;
    }
    console.log(`\n解除するデザイン: ${current.map((s) => s.name).join(", ")}`);
    if (!opts.yes) {
      const ok = await confirm({
        message: "スキルを撤去し、エージェント定義のデザイン節を削除します。よろしいですか?",
        default: true,
      });
      if (!ok) {
        console.log("中止しました。");
        return;
      }
    }

    // 「適用後のデザイン = 空」として適用するのが解除にあたる
    const result = applyDesign(projectPath, [], { force: opts.force });
    console.log("\nデザインを解除しました(エージェントはスキルを参照しなくなります)。");
    if (result.removed.length > 0) console.log(`撤去したスキル: ${result.removed.join(", ")}`);
    if (result.kept.length > 0) {
      console.warn(`注意: 手が入っているため残したスキル: ${result.kept.join(", ")}`);
    }
    console.log(
      result.agents.length > 0
        ? `エージェント定義の指示を更新: ${result.agents.join(", ")}`
        : "エージェント定義の指示に変更はありませんでした。",
    );
    console.log(`ダッシュボード: ${result.dashboardPath}`);
  });

/** 更新の扱い → 表に出すラベル */
const UPDATE_STATUS_LABEL: Record<UpdateAsset["status"], string> = {
  create: "➕ 追加",
  update: "🔄 更新",
  remove: "🗑 削除",
  kept: "⬜ 据え置き",
};

/** アセットの種類 → 表に出すラベル(何が変わるのかが分かるように) */
const UPDATE_KIND_LABEL: Record<UpdateAsset["kind"], string> = {
  agent: "担当エージェント定義",
  section: "エージェントへの指示",
  scaffold: "足場(書式ガイド・スクリプト)",
  skill: "スキル",
  bin: "実行スクリプト",
  dashboard: "ダッシュボード",
  settings: "チーム設定",
};

program
  .command("update")
  .argument("[project-dir]", "対象プロジェクトのディレクトリパス(既定: カレントディレクトリ)", ".")
  .description(
    "導入済みの機能に関わるアセット(指示・足場・スキル・実行スクリプト)を、いまの atf の内容に更新する",
  )
  .addHelpText(
    "after",
    [
      "",
      "更新するのは atf が内容を決めるものだけです:",
      "  - エージェント定義の atf セクション(手で書き足した節は残ります)",
      "  - 足場の書式ガイド・変換スクリプト・解説ページのテンプレート、atf-bin/*.sh、ダッシュボード、チーム設定の記録",
      "  - 付随スキル(カタログの版が上がっているもの。手編集されたものは --force のときだけ)",
      "",
      "機能の有効/無効は変えません(足す・外すのは `atf apply` / `atf remove`)。",
      "ユーザーとエージェントが書いたもの(rules.json / rubric.json / run-arch-check.sh /",
      "run-alloy.sh / .als / 記録の jsonl / Issue ドラフト)には触れません。",
      "explain-template.html は基本上書きです — カスタマイズしている場合は提示される差分で確認してください。",
      "",
      "例:",
      "  atf update ../my-project --dry-run   # 何が変わるかだけを見る",
      "  atf update ../my-project             # 内容を確認してから更新する",
    ].join("\n"),
  )
  .option("-f, --force", "手編集されたスキルも最新の内容に入れ替える")
  .option("-n, --dry-run", "更新内容を表示するだけで、書き込まない")
  .option("-y, --yes", "確認プロンプトをスキップする")
  .action(async (projectDir: string, opts: { force?: boolean; dryRun?: boolean; yes?: boolean }) => {
    const projectPath = resolve(projectDir);
    const manifest = requireTeam(projectPath);
    if (!manifest) return;

    const plan = planUpdate(projectPath, { force: opts.force });
    console.log(`\n対象: ${plan.project}(${projectPath})`);

    // 有効な機能(= 更新の対象)を先に示す。ここに出ない機能は `atf apply <機能>` で導入する
    console.log("\n更新の対象になっている機能:");
    console.log(
      renderTable(
        ["機能", "id", "更新", "最新"],
        plan.features.map((feature) => {
          const changes = feature.assets.filter((a) => a.status !== "kept").length;
          const kept = feature.assets.filter((a) => a.status === "kept").length;
          return [
            feature.name,
            feature.id,
            changes > 0 ? `${changes} 件` : "なし",
            `${feature.unchanged} 件${kept > 0 ? ` / 据え置き ${kept} 件` : ""}`,
          ];
        }),
        { indent: "  " },
      ),
    );

    const rows: string[][] = [];
    for (const feature of plan.features) {
      // 同じ機能の 2 行目以降は名前を空にしてまとまりを見せる(status / eval の表と同じ)
      feature.assets.forEach((asset, i) => {
        rows.push([
          UPDATE_STATUS_LABEL[asset.status],
          i === 0 ? feature.name : "",
          UPDATE_KIND_LABEL[asset.kind],
          asset.label,
          asset.detail ?? "",
        ]);
      });
    }
    plan.common.forEach((asset, i) => {
      rows.push([
        UPDATE_STATUS_LABEL[asset.status],
        i === 0 ? "共通" : "",
        UPDATE_KIND_LABEL[asset.kind],
        asset.label,
        asset.detail ?? "",
      ]);
    });

    if (!plan.hasChanges) {
      console.log("\nすべて最新です(更新するアセットはありません)。");
      // 手が入っているため据え置くものは、--force という選択肢があることを知らせる
      const kept = plan.features.flatMap((f) => f.assets.filter((a) => a.status === "kept"));
      for (const asset of kept) {
        console.log(`  ⬜ ${asset.label}: ${asset.detail ?? "据え置き"}`);
      }
      return;
    }

    console.log("\n更新するアセット:");
    console.log(renderTable(["扱い", "機能", "種類", "対象", "詳細"], rows, { indent: "  " }));
    console.log(
      "\n  ユーザーとエージェントが書いたもの(規約 rules.json・評価観点 rubric.json・run-arch-check.sh・" +
        "\n  run-alloy.sh・解説テンプレート・.als・記録の jsonl・Issue ドラフト)には触れません。" +
        "\n  エージェント定義は atf の節だけを差し替えるので、手で書き足した節は残ります。",
    );

    if (opts.dryRun) {
      console.log("\n--dry-run のため書き込みませんでした。");
      return;
    }
    if (!opts.yes) {
      const ok = await confirm({
        message: "上記のアセットを更新します。よろしいですか?",
        default: true,
      });
      if (!ok) {
        console.log("中止しました。");
        return;
      }
    }

    const result = runUpdate(projectPath, plan, { force: opts.force });

    console.log("\n更新しました。");
    const added = result.apply.applied.filter((a) => a.agentFile);
    if (added.length > 0) {
      console.log(`  追加した担当エージェント: ${added.map((a) => a.agentFile).join(", ")}`);
    }
    console.log(
      result.apply.agents.length > 0
        ? `  指示を更新したエージェント定義: ${result.apply.agents.join(", ")}`
        : "  エージェント定義の指示に変更はありませんでした。",
    );
    if (result.managed.length > 0) console.log(`  最新化した足場: ${result.managed.join(", ")}`);
    if (result.skills.length > 0) console.log(`  入れ替えたスキル: ${result.skills.join(", ")}`);
    console.log(`  実行スクリプト: ${result.apply.binDir}(${result.apply.binScripts.join(", ")})`);
    if (result.apply.removedBinScripts.length > 0) {
      console.log(`  取り除いたスクリプト: ${result.apply.removedBinScripts.join(", ")}`);
    }
    console.log(`  チーム設定: ${result.settingsPath}`);
    console.log(`  ダッシュボード: ${result.dashboardPath}`);
    console.log(
      `\n適用状況は \`atf status ${projectDir}\` または \`bash atf-bin/status.sh\` で確認できます。`,
    );
  });

program
  .command("report", { hidden: true })
  .argument("<project-dir>", "対象プロジェクトのディレクトリパス")
  .description("導入済みチームの構成と実行記録を可視化した HTML ダッシュボードを再生成する")
  .option("-o, --output <file>", "出力先(デフォルト: <project-dir>/.claude/atf-dashboard.html)")
  .action((projectDir: string, opts: { output?: string }) => {
    const projectPath = resolve(projectDir);
    const manifest = requireTeam(projectPath);
    if (!manifest) return;
    const runs = loadRuns(projectPath);
    const tasks = loadTaskDrafts(projectPath);
    // 形式仕様モードでは、派生文書(docs/generated/)も .als と対になるよう作り直す
    const woven = manifest.requirements.formalSpec
      ? runWeave(projectPath, manifest.project)
      : undefined;
    const specs = loadSpecState(projectPath);
    const capabilities = {
      findings: loadCapabilityFindings(projectPath),
      plans: loadCapabilityPlans(projectPath),
    };
    const architecture = loadArchitectureState(projectPath);
    const evaluation = loadEvaluationState(projectPath);
    const output = opts.output
      ? resolve(opts.output)
      : join(projectPath, ".claude", "atf-dashboard.html");
    writeFileSync(
      output,
      buildDashboardHtml(manifest, runs, tasks, specs, capabilities, architecture, evaluation),
    );
    if (woven && (woven.written.length > 0 || woven.removed.length > 0)) {
      console.log(
        `派生文書を更新しました: ${woven.dir}(更新 ${woven.written.length} 件 / 削除 ${woven.removed.length} 件)`,
      );
    }
    console.log(
      `ダッシュボードを生成しました: ${output}(実行記録 ${runs.length} 件 / タスクドラフト ${tasks.length} 件` +
        (specs.models.length > 0 ? ` / Alloy モデル ${specs.models.length} 件` : "") +
        (capabilities.findings.length > 0 ? ` / 最新機能の調査 ${capabilities.findings.length} 件` : "") +
        (architecture.docs.length > 0 ? ` / リバースドキュメント ${architecture.docs.length} 件` : "") +
        (architecture.rules ? ` / アーキテクチャ規約 ${architecture.rules.rules.length} 件` : "") +
        (evaluation.records.length > 0 ? ` / 評価記録 ${evaluation.records.length} 件` : "") +
        ")",
    );
  });

program
  .command("formal", { hidden: true })
  .argument("<project-dir>", "対象プロジェクトのディレクトリパス")
  .description(
    "形式仕様(spec/*.als)を Alloy で検証する(実装前ゲート。導入先では bash atf-bin/formal.sh から呼ばれる)",
  )
  .option("--jar <path>", "Alloy の jar のパス(既定: ALLOY_JAR 環境変数 → tools/alloy.jar → ~/.atf/alloy.jar)")
  .action((projectDir: string, opts: { jar?: string }) => {
    const projectPath = resolve(projectDir);
    const models = loadSpecModels(projectPath);
    if (models.length === 0) {
      console.error(
        `検証する Alloy モデルがありません(${specDir(projectPath)}/*.als)。spec-formalizer に仕様の形式化を依頼してください。`,
      );
      process.exitCode = 1;
      return;
    }

    // 派生文書は .als と対で維持する(最新の検証結果を載せるため、検証のあとに作り直す)。
    // Alloy を実行できなかった場合も、要件の解説は読めるようにするため生成する
    const weave = () => {
      const result = runWeave(projectPath, projectNameOf(projectPath));
      if (result.written.length > 0) {
        console.log(`派生文書: ${result.dir}(${result.written.join(", ")})`);
      }
    };

    const report = verifySpecs(projectPath, { jar: opts.jar });
    if (!report.jar) {
      console.error(ALLOY_JAR_HELP);
      weave();
      process.exitCode = 1;
      return;
    }
    console.log(`Alloy: ${report.jar}`);

    let satisfied = 0;
    let failed = 0;
    for (const r of report.results) {
      console.log(`\n${r.model}`);
      if (!r.executed) {
        failed++;
        console.log(`  実行できませんでした: ${r.output.split("\n")[0]}`);
        continue;
      }
      if (r.checks.length === 0) {
        console.log("  検証コマンド(check / run)の結果を読み取れませんでした。");
        continue;
      }
      for (const c of r.checks) {
        if (isSatisfied(c.result)) satisfied++;
        else failed++;
        console.log(
          `  ${SPEC_RESULT_LABEL[c.result] ?? c.result}  ${c.kind ?? ""} ${c.command}` +
            (c.detail ? `\n      ${c.detail}` : ""),
        );
      }
    }

    console.log(`\n充足 ${satisfied} 件 / 未充足・エラー ${failed} 件`);
    console.log(`記録: ${checksPath(projectPath)}`);
    weave();
    if (report.satisfied) {
      console.log("実装前ゲート: 通過(すべての検証コマンドが充足しています)。");
    } else {
      console.error("実装前ゲート: 未通過。仕様(.als)を修正して再検証してください(実装に進まないこと)。");
      process.exitCode = 1;
    }
  });

program
  .command("weave", { hidden: true })
  .argument("<project-dir>", "対象プロジェクトのディレクトリパス")
  .description(
    "形式仕様(spec/*.als)と ADR から自然言語の文書を生成する(導入先では bash atf-bin/weave.sh から呼ばれる)",
  )
  .option("--check", "生成せずに、最新かどうかだけを確かめる(古ければ終了コード 1)")
  .action((projectDir: string, opts: { check?: boolean }) => {
    const projectPath = resolve(projectDir);
    const projectName = projectNameOf(projectPath);
    const models = loadSpecModels(projectPath);
    if (models.length === 0) {
      console.error(
        `Alloy モデルがありません(${specDir(projectPath)}/*.als)。spec-formalizer に仕様の形式化を依頼してください。`,
      );
      process.exitCode = 1;
      return;
    }

    if (opts.check) {
      const plan = planWeave(projectPath, projectName);
      const stale = [...plan.changed, ...plan.removed];
      if (stale.length === 0) {
        console.log(`派生文書は最新です: ${generatedDir(projectPath)}`);
        return;
      }
      console.error(`派生文書が古くなっています(${stale.join(", ")})。`);
      console.error("`bash atf-bin/weave.sh` で生成し直してください(生成物なので commit しません)。");
      process.exitCode = 1;
      return;
    }

    const result = runWeave(projectPath, projectName);
    console.log(`生成先: ${result.dir}`);
    for (const name of result.written) console.log(`  + ${name}`);
    for (const name of result.unchanged) console.log(`  = ${name}(変更なし)`);
    for (const name of result.removed) console.log(`  - ${name}(元の .als がありません)`);
    console.log(
      "\nここは使い捨ての派生物です(.gitignore 対象)。直すのは spec/*.als の doc comment か docs/adr/ です。",
    );
  });

program
  .command("lint", { hidden: true })
  .argument("<project-dir>", "対象プロジェクトのディレクトリパス")
  .description(
    "形式仕様の運用規約を検査する(必須タグ・@req の重複と孤児・手書き文書への規範文の混入。導入先では bash atf-bin/lint.sh から呼ばれる)",
  )
  .action((projectDir: string) => {
    const projectPath = resolve(projectDir);
    const findings = lintFormal(projectPath);
    if (findings.length === 0) {
      console.log("規約違反はありません(形式仕様と ADR は単一情報源として保たれています)。");
      return;
    }

    const rows = findings.map((f) => [
      f.severity === "error" ? "❌ 違反" : "⚠️ 警告",
      `${f.file}${f.line ? `:${f.line}` : ""}`,
      f.rule,
      f.message,
      f.fix,
    ]);
    console.log(renderTable(["判定", "場所", "規則", "内容", "直し方"], rows));

    const errors = findings.filter((f) => f.severity === "error").length;
    console.log(`\n違反 ${errors} 件 / 警告 ${findings.length - errors} 件`);
    if (hasLintErrors(findings)) {
      console.error("規約違反があります(要件・仕様の単一情報源が割れています)。上の「直し方」に沿って直してください。");
      process.exitCode = 1;
    }
  });

program
  .command("status")
  .argument("[project-dir]", "対象プロジェクトのディレクトリパス(既定: カレントディレクトリ)", ".")
  .description(
    "導入済みチームで有効になっている機能(Issue 駆動・形式仕様・アーキテクチャ検証・リバースドキュメント・ルーブリック評価など)と実体の状況を表示する",
  )
  .option("--json", "JSON で出力する(他ツールからの参照用)")
  .option("-e, --enabled", "有効な機能だけを表示する")
  .action((projectDir: string, opts: { json?: boolean; enabled?: boolean }) => {
    const projectPath = resolve(projectDir);
    const manifest = requireTeam(projectPath);
    if (!manifest) return;

    const state = collectProjectFeatures(projectPath, manifest);
    if (opts.json) {
      console.log(JSON.stringify(state, null, 2));
      // 食い違いがあるときは JSON でも終了コードで知らせる
      if (state.features.some((f) => f.issues.length > 0) || state.missingAgents.length > 0) {
        process.exitCode = 1;
      }
      return;
    }

    console.log(`\n対象: ${state.project}(${state.path})`);
    console.log(
      renderTable(
        ["項目", "内容"],
        [
          ["プリセット", `${state.presetName}(${state.preset})`],
          ["フェーズ", state.phase],
          ["重視観点", state.focus.join(", ") || "(なし)"],
          ["チーム規模", state.teamSize],
          ["GitHub", state.githubRepo ?? "(未設定)"],
          ["エージェント", `${state.agents.length} 体(下の表を参照)`],
          [
            "スキル",
            state.skills.length > 0 ? `${state.skills.length} 件(下の表を参照)` : "(未導入)",
          ],
          ["実行記録", `${state.runs} 件`],
          ["設定ファイル", state.settingsPath],
          ...(state.missingAgents.length > 0
            ? [["⚠️ 定義ファイルなし", state.missingAgents.join(", ")]]
            : []),
        ],
        { indent: "  " },
      ),
    );

    console.log("\nエージェント:");
    console.log(
      renderTable(
        ["状態", "名前", "出自", "役割"],
        state.agents.map((agent) => [
          agent.exists ? "✅" : "⚠️ なし",
          agent.name,
          agent.origin === "common" ? "共通" : "プリセット",
          firstSentence(agent.description) || "-",
        ]),
        { indent: "  " },
      ),
    );

    if (state.skills.length > 0) {
      console.log("\nスキル:");
      console.log(
        renderTable(
          ["状態", "名前", "分類", "カタログ id"],
          state.skills.map((skill) => [
            skill.exists ? "✅" : "⚠️ なし",
            skill.name,
            skill.category,
            skill.id,
          ]),
          { indent: "  " },
        ),
      );
    }

    const shown = opts.enabled ? state.features.filter((f) => f.enabled) : state.features;
    // 食い違いが 1 件もないときは「要確認」列を出さず、詳細に幅を回す
    const withIssues = shown.some((f) => f.issues.length > 0);
    console.log("\n機能の適用状況:");
    console.log(
      renderTable(
        withIssues ? ["状態", "機能", "詳細", "要確認"] : ["状態", "機能", "詳細"],
        shown.map((feature) => {
          const detail = [...feature.details];
          if (!feature.enabled && feature.howToEnable) detail.push(`有効化: ${feature.howToEnable}`);
          for (const command of feature.commands) detail.push(`コマンド: ${command}`);
          const row = [
            feature.enabled ? "✅ 有効" : "🚫 無効",
            feature.name,
            detail.join("\n") || "-",
          ];
          if (withIssues) row.push(feature.issues.map((i) => `⚠️ ${i}`).join("\n") || "-");
          return row;
        }),
        { indent: "  " },
      ),
    );

    const enabled = state.features.filter((f) => f.enabled).length;
    const issues = state.features.flatMap((f) => f.issues);
    console.log(`\n有効 ${enabled} 件 / 無効 ${state.features.length - enabled} 件`);
    const toCheck = issues.length + state.missingAgents.length;
    if (toCheck > 0) {
      console.error(`要確認 ${toCheck} 件(上の ⚠️ と注意を参照)`);
      process.exitCode = 1;
    } else {
      console.log("設定と実体は一致し、ゲートも通過しています。");
    }
  });

program
  .command("arch", { hidden: true })
  .argument("<project-dir>", "対象プロジェクトのディレクトリパス")
  .description(
    "アーキテクチャ適合検証(.claude/atf-arch/rules.json のレイヤ規約)を実行する(実装後ゲート。導入先では bash atf-bin/arch.sh から呼ばれる)",
  )
  .option("--runner <path>", "検証スクリプトのパス(既定: <project-dir>/.claude/atf-arch/run-arch-check.sh)")
  .action((projectDir: string, opts: { runner?: string }) => {
    const projectPath = resolve(projectDir);
    const rules = loadArchRules(projectPath);
    if (!rules || rules.rules.length === 0) {
      console.error(
        `アーキテクチャ規約が定義されていません(${archRulesPath(projectPath)})。arch-guard に規約の定義を依頼してください。`,
      );
      process.exitCode = 1;
      return;
    }

    const report = verifyArch(projectPath, {
      runner: opts.runner ? resolve(opts.runner) : undefined,
    });
    if (!report.executed) {
      console.error(report.output);
      if (!report.runner) console.error(ARCH_RUNNER_HELP);
      process.exitCode = 1;
      return;
    }
    console.log(`検証スクリプト: ${report.runner}${rules.tool ? ` / ツール: ${rules.tool}` : ""}`);

    const ruleName = new Map(rules.rules.map((r) => [r.id, r.description]));
    for (const check of report.checks) {
      console.log(
        `\n  ${ARCH_RESULT_LABEL[check.result] ?? check.result}  ${check.rule}` +
          (ruleName.get(check.rule) ? ` — ${ruleName.get(check.rule)}` : "") +
          (check.violations ? `\n      違反 ${check.violations} 件` : "") +
          (check.detail ? `\n      ${check.detail}` : ""),
      );
    }
    if (report.unchecked.length > 0) {
      console.log(`\n  ⬜ 未検証: ${report.unchecked.join(", ")}`);
      console.log("      run-arch-check.sh がこれらの規約の行を出力していません(arch-guard に配線を依頼してください)。");
    }

    const passed = report.checks.filter((c) => isArchPass(c.result)).length;
    const failed = report.checks.length - passed;
    console.log(`\n適合 ${passed} 件 / 違反・エラー ${failed} 件 / 未検証 ${report.unchecked.length} 件`);
    console.log(`記録: ${archChecksPath(projectPath)}`);
    if (report.passed) {
      console.log("適合ゲート: 通過(すべての規約が適合しています)。");
    } else {
      console.error(
        "適合ゲート: 未通過。依存の向きを修正するか、規約の見直しを arch-guard 経由でユーザーと合意してください(違反を残して完了としないこと)。",
      );
      process.exitCode = 1;
    }
  });

program
  .command("docs", { hidden: true })
  .argument("<project-dir>", "対象プロジェクトのディレクトリパス")
  .description(
    "リバースドキュメント(.claude/atf-docs/docs.jsonl)の一覧と、実装への追随状況を表示する(導入先では bash atf-bin/docs.sh から呼ばれる)",
  )
  .action((projectDir: string) => {
    const projectPath = resolve(projectDir);
    const records = loadReverseDocs(projectPath);
    if (records.length === 0) {
      console.error(
        `リバースドキュメントの記録がありません(${docsIndexPath(projectPath)})。doc-reverser にドキュメント化を依頼してください。`,
      );
      process.exitCode = 1;
      return;
    }

    const statuses = reverseDocStatuses(projectPath, records);
    for (const { record, docExists, diagramExists, missingSources } of statuses) {
      const problems = [
        docExists ? "" : "文書が見つからない",
        diagramExists === false ? "図が見つからない" : "",
        missingSources.length > 0 ? `根拠のコードが消えている(${missingSources.join(", ")})` : "",
      ].filter(Boolean);
      console.log(
        `\n${problems.length > 0 ? "⚠️ 要再生成" : "✅ 追随"}  [${record.kind}] ${record.path}` +
          `\n      ${record.title}${record.commit ? ` (commit ${record.commit})` : ""}` +
          (record.diagram ? `\n      図: ${record.diagram}` : "") +
          (record.sources?.length ? `\n      根拠: ${record.sources.join(", ")}` : "") +
          (problems.length > 0 ? `\n      ${problems.join(" / ")}` : ""),
      );
    }

    const stale = staleReverseDocs(statuses);
    console.log(`\n文書 ${statuses.length} 件 / 要再生成 ${stale.length} 件`);
    if (stale.length > 0) {
      console.error(
        "実装に追随していない文書があります。doc-reverser に差分更新(前回の commit と変更パスを添えて)を依頼してください。",
      );
      process.exitCode = 1;
    }
  });

program
  .command("eval", { hidden: true })
  .argument("<project-dir>", "対象プロジェクトのディレクトリパス")
  .description(
    "ルーブリック評価(.claude/atf-eval/)の集計と、評価ゲートの通過状況を表示する(導入先では bash atf-bin/eval.sh から呼ばれる)",
  )
  .action((projectDir: string) => {
    const projectPath = resolve(projectDir);
    const manifest = requireTeam(projectPath);
    if (!manifest) return;

    const rubric = loadRubric(projectPath);
    if (!rubric || rubric.criteria.length === 0) {
      console.error(
        `評価観点が定義されていません(${rubricPath(projectPath)})。evaluator にルーブリックの作成を依頼してください。`,
      );
      process.exitCode = 1;
      return;
    }

    const targets = evalTargetNames(manifest.requirements, manifest.agents);
    const records = loadEvaluations(projectPath);
    const gate = evalGateStatus(rubric, records, targets);
    const pass = passScoreOf(rubric);

    console.log(
      `評価基準: ${rubricPath(projectPath)}(観点 ${rubric.criteria.length} 件 / 既定の閾値 ${pass} 以上)`,
    );
    console.log(`評価対象: ${targets.join(", ") || "(なし)"}`);

    // 「このエージェントは何を、いくつ以上で見られ、外したら何をするのか」
    // — 評価対象ごとに観点・閾値・ネクストアクションを並べる
    const showActions = hasNextActions(rubric);
    console.log("\n評価観点(評価対象のエージェントごと):");
    if (targets.length === 0) {
      console.log("  評価対象のエージェントがいません(requirements.evalTargets を確認してください)。");
    } else {
      const rows: string[][] = [];
      for (const agent of targets) {
        const applied = criteriaFor(rubric, agent);
        if (applied.length === 0) {
          rows.push([agent, "(適用される観点なし)", "-", "-", ...(showActions ? ["-", "-"] : [])]);
          continue;
        }
        applied.forEach((c, i) => {
          const threshold = criterionPassScore(c, rubric);
          // 観点に固有の手順だけを並べ、全体の既定が効くものは「(既定)」に畳む
          // (同じ文面が行数ぶん繰り返されて表が読めなくなるのを避ける。既定は表の下に 1 度だけ出す)
          const actionCell = (kind: "below" | "meets") => {
            const own = ownNextActions(c, kind);
            if (own.length > 0) return own.map((a) => `- ${a}`).join("\n");
            return defaultNextActions(rubric, kind).length > 0 ? "(既定)" : "(未設定)";
          };
          rows.push([
            // 同じエージェントの 2 行目以降は名前を繰り返さない(どこまでが 1 体かを見やすくする)
            i === 0 ? agent : "",
            `${c.id} ${c.name}\n${c.description}`,
            `重み ${c.weight ?? 1}\n閾値 ${threshold} 以上`,
            [...c.levels]
              .sort((a, b) => b.score - a.score)
              .map((l) => `${l.score} ${l.label}${l.score === threshold ? "(閾値)" : ""}`)
              .join("\n"),
            ...(showActions ? [actionCell("below"), actionCell("meets")] : []),
          ]);
        });
      }
      console.log(
        renderTable(
          [
            "エージェント",
            "観点",
            "重み・閾値",
            "水準",
            ...(showActions ? ["閾値未満のとき", "閾値以上のとき"] : []),
          ],
          rows,
          { indent: "  " },
        ),
      );
      console.log(
        "  観点の適用範囲は rubric.json の appliesTo(省略 / [\"*\"] で全エージェント)で決まります。",
      );
      if (!showActions) {
        console.log(
          "  閾値のネクストアクション(rubric.json の actions)が未設定のため、「閾値未満のとき / 閾値以上のとき」の列と",
        );
        console.log(
          "  「次にやること」の表は出していません。設定すると差し戻しの手順が毎回同じ形で出ます(書式は .claude/atf-eval/README.md)。",
        );
      }
      if (showActions) {
        console.log("  ネクストアクションは観点の actions を優先し、(既定)は次の内容です:");
        for (const [kind, label] of [
          ["below", "閾値未満"],
          ["meets", "閾値以上"],
        ] as const) {
          const picked = defaultNextActions(rubric, kind);
          console.log(
            `    ${label}: ${picked.length > 0 ? picked.join(" / ") : "(未設定)"}`,
          );
        }
      }
    }

    // 「誰の成果物を、どの観点で採点しているか」— 評価対象 × 観点のスコア表
    const statuses = agentEvalStatuses(targets, records, rubric);
    console.log("\nスコアリング状況(評価対象 × 観点。セルは平均スコア):");
    console.log(
      renderTable(
        ["エージェント", ...rubric.criteria.map((c) => c.id), "総合", "状態"],
        statuses.map((status) => [
          status.agent,
          ...status.cells.map((cell) =>
            !cell.applies
              ? "対象外"
              : typeof cell.score === "number"
                ? `${cell.score}${cell.meets ? "" : " ⚠️"}`
                : "未採点",
          ),
          typeof status.averageScore === "number" ? String(status.averageScore) : "-",
          status.evaluated === 0
            ? "⬜ 未評価"
            : status.failed > 0
              ? `❌ 未達 ${status.failed} 件`
              : `✅ 合格 ${status.passed} 件`,
        ]),
        { indent: "  " },
      ),
    );
    console.log(
      "  対象外 = その観点の appliesTo から外れている / 未採点 = 観点は適用されるが、まだ採点した成果物がない / ⚠️ = 閾値未満",
    );
    console.log(
      "  評価対象のエージェントは atf-settings.yaml の requirements.evalTargets で 1 体ずつ ON/OFF できます。",
    );

    // 採点結果 × 閾値から決まる「次にやること」(ルーブリックに設定されたぶん)
    const below = nextActionItems(rubric, records, targets, "below");
    const meetsItems = nextActionItems(rubric, records, targets, "meets");
    if (below.length > 0) {
      console.log("\n次にやること(閾値未満の観点):");
      console.log(
        renderTable(
          ["対象", "成果物", "観点", "スコア", "ネクストアクション"],
          below.map((item) => [
            item.agent,
            item.artifact,
            `${item.criterion}\n${item.criterionName}`,
            `${item.score} / 閾値 ${item.threshold}`,
            item.actions.map((a) => `- ${a}`).join("\n"),
          ]),
          { indent: "  " },
        ),
      );
    }
    if (meetsItems.length > 0 && below.length === 0) {
      // 未達が残っているあいだは差し戻しが先。すべて閾値以上のときだけ「次に進む手順」を出す
      console.log("\n次に進む手順(閾値以上の観点):");
      console.log(
        renderTable(
          ["対象", "成果物", "観点", "スコア", "ネクストアクション"],
          meetsItems.map((item) => [
            item.agent,
            item.artifact,
            `${item.criterion}\n${item.criterionName}`,
            `${item.score} / 閾値 ${item.threshold}`,
            item.actions.map((a) => `- ${a}`).join("\n"),
          ]),
          { indent: "  " },
        ),
      );
    }

    // 閾値を設定した以上、合否の記録と食い違っていれば黙って通さない(判定は書き換えない)
    const mismatches = thresholdMismatches(rubric, records, targets);
    if (mismatches.length > 0) {
      console.warn("\n⚠️ 合格と記録されているが、閾値未満の観点が残っている評価:");
      for (const { record, below } of mismatches) {
        console.warn(`  ${record.target} — ${record.artifact}(${below.join(", ")})`);
      }
      console.warn(
        "  evaluator に再評価を依頼するか、rubric.json の閾値が妥当かをユーザーと確認してください。",
      );
    }

    const judged = latestEvaluations(records).filter((r) => targets.includes(r.target));
    console.log("\n成果物ごとの最新の判定:");
    if (judged.length === 0) {
      console.log("  評価記録がまだありません(evaluator に成果物の評価を依頼してください)。");
    } else {
      console.log(
        renderTable(
          ["判定", "対象・成果物", "総合", "観点ごとの採点", "改善指示"],
          judged
            .slice()
            .sort((a, b) => (a.evaluatedAt ?? "").localeCompare(b.evaluatedAt ?? ""))
            .map((record) => {
              const total = totalScore(record, rubric);
              const scores = (record.scores ?? []).map((sc) => {
                const criterion = rubric.criteria.find((c) => c.id === sc.id);
                const threshold = criterion ? criterionPassScore(criterion, rubric) : pass;
                // 根拠は同じ行に続ける(折り返しても先頭の "- " で 1 観点の区切りが分かる)
                return (
                  `- ${sc.id} ${sc.score}/${threshold}${sc.score < threshold ? " ⚠️" : ""}` +
                  (sc.comment ? ` ${sc.comment}` : "")
                );
              });
              return [
                EVAL_VERDICT_SHORT[record.verdict] ?? record.verdict,
                `${record.target}\n${record.artifact}` +
                  (record.task ? `\n(${record.task})` : "") +
                  (record.issue ? `\n${record.issue}` : ""),
                typeof total === "number"
                  ? `${total}${total < pass ? " ⚠️" : ""}`
                  : "-",
                scores.join("\n") || "-",
                (record.actions ?? []).map((a) => `- ${a}`).join("\n") || "-",
              ];
            }),
          { indent: "  " },
        ),
      );
      console.log(
        "  判定: ✅ 合格(次へ進める)/ ⚠️ 要改善(指摘を直して再評価)/ ❌ 不合格(方針から見直す)/ ❓ 判定不能(評価の前提が足りない)",
      );
      console.log("  採点は「スコア/閾値」。⚠️ は閾値未満です。");
    }
    if (gate.unevaluated.length > 0) {
      console.log(`\n  ⬜ 未評価: ${gate.unevaluated.join(", ")}`);
      console.log("      これらのエージェントの成果物はまだ採点されていません(evaluator に評価を依頼してください)。");
    }

    // 対象外のエージェントの記録は集計に入れないが、書かれていることは知らせる
    const offTarget = latestEvaluations(records).filter((r) => !targets.includes(r.target));
    if (offTarget.length > 0) {
      console.log(
        `\n  ℹ️ 評価対象外の記録 ${offTarget.length} 件(${[...new Set(offTarget.map((r) => r.target))].join(", ")})` +
          " — requirements.evalTargets が false、または agents にない名前です。",
      );
    }

    console.log(
      `\n合格 ${gate.passed} 件 / 未達 ${gate.failed} 件 / 未評価 ${gate.unevaluated.length} 体(対象 ${gate.targets} 体)`,
    );
    console.log(`記録: ${evaluationsPath(projectPath)}`);
    if (gate.ok) {
      console.log("評価ゲート: 通過(対象の成果物がすべて合格しています)。");
    } else {
      console.error(
        "評価ゲート: 未通過。改善指示に沿って修正し、evaluator に再評価を依頼してください(未達を残して完了としないこと)。",
      );
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
