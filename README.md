# agent-team-factory

多種多様な要件にあわせたエージェントチームを、指定されたプロジェクトディレクトリに提供する CLI ツール。

対象プロジェクトのディレクトリを自動解析し、対話ヒアリング(開発フェーズ・技術スタック・重視観点・チーム規模・Issue 駆動開発の有無)で要件を把握したうえで、最適なチームプリセットを選定・カスタマイズして、対象プロジェクトの `.claude/agents/` に Claude Code サブエージェント定義一式を導入します。新規開発では**形式仕様モードが既定で有効**になり、「何を作るか」の合意を `spec/main.als`(Alloy)と `docs/adr/`(決定の履歴)に置きます — 立ち上げ時に枠(名称・扱う範囲・**扱わない範囲**・承認者・トレードオフ)を 5 問だけ聞いて仕様に書き込み、自然言語の仕様書は手で書かず必要なときに生成します。

**技術スタック**はカテゴリごとに選択できます(言語 / フレームワーク / データベース・スキーマ管理 / テスト / CI・CD / インフラ・デプロイ / 監視・可観測性 / 品質・静的解析)。たとえばデータベース・スキーマ管理では PostgreSQL・Liquibase・Flyway・Prisma・tbls・Liam ERD などから選べます。選んだ技術はプリセット選定のスコアリングに使われ、各エージェント定義とダッシュボードにも明記されます(選択肢にないものは各カテゴリの「その他(自由入力)」で追加でき、自動検出できた技術は初期選択として提示されます)。選択肢を増やしたいときは `templates/tech-stack.json` に追記するだけです。

