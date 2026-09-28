import { select, checkbox, confirm, input } from "@inquirer/prompts";
import { loadSkillCatalog } from "./skills.js";
import { detectedSelections, emptyTechStack, loadTechStackCatalog, toTechStack } from "./techstack.js";
import type { Requirements, SkillDef, SpecFrame, TechCategory, TechStack } from "./types.js";

/** カンマ(和文・欧文)区切りの入力をリストに分解する */
const splitList = (v: string): string[] =>
  v
    .split(/[、,]/)
    .map((s) => s.trim())
    .filter(Boolean);
const required = (v: string) => v.trim() !== "" || "入力してください";
const requiredList = (v: string) => splitList(v).length > 0 || "1件以上入力してください";

/** トレードオフの選択肢。選んだ文字列がそのまま `@tradeoff` に書かれる */
const tradeoffChoices = [
  { name: "品質(品質を落としてまで期日を守らない)", value: "品質(品質を落としてまで期日を守らない)" },
  { name: "期日(リリース時期を守る)", value: "期日(リリース時期を守る)" },
  { name: "スコープ(予定した機能を削らない)", value: "スコープ(予定した機能を削らない)" },
  { name: "コスト(費用・工数を増やさない)", value: "コスト(費用・工数を増やさない)" },
];

/**
 * 新規開発の立ち上げで、仕様の枠(ルートモジュールの必須タグ)をヒアリングする。
 *
 * ここで聞いたことは **`spec/main.als` の doc comment にだけ**書かれる
 * (`atf-settings.yaml` には保存しない = 仕様の置き場を 2 つにしない)。
 * 既存プロジェクトでは聞かない — 何を作るかは既にコードと運用にあり、
 * spec-formalizer がそれを読み取って埋めるほうが早いため。
 *
 * @param projectName 既定値に使うプロジェクト名
 * @param today 承認日の既定値(ISO の日付部分。テストから固定値を渡せるようにしている)
 */
