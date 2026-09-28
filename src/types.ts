/** 対象リポジトリの自動解析結果 */
export interface RepoProfile {
  /** リポジトリの絶対パス */
  path: string;
  /** リポジトリ名(ディレクトリ名) */
  name: string;
  /** 検出された言語(拡張子ベース、ファイル数の多い順) */
  languages: string[];
  /** 検出されたフレームワーク・主要ツール(react, next, django など) */
  frameworks: string[];
  /** CI 設定の有無(.github/workflows など) */
  hasCI: boolean;
  /** テストの存在(テストディレクトリ・設定ファイル) */
  hasTests: boolean;
  /** おおよそのソースファイル数 */
  fileCount: number;
  /** git remote から検出した GitHub リポジトリ(owner/repo 形式、未検出なら undefined) */
  githubRepo?: string;
}

/**
 * 新規開発(greenfield)の立ち上げで聞く、仕様の枠。
 *
 * 書き込み先は `spec/main.als` のルートモジュールの doc comment だけで、
 * **`atf-settings.yaml` には保存しない**(保存すると仕様の置き場が 2 つになる)。
 * 導入後にこれらを変えるときは `.als` を直す。
 */
export interface SpecFrame {
  /** @title — 仕様全体の名称 */
  title: string;
  /** @scope — この仕様が扱う範囲 */
  scope: string;
  /** @out-of-scope — 意図的に扱わない範囲(1 行 1 件) */
  outOfScope: string[];
  /** @stakeholder — 承認者と承認日 */
  stakeholder: string;
  /** @tradeoff — トレードオフが必要になったときに最優先するもの(そのまま .als に書く文) */
  tradeoff: string;
}

/** 技術スタックカタログ(templates/tech-stack.json)の 1 技術 */
export interface TechItem {
  /** 技術の id(analyzer の検出値・プリセット match と同じ語彙にすること) */
  id: string;
  /** 表示名(ヒアリングの選択肢・エージェント定義・ダッシュボードに出る) */
  name: string;
}

/**
 * 技術スタックのカテゴリ(言語 / DB・スキーマ管理 など)。
 * templates/tech-stack.json に定義し、ヒアリングの選択肢を組み立てる。
 */
export interface TechCategory {
  /** カテゴリ id(TechStack.categories のキー) */
  id: string;
  /** カテゴリの表示名 */
  name: string;
  /** 補足説明(ヒアリングの質問文に出る) */
  description?: string;
  /**
   * 選択結果のマージ先。プリセットのスコアリングとプレースホルダ置換に効く
   * (languages → RepoProfile.languages / frameworks → RepoProfile.frameworks)。
   */
  target: "languages" | "frameworks";
  /** 常にヒアリング対象にするカテゴリ(言語・フレームワークなど。既定は false) */
  always?: boolean;
  /** このカテゴリで選べる技術 */
  items: TechItem[];
}

/** ヒアリングで選択する技術スタック */
export interface TechStack {
  /** 使用する言語(analyzer の検出値・プリセット match と同じ語彙。未定なら空) */
  languages: string[];
  /** 使用するフレームワーク・主要ツール(未定なら空) */
  frameworks: string[];
  /**
   * カテゴリ id → 選択した技術 id。カテゴリ単位の選択結果をそのまま保持する
   * (languages / frameworks はこれを target ごとに平坦化したもの)。
   */
  categories?: Record<string, string[]>;
}

