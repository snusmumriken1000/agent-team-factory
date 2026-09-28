import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./frontmatter.js";
import type { InstalledSkill, SkillCategory, SkillDef, SkillSource } from "./types.js";

/** templates/skills のルート(パッケージ同梱) */
export function skillsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ からも src/ からも見えるように 1 つ上の templates を参照する
  return join(here, "..", "templates", "skills");
}

/** 対象リポジトリの Claude Code スキル置き場 */
export function skillsDir(repoPath: string): string {
  return join(repoPath, ".claude", "skills");
}

/** 分類 → 表示ラベル(CLI・ヒアリング・ダッシュボードで共用) */
export const SKILL_CATEGORY_LABEL: Record<string, string> = {
  aesthetic: "見た目の方向性(1 つだけ選ぶ)",
  workflow: "作業の進め方(併用可)",
  imagegen: "画像生成(コードは書かない)",
  diagram: "図・ドキュメント(コードからの可視化)",
};

/** カタログ内での並び順(ヒアリング・一覧表示で使う) */
const CATEGORY_ORDER: SkillCategory[] = ["aesthetic", "workflow", "imagegen", "diagram"];

/**
 * templates/skills 配下のスキルをすべてロードする。
 * SKILL.md と skill.json が揃っているディレクトリだけを採用し、
 * 名前・説明は SKILL.md の frontmatter を単一情報源とする。
 */
export function loadSkillCatalog(root: string = skillsRoot()): SkillDef[] {
  if (!existsSync(root)) return [];
  const skills: SkillDef[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const skillMd = join(dir, "SKILL.md");
    const metaPath = join(dir, "skill.json");
    if (!existsSync(skillMd) || !existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      const { name, description } = parseFrontmatter(readFileSync(skillMd, "utf8"), entry.name);
      skills.push({
        id: entry.name,
        name,
        description,
        category: meta.category ?? "workflow",
        recommended: meta.recommended === true,
        source: meta.source,
        dir,
      });
    } catch {
      // 壊れた skill.json は無視する(カタログ全体を落とさない)
    }
  }
  return skills.sort(
    (a, b) =>
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
      Number(b.recommended) - Number(a.recommended) ||
      a.id.localeCompare(b.id),
  );
}

/** カタログ id の配列を SkillDef の配列にする(未知の id は捨てる) */
export function resolveSkills(ids: string[], catalog: SkillDef[] = loadSkillCatalog()): SkillDef[] {
  return ids
    .map((id) => catalog.find((s) => s.id === id))
    .filter((s): s is SkillDef => s !== undefined);
}

/** インストール済みスキルの記録用に、マニフェストへ載せる形へ落とす */
function toInstalled(skill: SkillDef): InstalledSkill {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    category: skill.category,
    ...(skill.source ? { source: skill.source } : {}),
  };
}

/** README に載せるのに必要な最小の情報(カタログ外のスキルも扱えるようにする) */
type SkillEntry = Pick<SkillDef, "name" | "description" | "category" | "source">;

