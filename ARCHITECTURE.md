# ARCHITECTURE

agent-team-factory(`atf`)の内部アーキテクチャを説明する。CLI の使い方や開発コマンドは [CLAUDE.md](./CLAUDE.md) を参照。

## 全体像

atf は「対象リポジトリの自動解析」と「対話ヒアリング」の 2 系統の入力から要件を組み立て、最適なプリセットを選んでエージェントチーム一式を対象リポジトリに書き込むパイプラインである。

```
  templates/tech-stack.json
            │ カテゴリ定義
            ▼
     ┌──────────────┐    選択肢    ┌─────────────┐
     │ techstack.ts │ ───────────→ │ hearing.ts  │ ←── ユーザー対話
     └──────────────┘              └──────┬──────┘
                                          │ Requirements(techStack を含む)
  対象リポジトリ                           ▼
        │         ┌─────────────┐    ┌────────────┐    ┌──────────────┐
        └────────→│ analyzer.ts │───→│ presets.ts │───→│ generator.ts │───→ 対象リポジトリへ書き込み
                  └─────────────┘    └────────────┘    └──────┬───────┘
                   RepoProfile         ScoredPreset[]         │ atf-settings.yaml
                   (applyTechStack で                         ▼
                    techStack を統合)                  ┌─────────────┐
                                                      │  report.ts  │───→ atf-dashboard.html
  atf-logs/runs.jsonl ───────────────────────────────→└─────────────┘
```

データは一方向に流れる。各モジュールは前段の出力(プレーンなデータオブジェクト)だけに依存し、モジュール間で状態を共有しない。

## モジュール構成

| モジュール | 責務 | 入力 | 出力 |
|---|---|---|---|
| `src/cli.ts` | commander によるコマンド定義と、パイプラインの結線(オーケストレーション) | argv | — |
| `src/analyzer.ts` | 対象リポジトリの走査と自動プロファイリング | リポジトリパス | `RepoProfile` |
| `src/hearing.ts` | @inquirer/prompts による対話ヒアリング | ユーザー対話 | `Requirements` |
| `src/techstack.ts` | 技術スタックカタログのロードと、カテゴリ選択 ↔ `TechStack` の変換・整形 | `templates/tech-stack.json` + カテゴリ選択 | `TechCategory[]` / `TechStack` |
| `src/presets.ts` | プリセットのロードとスコアリング | `RepoProfile` + `Requirements` | `ScoredPreset[]` |
| `src/generator.ts` | エージェント定義のレンダリングと対象リポジトリへの書き込み | `Preset` + `RepoProfile` + `Requirements` | `.claude/` 配下のファイル群 |
| `src/report.ts` | マニフェスト + 実行記録から HTML ダッシュボードを構築 | `TeamManifest` + `RunRecord[]` | 自己完結 HTML 文字列 |
| `src/features.ts` | プロジェクトごとの機能適用状況(有効/無効 + 実体との食い違い)の収集 | `TeamManifest` + `.claude/` の実体 | `ProjectFeatures` |
| `src/reverse.ts` | リバースドキュメントの記録の読み書きと、実装への追随状況の点検 | `.claude/atf-docs/docs.jsonl` | `ReverseDocRecord[]` / `ReverseDocStatus[]` |
| `src/arch.ts` | アーキテクチャ規約のロードと、検証スクリプトの実行・結果の解釈・記録 | `.claude/atf-arch/rules.json` + 検証出力 | `ArchRuleSet` / `ArchCheckRecord[]` |
| `src/alloy.ts` | 形式仕様の置き場の定義、`.als` の doc comment パース、検証記録・判断記録のロード、Alloy CLI の実行と出力の解釈、実装前ゲートの集計 | `spec/*.als` + `.claude/atf-formal/*.jsonl` | `SpecModel[]` / `SpecDeclaration[]` / `SpecSig[]` / `SpecGateStatus` |
| `src/adr.ts` | ADR(決定の履歴)のロードと、要件 ID との突き合わせ | `docs/adr/*.md` | `AdrRecord[]` |
| `src/weave.ts` | 形式仕様 + ADR から自然言語の文書を決定的に生成 | `SpecModel[]` + `AdrRecord[]` + 検証記録 | `docs/generated/*.md` / `*.explain.html` |
| `src/lint.ts` | 形式仕様の運用規約の機械検査(SSOT が割れていないか) | `spec/` + `docs/` + `.gitignore` | `LintFinding[]` |
| `src/specdoc.ts` | Alloy モデルの解説ページを、テンプレートへの差し込みで生成(書き出すのは weave) | `SpecModel` + 検証・判断の記録 + テンプレート | `<モデル名>.explain.html` の文字列 |
| `src/evaluate.ts` | ルーブリックと評価記録のロード、評価対象(エージェントごとの ON/OFF)の解決、評価対象 × 観点の集計、閾値に対するネクストアクションの解決、評価ゲートの判定 | `.claude/atf-eval/rubric.json` + `evaluations.jsonl` | `Rubric` / `EvaluationRecord[]` / `EvalGateStatus` |
| `src/apply.ts` | 導入済みチームへの機能(formal / arch / docs / issue / eval)の後追い導入 | `TeamManifest` + 機能 id | 更新された `.claude/` と `atf-settings.yaml` |
| `src/update.ts` | 導入済みの機能のアセット(atf が内容を決めるもの)の差分調査と更新 | `TeamManifest` + 配布物の実体 | `UpdatePlan` / 更新された `.claude/` と `atf-bin/` |
| `src/sections.ts` | エージェント定義のセクション単位の差し替え(atf が出し入れする節だけを対象にする) | 定義本文 + 見出し | 差し替え後の本文 |
| `src/bin.ts` | 対象プロジェクト直下 `atf-bin/` の実行スクリプト(atf を呼ぶ薄いラッパ)の生成と、`.gitignore` の調整 | `Requirements` + atf の所在 | `atf-bin/*.sh` |
| `src/settings.ts` | チーム設定(`atf-settings.yaml`)の読み書きと、旧 `.claude/team.json` からの自動移行 | `<repo>/atf-settings.yaml` | `TeamManifest` |
| `src/types.ts` | モジュール間で受け渡すデータ型の定義 | — | — |

