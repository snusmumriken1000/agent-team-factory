# スキルカタログ(templates/skills)

`atf init` が対象リポジトリの `.claude/skills/` に配布する Claude Code スキルの置き場。
プリセットと同じく**ディレクトリを置くだけでコード変更なしに認識される**(`src/skills.ts` の `loadSkillCatalog`)。

## 構成

```
templates/skills/
  sources.json      # 外部スキルの取得元(リポジトリ・pin した commit・分類)
  NOTICE.md         # 同梱スキルの出典とライセンス全文(sync-skills.mjs が生成。手で編集しない)
  <カタログ id>/
    SKILL.md        # スキル本体(外部由来のものは無改変)
    skill.json      # atf 側のメタ情報
    (bin/ schemas/ … 複数ファイルからなるスキルはパッケージごと同梱する)
```

`skill.json` の形式:

```json
{
  "category": "aesthetic",
  "recommended": true,
  "source": { "repo": "owner/repo", "homepage": "https://…", "path": "skills/x/SKILL.md", "commit": "…", "license": "MIT" }
}
```

- `category` — ヒアリングでの聞き方が変わる:
  - `aesthetic`: 見た目の方向性。**1 つだけ選ぶ**(併用すると指示が衝突するため select で聞く)
  - `workflow`: 作業の進め方。複数併用できる(checkbox)
  - `imagegen`: 画像生成専用(コードは書かない)。複数併用できる(checkbox)
  - `diagram`: 図・ドキュメント生成。**デザインのヒアリング対象外**で、機能の選択(リバースドキュメントモード)に応じて generator が配る。`atf apply design` でも撤去されない
- `recommended` — ヒアリングの既定値にする(`aesthetic` では 1 つだけ付ける)
- `source` — 外部由来のときだけ。atf 独自スキルでは省略できる
- **スキル名・説明は `SKILL.md` の frontmatter(`name` / `description`)が単一情報源**。`skill.json` には書かない。
  対象リポジトリには frontmatter の `name` をディレクトリ名として配置される
  (例: カタログ id `taste-skill` → `.claude/skills/design-taste-frontend/SKILL.md`)

## 外部スキルの更新

取得は開発者用スクリプトだけが行う(atf の CLI 本体はネットワークを使わない)。

```bash
npm run sync-skills              # sources.json に pin された commit から取り込み直す
npm run sync-skills -- --ref main  # 上流の最新 commit に pin を更新して取り込む
npm run sync-skills -- --check     # 取り込み済みの内容が pin と一致するか検証(CI 向け)
```

### パッケージごと同梱するスキル(vendored)

`SKILL.md` の手順がスキル内のスクリプトを実行するスキル(archify など)は、上流のパッケージごと同梱する。

- `skill.json` の `source` に `vendored: true` と `version`、サイズ削減のために `excluded`(除外したパス)を書く
- `LICENSE`(と必要なら `THIRD_PARTY_NOTICES.md`)をスキルのディレクトリに残す。`sync-skills.mjs` は LICENSE がないと失敗する
- `sync-skills.mjs` は取得も掃除もしない(`sources.json` には載せない)。出典表示だけを `NOTICE.md` に載せる
- `installSkills` はディレクトリ全体を配布先にコピーする(`skill.json` だけ配らない)

取り込んだ `SKILL.md` は**改変しない**。atf 側の都合(プレースホルダ置換など)は入れず、そのまま配る。
改変すると `--check` が落ち、上流との差分が追えなくなる。

## atf 独自スキルを足す

`templates/skills/<id>/` に `SKILL.md`(frontmatter に `name` と `description`)と
`category` だけ書いた `skill.json` を置けばよい。`sources.json` には追加しない
(`sync-skills.mjs` は `sources.json` にない**外部由来の**ディレクトリだけを掃除対象にする点に注意。
独自スキルを置く場合は `sources.json` の掃除対象から外れるよう `skill.json` に `source` を書かないこと)。

ヒアリングの選択肢はカタログから動的に組み立てられるため、`src/hearing.ts` の変更は不要。