/** 対象リポジトリに配った .claude/skills/README.md(出典・使い方・ライセンス) */
export function buildSkillsReadme(projectName: string, skills: SkillEntry[]): string {
  const rows = skills
    .map((s) => `| \`${s.name}\` | ${SKILL_CATEGORY_LABEL[s.category] ?? s.category} | ${s.description} |`)
    .join("\n");

  // 出典(リポジトリ + 版)ごとにまとめて謝辞・ライセンスを書く
  const bySource = new Map<string, SkillSource & { ids: string[] }>();
  for (const s of skills) {
    if (!s.source) continue;
    const key = `${s.source.repo}@${s.source.commit ?? s.source.version ?? "-"}`;
    const entry = bySource.get(key) ?? { ...s.source, ids: [] as string[] };
    entry.ids.push(s.name);
    bySource.set(key, entry);
  }
  const credits =
    bySource.size === 0
      ? "同梱スキルはすべて agent-team-factory が用意したもの。"
      : [...bySource.values()]
          .map(
            (s) => `### ${s.repo}

- 取得元: ${s.homepage ?? `https://github.com/${s.repo}`}
- ライセンス: ${s.license ?? "(不明)"}
- ${s.commit ? `取り込んだ commit: \`${s.commit}\`` : `取り込んだ版: \`${s.version ?? "(不明)"}\``}
- 該当スキル: ${s.ids.map((i) => `\`${i}\``).join(" / ")}${
              s.excluded && s.excluded.length > 0
                ? `\n- 同梱時に除外したパス: ${s.excluded.map((e) => `\`${e}\``).join(" / ")}`
                : ""
            }

${
  s.vendored
    ? "上流のパッケージ(スクリプト・スキーマ・テンプレート)ごと無改変で同梱している。ライセンス全文は同ディレクトリの `LICENSE` を参照。"
    : "`SKILL.md` は上流から無改変で取り込んでいる。ライセンス全文は上記リポジトリの LICENSE を参照。"
}`,
          )
          .join("\n\n");

  return `# ${projectName} のスキル

agent-team-factory が導入した Claude Code スキル。
各サブディレクトリの \`SKILL.md\` が本体で、Claude Code は起動時に frontmatter(名前と説明)だけを読み、
**実際に必要になったときに本文を読み込む**(常時コンテキストを消費しない)。

## 入っているスキル

| スキル名 | 分類 | 内容 |
| --- | --- | --- |
${rows}

## 使いどころ

- UI・画面・スタイルを実装/変更するときは、着手前に該当スキルを読み込んでその指示に従う
- 見た目の方向性を決めるスキルは**併用しない**(指示が衝突する)。このプロジェクトで選ばれた 1 つだけに従う
- 図・ドキュメント(コードからの可視化)のスキルは、構成図・フロー図を作る/更新するときに読み込む
- 関係しない作業(バックエンド・CI など)では読み込まなくてよい

## 出典

${credits}

## 更新・削除

このディレクトリは \`atf init\` / \`atf apply\` が作る。
手で編集したスキルは \`--force\` を付けない限り上書きされない。
不要なスキルはディレクトリごと削除してよい(\`atf-settings.yaml\` の \`skills\` からも消すこと)。
`;
}

/**
 * 配置先(.claude/skills/)に実在するスキルを読む。
 * 分類と出典はカタログ(インストール名で照合)から補い、
 * カタログにないもの(ユーザーが自分で置いたスキル)も一覧から落とさない。
 */
function listInstalled(dir: string, catalog: SkillDef[]): SkillEntry[] {
  const entries: SkillEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    const { name, description } = parseFrontmatter(readFileSync(file, "utf8"), entry.name);
    const known = catalog.find((s) => s.name === entry.name);
    entries.push({
      name,
      description,
      category: known?.category ?? "workflow",
      source: known?.source,
    });
  }
  return entries;
}

export interface InstallSkillsResult {
  dir: string;
  /** 実際にインストールされた(= カタログにあった)スキル */
  installed: InstalledSkill[];
  /** 新規に書き込んだスキル名(既存で上書きしなかったものは含まない) */
  written: string[];
  /** カタログに存在しなかった id */
  unknown: string[];
}

/**
 * カタログのスキルを対象リポジトリの .claude/skills/<スキル名>/ に配置する。
 *
 * - 単一ファイルのスキルは `SKILL.md` だけを書き込む
 * - 上流のパッケージごと同梱しているスキル(archify など。`bin/` や `schemas/` を持つ)は
 *   **ディレクトリ全体をコピー**する。`SKILL.md` の手順がスキル内のスクリプトを実行するため、
 *   本文だけ配ると動かない
 *
 * 既存の SKILL.md は force 指定がない限り上書きしない(ユーザーが手を入れた定義を尊重する)。
 */