/** ヒアリングで得た要件 */
export interface Requirements {
  /** 開発フェーズ: greenfield | active | maintenance */
  phase: string;
  /** 重視する観点(quality, security, speed, docs など) */
  focus: string[];
  /** チーム規模の希望: minimal | standard | full */
  teamSize: string;
  /** Issue 駆動開発にするか(true なら issue-manager をチームに追加し、全エージェントが Issue 起点で動く) */
  issueDriven?: boolean;
  /** チームが使う GitHub リポジトリ(owner/repo 形式)。ヒアリングで必ず確認する(未設定なら undefined) */
  githubRepo?: string;
  /** ブランチ + Pull Request のフロー(push → gh pr create → マージ)を開発手順に含めるか(githubRepo の設定が前提) */
  prFlow?: boolean;
  /**
   * 人間のタッチポイント。フロープレビュー HTML の確認後、チーム構築時に選択する。
   * - "issue-approval": エージェントが起票した Issue をユーザーが承認してから着手する
   * - "pr-merge": PR のマージはユーザーが行う(未選択なら CI・レビュー確認後にエージェントが gh pr merge まで実行)
   */
  touchpoints?: string[];
  /**
   * 形式仕様モード。true なら要件・仕様の単一情報源を Alloy(`spec/*.als`)と
   * ADR(`docs/adr/`)に置き、自然言語の文書は `atf weave` で必要なときに生成する
   * (`docs/generated/` は使い捨ての派生物)。実装前に検証(check / run)を通すゲートを
   * ワークフローに組み込み、spec-formalizer エージェントが teamSize の枠外で追加される。
   */
  formalSpec?: boolean;
  /**
   * 反例・充足不能が出たときに、spec-formalizer が仕様を自動で確定してよいか(formalSpec 有効時にヒアリング)。
   * - true(既定): 修正の選択肢が実質 1 つに決まるものは `.als`・ADR・実装まで自動で直し、
   *   判断の根拠を `.claude/atf-formal/decisions.jsonl` に記録する(設計判断が要るものは従来どおりユーザーに確認する)
   * - false: 反例が出たら必ず選択肢と推奨案を提示してユーザーの判断を待つ(自動では直さない)
   */
  specAutoFix?: boolean;
  /**
   * 最新機能スカウト。true なら Claude Code / Codex の新機能を調査し、
   * このプロジェクトに組み込めるかを検証して採否表と組み込み計画書を作る
   * capability-scout エージェントが teamSize の枠外で追加される。
   */
  capabilityScout?: boolean;
  /**
   * リバースドキュメントモード。true ならコードを解析して構成・処理フローの文書と図を起こし、
   * 実装の変更にあわせて維持する doc-reverser エージェントが teamSize の枠外で追加される
   * (図の生成には同梱の archify スキルを使う)。
   */
  reverseDocs?: boolean;
  /**
   * アーキテクチャ適合検証。true なら文書化したアーキテクチャをレイヤ規約
   * (.claude/atf-arch/rules.json)に落とし、ArchUnit などのフィットネス関数で
   * コードレベルの違反を検出する arch-guard エージェントが teamSize の枠外で追加される。
   */
  archCheck?: boolean;
  /**
   * ルーブリック評価。true なら各エージェントの成果物を
   * ルーブリック(.claude/atf-eval/rubric.json)で採点する evaluator エージェントが
   * teamSize の枠外で追加される。**機能全体の ON/OFF はこのフラグ**で、
   * エージェントごとの ON/OFF は evalTargets で指定する。
   */
  rubricEval?: boolean;
  /**
   * 評価対象にするエージェントの ON/OFF(エージェント名 → true/false)。
   * 省略、またはキーがないエージェントは **評価対象(true)** として扱う
   * (新しく増えたエージェントが黙って評価から外れないようにするため)。
   * evaluator 自身は常に対象外。手で false にして `atf apply eval` をやり直すと、
   * そのエージェント定義から評価の指示が外れる。
   */
  evalTargets?: Record<string, boolean>;
  /** 技術スタック(ヒアリングでカテゴリごとに選択。cli.ts が applyTechStack でプロファイルに統合する) */
  techStack?: TechStack;
  /**
   * 対象リポジトリに導入するデザインスキルのカタログ id(templates/skills/<id>)。
   * focus に "design" が含まれるときにヒアリングで選択する。
   * generator が .claude/skills/<スキル名>/SKILL.md として配置し、
   * 全エージェントに「UI 実装時は該当スキルを使う」指示を付与する。
   */
  designSkills?: string[];
}

/**
 * スキルの分類。ヒアリングでの聞き方が変わる:
 * - aesthetic: 見た目の方向性。指示が衝突するため 1 つだけ選ぶ
 * - workflow: 作業の進め方。複数併用できる
 * - imagegen: 画像生成専用(コードは書かない)。複数併用できる
 * - diagram: 図・ドキュメント生成(デザインのヒアリング対象外。機能の選択に応じて導入する)
 */
export type SkillCategory = "aesthetic" | "workflow" | "imagegen" | "diagram";