**リバースドキュメント**を選ぶと、コードを解析して構成・処理フローのドキュメントと図を起こし、実装の変更に追随して維持する `doc-reverser` エージェントが追加されます(図の生成には同梱の [archify](https://github.com/tt-a1i/archify) スキルを使います)。**アーキテクチャ適合検証**を選ぶと、文書化したアーキテクチャをレイヤ規約に落として ArchUnit などのフィットネス関数で違反を検出する `arch-guard` エージェントと、**実装後の適合ゲート**が組み込まれます(詳細は下記)。

**ルーブリック評価**を選ぶと、各エージェントの成果物を合意した基準(ルーブリック)で採点し、未達には改善指示を添えて差し戻す `evaluator` エージェントと、**完了前の評価ゲート**が組み込まれます。評価するエージェントは `atf-settings.yaml` の `requirements.evalTargets` で**1 体ずつ ON/OFF** できます(詳細は下記)。

**形式仕様モード**を選ぶと、要件・仕様の単一情報源が `spec/*.als`(Alloy)と `docs/adr/`(ADR)になり、それを書く `spec-formalizer` エージェントが追加されます。**実装前に Alloy で検証を通すゲート**が開発フローに組み込まれ、自然言語の仕様書は `atf weave` で生成する派生物として扱われます(詳細は下記)。

重視観点に**「UI/UX デザイン品質」**を選ぶと、UI の品質を担保する Claude Code スキルを選択でき、対象リポジトリの `.claude/skills/` に配置されます。各エージェントには「UI・画面・スタイルを実装するときは該当スキルに従う」指示が付与されます(詳細は下記)。
導入後にデザインを決め直したくなったら `atf apply design <project-dir>` で選び直せます(スキルの入れ替えとエージェントへの指示更新をまとめて行います)。

Issue 駆動開発を選ぶと、全プリセット共通の `issue-manager` エージェント(GitHub Issues の起票・整理・クローズ判断)がチームに追加され、各エージェントには「Issue を起点に作業し、報告・コミット・実行記録に Issue 番号を含める」指示が付与されます。

## 使い方

```bash
npm install

# 利用可能なチームプリセットを一覧
npm run dev -- catalog

# 解析 + ヒアリング → チームを導入
npm run dev -- init /path/to/project

# プリセット直接指定・既存定義の上書き
npm run dev -- init /path/to/project --preset security-audit --force

# このプロジェクトで有効な機能(形式仕様 / アーキテクチャ検証 / リバースドキュメントなど)を確認
npm run dev -- status /path/to/project
npm run dev -- status /path/to/project --json    # 他ツールから参照する
npm run dev -- status /path/to/project -e        # 有効な機能だけ表示

# 検証・再生成の実体(通常は導入先の atf-bin/*.sh から呼ばれる内部コマンド。atf --help には出ない)
ALLOY_JAR=/path/to/org.alloytools.alloy.dist.jar npm run dev -- formal /path/to/project
npm run dev -- arch /path/to/project      # アーキテクチャ適合検証(実装後ゲート)
npm run dev -- docs /path/to/project      # リバースドキュメントの追随状況
npm run dev -- eval /path/to/project      # ルーブリック評価の集計(完了前ゲート)
npm run dev -- report /path/to/project    # HTML ダッシュボードの再生成

# 導入済みチームに機能を導入する(formal / arch / docs / issue / eval / report / design)
npm run dev -- apply arch /path/to/project
npm run dev -- apply arch /path/to/project --run    # 導入直後に atf-bin/arch.sh を 1 度実行して配線を確認
npm run dev -- apply formal /path/to/project -y
npm run dev -- apply issue /path/to/project     # Issue 駆動開発(issue-manager)を導入
npm run dev -- apply eval /path/to/project      # ルーブリック評価(evaluator)を導入
npm run dev -- apply design /path/to/project   # デザインを対話で選ぶ

# 導入した機能を撤去する(apply の逆操作)
npm run dev -- remove arch /path/to/project
npm run dev -- remove arch /path/to/project --purge   # 成果物(.claude/atf-arch/)も削除

# 導入済みの機能のアセットを、いまの atf の内容に更新する
npm run dev -- update /path/to/project --dry-run   # 何が変わるかだけを見る
npm run dev -- update /path/to/project             # 内容を確認してから更新する

# 同梱プリセット・デザインスキルの一覧
npm run dev -- catalog
```

## 導入先での実行(`atf-bin/`)

`init` は対象プロジェクトの直下に `atf-bin/` を作り、ゲートと点検の入口を置きます。エージェントもユーザーも、`atf` が PATH にあるかを気にせずここから実行します。

```bash
bash atf-bin/status.sh    # 有効な機能と実体の点検
bash atf-bin/formal.sh    # 形式仕様(Alloy)の検証 — 実装前ゲート
bash atf-bin/lint.sh      # 形式仕様の運用規約の検査 — SSOT が割れていないか
bash atf-bin/weave.sh     # 形式仕様 + ADR から自然言語の文書を生成(docs/generated/)
bash atf-bin/arch.sh      # アーキテクチャ適合検証 — 実装後ゲート
bash atf-bin/docs.sh      # リバースドキュメントの追随状況
bash atf-bin/eval.sh      # ルーブリック評価の集計 — 完了前ゲート
```

- スクリプトは自分の位置からリポジトリルートを割り出すため、**どこから実行しても引数は不要**です
- 中身は `atf <サブコマンド> <リポジトリルート>` を呼ぶだけの薄いラッパで、判定ロジックは持ちません(単一情報源は atf 側)
- 有効な機能に対応するスクリプトだけが置かれます。機能を切って `init` をやり直すと、対応するスクリプトは取り除かれます
- `atf` の解決順は 環境変数 `ATF` → PATH 上の `atf` → `atf-bin/atf.local.sh` が記録したこのマシンの atf。すべて外れると解決方法を示して終了コード 127 で終わります
- **`atf-bin/*.sh` は commit** します(チーム全員と CI が同じ入口を使うため)。絶対パスを持つ `atf-bin/atf.local.sh` だけは `.gitignore` に追加されます
- `atf-bin/` は atf が管理するディレクトリで、`init` のたびに上書きされます。**手で編集しないでください**。検証の中身を書く場所は `.claude/atf-arch/run-arch-check.sh`(arch-guard が実装。こちらは上書きされません)です

## 適用されている機能を確認する(`atf status`)

機能のいくつか(形式仕様モード・アーキテクチャ適合検証・リバースドキュメント・Issue 駆動・PR フローなど)は**プロジェクトごとに ON / OFF** です。
導入済みのプロジェクトで何が効いているかは `atf status` で確認できます(引数を省略するとカレントディレクトリを見ます)。

```
$ atf status /path/to/project

対象: demo(/path/to/project)
  プリセット: Web アプリ開発チーム(web-dev)
  フェーズ: active / 重視観点: quality, docs / チーム規模: standard
  エージェント: 9 体(architect, implementer, …, doc-reverser, arch-guard, orchestrator)

機能の適用状況:

  ✅ 有効  リバースドキュメント
        担当: doc-reverser(.claude/agents/doc-reverser.md)
        文書: 2 件(図つき 1 件)
        鮮度: ⚠️ 要再生成 1 件(docs/architecture/api.md)
        図の生成: archify スキル(.claude/skills/archify)
        コマンド: bash atf-bin/docs.sh(一覧と追随状況)
        ⚠️ 実装に追随していない文書が 1 件ある(doc-reverser に差分更新を依頼)

  ✅ 有効  アーキテクチャ適合検証
        規約: 2 件 / レイヤ: 2 件 / ツール: dependency-cruiser
        適合ゲート: ✅ 通過(適合 2 件)

  🚫 無効  形式仕様(Alloy)+ ADR
        有効化: atf apply formal <project-dir>(または init のヒアリングで yes)
```

- 判断の根拠は `atf-settings.yaml`(導入時の要件)で、それに対応する**実体**(担当エージェント定義・成果物のディレクトリ・記録件数・ゲートの通過状況)を突き合わせて表示します
- **食い違いと未整備を検出します** — 有効なのに担当エージェント定義がない / archify スキルが配置されていない / 規約や検証スクリプトが雛形のまま / Alloy の jar がない / 文書が実装に追随していない / 無効なのに成果物が残っている、など。1 件以上あれば終了コード 1 を返すので CI からも使えます
- `--json` で機械可読な出力、`-e`(`--enabled`)で有効な機能だけの表示になります

## チーム設定(`atf-settings.yaml`)

`init` は対象プロジェクトのルートに `atf-settings.yaml` を作ります。**これがチーム構成の単一情報源**で、`status` / `report` / `design` はここを読みます(旧 `.claude/team.json` は廃止しました)。

```yaml
# atf-settings.yaml — demo のチーム設定(agent-team-factory が生成)
#
# - requirements: ヒアリングの結果。手で書き換えてよい設定
# - agents / flow / skills: atf が書き出す実体の記録(手で書き換えない)
version: 1
generatedBy: agent-team-factory
preset: quality-review
presetName: 品質レビューチーム
project: demo
requirements:
  phase: active
  focus:
    - quality
  teamSize: minimal
  issueDriven: true
  githubRepo: octocat/hello-world
  archCheck: true
  rubricEval: true
  evalTargets:          # 評価対象のエージェントを 1 体ずつ ON/OFF する
    code-reviewer: true
    orchestrator: false
agents:
  - file: code-reviewer.md
    name: code-reviewer
    description: 変更差分をレビューするコードレビュアー。
flow:
  - [ orchestrator, issue-manager ]
  - [ issue-manager, code-reviewer ]
```

- `atf apply` は**このファイルを作り直さず、変わった項目だけを書き換えます**。書き足したコメントや独自の項目はそのまま残ります(`atf init` はやり直すと全体を書き出します)
- `requirements` を書き換えると `atf status` の判断(どの機能が有効か)が変わります。ただし**エージェント定義は入れ替わりません** — 構成に反映するには `atf init <project-dir>` をやり直してください
- 手編集で壊れている場合は「どこが悪いのか」を示して終了コード 1 で止まります(必須項目: `project` / `preset` / `requirements` / `agents`)
- **旧 `.claude/team.json` は自動で移行されます** — 導入済みプロジェクトで `atf status` などを実行すると YAML に変換され、team.json は削除されます(`atf init` のやり直しは不要)

## ダッシュボード(可視化)

`init` を実行すると、対象リポジトリの `.claude/atf-dashboard.html` にチームダッシュボードが生成されます(ブラウザで開くだけで閲覧可能)。

- **チーム構成・入出力フロー** — エージェント間の入出力関係を Mermaid フローチャートで表示
- **エージェント一覧** — 各エージェントの役割カード
- **技術スタック** — ヒアリングで選択した技術をカテゴリ別に表示(選択した場合のみ)
- **デザインスキル** — 導入したスキルの名前・分類・出典(スキルを導入した場合のみ)
- **リバースドキュメント** — コードから起こした文書 ↔ 根拠コード ↔ 図の対応表と鮮度(要再生成の検出)
- **アーキテクチャ適合検証** — レイヤ・規約 ↔ 最新の検証結果と適合ゲートの通過状況
- **ルーブリック評価** — **評価対象のエージェントごと**の評価観点 ↔ 重み ↔ 閾値 ↔ 水準 ↔ 閾値を跨いだときのネクストアクション、**評価対象 × 観点のスコア表**(誰の成果物をどの観点で採点しているか)、閾値未満の観点に対する「次にやること」、成果物ごとの判定、評価ゲートの通過状況(`atf eval` と同じ並べ方)
- **実行記録** — 各エージェントは作業完了時に `.claude/atf-logs/runs.jsonl` へ実行記録(タスク・入力・出力・結果)を追記するよう指示されており、`atf report` で最新の実行タイムラインと実行回数をダッシュボードに反映できます

## 形式仕様モード(Alloy + ADR を要件・仕様の単一情報源にする)

ヒアリングで「要件・仕様を形式仕様(Alloy)+ ADR で管理しますか?」に yes と答えると(**新規開発では既定で有効**)、次の仕組みが導入されます。

**依存の向きは一方向です。** 自然言語の要件定義書を書いてから形式化するのではなく、形式仕様を直接書き、自然言語が必要になったときに生成します:

```
spec/*.als + docs/adr/  ──weave──▶  docs/generated/*.md
      (正・手書き)                   (派生・使い捨て・gitignore)
```

**置き場** — 役割ごとに分かれ、混ぜません:

| パス | 内容 | 扱い |
| --- | --- | --- |
| `spec/main.als` | ルートモジュール。`@title` / `@scope` / `@out-of-scope` / `@stakeholder` / `@tradeoff` | 手書き。**ここが「何を作るか」の合意** |
| `spec/<関心事>.als` | 関心事ごとの仕様(構造・不変条件・状態遷移・権限) | 手書き。ここが正 |
| `docs/adr/NNNN-....md` | 決定の履歴(いつ・何を・なぜ決めたか・却下した案) | 手書き。過去形・追記のみ |
| `docs/generated/` | 仕様書・用語集・トレーサビリティ・解説ページ | **生成物**。編集も commit もしない |
| `.claude/atf-formal/checks.jsonl` | 検証結果の記録(1 行 1 コマンド) | 記録 |
| `.claude/atf-formal/decisions.jsonl` | 反例から確定した仕様の記録(採用した仕様・根拠・採らなかった案・直したファイル) | 記録 |
| `.claude/atf-formal/narration/` | 反例の自然言語化(LLM 生成・非決定的) | 使い捨て。commit しない |
| `spec/README.md` / `spec/run-alloy.sh` | 書式ガイドと Alloy 実行スクリプト(atf が生成) | 参照・実行 |

**書式は doc comment とタグ**です(`/** ... */` を宣言の直上に置く。行コメント `--` は注釈として読まれません):

```alloy
/**
 * 注文。顧客ごとに 1 件ずつ作られる。
 * @term 注文 / Order
 * @rationale 下書きを別 sig にすると状態遷移が二重化するため、状態はフィールドで表す。
 * @adr docs/adr/0003-order-state.md
 */
sig Order {
  /** @term 注文者 / Customer */
  customer: one Customer,
  state: one State
}

/**
 * @req R-14  キャンセル済みの注文は出荷されない
 * @usecase 顧客 注文をキャンセルする
 */
fact CancelledIsNeverShipped { no s: Shipment | s.of.state = Cancelled }

/**
 * @req R-14
 * @validation 在庫と請求の整合性に対する機械的証拠
 * @relaxed スコープ 5 での有限検査。無限モデルの保証はない。
 */
check NoShipmentForCancelled for 5
```

タグ語彙は `@title` / `@scope` / `@out-of-scope` / `@stakeholder` / `@tradeoff` / `@module` / `@term` / `@rationale` / `@relaxed` / `@req` / `@validation` / `@adr` / `@actor` / `@usecase`。要件の**文を書けるのは 1 か所だけ**で、他の宣言からは `@req R-14` と ID だけで参照します。`@actor <名前> <説明>` と `@usecase <アクター> <ユースケース名>` は解説ページのユースケース図の情報源になります。

**`.als` と ADR の使い分け**は 1 つの問いで決まります — *その宣言を削除したとき、そのテキストも一緒に消えるか*。消えるなら `.als` の doc comment(`@rationale`)、残るなら(= 独立した履歴)ADR です。却下した案は貼り先の宣言が存在しないので必ず ADR に書きます。

**立ち上げ** — 新規開発(greenfield)では `init` がルートモジュールの枠を 5 問だけ聞き、`spec/main.als` に書き込みます(名称・扱う範囲・**意図的に扱わない範囲**・承認者・トレードオフの最優先)。既存プロジェクトでは聞かず、`TODO:` のまま配ります — 何を作るかはコードと運用にあるので、spec-formalizer が読み取ってユーザーと確定するほうが早いからです。どちらの場合も、埋まっていないことは `bash atf-bin/lint.sh` が違反として報告します。聞いた内容は **`.als` にだけ**書かれます(`atf-settings.yaml` には保存しません。仕様の置き場を 2 つにしないため)。

**ワークフロー** — 仕様を書く → **規約検査 + Alloy 検証(実装前ゲート)** → 実装 の順に進み、反例が出たら実装せず仕様に戻ります:

```
Issue 起票 → spec/*.als を書く → lint + Alloy 検証 ──(充足)──→ 実装・テスト → PR
                     ↑                       │
                     └───(反例・充足不能)───┘
```

- `spec-formalizer` がユーザーと対話して `spec/*.als` を直接書きます。形式化しない範囲(性能・UI 文言・外部サービスの挙動など)はルートモジュールの `@out-of-scope` に明記し、レビューとテストで担保します。**全面適用はしません**(コアの不変条件・状態遷移・権限モデルだけを形式化)
- `bash atf-bin/lint.sh`(= `atf lint`)が運用規約を機械検査します。必須タグの欠落・要件 ID の重複と孤児・`check` の `@req` 欠落・**手書き `.md` への規範文の混入**を検出し、違反があれば終了コード 1 を返します(規約は人のレビューではなく CI で落とします)
- `bash atf-bin/formal.sh`(= `atf formal`)が `.als` を Alloy で実行し、`check`(反例探索)と `run`(充足可能性)の結果を `checks.jsonl` に記録します。未充足があれば終了コード 1 で「実装前ゲート未通過」を返します
- `orchestrator` は**検証が通るまで実装エージェントに委譲しません**。反例が出た場合は仕様の修正に戻します
- 結果はダッシュボードの「形式仕様(Alloy)と実装前検証」セクション(要件 ↔ 検証コマンド ↔ 最新結果 + 解説ページへのリンク + 自動確定した仕様)に表示されます

**自然言語化(weave)** — 「仕様書がほしい」と言われたら文書を書かず、`bash atf-bin/weave.sh`(= `atf weave`)を実行します:

| 生成物 | 内容 |
| --- | --- |
| `docs/generated/overview.md` | 仕様の名称・対象範囲・**意図的に扱わない範囲**・承認・トレードオフの最優先 |
| `docs/generated/spec.md` | 全モジュールの doc comment + 宣言シグネチャ(注釈のない宣言も洗い出す) |
| `docs/generated/glossary.md` | `@term` から作る用語集(業務用語 ↔ 形式仕様の対応) |
| `docs/generated/traceability.md` | `@req` × `check` × ADR のマトリクス(最新の検証結果つき) |
| `docs/generated/<モデル名>.explain.html` | **解説ページ**。数式が読めなくても要件と検証状況を追える |

生成は**決定的**(同じ入力なら常に同じ出力)なので、`atf weave --check` を CI に置けば「派生文書が古い」ことを検出できます。反例の自然言語化だけは LLM を使い非決定的なので、`docs/generated/` ではなく `.claude/atf-formal/narration/` に出します(commit しません)。

**反例が出たときの決着** — 「開発者に聞く」か「自動で直す」かを、判断基準で振り分けます(既定は自動確定あり。ヒアリングか `requirements.specAutoFix` で切り替え):

| 状況 | 進め方 |
| --- | --- |
| 選択肢が実質 1 つに決まる(規格で決まっている / 整合性・セキュリティの観点で一方しか選べない / 仕様の他の記述から一意に導ける / 既存実装の既定に合わせるだけ) | spec-formalizer が `.als` を直して再検証し、ADR を 1 件追加。既存の実装が食い違えば orchestrator 経由で実装も修正。判断は `decisions.jsonl` に記録し、報告に必ず添えます |
| ビジネスルール・料金・権限境界・体験の選択、互換性を壊す変更、**判断に迷うもの** | 実装を止めて、選択肢・影響・推奨案を添えてユーザーに確認します |

```bash
atf apply formal <project-dir> --ask-only   # 自動確定をやめ、必ずユーザーに確認する
atf apply formal <project-dir> --auto-fix   # 自動確定を有効にする(既定)
```

自動確定した仕様は `status: auto`(ユーザー未確認)として記録され、`atf status` とダッシュボードが「要確認」として出します。覆すときは記録を書き換えず、新しい行と新しい ADR を追記します(履歴を消しません)。

**解説ページ** — 各 `.als` には解説 HTML(`docs/generated/<モデル名>.explain.html`)が対で維持されます。`bash atf-bin/weave.sh`・`bash atf-bin/formal.sh`(検証と同時)・`bash atf-bin/report.sh` のたびに作り直されるので、**内容を直すときは `.als` の doc comment**を直します。ページは 3 つのタブ構成です(左から):

| タブ | 内容 |
| --- | --- |
| **ユースケース** | **ユースケース図**(四角 = アクター、角丸 = ユースケース、枠 = システム境界)+ アクター一覧 + ユースケース一覧(アクター ↔ ユースケース ↔ 要件 ↔ 書いてある宣言)+ 意図的に扱わない範囲 |
| **検証事項** | `check` / `run` で**いま何を確かめているか**の一覧だけ(要件 ↔ コマンド ↔ 最新結果) |
| **Alloy コード解説** | Alloy の記法の読み方 + **文芸的プログラミング**(doc comment の散文 → コード → 散文 → コード。上から読むとモデル全体になる) |

ユースケース図の情報源は doc comment の `@actor <名前> <説明>`(人・外部システムを表す sig に付ける)と `@usecase <アクター> <ユースケース名>`(`pred` / `assert` / `fact` に付ける)だけです。Alloy にはアクターの概念がないため atf は推測せず、タグがなければ図は描かずに書き方を案内します(`@usecase` が参照するアクターに `@actor` がなければ `atf lint` が警告します)。

タブの切り替えは CSS だけで動き(JavaScript 不要)、印刷時はすべてのタブが並びます。ユースケース図の描画にのみ Mermaid(CDN)を使います。関係性グラフ・sig 一覧・反例から確定した仕様・モデル全文は既定のページには出しませんが、独自テンプレートからは差し込めます(`{{graph}}` / `{{sigs}}` / `{{decisions}}` / `{{source}}`。反例から確定した仕様はダッシュボードに表示されます)。

ページの**形式**を変えたいときは `.claude/atf-formal/explain-template.html` を編集します(`{{...}}` の差し込み口と `<!-- atf:block ... -->` の繰り返し雛形の説明はファイル冒頭にあります)。プロジェクトのテンプレートは atf 同梱のものより優先されるため、プロジェクトごとに形式を変えられます。ただし **`atf update` はこのテンプレートを atf 同梱の最新版へ基本上書きで入れ替えます**(実行前に差分が提示されるので、カスタマイズを維持したい場合はそこで中止するか、`--dry-run` で先に確認してください)。

**Alloy の準備**: Java 17 以上と Alloy の jar が必要です。jar は [AlloyTools のリリース](https://github.com/AlloyTools/org.alloytools.alloy/releases)から入手し、`ALLOY_JAR` 環境変数・`<project-dir>/tools/alloy.jar`・`~/.atf/alloy.jar` のいずれかに置きます(この順に探索)。

> Alloy 6 の CLI は 1 コマンド 1 行の表で結果を出し、充足性は SAT / UNSAT で表れます(`check` は UNSAT が合格 = 反例なし、`run` は SAT が合格 = インスタンスあり)。反例が見つかっても終了コードは 0 のため、合否は `atf formal` の判定を使ってください(`bash atf-bin/formal.sh` が表示します)。

> **適用範囲**: 形式仕様が効くのは、ドメインが安定していて長寿命で、仕様と実装の乖離が致命的な領域(プロトコル・決済・認可モデル・状態遷移・分散合意)です。要件が動くたびに書き直しが要る探索的な案件では、コア以外を `@out-of-scope` に置いて範囲を絞ってください。

## リバースドキュメント(コードからドキュメントを起こす)

ヒアリングで「コードからドキュメントをリバース生成しますか?」に yes と答えると、`doc-reverser` エージェント(チーム規模の枠外)と次の仕組みが導入されます。

**原則はコードが単一情報源**です。設計書の「あるべき姿」ではなく、いま動いている実装を記述します。書いたことはすべてコードで裏が取れること・節ごとに根拠のパスを併記すること・確認できないことは「未確認」と明記すること(推測を書かない)が指示として埋め込まれます。

| パス | 内容 |
| --- | --- |
| `docs/architecture/*.md` | 起こした文書(全体像 / 構造 / 処理フロー / データ / インターフェース / 運用 / 設計判断) |
| `docs/architecture/diagrams/*.html` | 図(archify が生成する自己完結 HTML。JSON 仕様も隣に残す) |
| `.claude/atf-docs/docs.jsonl` | 文書 ↔ 根拠コードの対応記録(1 行 1 文書)。ダッシュボードの入力 |
| `.claude/atf-docs/README.md` | 書式と記録形式(atf が生成) |

- **図は同梱の [archify](https://github.com/tt-a1i/archify) スキル**(MIT License)で生成します。構成図 / 処理フロー / シーケンス / データフロー / 状態遷移の 5 種類に対応し、`.claude/skills/archify/` にパッケージごと配置されます(スキルの手順がスキル内のスクリプトを実行するため、`SKILL.md` だけでなく一式を配ります)
- **差分更新**: 2 回目以降は `git diff` の変更ファイルと `docs.jsonl` の `sources` を突き合わせ、影響を受ける文書だけを更新します(影響がなければ「更新不要」と報告します)
- **鮮度の検出**: `bash atf-bin/docs.sh` とダッシュボードが、文書・図が欠けているもの / 根拠にしたコードが消えているものを「要再生成」として表示します
- 各エージェントには「実装前に該当文書を読む」「構造・依存・データモデルを変えたら同じ作業単位のうちに doc-reverser へ更新を依頼する」指示が付与されます

## アーキテクチャ適合検証(ArchUnit などのフィットネス関数)

ヒアリングで「アーキテクチャ適合検証を導入しますか?」に yes と答えると、`arch-guard` エージェント(チーム規模の枠外)と**実装後の適合ゲート**が導入されます。

| パス | 内容 |
| --- | --- |
| `.claude/atf-arch/rules.json` | レイヤと規約の定義(**規約の単一情報源**。`ARCH-01` 形式の安定 id) |
| `.claude/atf-arch/run-arch-check.sh` | 検証スクリプト(言語ごとのツールを呼び、共通形式で結果を出す) |
| `.claude/atf-arch/checks.jsonl` | 検証結果の記録(1 行 1 規約)。ダッシュボードの入力 |
| `.claude/atf-arch/README.md` | 書式と実行方法・言語別のツール案内(atf が生成) |
| `.claude/atf-arch/report-junit.mjs` | JUnit XML を `ARCH` 行に変換するスクリプト(ArchUnit 系で共用。atf が生成) |

**検証の実体は言語ごとのツール**で、atf は実行・記録・集計だけを担います(ツールの導入と配線は arch-guard の担当):

| 言語・環境 | 推奨 | 併用・代替 |
| --- | --- | --- |
| Java / Kotlin / Scala | ArchUnit | Konsist(Kotlin 固有の構造) |
| TypeScript / JavaScript | ArchUnitTS(npm: `archunit`) | dependency-cruiser / ts-arch / eslint-plugin-boundaries |
| Python | ArchUnitPython(pip: `archunitpython`) | import-linter |
| Go | go-arch-lint | depguard |
| PHP | deptrac | — |
| Ruby | packwerk | — |
| C# / .NET | NetArchTest | — |

ツールの一覧は `templates/arch-tools.json` のカタログが単一情報源で、**ここに 1 エントリ足すだけで対応ツールが増えます**(コード変更は不要)。`.claude/atf-arch/README.md` には、そのリポジトリで検出された言語のツールだけが導入方法・実行コマンド・`ARCH` 行への変換方法つきで書き出されます。

ArchUnit 系(ArchUnit / ArchUnitTS / ArchUnitPython / NetArchTest)は「規約 1 件 = テスト 1 件」で書けるため、**テスト名の先頭を規約 id にする**という約束を 1 つ置いてあります。テストランナーが出す JUnit XML は同梱の変換スクリプトでそのまま `ARCH` 行になります:

```bash
npx vitest run --reporter=junit --outputFile=.arch/junit.xml '**/*.arch.test.ts' || true
node .claude/atf-arch/report-junit.mjs .arch/junit.xml
```

`run-arch-check.sh` は規約ごとに 1 行、次の共通形式で出力する規約です(atf が解釈するのはこの形式だけ):

```
ARCH ARCH-01 PASS
ARCH ARCH-02 VIOLATION 3 src/app/service.ts が src/web/ に依存している 他 2 件
ARCH ARCH-03 ERROR dependency-cruiser が未導入
```

```
実装・テスト → アーキテクチャ検証 ──(適合)──→ PR
                     │
                     └──(規約違反)──→ 実装の修正
```

- `bash atf-bin/arch.sh`(= `atf arch`)が検証を実行し、結果を `checks.jsonl` に記録します。**違反または未検証の規約が残っていれば終了コード 1**(適合ゲート未通過)を返します
- `orchestrator` は違反・未検証が残っているあいだ作業を完了としません。違反は回避策で消さず、依存の向きの修正か、規約の見直し(ユーザーの合意が前提)で解消します
- 既存コードの違反は**ベースラインとして件数を凍結**し、増やさないことを保証する運用を指示しています(規約を緩めない)
- 結果はダッシュボードの「アーキテクチャ適合検証」セクション(レイヤ / 規約 ↔ 検証の実体 ↔ 最新結果)に表示されます

## ルーブリック評価(成果物の採点)

ヒアリングで「各エージェントの成果物をルーブリックで評価しますか?」に yes と答えると、`evaluator` エージェント(チーム規模の枠外)と**完了前の評価ゲート**が導入されます。

| パス | 内容 |
| --- | --- |
| `.claude/atf-eval/rubric.json` | 評価観点と水準の定義(**評価基準の単一情報源**。`EVAL-01` 形式の安定 id) |
| `.claude/atf-eval/evaluations.jsonl` | 評価記録(1 行 1 成果物)。ダッシュボードとゲート判定の入力 |
| `.claude/atf-eval/README.md` | 書式と運用(atf が生成) |

採点するのは evaluator で、**atf は記録の集計とゲート判定だけ**を担います(検証ツールを直接叩かない、という他の機能と同じ切り分けです)。

```
実装・テスト → ルーブリック評価 ──(合格)──→ 完了・PR
                     │
                     └──(要改善・不合格)──→ 改善指示つきで担当に差し戻す
```

- 観点は `EVAL-01` のような安定 id を持ち、水準は**観察できる事実**で書きます(「丁寧である」ではなく「異常系のテストがない」)。閾値は `passScore`(既定 3)、重要な観点には `weight` を付けます
- 判定は `pass` / `revise`(要改善)/ `fail`(不合格)/ `unknown`。`revise` / `fail` には「何をどう直すか」を `actions` に必ず書きます
- 同じ `target` + `artifact` の記録は**後勝ち**で、再評価すると最新の判定に置き換わります(履歴は生ファイルに残ります)
- `bash atf-bin/eval.sh`(= `atf eval`)が集計し、**未達が残っている / 対象エージェントに未評価がある**あいだは終了コード 1(評価ゲート未通過)を返します
- evaluator は**実装しません**。修正は元の担当エージェントに差し戻します(評価者が直すと自己採点になるため)

### 閾値とネクストアクションをセットで設定する

スコアの基準だけでは「で、次に何をするのか」が評価のたびにぶれます。`rubric.json` には**閾値と、それを跨いだときの行動**を一緒に書けます。

```json
{
  "passScore": 3,
  "actions": {
    "below": ["担当エージェントに改善指示を添えて差し戻し、修正後に再評価する"],
    "meets": ["orchestrator に合格を報告し、次の作業へ進む"]
  },
  "criteria": [
    {
      "id": "EVAL-02",
      "name": "検証の裏づけ",
      "description": "動くことの根拠が示されているか",
      "passScore": 4,
      "actions": {
        "below": ["不足しているテストを一覧にして test-engineer に差し戻す",
                  "CI から実行されているかを env-builder に確認する"]
      },
      "levels": [ ... ]
    }
  ]
}
```

| 項目 | 意味 |
|---|---|
| `passScore`(ルーブリック直下) | 全体の閾値。既定 3 |
| `criteria[].passScore` | **その観点だけの閾値**(「この観点は 4 以上を求める」)。省略時は全体の値 |
| `actions.below` | スコアが**閾値未満**のときにやること(差し戻しの手順) |
| `actions.meets` | スコアが**閾値以上**のときにやること(次に進む手順) |
| `criteria[].actions` | その観点だけのネクストアクション。省略時はルーブリック直下の `actions` を使う |

`bash atf-bin/eval.sh` は、**評価観点の表に「閾値未満のとき / 閾値以上のとき」の列**を出します
(観点に固有の手順はそのまま、ルーブリック直下の既定が効くものは `(既定)` と畳んで表の下に 1 度だけ展開します)。
さらに採点結果を**観点ごとの閾値**と突き合わせ、該当するネクストアクションを
「次にやること」として対象・成果物つきで一覧にします。未達が残っているあいだは差し戻しが先なので、
`meets` の手順はすべての観点が閾値以上になったときだけ出ます。

閾値を上げると既存の「合格」と食い違うことがあります。その場合は `atf eval` / `atf status` が
**「合格と記録されているが、閾値未満の観点が残っている」**と要確認で報告します(判定は書き換えません)。
再評価するか閾値を見直すかはユーザーの判断です。

### どのエージェントを、どの観点で採点しているかを見る

`bash atf-bin/eval.sh`(= `atf eval`)は次の表を出します(ネクストアクション関連の表は、設定があるときだけ出ます)。

```
評価観点(評価対象のエージェントごと):
  ┌───────────────┬────────────────┬─────────────┬──────────────┬────────────────┬──────────┐
  │ エージェント  │ 観点           │ 重み・閾値  │ 水準         │ 閾値未満のとき │ 閾値以上 │
  ├───────────────┼────────────────┼─────────────┼──────────────┼────────────────┼──────────┤
  │ code-reviewer │ EVAL-01 要求の │ 重み 2      │ 4 優秀       │ (既定)         │ (既定)   │
  │               │ 充足           │ 閾値 3 以上 │ 3 合格(閾値) │                │          │
  │               │ EVAL-02 検証の │ 重み 1      │ 4 優秀(閾値) │ - 不足している │ (既定)   │
  │               │ 裏づけ         │ 閾値 4 以上 │ 3 合格       │ テストを一覧に │          │
  │               │                │             │              │ して差し戻す   │          │
  │ test-engineer │ EVAL-01 要求の │ 重み 2      │ 3 以上       │ (既定)         │ (既定)   │
  └───────────────┴────────────────┴─────────────┴──────────────┴────────────────┴──────────┘
  ネクストアクションは観点の actions を優先し、(既定)は次の内容です:
    閾値未満: 担当エージェントに改善指示を添えて差し戻し、修正後に再評価する
    閾値以上: orchestrator に合格を報告し、次の作業へ進む

(ネクストアクションの列は、設定があるときだけ出ます)

スコアリング状況(評価対象 × 観点。セルは平均スコア):
  ┌─────────────────────┬─────────┬─────────┬─────────┬──────┬──────────────┐
  │ エージェント        │ EVAL-01 │ EVAL-02 │ EVAL-03 │ 総合 │ 状態         │
  ├─────────────────────┼─────────┼─────────┼─────────┼──────┼──────────────┤
  │ code-reviewer       │ 4       │ 3       │ 未採点  │ 3.67 │ ✅ 合格 1 件 │
  │ test-engineer       │ 3       │ 2 ⚠️    │ 対象外  │ 2.67 │ ❌ 未達 1 件 │
  │ refactoring-advisor │ 未採点  │ 未採点  │ 対象外  │ -    │ ⬜ 未評価    │
  └─────────────────────┴─────────┴─────────┴─────────┴──────┴──────────────┘
```

- **評価観点** — **評価対象のエージェントごと**に、そのエージェントが見られる観点・重み・閾値・水準(閾値に印が付く)・**閾値を跨いだときのネクストアクション**を並べたもの。どの観点が誰に効くかは `appliesTo` で決まります
- **スコアリング状況** — 評価対象 × 観点の行列。セルは**その観点の平均スコア**で、閾値未満には `⚠️` が付きます。`対象外` はその観点の `appliesTo` から外れている、`未採点` は観点は適用されるがまだ採点した成果物がない状態です
- **次にやること** — 閾値を下回った観点ごとに、設定済みのネクストアクションを対象・成果物つきで一覧にしたもの
- **成果物ごとの最新の判定** — 判定 / 対象・成果物 / 総合 / 観点ごとの採点(「スコア/閾値」。閾値未満は `⚠️`)/ 改善指示 の表

同じ表(同じ並べ方・同じ `(既定)` の畳み方)はダッシュボードの「ルーブリック評価」セクションにも出ます。

### 評価対象のエージェントを 1 体ずつ ON/OFF する

機能全体の ON/OFF は `requirements.rubricEval`、**エージェントごとの ON/OFF は `requirements.evalTargets`** です。

```yaml
requirements:
  rubricEval: true       # 機能全体の ON/OFF
  evalTargets:
    code-reviewer: true  # 評価する
    test-engineer: true
    env-builder: false   # 評価しない
    orchestrator: false
```

`evalTargets` は導入時にチーム構成から自動で書き出されます(evaluator 自身は対象外)。`false` に書き換えて
`atf apply eval <project-dir>` をやり直すと、**そのエージェント定義から評価の指示が外れ**、evaluator の
「評価対象」一覧・ゲート判定・ダッシュボードの集計からも外れます。設定にないエージェント(あとから増えた担当)は
対象として扱われるため、黙って評価から漏れることはありません。

## あとから機能を導入する(`atf apply`)

`init` のヒアリングで見送った機能は、あとから `atf apply` で足せます。チームを作り直す必要はありません。

```bash
atf apply <formal|arch|docs|issue|eval|report> <project-dir>
```

| サブコマンド | 内容 | 担当エージェント | 配るスクリプト |
|---|---|---|---|
| `formal` | 形式仕様(Alloy)+ ADR による要件・仕様の単一情報源 | spec-formalizer | `atf-bin/formal.sh` / `weave.sh` / `lint.sh` |
| `arch` | アーキテクチャ適合検証 | arch-guard | `atf-bin/arch.sh` |
| `docs` | リバースドキュメント(図は archify スキル) | doc-reverser | `atf-bin/docs.sh` |
| `issue` | Issue 駆動開発(作業は Issue 起点。起案は `.claude/atf-issues/`) | issue-manager | — |
| `eval` | ルーブリック評価(成果物の採点。対象はエージェントごとに ON/OFF) | evaluator | `atf-bin/eval.sh` |
| `report` | ダッシュボード(チーム構成と実行記録の可視化) | — | `atf-bin/report.sh` |
| `design` | デザイン(スキル + エージェントへの指示)※選択は対話 | — | — |

> **置き場の変更**: 形式仕様は `.claude/atf-specs/` から **`spec/`(仕様)・`docs/adr/`(決定の履歴)・`docs/generated/`(生成物)・`.claude/atf-formal/`(記録)** に分かれました。
> 導入済みのプロジェクトは `atf apply formal <project-dir>`(または `atf update`)を 1 度流すと、旧レイアウトのファイルが新しい置き場へ移り、旧ディレクトリは片付きます。
> **`.als` の書式は自動変換しません** — 行コメント(`-- REQ-01:`)は doc comment(`/** @req R-01 ... */`)に手で書き換えてください。何が足りないかは `bash atf-bin/lint.sh` が指摘します。

サブコマンド名は `atf-bin/` に置かれるスクリプト名と同じです(`atf apply arch <dir>` で導入 → `bash atf-bin/arch.sh` で実行)。
`issue` はゲートではなく**進め方**の機能なので実行スクリプトを持ちません(`--run` も出ません)。導入すると
issue-manager が加わり、全エージェントが Issue 番号を起点に動くようになります。起票先は `atf-settings.yaml` の
`requirements.githubRepo` で、未設定のまま導入すると警告が出ます。

実行すると次の 5 つが揃います。

1. `atf-settings.yaml` の `requirements`(`formalSpec` / `archCheck` / `reverseDocs` / `rubricEval`)を有効にする — 有効/無効の単一情報源(`report` は常に使えるため requirements を持ちません)
2. 担当エージェント定義を `.claude/agents/` に追加(既存の同名定義があれば尊重して上書きしません)
3. 既存の全エージェント定義に、その機能のセクションを差し込む(orchestrator にはゲート、env-builder には整備指示)
4. 成果物の置き場(`.claude/atf-arch/` など)と `atf-bin/<機能>.sh` を用意
5. `atf-settings.yaml` の構成図の辺とダッシュボードを更新

セクションの差し込みは**何度実行しても増殖せず**、手で書き足した節は残ります(`atf apply design` と同じ仕組み)。`-d/--design-doc` で形式化の対象にする設計書のパスを渡せます。

#### 導入直後のスモーク実行(`-r/--run`)

`-r/--run` を付けると、導入した直後に `bash atf-bin/<機能>.sh` を 1 度だけ実行します。確かめているのは
**配線**(スクリプトが配られたか / そこから `atf` を解決できるか)で、ゲートの合否ではありません。

| 表示 | 意味 | 終了コード |
|---|---|---|
| ⬜ 未整備 | 検証・点検の対象(`.als` / 規約 / 文書の記録)がまだない。**導入直後の正常な状態**で、中身は担当エージェントがこれから作る | 0 |
| ✅ 実行できました | 中身が揃っていて、ゲートも通った | 0 |
| ❌ ゲート未通過 | 中身は揃っているが、違反・未充足が残っている | 1 |
| ⚠️ atf を解決できません | スクリプトから `atf` を見つけられない(PATH / 環境変数 `ATF` / `atf-bin/atf.local.sh` を確認) | 1 |

導入先で `atf` が PATH にないケースをその場で検出できるので、他のマシンやコンテナで `apply` したときに有用です。

検証や再生成を実際に走らせるのは配られた `atf-bin/*.sh` です。その実体(`atf formal` / `atf weave` / `atf lint` / `atf arch` / `atf docs` / `atf report`)はスクリプトから呼ばれる内部コマンドで、`atf --help` には出しません。

### 機能を撤去する(`atf remove`)

```bash
atf remove <formal|arch|docs|issue|design> <project-dir>
```

`apply` の逆操作です。次を行います。

1. `atf-settings.yaml` の `requirements` を `false` にする
2. 担当エージェント定義（`arch-guard.md` など）を削除し、`agents` からも外す
3. 残るエージェント定義から、その機能のセクションだけを取り除く（手で書き足した節は残ります）
4. 付随するスキル（`docs` の archify）を撤去する。手編集されたものは残して報告します（`-f` で強制撤去）
5. `atf-bin/<機能>.sh` を取り除き、構成図の辺とダッシュボードを更新する

**成果物は既定で残します** — `.claude/atf-arch/` の規約、`spec/` の `.als` と `docs/adr/` の ADR、`.claude/atf-docs/` の索引は、ユーザーとエージェントの作業結果だからです。この状態では `atf status` が「無効だが成果物が残っている」と報告します。まとめて削除するなら `--purge` を付けてください（元に戻せません）。

撤去したあと `atf apply <機能>` を実行すれば、エージェント定義は雛形から作り直されます。

### 導入済みのアセットを更新する(`atf update`)

```bash
atf update <project-dir>             # 更新内容を表示して承認を取ってから実行
atf update <project-dir> --dry-run   # 何が変わるかだけを見る(書き込まない)
atf update <project-dir> -f          # 手編集されたスキルも入れ替える
atf update <project-dir> -y          # 確認プロンプトを省く
```

atf 側を更新したあと、**すでに導入済みのプロジェクトを追随させる**ためのコマンドです。
対象は**いま有効になっている機能だけ**で、機能の有効/無効は変えません(足す・外すのは `atf apply` / `atf remove`)。

実行前に「どの機能の・どのアセットが・どう変わるか」を表で提示し、**承認を得てから**書き込みます。

| 更新するもの(atf が内容を決める) | 触らないもの(ユーザーとエージェントが書く) |
| --- | --- |
| エージェント定義の atf セクション(手で書き足した節は残る) | `rules.json`(レイヤ規約)/ `rubric.json`(評価観点) |
| 足場の書式ガイド(各 `README.md`)と `report-junit.mjs` | `run-arch-check.sh` / `run-alloy.sh` / `explain-template.html` |
| `atf-bin/*.sh`、ダッシュボード、`atf-settings.yaml` の記録 | `.als`、各種 `*.jsonl` の記録、Issue ドラフト |
| 付随スキル(カタログの版が上がったもの) | 手編集されたスキル(`--force` のときだけ入れ替え) |

欠けている担当エージェント定義や実行スクリプトがあれば、あわせて配り直します(修復としても使えます)。
スキルは `atf-settings.yaml` に記録した版(pin した commit / 同梱した版)とカタログを比べて判断するため、
**版が同じで中身だけが違うもの = 手編集**とみなして据え置き、表に「据え置き」として報告します。

## デザインスキル

重視観点に「UI/UX デザイン品質」を選ぶと、導入するスキルをヒアリングで選択できます。

- **見た目の方向性**(1 つだけ選ぶ) — `taste-skill`(既定)/ `minimalist-skill` / `brutalist-skill` / `soft-skill` / `taste-skill-v1`
- **作業の進め方**(併用可) — `redesign-skill`(既存プロジェクトの改善)/ `output-skill`(出力の省略防止)/ `image-to-code-skill` / `gpt-tasteskill` / `stitch-skill`
- **画像生成**(併用可) — `imagegen-frontend-web` / `imagegen-frontend-mobile` / `brandkit`

選んだスキルは対象リポジトリの `.claude/skills/<スキル名>/SKILL.md` に配置され、Claude Code が起動時に認識します。
スキル本文は必要になったときだけ読み込まれるため、UI に関係しない作業のコンテキストは消費しません。

### あとからデザインを適用・変更する(`atf apply design`)

チーム導入後にデザインを決めたり差し替えたりする場合は `atf apply design <project-dir>` を使います。選択は対話のみで、スキルを 1 つも選ばずに進めると解除になります。

```bash
atf apply design /path/to/project        # 対話で選び直す(現在の選択が初期値になる)
atf apply design /path/to/project -f     # 手編集されたスキルも入れ替える
atf apply design /path/to/project -y     # 差分の確認プロンプトを省く
```

- **指定した集合がそのまま適用後のデザイン**になります。選択から外れたスキルは `.claude/skills/` から撤去されます(手を入れた `SKILL.md` は残し、警告します。`--force` で撤去)
- `.claude/agents/*.md` のデザイン関連セクション(「デザインスキル(UI 実装時に使う)」/「デザインスキルの配分」/「デザインスキルの実行環境」)を差し替えます。何度実行しても指示は増殖せず、手で書き足した他のセクションは残ります
- `atf-settings.yaml`(`skills` / `requirements.designSkills`)とダッシュボードも更新されます
- 見た目の方向性のスキルが複数指定された場合は先頭の 1 つだけを採用します(指示が衝突するため)
- スキルは、それを使う機能の導入で配られます(デザインスキル → `atf apply design` / 図の archify → `atf apply docs`)。配置だけを行うコマンドはありません(エージェントが参照しないスキルが残るため)

デザインスキルは [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill)(MIT License)から**無改変で**取り込んでいます。
図の生成に使う [archify](https://github.com/tt-a1i/archify)(MIT License)はパッケージごと同梱しています(テストと生成済みサンプル HTML は同梱時に除外)。
出典と取り込んだ commit は `templates/skills/NOTICE.md` と、配布先の `.claude/skills/README.md` に記録されます。
更新は `npm run sync-skills`(pin した commit の再取得)/ `npm run sync-skills -- --ref main`(最新へ pin を更新)で行います。

## 同梱プリセット

| ID | チーム | 用途 |
| --- | --- | --- |
| `web-dev` | Web アプリ開発チーム | 設計・実装・テスト・レビュー・ドキュメントを分担する標準開発体制 |
| `quality-review` | 品質レビューチーム | コード品質・テスト・保守性の改善 |
| `security-audit` | セキュリティ監査チーム | 脆弱性検出・依存関係監査・修正(防御目的) |
| `new-service` | 新サービス検討チーム | 新規サービスの企画・市場調査・実現性検証・UX 設計・事業性評価 |

プリセットは `templates/presets/<id>/` に `preset.json` + `agents/*.md` を置くだけで追加できます。
スキルも同様に `templates/skills/<id>/` に `SKILL.md` + `skill.json` を置くだけで追加できます。

## 開発

```bash
npm run dev -- <args>   # ビルドなしで実行
npm test                # テスト
npm run typecheck       # 型チェック
npm run build           # ビルド(dist/。グローバルの `atf` が実行するのはこちら)
npm run sync-skills     # 外部スキルを pin した commit から取り込み直す(--check で差分検証)
```

`atf` コマンドとして使うときは `npm install -g .`(または `npm link`)。どちらも `prepare` スクリプトで
`dist/` をビルドしてから配置します。**ソースを編集したら `npm run build` を忘れないこと** —
グローバルの `atf` はリポジトリの `dist/` を指すシンボリックリンクなので、ビルドしないと古い挙動のままです
(`npm run dev -- <args>` はビルド不要で常に最新のソースを実行します)。