対話(inquirer)は `hearing.ts` と `cli.ts`(プリセット確定・導入確認)にのみ存在する。`analyzer` / `presets` / `generator` / `report` は純粋な入出力関数の集まりで、対話や process 終了に依存しないため単体テストしやすい。

## コマンドとパイプラインの対応

- `atf catalog` — 同梱カタログ(プリセット / スキル)の一覧
- `atf init <repo>` — フルパイプライン。`--preset <id>` でスコアリング後の選択をスキップ、`--force` で既存定義を上書き
- `atf apply <formal|arch|docs|issue|eval|report|design> <repo>` — 導入済みチームへの機能の導入。`requirements` の有効化 + 担当エージェントの追加 + 既存定義へのセクション差し込み + 足場と `atf-bin/<機能>.sh` の配布。実行系(`atf formal` / `weave` / `lint` / `arch` / `docs` / `eval` / `report`)は atf-bin のスクリプトが呼ぶ内部コマンドで、ヘルプには出さない。`design` だけは atf-bin のスクリプトを持たず、対話でスキルを選んで `design.ts` の `applyDesign` を呼ぶ。`issue`(Issue 駆動開発)もゲートではなく進め方の機能なので実行スクリプトを持たず、issue-manager・Issue 起点の指示・ドラフトの置き場(`.claude/atf-issues/`)だけを配る。`-r/--run` を付けると導入直後に `atf-bin/<機能>.sh` を 1 度実行して配線(スクリプトと atf の解決)を確かめる — 中身(.als / 規約 / 文書の記録)は担当エージェントがこれから作るため、未整備は失敗扱いにしない
- `atf remove <formal|arch|docs|issue|eval|design> <repo>` — `apply` の逆操作。requirements を false にし、担当エージェント定義の削除・残る定義からのセクション除去・付随スキルの撤去・`atf-bin/<機能>.sh` の削除を行う。成果物(`.claude/atf-arch/`・`spec/`・`docs/adr/` など)は既定で残し、`--purge` でのみ削除する
- `atf update [repo]` — 導入済みチームの**アセットの更新**。いま有効な機能だけを対象に、atf が内容を決めるもの(エージェント定義の atf セクション・足場の書式ガイドと `report-junit.mjs`・`atf-bin/*.sh`・ダッシュボード・チーム設定の記録・付随スキル)を最新版へ入れ替える。requirements は変えない(機能の出し入れは `apply` / `remove`)。`planUpdate` が書き込まずに差分を調べ、CLI が表で提示して**承認を得てから** `runUpdate` を呼ぶ(`--dry-run` は提示だけ、`-f` は手編集されたスキルも入れ替え)。ユーザーとエージェントが書いたもの(規約・評価観点・検証スクリプト・`.als`・記録の jsonl・Issue ドラフト)には触れない
- `atf report <repo>` — 導入済みリポジトリの `atf-settings.yaml` + `runs.jsonl` から report 単体を再実行
- `atf status [repo]` — 導入済みチームで有効な機能と実体の点検(引数省略でカレントディレクトリ)。根拠は `<repo>/atf-settings.yaml` の requirements。食い違い・未整備が 1 件以上あれば exit code 1
- `atf arch <repo>` — アーキテクチャ適合検証(`.claude/atf-arch/run-arch-check.sh`)を実行して結果を記録。違反・未検証が残れば exit code 1(実装後ゲート)。導入先では `bash atf-bin/arch.sh` から呼ばれる
- `atf docs <repo>` — リバースドキュメントの記録と実ファイルを突き合わせ、追随していない文書があれば exit code 1。導入先では `bash atf-bin/docs.sh` から呼ばれる
- `atf eval <repo>` — ルーブリック評価(`.claude/atf-eval/`)の記録を集計し、**評価観点**(評価対象のエージェントごとに、そのエージェントに適用される観点・重み・閾値・水準・閾値を跨いだときのネクストアクション)、**評価対象 × 観点のスコア表**、**閾値未満の観点に対する「次にやること」**、**成果物ごとの最新の判定**(判定 / 対象・成果物 / 総合 / 観点ごとの採点 / 改善指示)をすべて表で表示する。未達(要改善・不合格)が残る、または評価対象のエージェントに未評価があれば exit code 1(完了前ゲート)。採点は evaluator が行い、atf は集計と判定だけを担う。導入先では `bash atf-bin/eval.sh` から呼ばれる