/** 外部リポジトリから取り込んだスキルの出典(再配布時の表示に使う) */
export interface SkillSource {
  /** owner/repo 形式 */
  repo: string;
  homepage?: string;
  /** 上流リポジトリ内の SKILL.md のパス */
  path: string;
  /** 取り込んだ commit(pin)。commit を特定できない同梱(vendored)では省略する */
  commit?: string;
  /** 取り込んだ版(commit が分からない同梱で使う。例: 2.17.0) */
  version?: string;
  /**
   * 複数ファイルからなるスキルを、上流のパッケージごと同梱していることを示す。
   * sync-skills.mjs は取得せず(ネットワーク越しの単一 SKILL.md ではないため)、
   * 出典表示だけを NOTICE.md に載せる。
   */
  vendored?: boolean;
  /** 同梱時に除外したパス(サイズ削減のため。出典表示に載せる) */
  excluded?: string[];
  license?: string;
}

/** スキル定義(templates/skills/<id>/)。名前と説明は SKILL.md の frontmatter が単一情報源 */
export interface SkillDef {
  /** カタログ id(ディレクトリ名) */
  id: string;
  /** インストール名(frontmatter の name)。配置先ディレクトリ名にもなる */
  name: string;
  description: string;
  category: SkillCategory;
  /** ヒアリングの既定値にするか */
  recommended: boolean;
  /** 外部由来のときだけ設定される */
  source?: SkillSource;
  /** スキルのルートディレクトリ(ロード時に付与) */
  dir: string;
}

/** 対象リポジトリに導入したスキル(atf-settings.yaml とダッシュボードの入力) */
export interface InstalledSkill {
  id: string;
  name: string;
  description: string;
  category: string;
  source?: SkillSource;
}

/** プリセット定義(templates/presets/<id>/preset.json) */
export interface Preset {
  id: string;
  name: string;
  description: string;
  /** マッチ条件。profile/requirements と照合してスコアリングに使う */
  match: {
    languages?: string[];
    frameworks?: string[];
    focus?: string[];
    phase?: string[];
  };
  /** チームに含まれるエージェント定義ファイル名(agents/ 配下の .md) */
  agents: string[];
  /** エージェント間の入出力フロー(from → to のエージェント名ペア)。可視化に使う */
  flow?: string[][];
  /** プリセットのルートディレクトリ(ロード時に付与) */
  dir: string;
}

/** 対象リポジトリの atf-settings.yaml に記録されるチーム設定(旧 .claude/team.json) */
export interface TeamManifest {
  generatedBy: string;
  preset: string;
  presetName: string;
  project: string;
  requirements: Requirements;
  agents: TeamAgent[];
  flow: string[][];
  /** 導入したスキル(.claude/skills/)。未導入なら省略される */
  skills?: InstalledSkill[];
}

/** マニフェスト内のエージェント情報(frontmatter から抽出) */
export interface TeamAgent {
  file: string;
  name: string;
  description: string;
}

/** .claude/atf-issues/ の Issue ドラフト 1 件(チームのタスク) */
export interface TaskDraft {
  /** ファイル名から拡張子を除いた ID(例: draft-01-project-scaffold) */
  id: string;
  /** 参照用の短い ID(例: draft-01)。他ドラフトからの依存参照に使う */
  ref: string;
  /** ファイル名 */
  file: string;
  /** 1 行目の見出し(なければファイル名) */
  title: string;
  /** 依存するタスクの ref(例: ["draft-01"]) */
  dependsOn: string[];
}

/** .claude/atf-logs/runs.jsonl の 1 行(エージェントが自己申告する実行記録) */
export interface RunRecord {
  agent: string;
  task?: string;
  inputs?: string;
  outputs?: string;
  status?: string;
  finishedAt?: string;
  /** Issue 駆動時の対応 Issue 番号(例: "#123") */
  issue?: string;
}

/** プリセット選定結果 */
export interface ScoredPreset {
  preset: Preset;
  score: number;
}

