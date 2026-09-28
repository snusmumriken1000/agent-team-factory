import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adrsByRequirement, loadAdrs } from "./adr.js";
import {
  latestSpecCheck,
  loadSpecChecks,
  loadSpecDecisions,
  loadSpecModels,
  rootModel,
  specSigs,
  tagValue,
  tagValues,
  ROOT_MODEL,
  SPEC_RESULT_LABEL,
} from "./alloy.js";
import { explainDocName, loadExplainTemplate, renderSpecExplainHtml } from "./specdoc.js";
import type { AdrRecord } from "./adr.js";
import type { SpecCheckRecord, SpecDeclaration, SpecModel } from "./types.js";

/**
 * weave — 形式仕様(`spec/*.als`)と ADR から自然言語の文書を生成する。
 *
 * 依存の向きは `.als` → `.md` の一方向だけ。ここで作るものはすべて**派生物**で、
 * `docs/generated/` に出して `.gitignore` に入れる(人が編集する余地をゼロにするため)。
 * 手書きしてよいのは `spec/*.als` と `docs/adr/*.md` の 2 種類だけ。
 *
 * **生成は決定的でなければならない**(同じ入力なら常にバイト一致の出力)。
 * 時刻・乱数など入力にない値を出力に混ぜないこと。混ぜると差分ゲート(`atf weave --check`)が
 * 常に落ちて意味を失う。反例の自然言語化(LLM を使う非決定的な生成)はここには含めず、
 * `.claude/atf-formal/narration/` に分けている。
 */

/** weave の出力先(使い捨ての派生物。.gitignore 対象) */
export function generatedDir(repoPath: string): string {
  return join(repoPath, "docs", "generated");
}

/** 生成物の先頭に付ける表示(手で編集させないため) */
export const BANNER = "<!-- GENERATED FROM spec/*.als — DO NOT EDIT -->";

/** weave が生成する 1 ファイル */
interface WeaveFile {
  /** docs/generated/ からの相対ファイル名 */
  name: string;
  content: string;
}

const md = (lines: string[]): string => `${BANNER}\n\n${lines.join("\n").replace(/\n+$/, "")}\n`;

/** Markdown の表のセルとして安全にする(改行と | を潰す) */
const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();

/** 空なら「-」を返す */
const dash = (text: string | undefined): string => (text && text.trim() !== "" ? text.trim() : "-");

/** モデルの並び: ルートモジュールを先頭に、あとはファイル名順 */
function orderModels(models: SpecModel[]): SpecModel[] {
  const root = models.filter((m) => m.file === ROOT_MODEL);
  const rest = models.filter((m) => m.file !== ROOT_MODEL);
  return [...root, ...rest];
}

/** 仕様全体の名称(ルートモジュールの @title。なければプロジェクト名) */
function specTitle(models: SpecModel[], projectName: string): string {
  return tagValue(rootModel(models)?.doc, "title") ?? `${projectName} 仕様`;
}

/** overview.md — ルートモジュールの @title / @scope / @out-of-scope / @stakeholder */
function buildOverview(models: SpecModel[], projectName: string): string {
  const root = rootModel(models);
  if (!root) {
    return md([
      `# ${projectName} 仕様の概要`,
      "",
      `ルートモジュール \`spec/${ROOT_MODEL}\` がありません。`,
      "`@title` / `@scope` / `@out-of-scope` / `@stakeholder` を持つルートモジュールを作ってください",
      "(`bash atf-bin/lint.sh` が必須タグの欠落を検出します)。",
    ]);
  }

  const outOfScope = tagValues(root.doc, "out-of-scope");
  // 散文がなければ空行を足さない(見出しの直後に表が来る)
  const prose = (root.doc?.prose ?? []).filter((p) => p !== "");
  const lines = [
    `# ${specTitle(models, projectName)}`,
    "",
    ...(prose.length > 0 ? [...prose, ""] : []),
    "| 項目 | 内容 |",
    "| --- | --- |",
    `| 対象範囲 | ${cell(dash(tagValue(root.doc, "scope")))} |`,
    `| 承認 | ${cell(dash(tagValue(root.doc, "stakeholder")))} |`,
    `| トレードオフの最優先 | ${cell(dash(tagValue(root.doc, "tradeoff")))} |`,
    "",
    "## 意図的に扱わない範囲",
    "",
    ...(outOfScope.length > 0 ? outOfScope.map((s) => `- ${s}`) : ["- (記載なし)"]),
    "",
    "## モジュール",
    "",
    "| モジュール | ファイル | 対象範囲 |",
    "| --- | --- | --- |",
    ...orderModels(models).map(
      (m) =>
        `| ${cell(m.module)} | \`spec/${cell(m.file)}\` | ${cell(dash(tagValue(m.doc, "scope")))} |`,
    ),
  ];
  return md(lines);
}