export function installSkills(
  repoPath: string,
  ids: string[],
  opts: { force?: boolean; catalog?: SkillDef[]; projectName?: string } = {},
): InstallSkillsResult {
  const catalog = opts.catalog ?? loadSkillCatalog();
  const skills = resolveSkills(ids, catalog);
  const unknown = ids.filter((id) => !catalog.some((s) => s.id === id));
  const dir = skillsDir(repoPath);
  const written: string[] = [];
  if (skills.length === 0) return { dir, installed: [], written, unknown };

  mkdirSync(dir, { recursive: true });
  for (const skill of skills) {
    const dest = join(dir, skill.name);
    const destFile = join(dest, "SKILL.md");
    if (existsSync(destFile) && !opts.force) continue;
    mkdirSync(dest, { recursive: true });
    // atf のメタ情報(skill.json)は配らない。それ以外はスキル本体として配置する
    for (const entry of readdirSync(skill.dir, { withFileTypes: true })) {
      if (entry.name === "skill.json") continue;
      cpSync(join(skill.dir, entry.name), join(dest, entry.name), {
        recursive: true,
        force: true,
      });
    }
    written.push(skill.name);
  }

  // 出典とライセンス表示は常に最新の一覧に更新する(再配布の条件のため手編集を尊重しない)。
  // 追加インストール(機能を後から導入したとき)で既存分の表示が消えないよう、
  // 配置先に実在するスキルすべてを対象にする
  writeFileSync(
    join(dir, "README.md"),
    buildSkillsReadme(opts.projectName ?? "このプロジェクト", listInstalled(dir, catalog)),
  );

  return { dir, installed: skills.map(toInstalled), written, unknown };
}

export interface RemoveSkillsResult {
  dir: string;
  /** 実際に取り除いたスキル名 */
  removed: string[];
  /** 手が入っていたため残したスキル名 */
  kept: string[];
}

/**
 * 配置済みのスキルを .claude/skills/ から取り除く(atf apply design でデザインを差し替えるときに使う)。
 * SKILL.md がカタログと同一のもの(= atf が配ったまま)だけを削除し、
 * 手を入れたものは残して kept で返す(force 指定時は残さず削除する)。
 * 残ったスキルだけで README.md を作り直し、1 つも残らなければディレクトリごと片付ける。
 */
export function removeSkills(
  repoPath: string,
  names: string[],
  opts: { force?: boolean; catalog?: SkillDef[]; projectName?: string } = {},
): RemoveSkillsResult {
  const catalog = opts.catalog ?? loadSkillCatalog();
  const dir = skillsDir(repoPath);
  const removed: string[] = [];
  const kept: string[] = [];
  if (!existsSync(dir)) return { dir, removed, kept };

  for (const name of names) {
    const dest = join(dir, name);
    const destFile = join(dest, "SKILL.md");
    if (!existsSync(destFile)) continue;
    const known = catalog.find((s) => s.name === name);
    const pristine =
      known !== undefined &&
      readFileSync(destFile, "utf8") === readFileSync(join(known.dir, "SKILL.md"), "utf8");
    if (!pristine && !opts.force) {
      kept.push(name);
      continue;
    }
    rmSync(dest, { recursive: true, force: true });
    removed.push(name);
  }
  if (removed.length === 0) return { dir, removed, kept };

  const remaining = listInstalled(dir, catalog);
  if (remaining.length > 0) {
    writeFileSync(
      join(dir, "README.md"),
      buildSkillsReadme(opts.projectName ?? "このプロジェクト", remaining),
    );
  } else {
    rmSync(join(dir, "README.md"), { force: true });
    try {
      rmdirSync(dir); // 中身が残っている(ユーザーが置いたファイルなど)場合は触らない
    } catch {
      // 空でなければそのままにする
    }
  }
  return { dir, removed, kept };
}