/**
 * Alloy の検証結果。`check`(表明の反証探索)と `run`(充足可能性の確認)で意味が異なる:
 * - pass: check で反例が見つからなかった(表明はスコープ内で成立)
 * - counterexample: check で反例が見つかった(設計の欠陥)
 * - instance: run でインスタンスが見つかった(その要件は充足可能)
 * - no-instance: run でインスタンスが見つからなかった(制約が矛盾している疑い)
 * - error: 構文エラーなど、検証自体が実行できなかった
 * - unknown: 出力を解釈できなかった(生の出力を detail に残す)
 */
export type SpecResult =
  | "pass"
  | "counterexample"
  | "instance"
  | "no-instance"
  | "error"
  | "unknown";

/**
 * `.als` の doc comment(`/**` で始まるブロックコメント)に書かれたタグ 1 件。
 *
 * タグ語彙は形式仕様先行戦略 §3.2 に従う(`@title` / `@scope` / `@out-of-scope` /
 * `@stakeholder` / `@module` / `@term` / `@rationale` / `@relaxed` / `@req` /
 * `@validation` / `@adr`)。atf はこれに `@tradeoff`(トレードオフ時の最優先)を足している。
 */
export interface SpecTag {
  /** タグ名(先頭の `@` を除く。例: req) */
  name: string;
  /** タグの値(複数行にまたがる場合は空白で連結する) */
  value: string;
}

/** 宣言の直上に置かれた doc comment(タグ + タグの付かない散文) */
export interface SpecDoc {
  /** タグの付かない散文(宣言そのものの説明。weave の本文になる) */
  prose: string[];
  /** タグの並び(書かれた順。同じタグが複数回現れてよい) */
  tags: SpecTag[];
}

/** doc comment を貼る対象になる宣言の種類 */
export type SpecDeclKind =
  | "module"
  | "open"
  | "sig"
  | "fact"
  | "pred"
  | "assert"
  | "fun"
  | "check"
  | "run"
  | "other";

/** `.als` の宣言 1 件(doc comment と対応付けたもの) */
export interface SpecDeclaration {
  kind: SpecDeclKind;
  /** 宣言の名前(check / run はコマンド名。無名なら空文字) */
  name: string;
  /** 宣言の先頭行(一覧表示に使うシグネチャ) */
  signature: string;
  /** 宣言の全文(本文の波括弧を含む) */
  code: string;
  /** 直上の doc comment(なければ undefined) */
  doc?: SpecDoc;
  /** ファイル内の行番号(1 始まり。lint の報告に使う) */
  line: number;
}

/** `.als` から抽出した検証コマンド(check / run) */
export interface SpecCommand {
  kind: "check" | "run";
  /** コマンド名(assert / pred の名前)。トレーサビリティのため無名コマンドは使わない運用 */
  name: string;
  /** for 5 などのスコープ指定(なければ undefined) */
  scope?: string;
  /** doc comment の `@req` に書かれた要件 ID(`check` には必須。lint が検査する) */
  requirements: string[];
  /** `@validation`(この検証が何の機械的証拠になるか) */
  validation?: string;
  /** ファイル内の行番号(1 始まり) */
  line: number;
}

/**
 * `@req <ID> <要件の文>` から拾った業務要件。
 * 要件の文を書けるのは 1 か所だけで(lint が重複を検出する)、
 * 他の宣言からは ID だけで参照する。
 */
export interface SpecRequirement {
  /** 要件 ID(例: R-014) */
  id: string;
  /** 要件の文(ID だけの参照では空文字) */
  text: string;
  /** この要件 ID が付いている宣言の名前 */
  declarations: string[];
  /** ファイル内の行番号(1 始まり) */
  line: number;
}

/** `spec/*.als` のモデル 1 件 */
export interface SpecModel {
  /** ファイル名(例: accessControl.als) */
  file: string;
  /** module 宣言の名前(なければファイル名から) */
  module: string;
  /** module 宣言に付いた doc comment(ルートモジュールなら @title / @scope / @out-of-scope / @stakeholder) */
  doc?: SpecDoc;
  /** 宣言の並び(doc comment の有無によらず、書かれた順) */
  declarations: SpecDeclaration[];
  /** `@req` から集めた要件 */
  requirements: SpecRequirement[];
  /** モデル内の check / run コマンド */
  commands: SpecCommand[];
}

