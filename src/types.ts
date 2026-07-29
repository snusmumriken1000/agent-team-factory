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