導入先のプロジェクトは `atf` を直接呼ばず、`init` が置く `atf-bin/*.sh`(`status` / `report` / `formal` / `weave` / `lint` / `arch` / `docs` / `eval`)を入口にする。スクリプトは自分の位置からリポジトリルートを割り出して `atf <サブコマンド> <ルート>` を呼ぶだけで、判定ロジックは持たない(単一情報源は atf 側)。atf の解決順は 環境変数 `ATF` → PATH → `atf-bin/atf.local.sh` の `ATF_HOME_DIR`

## 各モジュールの設計

### analyzer — 自動解析

対象リポジトリを深さ 6 まで再帰走査し(`node_modules` などは除外)、以下を検出する:

- **言語**: 拡張子 → 言語のマッピング。ファイル数の多い順に並ぶ
- **フレームワーク**: package.json の dependencies/devDependencies 名(react, next など)+ マーカーファイル(manage.py → django, Cargo.toml → cargo など)の 2 系統
- **CI / テストの有無**: `.github/workflows` 等の存在、テストディレクトリ名・`*.test.*` / `*.spec.*` ファイル名
- **GitHub リポジトリ**: `.git/config` の remote URL から owner/repo を抽出(https / ssh 両形式に対応)。ヒアリングのデフォルト値に使うだけなので検出できなくてもよい

検出はヒューリスティックであり、外れても致命的にならない設計(スコアリングの加点材料に使われるだけで、ユーザーの明示要件が優先される)。

### hearing — 対話ヒアリング

開発フェーズ / 技術スタック / 重視観点 / チーム規模 / GitHub リポジトリ / Issue 駆動の有無などの質問で `Requirements` を作る。

**使用する GitHub リポジトリは必ず確認する**。analyzer の検出値(remote URL 由来)はデフォルトとして提示するだけで、確認をスキップしない — 検出はヒューリスティックであり、フォークや別リポジトリの Issue を使う運用があり得るため。owner/repo 形式でバリデーションし、GitHub を使わないプロジェクトのために空欄(未設定)も許す。指定された値は Issue 駆動指示の起票先(`gh -R owner/repo`)、`{{githubRepo}}` プレースホルダ、ダッシュボードのメタ表示に使われる。**重視観点(focus)の選択肢はプリセットの match 条件と対応している**ため、新しい focus をプリセットで使う場合は hearing.ts にも選択肢を追加する必要がある(選択肢にない focus は永遠にマッチしない)。