export async function hearSpecFrame(
  projectName: string,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<SpecFrame> {
  console.log("\n要件・仕様の単一情報源は spec/main.als(Alloy)と docs/adr/ です。");
  console.log("まず「何を作るか / 何を作らないか」の枠を決めます(あとから .als を直せます)。\n");

  const title = await input({
    message: "この仕様全体の名称は?(@title)",
    default: `${projectName} の仕様`,
    validate: required,
  });
  const scope = await input({
    message: "この仕様が扱う範囲は?(@scope。何の構造・不変条件・状態遷移を決めるのか)",
    validate: required,
  });
  const outOfScope = splitList(
    await input({
      message:
        "意図的に扱わない範囲は?(@out-of-scope。カンマ区切りで複数可。性能・UI 文言・外部サービスの挙動など、形式化しないと決めたもの)",
      validate: requiredList,
    }),
  );
  const stakeholder = await input({
    message: "この仕様の承認者は?(@stakeholder。役割名でも可)",
    validate: required,
  });
  const tradeoff = await select({
    message: "トレードオフが必要になったとき、何を最優先しますか?(@tradeoff)",
    choices: tradeoffChoices,
  });

  return { title, scope, outOfScope, stakeholder: `${stakeholder} (承認: ${today})`, tradeoff };
}

/** 「その他(自由入力)」を表す番兵値(カタログの id と衝突しない値にする) */
const OTHER_TECH = "__other__";

/**
 * 使用する技術スタックをカテゴリごとに選択させる。
 * 選択肢は templates/tech-stack.json のカタログから動的に組み立てるため、
 * カテゴリ・技術を増やしてもこの関数を変更する必要はない。
 *
 * - まず「どのカテゴリを設定するか」を選ばせ、選んだカテゴリだけ技術を聞く
 *   (カテゴリが増えても質問が延々と続かないようにするため)
 * - 自動検出できた技術は初期チェックとして提示する
 * - 選択結果はプリセットのスコアリングと {{languages}} / {{frameworks}} 置換の入力になる
 *
 * @param detected 自動検出できた言語・フレームワーク(初期チェックとして提示)
 * @param catalog 技術スタックカタログ(テスト用に差し替え可能)
 */
export async function hearTechStack(
  detected: TechStack = { languages: [], frameworks: [] },
  catalog: TechCategory[] = loadTechStackCatalog(),
): Promise<TechStack> {
  if (catalog.length === 0) return emptyTechStack();

  console.log("\n使用する技術スタックをカテゴリごとに選択します(未定の項目は選択なしで進められます)。");

  const detectedByCategory = detectedSelections(catalog, detected);
  const targets = await checkbox({
    message: "技術を選ぶカテゴリは?(選ばなかったカテゴリは未設定のまま進みます)",
    choices: catalog.map((c) => ({
      name: c.description ? `${c.name} — ${c.description}` : c.name,
      value: c.id,
      // 言語・フレームワーク(always)と、検出値があるカテゴリは初期選択にする
      checked: c.always === true || (detectedByCategory[c.id]?.length ?? 0) > 0,
    })),
  });

  const selections: Record<string, string[]> = {};
  for (const category of catalog) {
    if (!targets.includes(category.id)) continue;
    const alreadyDetected = detectedByCategory[category.id] ?? [];
    // カタログにない検出値(独自の検出語彙など)も選択肢として残す
    const extras = alreadyDetected.filter((id) => !category.items.some((i) => i.id === id));
    const picked = await checkbox({
      message: `${category.name}で使う技術は?(複数可・未定なら選択なし)`,
      choices: [
        ...category.items.map((i) => ({
          name: i.name,
          value: i.id,
          checked: alreadyDetected.includes(i.id),
        })),
        ...extras.map((id) => ({ name: `${id}(検出)`, value: id, checked: true })),
        { name: "その他(自由入力)", value: OTHER_TECH },
      ],
    });

    const chosen = picked.filter((v) => v !== OTHER_TECH);
    if (picked.includes(OTHER_TECH)) {
      const free = splitList(
        await input({
          message: `${category.name}で使う、選択肢にない技術は?(カンマ区切り)`,
        }),
      );
      // 自由入力はプリセット match と照合できるよう小文字に正規化する
      chosen.push(...free.map((s) => s.toLowerCase()));
    }
    selections[category.id] = chosen;
  }

  return toTechStack(catalog, selections);
}

/**
 * 対話ヒアリングで要件を収集する。
 * @param detectedGithubRepo 対象リポジトリの git remote から検出した GitHub リポジトリ(デフォルト値として提示)
 * @param detectedStack 自動検出できた技術スタック(技術スタック選択で初期チェックとして提示)
 */
export async function hearRequirements(
  detectedGithubRepo?: string,
  detectedStack?: TechStack,
): Promise<Requirements> {
  const phase = await select({
    message: "プロジェクトの開発フェーズは?",
    choices: [
      { name: "新規開発(ゼロから立ち上げ)", value: "greenfield" },
      { name: "活発に開発中(機能追加が中心)", value: "active" },
      { name: "保守・運用(安定性が最優先)", value: "maintenance" },
    ],
  });

  // 使用する技術スタックはフェーズによらず確認する(検出はヒューリスティックであり、
  // DB 管理ツールなど検出できない領域もあるため。検出値は初期チェックとして提示する)
  const techStack = await hearTechStack(detectedStack);

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
      { name: "UI/UX デザイン品質", value: "design" },
    ],
    required: true,
  });

  // UI/UX デザイン品質を重視するチームには、対象リポジトリに配るデザインスキルを選ばせる
  const designSkills = focus.includes("design")
    ? await hearDesignSkills({
        phase,
        focus,
        frameworks: [...new Set([...techStack.frameworks, ...(detectedStack?.frameworks ?? [])])],
      })
    : undefined;

  const teamSize = await select({
    message: "チーム規模の希望は?",
    choices: [
      { name: "最小構成(2〜3 エージェント)", value: "minimal" },
      { name: "標準構成(4〜5 エージェント)", value: "standard" },
      { name: "フル構成(役割を細分化)", value: "full" },
    ],
  });

  // 形式仕様モード: 要件・仕様の単一情報源を spec/*.als と docs/adr/ に置き、
  // 自然言語の仕様書は atf weave で生成する(実装前に Alloy の検証ゲートを通す)。
  // 新規開発では「何を作るか」の合意をこの仕様づくりから始めるため、既定で有効にする
  console.log(
    "\n形式仕様モードでは、要件・仕様を Alloy(spec/*.als)と ADR(docs/adr/)に置き、" +
      "\n自然言語の仕様書は必要になったときに生成します(docs/generated/。手書きしません)。",
  );
  const formalSpec = await confirm({
    message:
      "要件・仕様を形式仕様(Alloy)+ ADR で管理しますか?(実装前に充足性を検証するゲートが入ります)",
    default: phase === "greenfield",
  });
  // 反例が出たときに、明白なものは自動で仕様を確定してよいか
  // (無効にすると、仕様の変更は必ずユーザーの判断待ちになる)
  let specAutoFix: boolean | undefined;
  if (formalSpec) {
    specAutoFix = await confirm({
      message:
        "検証で反例が出たとき、選択肢が実質 1 つに決まるものは自動で仕様を確定してよいですか?(.als・ADR・実装まで修正し、根拠を decisions.jsonl に記録します。ビジネスルールや体験の選択、判断に迷うものは必ず確認します)",
      default: true,
    });
  }

  // リバースドキュメント: コードから文書と図を起こして維持する役を追加する。
  // 既存コードがあるフェーズ(活発に開発中・保守運用)では既定で有効にする
  const reverseDocs = await confirm({
    message:
      "コードからドキュメントをリバース生成しますか?(構成・処理フローの文書と図をコードから起こし、実装の変更に追随して維持します)",
    default: phase !== "greenfield",
  });

  // アーキテクチャ適合検証: レイヤ規約を機械検証するフィットネス関数を組み込む
  const archCheck = await confirm({
    message:
      "アーキテクチャ適合検証を導入しますか?(レイヤ規約を rules.json に定義し、ArchUnit / ArchUnitTS / ArchUnitPython / go-arch-lint などで依存の向きの違反を検出します)",
    default: true,
  });

  // ルーブリック評価: 各エージェントの成果物を基準で採点し、未達を差し戻す役を追加する。
  // 評価するエージェントの個別 ON/OFF は、チーム構成が確定したあとに
  // atf-settings.yaml(requirements.evalTargets)で切り替える
  const rubricEval = await confirm({
    message:
      "各エージェントの成果物をルーブリックで評価しますか?(評価観点を rubric.json に定義し、成果物を採点して未達は改善指示つきで差し戻します。エージェントごとの ON/OFF は導入後に atf-settings.yaml で切り替えられます)",
    default: true,
  });

  // 最新機能スカウト: Claude Code / Codex の新機能を調査し、取り込み計画を立てる役を追加する
  const capabilityScout = await confirm({
    message:
      "Claude Code / Codex の最新機能を調査し、このプロジェクトへの取り込み計画を立てるエージェントを追加しますか?(組み込めるもの / 組み込めないものの採否表と、組み込むための計画書を作ります)",
    default: true,
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

  return {
    phase,
    focus,
    designSkills,
    teamSize,
    issueDriven,
    githubRepo,
    prFlow,
    formalSpec,
    specAutoFix,
    reverseDocs,
    archCheck,
    rubricEval,
    capabilityScout,
    techStack,
  };
}

/** モバイル向けの画像生成スキルを既定 ON にするかの判定 */
const looksMobile = (focus: string[], frameworks: string[]): boolean =>
  focus.includes("mobile") ||
  frameworks.some((f) => ["flutter", "react-native", "expo", "swiftui"].includes(f));

/**
 * 対象リポジトリに導入するデザインスキルを選択する(focus に design を含むときだけ呼ぶ)。
 * 選択肢は templates/skills のカタログから動的に組み立てるため、
 * スキルを追加してもこの関数を変更する必要はない。
 *
 * - 見た目の方向性(aesthetic)は指示が衝突するため 1 つだけ選ばせる
 * - 作業の進め方(workflow)・画像生成(imagegen)は併用できるため複数選択にする
 * - `current` に適用済みのデザイン(カタログ id)を渡すと初期値として提示する
 *   (`atf apply design` での再選択。空配列ではなく未指定のときだけ推奨値・ヒューリスティックを使う)
 */
export async function hearDesignSkills(ctx: {
  phase: string;
  focus: string[];
  frameworks: string[];
  current?: string[];
  catalog?: SkillDef[];
}): Promise<string[]> {
  const catalog = ctx.catalog ?? loadSkillCatalog();
  if (catalog.length === 0) return [];

  const label = (s: SkillDef) => `${s.name} — ${s.description.split(/[。.]\s?/)[0]}`;
  const selected: string[] = [];

  console.log("\n対象リポジトリに導入するデザインスキル（UI 実装時に参照する指針）を選びます。");
  console.log("スキルは .claude/skills/ に配置され、エージェントが UI を実装するときに参照します。\n");

  const aesthetic = catalog.filter((s) => s.category === "aesthetic");
  if (aesthetic.length > 0) {
    const style = await select<string>({
      message: "見た目の方向性を 1 つ選んでください(併用すると指示が衝突するため 1 つだけ)",
      choices: [
        ...aesthetic.map((s) => ({ name: label(s), value: s.id })),
        { name: "指定しない", value: "" },
      ],
      default: ctx.current
        ? // 適用済みのデザインを選び直す場合は現状を初期値にする(未選択だった = 指定しない)
          aesthetic.find((s) => ctx.current!.includes(s.id))?.id ?? ""
        : aesthetic.find((s) => s.recommended)?.id ?? aesthetic[0].id,
    });
    if (style) selected.push(style);
  }

  const extras = catalog.filter((s) => s.category === "workflow" || s.category === "imagegen");
  if (extras.length > 0) {
    const isMobile = looksMobile(ctx.focus, ctx.frameworks);
    const checked = (s: SkillDef) =>
      // 適用済みのデザインがあるならその内容を、なければ
      // 既存プロジェクトの改善には redesign 系、モバイル案件にはモバイル向け画像生成を既定で提案する
      ctx.current
        ? ctx.current.includes(s.id)
        : (s.id === "redesign-skill" && ctx.phase !== "greenfield") ||
          (s.id === "imagegen-frontend-mobile" && isMobile);
    const picked = await checkbox<string>({
      message: "併用するスキルを選んでください(複数可・0 件可)",
      choices: extras.map((s) => ({ name: label(s), value: s.id, checked: checked(s) })),
    });
    selected.push(...picked);
  }

  return selected;
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