/** .claude/atf-formal/checks.jsonl の 1 行(Alloy 検証の記録) */
export interface SpecCheckRecord {
  /** モデルのファイル名(例: order.als) */
  model: string;
  /** 実行した check / run のコマンド名 */
  command: string;
  kind?: "check" | "run" | "unknown";
  result: SpecResult;
  /** Alloy の出力から拾った 1 行(反例の要約など) */
  detail?: string;
  /** ISO 8601 形式の検証時刻 */
  checkedAt?: string;
  /** 記録したエージェント(atf formal で記録した場合は "atf formal") */
  agent?: string;
}

/**
 * 反例・充足不能をもとに「圧倒的に推奨される仕様」へ自動で寄せた判断の記録
 * (`.claude/atf-formal/decisions.jsonl` の 1 行。書くのは spec-formalizer、
 * atf は読んで可視化・点検するだけ)。
 *
 * requirements.specAutoFix が false のときは自動確定を行わないため、このファイルは空になる。
 */
export interface SpecDecisionRecord {
  /** 対象の要件 ID(@req の ID。例: R-01) */
  requirement: string;
  /** モデルのファイル名(例: order.als) */
  model?: string;
  /** 反例が出た check / run のコマンド名 */
  command?: string;
  /** 何が破れていたか(反例・充足不能の要旨) */
  finding: string;
  /** 採用した仕様(日本語。設計書に書く文面と揃える) */
  decision: string;
  /** なぜその仕様が圧倒的に推奨されるのか(根拠) */
  rationale: string;
  /** 採らなかった選択肢(あれば。ユーザーが覆せるようにするため残す) */
  alternatives?: string[];
  /** 自動で修正したファイル(.als・設計書・実装) */
  changed?: string[];
  /** 修正後の再検証で充足したか */
  reverified?: boolean;
  /** ISO 8601 形式の判断時刻 */
  decidedAt?: string;
  /** 判断したエージェント(通常 spec-formalizer) */
  agent?: string;
  /**
   * ユーザーの確認状況。
   * - auto: 自動確定したがユーザーは未確認(既定。報告に含める)
   * - confirmed: ユーザーが確認して了承した
   * - reverted: ユーザーが別の仕様に差し戻した
   */
  status?: "auto" | "confirmed" | "reverted";
}

/** sig のフィールド(関係)。`customer: one Customer` の 1 件 */
export interface SpecField {
  /** フィールド名 */
  name: string;
  /** 多重度(one / lone / some / set。省略時は undefined) */
  multiplicity?: string;
  /** 関係の相手(型の式に出てくる最初の sig 名。`Order -> lone State` なら Order) */
  target: string;
  /** 型の式そのもの(表示用。`seq Order` や `Order -> lone State` のような形も残す) */
  expression: string;
  /** フィールドの直上に置いた doc comment(`@term` を書くと用語集に載る) */
  doc?: SpecDoc;
}

/** `.als` から抽出した sig(もの)の定義。関係性グラフと用語集の入力 */
export interface SpecSig {
  /** sig 名 */
  name: string;
  /** abstract sig か */
  abstract?: boolean;
  /** sig 自体の多重度(one / lone / some。`one sig Pending` の one) */
  multiplicity?: string;
  /** extends / in の相手(なければ undefined) */
  parent?: string;
  /** parent との関係の種類 */
  parentKind?: "extends" | "in";
  /** フィールド(関係) */
  fields: SpecField[];
  /** sig 宣言の doc comment */
  doc?: SpecDoc;
}

/**
 * ユースケース図のアクター(`@actor <名前> <説明>`)。
 * Alloy の言語にはアクターの概念がないため、doc comment のタグを情報源にする。
 */
export interface SpecActor {
  /** アクター名(`@usecase` の 1 語目と突き合わせるキー) */
  name: string;
  /** 説明(省略可) */
  description?: string;
  /** タグを書いた宣言の名前(sig 名など。出典の表示に使う) */
  declaration?: string;
}

/**
 * ユースケース図の 1 ユースケース(`@usecase <アクター> <ユースケース名>`)。
 * 書く場所は pred / run / assert など「振る舞い」の宣言の doc comment。
 */
