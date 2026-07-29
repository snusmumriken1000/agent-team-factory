# ARCHITECTURE

agent-team-factory(`atf`)の内部アーキテクチャを説明する。CLI の使い方や開発コマンドは [CLAUDE.md](./CLAUDE.md) を参照。

## 全体像

atf は「対象リポジトリの自動解析」と「対話ヒアリング」の 2 系統の入力から要件を組み立て、最適なプリセットを選んでエージェントチーム一式を対象リポジトリに書き込むパイプラインである。

```
                 ┌─────────────┐
  対象リポジトリ →│ analyzer.ts │→ RepoProfile ─┐
                 └─────────────┘               │   ┌────────────┐              ┌──────────────┐
                                               ├──→│ presets.ts │→ ScoredPreset│ generator.ts │→ 対象リポジトリへ書き込み
                 ┌─────────────┐               │   │ (スコアリング)│   [] (選択)  │  (導入)       │
  ユーザー対話  →│ hearing.ts  │→ Requirements ─┘   └────────────┘              └──────┬───────┘
                 └─────────────┘                                                      │
                                                                               ┌──────▼──────┐
                                       .claude/team.json + atf-logs/runs.jsonl →│ report.ts   │→ atf-dashboard.html
                                                                               └─────────────┘
```

データは一方向に流れる。各モジュールは前段の出力(プレーンなデータオブジェクト)だけに依存し、モジュール間で状態を共有しない。

## モジュール構成

| モジュール | 責務 | 入力 | 出力 |
|---|---|---|---|
| `src/cli.ts` | commander によるコマンド定義と、パイプラインの結線(オーケストレーション) | argv | — |
| `src/analyzer.ts` | 対象リポジトリの走査と自動プロファイリング | リポジトリパス | `RepoProfile` |
| `src/hearing.ts` | @inquirer/prompts による対話ヒアリング | ユーザー対話 | `Requirements` |
| `src/presets.ts` | プリセットのロードとスコアリング | `RepoProfile` + `Requirements` | `ScoredPreset[]` |
| `src/generator.ts` | エージェント定義のレンダリングと対象リポジトリへの書き込み | `Preset` + `RepoProfile` + `Requirements` | `.claude/` 配下のファイル群 |
| `src/report.ts` | マニフェスト + 実行記録から HTML ダッシュボードを構築 | `TeamManifest` + `RunRecord[]` | 自己完結 HTML 文字列 |
| `src/types.ts` | モジュール間で受け渡すデータ型の定義 | — | — |

対話(inquirer)は `hearing.ts` と `cli.ts`(プリセット確定・導入確認)にのみ存在する。`analyzer` / `presets` / `generator` / `report` は純粋な入出力関数の集まりで、対話や process 終了に依存しないため単体テストしやすい。

## コマンドとパイプラインの対応

- `atf analyze <repo>` — analyzer 単体を実行して `RepoProfile` を JSON 表示(パイプラインの前段だけを切り出したデバッグ用途)
- `atf list` — presets のロード結果を一覧表示
- `atf generate <repo>` — フルパイプライン。`--preset <id>` でスコアリング後の選択をスキップ、`--force` で既存定義を上書き
- `atf report <repo>` — 導入済みリポジトリの `team.json` + `runs.jsonl` から report 単体を再実行

## 各モジュールの設計

### analyzer — 自動解析

対象リポジトリを深さ 6 まで再帰走査し(`node_modules` などは除外)、以下を検出する:

- **言語**: 拡張子 → 言語のマッピング。ファイル数の多い順に並ぶ
- **フレームワーク**: package.json の dependencies/devDependencies 名(react, next など)+ マーカーファイル(manage.py → django, Cargo.toml → cargo など)の 2 系統
- **CI / テストの有無**: `.github/workflows` 等の存在、テストディレクトリ名・`*.test.*` / `*.spec.*` ファイル名

検出はヒューリスティックであり、外れても致命的にならない設計(スコアリングの加点材料に使われるだけで、ユーザーの明示要件が優先される)。

### hearing — 対話ヒアリング

4 つの質問(開発フェーズ / 重視観点 / チーム規模 / Issue 駆動の有無)で `Requirements` を作る。**重視観点(focus)の選択肢はプリセットの match 条件と対応している**ため、新しい focus をプリセットで使う場合は hearing.ts にも選択肢を追加する必要がある(選択肢にない focus は永遠にマッチしない)。

### presets — ロードとスコアリング

- **ロード**: `templates/presets/<id>/preset.json` を列挙するだけの規約ベース。ディレクトリ名がプリセット ID になり、コード変更なしでプリセットを追加できる
- **パス解決**: `presetsRoot()` は `import.meta.url` 基準で `../templates/presets` を参照する。`src/` からの tsx 実行と `dist/` からのビルド実行の両方で同じ相対位置に templates が見えることに依存している(ディレクトリ構成変更時の要注意点)
- **スコアリング**: match 条件との一致 1 件ごとに加点する
  - focus 一致: **+5**(ユーザーの明示要件を最重視)
  - 言語 / フレームワーク一致: +2(自動検出は補助材料)
  - フェーズ一致: +1
  - focus がスコアを支配するのは意図的な設計。自動検出が外れていてもユーザーの意図どおりのチームが上位に来る

スコアリングは順位付けのみを行い、最終決定はユーザーに委ねる(`generate` では推奨順のリストから select で確定)。