**技術スタックはカテゴリ単位で聞く**。「どのカテゴリを設定するか」を先に選ばせ、選ばれたカテゴリについてだけ技術の複数選択を出す(カテゴリを増やしても質問が延々と続かないようにするための 2 段構え)。言語・フレームワーク(カタログの `always`)と、検出値があるカテゴリは初期選択として提示する。各カテゴリの末尾には「その他(自由入力)」があり、カタログにない技術も小文字に正規化して取り込める(プリセットの match と照合できるようにするため)。フェーズによらず必ず聞くのは、analyzer が検出できるのは言語とフレームワークの一部だけで、マイグレーションツールやスキーマドキュメント生成のような選択はコードから読み取れないため。

### techstack — 技術スタックのカタログ

選択肢は `templates/tech-stack.json` に外出しされており、カテゴリと技術を追記するだけでヒアリングの選択肢が増える(presets / skills と同じ「規約ベースのカタログ」方針)。

- **カテゴリ定義**: `id`(`TechStack.categories` のキー)/ `name`(表示名)/ `description`(質問文の補足)/ `always`(常にヒアリング対象)/ `items`(`id` + `name`)
- **`target` が設計の要**: カテゴリは選択結果のマージ先(`languages` か `frameworks`)を持つ。`toTechStack()` が `target` ごとに選択を平坦化するため、**DB 管理・CI・監視など新しいカテゴリを足してもスコアリングとプレースホルダ置換の経路は増えない**(`RepoProfile` は languages / frameworks の 2 軸のままでよい)
- **id の語彙**: 技術の `id` は analyzer の検出値・プリセットの `match` と同じ語彙に揃える規約。揃っていないと検出値を初期選択にできず、スコアリングにも効かない
- **検出値の振り分け**: `detectedSelections()` が analyzer の検出値をカテゴリに割り当てる。カタログにない検出値(例: `maven`)は捨てずに target が一致する先頭カテゴリへ寄せ、ヒアリングでは `maven(検出)` として選択済みで表示する
- **表示の単一情報源**: `formatTechStack()` が「カテゴリ名 + 表示名」の行を返し、CLI の確認表示・エージェント定義・ダッシュボード・フロープレビューがこれを共用する。`categories` を持たない古い設定は検出値と同じ規則で振り分けて表示するため、再生成なしでも表示が壊れない

`TechStack` が `languages` / `frameworks`(平坦化済み)と `categories`(カテゴリ id → 技術 id)を両方持つのは、前者が既存のスコアリング経路の入力、後者が人間向け表示の入力という役割分担による。

### presets — ロードとスコアリング

- **ロード**: `templates/presets/<id>/preset.json` を列挙するだけの規約ベース。ディレクトリ名がプリセット ID になり、コード変更なしでプリセットを追加できる
- **パス解決**: `presetsRoot()` は `import.meta.url` 基準で `../templates/presets` を参照する。`src/` からの tsx 実行と `dist/` からのビルド実行の両方で同じ相対位置に templates が見えることに依存している(ディレクトリ構成変更時の要注意点)
- **スコアリング**: match 条件との一致 1 件ごとに加点する
  - focus 一致: **+5**(ユーザーの明示要件を最重視)
  - 言語 / フレームワーク一致: +2(自動検出は補助材料)
  - フェーズ一致: +1
  - focus がスコアを支配するのは意図的な設計。自動検出が外れていてもユーザーの意図どおりのチームが上位に来る

スコアリングは順位付けのみを行い、最終決定はユーザーに委ねる(`init` では推奨順のリストから select で確定)。

- **不適合時の中断**: `uncoveredFocus()` が、選択された focus のうちどのプリセットの match にも含まれないものを返す。`init` は**全 focus が未カバーの場合**、管理者に新しいテンプレート(プリセット)の作成を問い合わせるよう促すメッセージを表示して中断する(exit code 1、何も書き込まない)。一部の focus だけ未カバーの場合は警告を出して続行する。`--preset` で明示指定された場合はユーザーの判断を尊重してチェックしない。判定基準を focus に限定しているのは、スコアリングと同じく「ユーザーの明示要件を最重視する」設計に揃えたため

### generator — 導入

`generateTeam()` が対象リポジトリの `.claude/` 配下に一式を書き込む。処理順:

1. **teamSize によるトリミング**: `preset.json` の `agents` 配列の先頭から `minimal: 3 / standard: 5 / full: ∞` 体を採用(配列は重要な順に並べる規約)
2. **テンプレートのレンダリング**: 各 `agents/*.md` の `{{projectName}}` `{{languages}}` `{{frameworks}}` `{{techStack}}` `{{phase}}` `{{focus}}` `{{githubRepo}}` を profile / requirements の値で置換(`{{techStack}}` はカテゴリ名付きの表示名)
3. **指示の自動付与**: 全エージェント定義の末尾に 2 種類の指示を注入する
   - 実行記録指示(常時): 完了時に `.claude/atf-logs/runs.jsonl` へ JSON を 1 行追記する(ダッシュボードのフィードバックループの起点)
   - Issue 駆動指示(`requirements.issueDriven` 時のみ): Issue 起点でのみ着手する等の制約
   - 技術スタック指示(`requirements.techStack` に選択がある時のみ): カテゴリ別の技術一覧と「ここにない技術を導入するなら理由を添えてユーザーに確認する」制約。選択をプロンプトに焼き込むことで、エージェントが勝手な技術を持ち込むのを防ぐガードレールになる
4. **issue-manager の追加**(Issue 駆動時): `templates/common/issue-manager.md` を teamSize の枠外で追加し、`issue-manager → 先頭エージェント` のフロー辺を足す。orchestrator には Issue 駆動モードの運用、env-builder には gh CLI の点検指示が付き、`.claude/atf-issues/`(ドラフトの書式ガイド)を用意する。あとから `atf apply issue` / `atf remove issue` で出し入れできる
5. **チーム設定の記録**: チーム構成を `<repo>/atf-settings.yaml`(`TeamManifest`)に書き込む。以降の `report` / `status` の単一情報源
6. **ダッシュボード生成**: report.ts を呼んで `.claude/atf-dashboard.html` を出力(既存の実行記録があれば反映)

**上書きポリシー**: 既存のエージェント定義ファイルは `--force` なしでは上書きしない(対象リポジトリの手書き定義を尊重)。一方 `atf-settings.yaml` とダッシュボードは毎回無条件に上書きされる(この非対称性は既知の制約 — 後述)。

### features — 機能の適用状況の点検

機能の ON / OFF はプロジェクトごとに異なり(形式仕様・アーキテクチャ検証・リバースドキュメント・Issue 駆動・PR フロー…)、その根拠は `atf-settings.yaml` の `requirements` にある。しかし **設定だけを見ても「本当に効いているか」は分からない** — 担当エージェント定義が手で消される、検証スクリプトが雛形のまま放置される、文書が実装に追随しなくなる、といった乖離が起きるため。

そこで `collectProjectFeatures()` は機能ごとに「宣言(requirements)」と「実体(エージェント定義・成果物ディレクトリ・記録・ゲートの状況)」の両方を見て、`details`(状況)と `issues`(食い違い・未整備)に分けて返す。`issues` が 1 件以上なら `atf status` は exit code 1 を返すため、CI から「導入したはずの仕組みが動いていない」ことを検出できる。

機能を 1 つ追加するときは、`FeatureStatus` を返す純関数を 1 つ足して `collectProjectFeatures()` の配列に並べるだけでよい(表示は cli.ts、判定ロジックは features.ts に閉じる)。

### settings — チーム設定の単一情報源

チーム構成は**対象プロジェクトのルートに置く `atf-settings.yaml` だけ**が持つ(旧 `.claude/team.json` は廃止)。情報源を 1 つにしたのは、「人が読み書きする設定」と「atf が書く記録」が別ファイルに分かれていると、どちらが正なのか分からなくなるため。ファイル内では役割を冒頭コメントで分けている — `requirements` は手で書き換えてよい設定、`agents` / `flow` / `skills` は atf が書き出す実体の記録。

- **書き手**: `init`(全体を書き出す = `saveTeamSettings()`)・`apply <機能>`(requirements と skills)・`apply design`(skills と requirements.designSkills)。apply 系は `updateTeamSettings()` 経由で、既存ファイルの変わった項目だけを書き換える(手書きのコメント・atf が知らない項目は残る)
- **読み手**: `status`(features.ts の判定根拠)・`report`(ダッシュボード)・`design`
- **手編集への耐性**: YAML は人が壊しうるので、`loadTeamSettings()` は構文エラー・必須項目の欠落を**どこが悪いか分かるエラー**にし、cli.ts が終了コード 1 で報告する。省略可能な項目(presetName / flow / skills)は既定値で補う
- **移行**: `.claude/team.json` しかないプロジェクトは、読み書きのどちらでも `migrateLegacyManifest()` が YAML に変換して team.json を削除する(2 つの情報源を並存させない)。`atf init` のやり直しは不要