export interface SpecUseCase {
  /** 実行するアクター名(`@actor` で定義した名前。未設定なら undefined) */
  actor?: string;
  /** ユースケース名(利用者から見た目的) */
  name: string;
  /** タグを書いた宣言の名前 */
  declaration: string;
  /** タグを書いた宣言の種類(pred / run など) */
  kind: SpecDeclKind;
  /** その宣言の `@req` から拾った要件 ID */
  requirements: string[];
}

/**
 * 最新機能の採否判定。capability-scout が 1 機能ごとに下す。
 * - adopt: 組み込める(組み込み計画書を作る)
 * - trial: 組み込める見込みだが、まず小さく試して確かめる
 * - hold: 前提条件(版・プラン・権限など)が満たされれば組み込める
 * - reject: 組み込めない(プロジェクトに合わない・前提が満たせない)
 */
export type CapabilityVerdict = "adopt" | "trial" | "hold" | "reject";

/** .claude/atf-capabilities/findings.jsonl の 1 行(調査した機能 1 件の採否) */
export interface CapabilityFinding {
  /** 機能の安定 ID(例: cc-subagents)。同じ ID の行は後勝ちで最新の判定になる */
  id: string;
  /** 情報源のプロダクト(claude-code / codex / claude-api など) */
  product: string;
  /** 機能名 */
  name: string;
  /** 何ができる機能か(1〜2 文) */
  summary: string;
  /** 採否の判定 */
  verdict: CapabilityVerdict;
  /** 判定の根拠(組み込める理由 / 組み込めない理由) */
  reason: string;
  /** どう確かめたか(実行したコマンド・読んだドキュメント・試した結果) */
  evidence?: string;
  /** 一次情報の URL(ドキュメント・変更履歴) */
  docUrl?: string;
  /** 確認した版(例: claude-code 2.1.0)。版に依存する機能の再調査に使う */
  version?: string;
  /** 想定工数の目安(S / M / L) */
  effort?: string;
  /** 組み込み計画書のパス(verdict が adopt / trial のとき。例: plan-cc-subagents.md) */
  plan?: string;
  /** 調査日時(ISO 8601) */
  surveyedAt?: string;
  /** 記録したエージェント */
  agent?: string;
}

/** .claude/atf-capabilities/plan-*.md(組み込み計画書)1 件 */
export interface CapabilityPlan {
  /** ファイル名(例: plan-cc-subagents.md) */
  file: string;
  /** 対応する findings の id(ファイル名の plan- を除いた部分) */
  id: string;
  /** 1 行目の見出し(なければファイル名) */
  title: string;
}

/**
 * リバースドキュメントの種類。全体像から詳細へ並ぶ順に定義する
 * (ダッシュボードの表示順にも使う)。
 */
export type ReverseDocKind =
  | "overview"
  | "structure"
  | "flow"
  | "data"
  | "api"
  | "ops"
  | "decision";

/** .claude/atf-docs/docs.jsonl の 1 行(コードから起こした文書 1 件) */
export interface ReverseDocRecord {
  /** 生成した文書のパス(リポジトリルートからの相対パス。例: docs/architecture/overview.md) */
  path: string;
  /** 文書の見出し */
  title: string;
  /** 文書の種類 */
  kind: ReverseDocKind;
  /** 根拠にしたコード(ファイル・ディレクトリのパス)。文書 ↔ コードのトレーサビリティ */
  sources: string[];
  /** 添付した図のパス(archify が生成した HTML など) */
  diagram?: string;
  /** 図の種類(architecture / workflow / sequence / dataflow / lifecycle) */
  diagramType?: string;
  /** 1〜2 文の要約(ダッシュボード表示用) */
  summary?: string;
  /** 生成時点の git HEAD(短縮 SHA でよい)。実装がどこまで反映されているかの目印 */
  commit?: string;
  /** 生成日時(ISO 8601) */
  generatedAt?: string;
  /** 生成したエージェント */
  agent?: string;
}

/** 記録と実ファイルを突き合わせた結果(文書が実装に追随しているかの点検) */
export interface ReverseDocStatus {
  record: ReverseDocRecord;
  /** 文書本体が存在するか */
  docExists: boolean;
  /** 図が存在するか(図の記録がない場合は undefined) */
  diagramExists?: boolean;
  /** 根拠にしたコードのうち、現在は存在しないパス(文書が古い疑い) */
  missingSources: string[];
}