/** 宣言 1 件の見出し(@req の文 → 散文の 1 行目 → シグネチャ) */
function headingOf(decl: SpecDeclaration): string {
  const req = tagValues(decl.doc, "req")[0];
  const text = req?.replace(/^\S+\s*/, "").trim();
  if (text) return text;
  const prose = decl.doc?.prose.find((p) => p !== "");
  return prose ?? decl.signature;
}

/** spec.md — 全モジュールの doc comment と宣言シグネチャ */
function buildSpecDoc(models: SpecModel[], projectName: string): string {
  const lines: string[] = [`# ${specTitle(models, projectName)}`, ""];
  lines.push(
    "この文書は `spec/*.als` から生成した読み物です。**仕様の正は `.als`** で、ここを直しても仕様は変わりません。",
    "",
  );

  for (const model of orderModels(models)) {
    lines.push(`## モジュール \`${model.module}\`(\`spec/${model.file}\`)`, "");
    for (const p of model.doc?.prose ?? []) if (p !== "") lines.push(p, "");
    const scope = tagValue(model.doc, "scope");
    if (scope) lines.push(`対象範囲: ${scope}`, "");

    const documented = model.declarations.filter(
      (d) => d.doc !== undefined && d.kind !== "module",
    );
    const bare = model.declarations.filter((d) => d.doc === undefined && d.kind !== "open");

    for (const decl of documented) {
      const heading = headingOf(decl);
      lines.push(`### ${heading}`, "");
      // 見出しに使った行は本文で繰り返さない
      for (const p of decl.doc?.prose ?? []) if (p !== "" && p !== heading) lines.push(p, "");
      const facts: string[] = [];
      // 要件は ID だけを出す(文は見出しになっているため)
      for (const value of tagValues(decl.doc, "req")) {
        facts.push(`- 要件: ${value.split(/\s+/)[0]}`);
      }
      for (const [tag, label] of [
        ["validation", "機械的証拠"],
        ["rationale", "なぜこの形か"],
        ["relaxed", "意図的に緩くしている点"],
        ["term", "業務用語"],
        ["adr", "関連する決定"],
      ] as const) {
        for (const value of tagValues(decl.doc, tag)) facts.push(`- ${label}: ${value}`);
      }
      if (facts.length > 0) lines.push(...facts, "");
      lines.push("```alloy", decl.signature, "```", "");
    }

    if (bare.length > 0) {
      lines.push(
        "注釈(doc comment)のない宣言 — 説明が要るものには `/** ... */` を付けてください:",
        "",
        ...bare.map((d) => `- \`${d.signature}\``),
        "",
      );
    }
  }

  return md(lines);
}

/** glossary.md — 全 @term(sig とフィールドに書いたもの) */
function buildGlossary(models: SpecModel[], projectName: string): string {
  const rows: string[] = [];
  for (const model of orderModels(models)) {
    for (const sig of specSigs(model)) {
      for (const term of tagValues(sig.doc, "term")) {
        rows.push(
          `| ${cell(term)} | \`${cell(sig.name)}\` | ${cell(model.module)} | ${cell(dash(sig.doc?.prose.find((p) => p !== "")))} |`,
        );
      }
      for (const field of sig.fields) {
        for (const term of tagValues(field.doc, "term")) {
          rows.push(
            `| ${cell(term)} | \`${cell(`${sig.name}.${field.name}`)}\` | ${cell(model.module)} | ${cell(dash(field.doc?.prose.find((p) => p !== "")))} |`,
          );
        }
      }
    }
  }
  rows.sort();

  return md([
    `# ${specTitle(models, projectName)} 用語集`,
    "",
    "`.als` の `@term` から生成した、業務用語と形式仕様の対応表。",
    "",
    "| 業務用語 | 対応する宣言 | モジュール | 説明 |",
    "| --- | --- | --- | --- |",
    ...(rows.length > 0
      ? rows
      : ["| (まだありません) | - | - | `sig` / フィールドの doc comment に `@term` を付けてください |"]),
  ]);
}