### alloy / adr / weave / lint / specdoc — 形式仕様を単一情報源にする

- **依存の向きは一方向**: 手で書くのは `spec/*.als`(いまの仕様)と `docs/adr/*.md`(決定の履歴)だけで、自然言語の文書は `weave` が `docs/generated/` に生成する派生物。atf 側に「自然言語の仕様書を手で書かせる導線」を作らないこと(作った瞬間に SSOT が割れる)
- **置き場で役割を分ける**: `spec/`(手書きの正)/ `docs/adr/`(手書きの履歴)/ `docs/generated/`(生成物・gitignore)/ `.claude/atf-formal/`(検証記録・仕様判断・解説ページのテンプレート)。上書き規則が逆のものを同じディレクトリに混ぜない
- **注釈は doc comment だけ**: `parseDeclarations()` が `/**` ブロックを直後の宣言に対応付け、`parseDocComment()` がタグ(`@req` / `@term` / `@rationale` …)と散文に分ける。行コメントは読み飛ばす。**要件の文を書けるのは 1 か所だけ**で、他の宣言からは ID だけで参照する(重複は lint が落とす)
- **合否の判定は出力の解釈で行う**: Alloy は反例が見つかっても終了コード 0 で終わるため、終了コードを信用しない。`check` は UNSAT が合格(反例なし)、`run` は SAT が合格(インスタンスあり)と**向きが逆**になる
- **ゲートの集計は 1 か所**: 「充足 / 未充足 / 未検証」の数え方は `specGateStatus()` が単一情報源で、CLI・ダッシュボード・解説ページ・`atf status` はこれを呼ぶだけにする
- **生成は決定的**: `buildWeave()` の出力に時刻・乱数など入力にない値を混ぜない(混ぜると `atf weave --check` の差分ゲートが常に落ちて意味を失う)。LLM を使う非決定的な出力(反例のナレーション)は `docs/generated/` に出さず `.claude/atf-formal/narration/` に分ける
- **規約は CI で落とす**: 「手書き `.md` に規範文を書かない」「`check` に `@req` を付ける」といった運用規約は人のレビューに任せず `lint.ts` に足す。error が 1 件でもあれば非ゼロ終了、warn は落とさない
- **仕様判断は atf が持たない**: 反例が出たあと「どう直すか」を決めるのは spec-formalizer とユーザーで、atf は `decisions.jsonl` と ADR を**読むだけ**(書き換えない)。自動確定してよいか(`requirements.specAutoFix`)は設定に置き、判断基準と手順はエージェント定義に埋め込む。`status: auto`(ユーザー未確認)の記録は `atf status` とダッシュボードが「要確認」として出し、**黙って通らない**ようにしている
- **解説ページはテンプレート + 差し込み**: 3 タブ構成で、`specUseCases()` の `@actor` / `@usecase` を `buildUseCaseGraph()` で Mermaid に変換して**ユースケース**のタブに、`check` / `run` の一覧を**検証事項**のタブに、宣言と doc comment(文芸的プログラミング)を **Alloy コード解説**のタブに流し込む(関係性グラフ `buildSpecGraph()` / sig 一覧 / 反例から確定した仕様 / モデル全文は既定ページから外したが、レンダラは値を渡すので独自テンプレートから差し込める)。差し込み先はテンプレート(`{{名前}}` の差し込み口と `<!-- atf:block -->` の繰り返し雛形)。ページの形式はテンプレートが決めるので、見出し・配色を変えたいときにコードを触らずに済む(プロジェクトの `.claude/atf-formal/explain-template.html` が atf 同梱より優先)

### reverse / arch — ドキュメントと規約の検証

どちらも「**生成するのはエージェント、atf は記録を読んで判定する**」という役割分担で設計している(runs.jsonl と同じ構図)。