/** アーキテクチャ規約のレイヤ(.claude/atf-arch/rules.json) */
export interface ArchLayer {
  /** レイヤ id(ルールの from / to で参照する) */
  id: string;
  /** 表示名 */
  name: string;
  /** このレイヤに属するコードのパターン(glob・パッケージ名など。検証ツールに渡す) */
  patterns: string[];
  description?: string;
}

/**
 * アーキテクチャ規約 1 件の種類。
 * - forbid: from から to への依存を禁止する
 * - allow-only: from が依存してよいのは to だけ(それ以外への依存を禁止)
 * - no-cycle: 循環依存を禁止する
 * - naming: 命名・配置の規約
 * - custom: 上記に当てはまらない規約(検証は tool に委ねる)
 */
export type ArchRuleKind = "forbid" | "allow-only" | "no-cycle" | "naming" | "custom";

/**
 * アーキテクチャ適合検証ツール 1 件(templates/arch-tools.json のカタログ項目)。
 * atf はツールを直接叩かないため、ここにあるのは「arch-guard に渡す配線の知識」だけ。
 */
export interface ArchTool {
  /** ツール id(rules.json の tool に書く値) */
  id: string;
  /** 表示名 */
  name: string;
  /** 対象言語(analyzer の検出値・tech-stack.json と同じ語彙) */
  languages: string[];
  /** その言語の既定の推奨(言語ごとに 1 つだけ) */
  recommended?: boolean;
  /** 公式ドキュメント・リポジトリ */
  url?: string;
  /** 導入方法(依存の追加はユーザー確認が前提) */
  install?: string;
  /** 規約を書く場所(設定ファイル・テストコード) */
  config?: string;
  /** 検証の実行コマンド */
  run?: string;
  /** 出力を ARCH 行に変換する手順 */
  report?: string;
  /** 向き・不向きや制約 */
  notes?: string;
}

/** アーキテクチャ規約 1 件(ArchUnit などの検証 1 件に対応する) */
export interface ArchRule {
  /** 規約の安定 id(検証記録と対応させる。例: ARCH-01) */
  id: string;
  /** 規約の内容(日本語 1 文) */
  description: string;
  kind: ArchRuleKind;
  /** 依存元のレイヤ id(kind が no-cycle / naming のときは省略可) */
  from?: string;
  /** 依存先のレイヤ id(forbid は禁止先、allow-only は許可先) */
  to?: string[];
  /** この規約を検証している実体(ArchUnit のテスト名・コマンドなど) */
  tool?: string;
  /** 規約の根拠(リバースドキュメント・ADR のパス) */
  source?: string;
  /** 違反の扱い(既定は error) */
  severity?: "error" | "warn";
}

/** .claude/atf-arch/rules.json(アーキテクチャ規約の単一情報源) */
export interface ArchRuleSet {
  project?: string;
  /** 検証に使うツール(archunit / dependency-cruiser / import-linter / deptrac など) */
  tool?: string;
  /** 検証の実行コマンド(run-arch-check.sh が実行するもの。記録用) */
  command?: string;
  layers: ArchLayer[];
  rules: ArchRule[];
  /** 規約に落とせなかった申し合わせ(レビューで担保する) */
  notes?: string[];
}

/**
 * アーキテクチャ検証の結果。
 * - pass: 違反なし
 * - violation: 違反あり(実装が規約から外れている)
 * - error: 検証自体が実行できなかった(ツール未導入・設定エラー)
 * - unknown: 出力を解釈できなかった
 */
export type ArchResult = "pass" | "violation" | "error" | "unknown";

/** .claude/atf-arch/checks.jsonl の 1 行(アーキテクチャ検証の記録) */
export interface ArchCheckRecord {
  /** 検証した規約の id(rules.json の ArchRule.id)。実行単位の記録は "(実行)" */
  rule: string;
  result: ArchResult;
  /** 違反件数(分かる場合) */
  violations?: number;
  /** 出力から拾った 1 行(違反箇所の要約など) */
  detail?: string;
  /** 検証に使ったツール */
  tool?: string;
  /** 検証時刻(ISO 8601) */
  checkedAt?: string;
  /** 記録したエージェント(atf arch で記録した場合は "atf arch") */
  agent?: string;
}