- **不適合時の中断**: `uncoveredFocus()` が、選択された focus のうちどのプリセットの match にも含まれないものを返す。`generate` は**全 focus が未カバーの場合**、管理者に新しいテンプレート(プリセット)の作成を問い合わせるよう促すメッセージを表示して中断する(exit code 1、何も書き込まない)。一部の focus だけ未カバーの場合は警告を出して続行する。`--preset` で明示指定された場合はユーザーの判断を尊重してチェックしない。判定基準を focus に限定しているのは、スコアリングと同じく「ユーザーの明示要件を最重視する」設計に揃えたため

### generator — 導入

`generateTeam()` が対象リポジトリの `.claude/` 配下に一式を書き込む。処理順:

1. **teamSize によるトリミング**: `preset.json` の `agents` 配列の先頭から `minimal: 3 / standard: 5 / full: ∞` 体を採用(配列は重要な順に並べる規約)
2. **テンプレートのレンダリング**: 各 `agents/*.md` の `{{projectName}}` `{{languages}}` `{{frameworks}}` `{{phase}}` `{{focus}}` を profile / requirements の値で置換
3. **指示の自動付与**: 全エージェント定義の末尾に 2 種類の指示を注入する
   - 実行記録指示(常時): 完了時に `.claude/atf-logs/runs.jsonl` へ JSON を 1 行追記する(ダッシュボードのフィードバックループの起点)
   - Issue 駆動指示(`requirements.issueDriven` 時のみ): Issue 起点でのみ着手する等の制約
4. **issue-manager の追加**(Issue 駆動時): `templates/common/issue-manager.md` を teamSize の枠外で追加し、`issue-manager → 先頭エージェント` のフロー辺を足す
5. **マニフェスト記録**: チーム構成を `.claude/team.json`(`TeamManifest`)に書き込む。以降の `report` 再生成の単一情報源
6. **ダッシュボード生成**: report.ts を呼んで `.claude/atf-dashboard.html` を出力(既存の実行記録があれば反映)

**上書きポリシー**: 既存のエージェント定義ファイルは `--force` なしでは上書きしない(対象リポジトリの手書き定義を尊重)。一方 `team.json` とダッシュボードは毎回無条件に上書きされる(この非対称性は既知の制約 — 後述)。

### report — 可視化

`team.json` + `runs.jsonl` から**外部依存なしの自己完結 HTML**(Mermaid のみ CDN)を組み立てる。セクション構成:

1. **実行環境の仕組み** — ハーネス / ガードレール / フィードバックループの 3 要素カード。項目はマニフェストと実行記録から動的に導出し、Issue 駆動オフ時は関連項目を「未導入」と薄く表示する
2. **チーム構成・入出力フロー** — `manifest.flow` を Mermaid の flowchart として描画。teamSize 制限で除外されたエージェントへの辺は描かない
3. **エージェントカード** — 各エージェントの name / description
4. **実行回数バー / 実行記録テーブル** — `runs.jsonl` の集計。Issue 駆動時は Issue 列を追加

**セキュリティ上の不変条件**: `runs.jsonl` はエージェントの自己申告であり信頼できない入力として扱う。エージェント由来の文字列は必ず `escapeHtml` を通す。壊れた JSON 行は無視する(寛容な読み込み)。

## データモデル(types.ts)

```
RepoProfile      自動解析の結果(path, languages, frameworks, hasCI, hasTests, ...)
Requirements     ヒアリング結果(phase, focus[], teamSize, issueDriven?)
Preset           preset.json + ロード時付与の id / dir
ScoredPreset     { preset, score } — スコアリング結果
TeamManifest     team.json の中身。導入したチームの構成(再生成の単一情報源)
TeamAgent        マニフェスト内の 1 エージェント(file, name, description)
RunRecord        runs.jsonl の 1 行(エージェントの実行自己申告)
```

## 対象リポジトリに生成されるもの

```
<対象リポジトリ>/.claude/
├── agents/*.md            # エージェント定義(レンダリング済み + 実行記録/Issue 駆動指示付き)
├── team.json              # チームマニフェスト(TeamManifest)
├── atf-dashboard.html     # 自己完結ダッシュボード
└── atf-logs/runs.jsonl    # エージェントが追記する実行記録(atf は読むだけ)
```

`runs.jsonl` だけは atf が書かない。生成されたエージェント定義内の指示に従って**エージェント自身が追記**し、`atf report` がそれを読んで可視化する。この「定義に指示を埋め込む → 実行時に記録される → report で観測する」という一巡が、このツールが提供するフィードバックループの中核である。

## テンプレートの規約

```
templates/
├── presets/<id>/
│   ├── preset.json        # name / description / match / agents / flow
│   └── agents/*.md        # frontmatter(name, description)+ 本文({{placeholder}} 可)
└── common/
    └── issue-manager.md   # 全プリセット共通(teamSize の枠外で追加される)
```

- `preset.json` の `agents` は重要な順に並べる(teamSize トリミングが先頭から採用するため)
- `flow` はダッシュボード構成図の from → to ペア。エージェント名(frontmatter の name)で書く

## 既知の制約

- **プリセット切り替え時の残留**: 別プリセットで `generate` し直しても旧プリセットのエージェント .md は削除されない(掃除機能がない)。team.json は新プリセットで上書きされるため、`agents/` の実ファイルとマニフェストが乖離しうる
- **スキップ時のマニフェスト**: 既存定義をスキップした場合も、マニフェストにはディスク上の実ファイルではなくプリセット側の frontmatter が記録される
- **`report` は導入が前提**: `team.json` がないリポジトリでは実行できない