- **reverse**: `docs.jsonl` は 1 行 1 文書の追記型ログで、**同じ `path` の行は後勝ち**(再生成のたびに追記でき、履歴は生ファイルに残る)。`sources`(根拠にしたコードのパス)が「実装が変わったらどの文書を直すか」の索引になり、`reverseDocStatuses()` が記録と実ファイルを突き合わせて「文書・図が欠けている / 根拠のコードが消えている」文書を検出する。これが**ドキュメントの陳腐化を検知する唯一の仕組み**であるため、`sources` の省略は指示で禁じている
- **arch**: 検証ツールは言語ごとに異なる(ArchUnit / ArchUnitTS / ArchUnitPython / go-arch-lint / dependency-cruiser …)ため、atf は**ツールを抽象化せず、出力形式だけを規約にした**。対応ツールは `templates/arch-tools.json` のカタログにデータとして持ち、コードはツールを知らない(増やすのは JSON への 1 エントリ)。テスト形式のツール(ArchUnit 系)は「テスト名の先頭を規約 id にする」約束 1 つで JUnit XML → ARCH 行の変換を 1 本(`report-junit.mjs`)に共通化している。`run-arch-check.sh` が規約ごとに `ARCH <規約 id> <PASS|VIOLATION|ERROR> [件数] [詳細]` を出し、`parseArchOutput()` がそれを解釈する。ツール固有のパーサを atf に持たないので、新しい言語・ツールは**スクリプト側の変換だけ**で対応できる
- **未検証を「合格」にしない**: `rules.json` にあって出力行がなかった規約は `unchecked` として集計され、適合ゲートは通らない(`archGateStatus()`)。検証の設定漏れが「違反なし」に見えてしまうのを防ぐための判定

### report — 可視化

`atf-settings.yaml` + `runs.jsonl` から**外部依存なしの自己完結 HTML**(Mermaid のみ CDN)を組み立てる。セクション構成:

1. **実行環境の仕組み** — ハーネス / ガードレール / フィードバックループの 3 要素カード。項目はマニフェストと実行記録から動的に導出し、Issue 駆動オフ時は関連項目を「未導入」と薄く表示する
2. **チーム構成・入出力フロー** — `manifest.flow` を Mermaid の flowchart として描画。teamSize 制限で除外されたエージェントへの辺は描かない
3. **エージェントカード** — 各エージェントの name / description
4. **技術スタック** — ヒアリングで選択した技術をカテゴリ別の表で表示(選択がなければ見出しごと省略)。同じ表をチーム導入前のフロープレビュー HTML にも出し、確定前に確認できるようにしている
5. **リバースドキュメント / アーキテクチャ適合検証** — 文書 ↔ 根拠コード ↔ 図の対応と鮮度、レイヤ・規約 ↔ 最新の検証結果と適合ゲート(該当モードが有効なときのみ)。入力は `loadArchitectureState()` がまとめて読み、`init` / `report` / `apply` のすべての入口で同じ状態を使う
6. **ルーブリック評価** — 評価対象のエージェントごとの評価観点 ↔ 重み ↔ 閾値 ↔ 水準 ↔ ネクストアクション(`criteriaFor` / `ownNextActions` / `defaultNextActions`。CLI と同じ並べ方・同じ `(既定)` の畳み方)、評価対象 × 観点のスコア表(`agentEvalStatuses` の `cells`。CLI の表と同じ集計)、閾値未満の観点に対する「次にやること」、成果物ごとの最新判定と改善指示、評価ゲート(`rubricEval` が有効なときのみ)。入力は `loadEvaluationState()` がまとめて読む。集計の対象は `requirements.evalTargets` が `true` のエージェントだけ
7. **実行回数バー / 実行記録テーブル** — `runs.jsonl` の集計。Issue 駆動時は Issue 列を追加

**セキュリティ上の不変条件**: `runs.jsonl` はエージェントの自己申告であり信頼できない入力として扱う。エージェント由来の文字列は必ず `escapeHtml` を通す。壊れた JSON 行は無視する(寛容な読み込み)。

## データモデル(types.ts)