/** ルーブリックの評価水準 1 段階(.claude/atf-eval/rubric.json) */
export interface RubricLevel {
  /** 水準のスコア(大きいほど良い。既定の雛形は 4〜1) */
  score: number;
  /** 水準の名前(優秀 / 合格 など) */
  label: string;
  /** その水準と判定する条件(観察できる事実で書く) */
  description: string;
}

/**
 * 閾値に対する採点結果ごとのネクストアクション。
 * 「スコアが閾値未満ならこうする / 満たしていればこう進む」を**評価基準の側に**書いておくことで、
 * 差し戻しの指示が評価のたびにぶれないようにする。
 */
export interface RubricActions {
  /** 閾値未満だったときにやること(差し戻しの手順) */
  below?: string[];
  /** 閾値以上だったときにやること(次に進む手順) */
  meets?: string[];
}

/** ルーブリックの評価観点 1 件(評価 1 項目に対応する) */
export interface RubricCriterion {
  /** 観点の安定 id(評価記録と対応させる。例: EVAL-01) */
  id: string;
  /** 観点の名前 */
  name: string;
  /** 何を見る観点か(1 文) */
  description: string;
  /** 総合スコアを出すときの重み(既定 1) */
  weight?: number;
  /** この観点だけの合格線(省略時は Rubric.passScore を使う) */
  passScore?: number;
  /**
   * この観点を適用するエージェント名。省略 or ["*"] で全エージェントに適用する
   * (実装向けの観点とドキュメント向けの観点を分けるために使う)。
   */
  appliesTo?: string[];
  /** この観点の閾値に対するネクストアクション(省略時は Rubric.actions を使う) */
  actions?: RubricActions;
  /** 評価水準(スコアの降順で書く) */
  levels: RubricLevel[];
}

/** .claude/atf-eval/rubric.json(ルーブリック = 評価基準の単一情報源) */
export interface Rubric {
  project?: string;
  /** 合格とみなす最低スコア(観点ごと・総合の両方に使う。既定 3) */
  passScore?: number;
  /** 観点に actions がないときに使う、閾値に対するネクストアクションの既定 */
  actions?: RubricActions;
  criteria: RubricCriterion[];
  /** ルーブリックに落とせなかった申し合わせ(人のレビューで担保する) */
  notes?: string[];
  /**
   * atf が置いた雛形のままであることを示す目印。
   * evaluator が観点を書き起こしたらこの項目を削除する
   * (「評価基準が未整備」の判定の単一情報源)。
   */
  template?: boolean;
}

/**
 * 成果物 1 件に対する評価の判定。
 * - pass: 合格(そのまま次へ進んでよい)
 * - revise: 要改善(指摘を直して再評価する)
 * - fail: 不合格(やり直し。設計・方針から見直す)
 * - unknown: 判定できなかった(評価の前提が足りない)
 */
export type EvalVerdict = "pass" | "revise" | "fail" | "unknown";

/** 観点ごとの採点(評価記録 1 行に複数含まれる) */
export interface EvaluationScore {
  /** 観点の id(RubricCriterion.id) */
  id: string;
  /** 付けたスコア(その観点の levels のいずれかの score) */
  score: number;
  /** 採点の根拠(観察した事実。空にしない運用) */
  comment?: string;
}

/** .claude/atf-eval/evaluations.jsonl の 1 行(成果物 1 件の評価) */
export interface EvaluationRecord {
  /** 評価対象のエージェント名(atf-settings.yaml の agents の name) */
  target: string;
  /** 評価した成果物(ファイルパス・PR・Issue など。target との組で 1 件を識別する) */
  artifact: string;
  /** どの依頼に対する成果物か */
  task?: string;
  /** 観点ごとの採点 */
  scores: EvaluationScore[];
  /** 総合スコア(省略時は scores の加重平均を使う) */
  total?: number;
  verdict: EvalVerdict;
  /** 改善指示(verdict が revise / fail のときは必ず書く) */
  actions?: string[];
  /** 評価時刻(ISO 8601) */
  evaluatedAt?: string;
  /** 記録したエージェント(通常は evaluator) */
  agent?: string;
  /** Issue 駆動時の対応 Issue 番号(例: "#123") */
  issue?: string;
}