/** traceability.md — @req × check × ADR のマトリクス */
function buildTraceability(
  models: SpecModel[],
  checks: SpecCheckRecord[],
  adrs: AdrRecord[],
  projectName: string,
): string {
  const byRequirement = adrsByRequirement(adrs);
  const rows: string[] = [];
  const ids = new Set<string>();

  for (const model of orderModels(models)) {
    for (const req of model.requirements) {
      ids.add(req.id);
      const commands = model.commands.filter((c) => c.requirements.includes(req.id));
      const results = commands.map((c) => {
        const latest = latestSpecCheck(checks, model.file, c.name);
        return `${c.kind} ${c.name}: ${latest ? (SPEC_RESULT_LABEL[latest.result] ?? latest.result) : "未検証"}`;
      });
      rows.push(
        `| ${cell(req.id)} | ${cell(dash(req.text))} | \`${cell(model.file)}\` | ${cell(req.declarations.join(" / "))} | ${cell(results.length > 0 ? results.join(" / ") : "検証コマンドなし")} | ${cell((byRequirement.get(req.id) ?? []).map((a) => a.id).join(" / ") || "-")} |`,
      );
    }
  }
  rows.sort();

  // ADR が参照しているのに `.als` に無い ID(孤児。詳しい報告は atf lint)
  const orphans = adrs
    .flatMap((adr) => adr.refs.filter((ref) => !ids.has(ref)).map((ref) => `${ref}(${adr.id})`))
    .sort();

  return md([
    `# ${specTitle(models, projectName)} トレーサビリティ`,
    "",
    "業務要件(`@req`)と、それを機械検証する `check` / `run`、決定の履歴(ADR)の対応。",
    "",
    "| 要件 | 内容 | モデル | 宣言 | 検証と最新結果 | ADR |",
    "| --- | --- | --- | --- | --- | --- |",
    ...(rows.length > 0 ? rows : ["| (まだありません) | - | - | - | - | - |"]),
    "",
    ...(orphans.length > 0
      ? [
          "## ADR が参照している未定義の要件",
          "",
          ...orphans.map((o) => `- ${o}`),
          "",
          "`bash atf-bin/lint.sh` が孤児として検出します。",
        ]
      : []),
  ]);
}

/**
 * weave の出力を組み立てる(書き込みはしない)。
 * 生成と差分確認(`--check`)の単一情報源。
 */
function buildWeave(repoPath: string, projectName: string): WeaveFile[] {
  const models = loadSpecModels(repoPath);
  const checks = loadSpecChecks(repoPath);
  const decisions = loadSpecDecisions(repoPath);
  const adrs = loadAdrs(repoPath);
  const template = loadExplainTemplate(repoPath);

  const files: WeaveFile[] = [
    { name: "overview.md", content: buildOverview(models, projectName) },
    { name: "spec.md", content: buildSpecDoc(models, projectName) },
    { name: "glossary.md", content: buildGlossary(models, projectName) },
    { name: "traceability.md", content: buildTraceability(models, checks, adrs, projectName) },
  ];

  for (const model of models) {
    files.push({
      name: explainDocName(model.file),
      content: renderSpecExplainHtml({
        projectName,
        model,
        source: readFileSync(join(repoPath, "spec", model.file), "utf8"),
        checks,
        decisions,
        template,
      }),
    });
  }
  return files;
}

export interface WeaveResult {
  dir: string;
  /** 書き出した(内容が変わった)ファイル名 */
  written: string[];
  /** 内容が同じだったファイル名 */
  unchanged: string[];
  /** 元になる `.als` が消えたため取り除いた生成物 */
  removed: string[];
}

/** いま weave を実行したら内容が変わるファイル(`atf weave --check` の判定に使う) */
export function planWeave(repoPath: string, projectName: string): {
  changed: string[];
  removed: string[];
} {
  const dir = generatedDir(repoPath);
  const files = buildWeave(repoPath, projectName);
  const changed = files
    .filter(({ name, content }) => {
      const dest = join(dir, name);
      return !existsSync(dest) || readFileSync(dest, "utf8") !== content;
    })
    .map(({ name }) => name);
  return { changed, removed: staleGenerated(dir, files) };
}

/** 生成物のうち、いまの weave が作らなくなったもの(元の .als が消えた場合など) */
function staleGenerated(dir: string, files: WeaveFile[]): string[] {
  if (!existsSync(dir)) return [];
  const keep = new Set(files.map((f) => f.name));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") || f.endsWith(".explain.html"))
    .filter((f) => !keep.has(f))
    .sort();
}

/** 自然言語の文書を生成する(`atf weave`) */
export function runWeave(repoPath: string, projectName: string): WeaveResult {
  const dir = generatedDir(repoPath);
  const files = buildWeave(repoPath, projectName);
  mkdirSync(dir, { recursive: true });

  const written: string[] = [];
  const unchanged: string[] = [];
  for (const { name, content } of files) {
    const dest = join(dir, name);
    if (existsSync(dest) && readFileSync(dest, "utf8") === content) {
      unchanged.push(name);
      continue;
    }
    writeFileSync(dest, content);
    written.push(name);
  }

  // 元の .als が消えた生成物は残さない(古い仕様が読まれ続けるのを防ぐ)
  const removed = staleGenerated(dir, files);
  for (const name of removed) rmSync(join(dir, name));

  return { dir, written, unchanged, removed };
}