```
RepoProfile      自動解析の結果(path, languages, frameworks, hasCI, hasTests, ...)
Requirements     ヒアリング結果(phase, focus[], teamSize, issueDriven?, githubRepo?, techStack?, rubricEval?, evalTargets?)
Rubric           rubric.json の中身(criteria[] = EVAL-xx の観点と水準、passScore = 閾値、actions = 閾値を跨いだときの手順、notes[]、template?)
RubricActions    閾値に対するネクストアクション({ below?: string[]; meets?: string[] }。観点 → ルーブリック直下の順に解決)
EvaluationRecord evaluations.jsonl の 1 行(target = 評価されたエージェント, artifact, scores[], verdict, actions[])
TechStack        選択した技術(languages[] / frameworks[] = target ごとの平坦化、categories = カテゴリ id → 技術 id)
TechCategory     tech-stack.json の 1 カテゴリ(id, name, description?, target, always?, items)
TechItem         カテゴリ内の 1 技術(id = 検出値・match と同じ語彙 / name = 表示名)
Preset           preset.json + ロード時付与の id / dir
ScoredPreset     { preset, score } — スコアリング結果
TeamManifest     atf-settings.yaml の中身。導入したチームの構成(再生成の単一情報源)
TeamAgent        設定内の 1 エージェント(file, name, description)
RunRecord        runs.jsonl の 1 行(エージェントの実行自己申告)
```

## 対象リポジトリに生成されるもの

```
<対象リポジトリ>/
├── atf-settings.yaml          # チーム設定(TeamManifest。構成の単一情報源)
├── spec/                      # 形式仕様(*.als)。**要件・仕様の単一情報源**(手書き)
├── docs/
│   ├── adr/                   # 決定の履歴(手書き・過去形・追記のみ)
│   └── generated/             # weave の出力(仕様書・用語集・トレーサビリティ・解説)。gitignore
└── .claude/
    ├── agents/*.md            # エージェント定義(レンダリング済み + 実行記録/Issue 駆動指示付き)
    ├── atf-dashboard.html     # 自己完結ダッシュボード
    ├── atf-formal/            # 検証記録・仕様判断の記録・解説ページのテンプレート・ナレーション
    ├── atf-docs/              # リバースドキュメントの索引(docs.jsonl)と書式ガイド
    ├── atf-arch/              # アーキテクチャ規約(rules.json)・検証スクリプト・検証記録
    ├── atf-eval/              # ルーブリック(rubric.json)と評価記録(evaluations.jsonl)
    ├── skills/                # 配布したスキル(デザイン / 図の生成に使う archify)
    └── atf-logs/runs.jsonl    # エージェントが追記する実行記録(atf は読むだけ)
```

`runs.jsonl` だけは atf が書かない。生成されたエージェント定義内の指示に従って**エージェント自身が追記**し、`atf report` がそれを読んで可視化する。この「定義に指示を埋め込む → 実行時に記録される → report で観測する」という一巡が、このツールが提供するフィードバックループの中核である。

## テンプレートの規約

```
templates/
├── presets/<id>/
│   ├── preset.json        # name / description / match / agents / flow
│   └── agents/*.md        # frontmatter(name, description)+ 本文({{placeholder}} 可)
├── tech-stack.json        # 技術スタックの選択肢(categories[].items[])
├── spec-explain.html      # Alloy モデルの解説ページの形式(差し込み口 {{...}} と繰り返し雛形)
├── skills/<id>/
│   ├── SKILL.md           # スキル本体(外部由来のものは無改変)
│   └── skill.json         # 分類(aesthetic / workflow / imagegen / diagram)・出典
└── common/
    ├── issue-manager.md   # 全プリセット共通(teamSize の枠外で追加される)
    ├── spec-formalizer.md # 形式仕様担当(formalSpec 時)
    ├── doc-reverser.md    # リバースドキュメント担当(reverseDocs 時)
    ├── arch-guard.md      # アーキテクチャ適合検証担当(archCheck 時)
    └── evaluator.md       # ルーブリック評価担当(rubricEval 時)
```

- `preset.json` の `agents` は重要な順に並べる(teamSize トリミングが先頭から採用するため)
- `flow` はダッシュボード構成図の from → to ペア。エージェント名(frontmatter の name)で書く
- `tech-stack.json` のカテゴリは `target`(`languages` / `frameworks`)で選択結果のマージ先を決める。技術の `id` は analyzer の検出値・プリセットの `match` と同じ語彙、`name` は表示用

## 既知の制約

- **プリセット切り替え時の残留**: 別プリセットで `init` し直しても旧プリセットのエージェント .md は削除されない(掃除機能がない)。atf-settings.yaml は新プリセットで上書きされるため、`agents/` の実ファイルと設定が乖離しうる
- **スキップ時のマニフェスト**: 既存定義をスキップした場合も、マニフェストにはディスク上の実ファイルではなくプリセット側の frontmatter が記録される
- **`report` は導入が前提**: `atf-settings.yaml`(または旧 `team.json`)がないリポジトリでは実行できない
