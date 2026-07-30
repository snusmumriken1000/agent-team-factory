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

/** 新規開発(greenfield)時にヒアリングするインセプションデッキ(何を作るかの合意) */
export interface InceptionDeck {
  /** なぜ作るのか(背景・解決したい課題) */
  purpose: string;
  /** 誰のためのプロダクトか(対象ユーザー) */
  targetUsers: string;
  /** 中核となる価値(既存の代替手段との違い) */
  coreValue: string;
  /** 必ず実現すること(スコープ内) */
  mustHave: string[];
  /** やらないことリスト(スコープ外の明確化) */
  notList: string[];
  /** 成功の判断基準 */
  successCriteria: string;
  /** 夜も眠れない問題(最大の懸念・リスク。空欄可) */
  risks: string;
  /** トレードオフ時に最優先するもの */
  tradeoffPriority: "quality" | "deadline" | "scope" | "cost";
}

/** tradeoffPriority → 表示用ラベル(生成物・ダッシュボードの両方で使う) */
export const TRADEOFF_LABEL: Record<string, string> = {
  quality: "品質(品質を落とさない)",
  deadline: "期日(リリース時期を守る)",
  scope: "スコープ(予定した機能を削らない)",
  cost: "コスト(費用・工数を増やさない)",
};

/** 新規開発(greenfield)時にヒアリングで選択する技術スタック */
export interface TechStack {
  /** 使用する言語(analyzer の検出値・プリセット match と同じ語彙。未定なら空) */
  languages: string[];
  /** 使用するフレームワーク・主要ツール(未定なら空) */
  frameworks: string[];
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
  /** インセプションデッキ(phase が greenfield のときにヒアリングで作成。何を作るかの合意事項) */
  inception?: InceptionDeck;
  /** 技術スタック(phase が greenfield のときにヒアリングで選択。cli.ts が applyTechStack でプロファイルに統合する) */
  techStack?: TechStack;
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

/** 対象リポジトリの .claude/team.json に記録されるマニフェスト */
export interface TeamManifest {
  generatedBy: string;
  preset: string;
  presetName: string;
  project: string;
  requirements: Requirements;
  agents: TeamAgent[];
  flow: string[][];
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
