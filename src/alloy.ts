import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  SpecCheckRecord,
  SpecCommand,
  SpecDecisionRecord,
  SpecDeclaration,
  SpecDeclKind,
  SpecDoc,
  SpecField,
  SpecModel,
  SpecRequirement,
  SpecResult,
  SpecSig,
  SpecTag,
  SpecActor,
  SpecUseCase,
} from "./types.js";

/**
 * 形式仕様(SSOT)の置き場。
 *
 * 手書きするのはここの `.als` と `docs/adr/*.md` の 2 種類だけで、
 * 自然言語の仕様書は `atf weave` が `docs/generated/` に生成する派生物として扱う。
 */
export function specDir(repoPath: string): string {
  return join(repoPath, "spec");
}

/**
 * atf とエージェントが書く記録の置き場(検証結果・仕様判断・解説ページの形式)。
 * 仕様そのもの(`spec/`)や履歴(`docs/adr/`)とは置き場を分け、
 * 「手で書くもの」と「記録」を混ぜない。
 */
export function formalDir(repoPath: string): string {
  return join(repoPath, ".claude", "atf-formal");
}

/** 検証記録ファイル(1 行 1 検証コマンドの JSONL) */
export function checksPath(repoPath: string): string {
  return join(formalDir(repoPath), "checks.jsonl");
}

/** 反例をもとに自動確定した仕様の記録ファイル(1 行 1 判断の JSONL) */
export function decisionsPath(repoPath: string): string {
  return join(formalDir(repoPath), "decisions.jsonl");
}

/**
 * 反例ナレーション(LLM が書く自然言語の説明)の置き場。
 * 非決定的な生成物なので weave の出力先(`docs/generated/`)とは分け、commit しない。
 */
export function narrationDir(repoPath: string): string {
  return join(formalDir(repoPath), "narration");
}

/** 解説ページの形式を決めるテンプレート(プロジェクトで差し替えられる) */
export const EXPLAIN_TEMPLATE_FILE = "explain-template.html";

/** ルートモジュールのファイル名(`@title` / `@scope` / `@out-of-scope` / `@stakeholder` を持つ) */
export const ROOT_MODEL = "main.als";

/** doc comment のタグ語彙(strategy §3.2 + atf の拡張 @tradeoff) */
export const SPEC_TAGS = [
  "title",
  "scope",
  "out-of-scope",
  "stakeholder",
  "tradeoff",
  "module",
  "term",
  "rationale",
  "relaxed",
  "req",
  "validation",
  "adr",
  "actor",
  "usecase",
] as const;

/** ルートモジュールに必須のタグ(欠けていたら lint が落とす) */
export const ROOT_REQUIRED_TAGS = ["title", "scope", "out-of-scope", "stakeholder"] as const;

/** doc comment から、そのタグの値をすべて取り出す(書かれた順) */
export function tagValues(doc: SpecDoc | undefined, name: string): string[] {
  return (doc?.tags ?? []).filter((t) => t.name === name).map((t) => t.value);
}

/** doc comment から、そのタグの最初の値を取り出す */
export function tagValue(doc: SpecDoc | undefined, name: string): string | undefined {
  return tagValues(doc, name)[0];
}

/**
 * doc comment の中身(`/**` と閉じ記号を除いた行)を、散文とタグに分解する。
 *
 * - 各行の先頭の `*` と空白は落とす
 * - `@tag 値` でタグが始まり、次のタグまでの継続行は値に連結する
 * - タグより前の行はタグの付かない散文(宣言の説明)になる
 */
export function parseDocComment(lines: string[]): SpecDoc {
  const prose: string[] = [];
  const tags: SpecTag[] = [];
  let current: SpecTag | undefined;

  for (const raw of lines) {
    const line = raw.replace(/^\s*\*\s?/, "").trimEnd();
    const tag = line.trim().match(/^@([\w-]+)\s*(.*)$/);
    if (tag) {
      current = { name: tag[1].toLowerCase(), value: tag[2].trim() };
      tags.push(current);
      continue;
    }
    const text = line.trim();
    if (current) {
      // 継続行(タグの値の折り返し)。空行が来たらタグは終わりとみなす
      if (text === "") current = undefined;
      else current.value = current.value === "" ? text : `${current.value} ${text}`;
      continue;
    }
    if (text !== "" || prose.length > 0) prose.push(text);
  }

  // 末尾の空行は落とす(散文の段落だけを残す)
  while (prose.length > 0 && prose[prose.length - 1] === "") prose.pop();
  return { prose, tags };
}

/** 宣言の先頭行から種類と名前を読む */
function declarationHead(line: string): { kind: SpecDeclKind; name: string; rest: string } {
  const module = line.match(/^module\s+([\w/$'".-]+)/);
  if (module) return { kind: "module", name: module[1].replace(/["']/g, ""), rest: "" };
  if (/^open\s/.test(line)) return { kind: "open", name: line.replace(/^open\s+/, "").trim(), rest: "" };

  const sig = line.match(/^(?:(?:abstract|one|lone|some|var|private)\s+)*sig\s+([A-Za-z_][\w']*)/);
  if (sig) return { kind: "sig", name: sig[1], rest: "" };

  const named = line.match(/^(fact|pred|assert|fun|check|run)\s+([A-Za-z_][\w']*)\s*(.*)$/);
  if (named) {
    return { kind: named[1] as SpecDeclKind, name: named[2], rest: named[3].trim() };
  }
  const anonymous = line.match(/^(fact|pred|assert|fun|check|run)\b\s*(.*)$/);
  if (anonymous) return { kind: anonymous[1] as SpecDeclKind, name: "", rest: anonymous[2].trim() };

  return { kind: "other", name: "", rest: "" };
}

/** 行の波括弧の増減(文字列リテラル内は数えない) */
function braceDelta(line: string): number {
  let delta = 0;
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inString = !inString;
    else if (!inString && c === "{") delta++;
    else if (!inString && c === "}") delta--;
  }
  return delta;
}

/**
 * `.als` のソースを「doc comment + 直後の宣言」の単位に切り出す。
 *
 * doc comment(`/**` で始まるブロックコメント)だけを注釈として扱い、
 * 行コメント(`--` / `//`)は読み飛ばす(仕様の情報は doc comment に集める規約のため)。
 */
function parseDeclarations(source: string): SpecDeclaration[] {
  const lines = source.split("\n");
  const declarations: SpecDeclaration[] = [];
  let pending: SpecDoc | undefined;
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (trimmed === "") {
      i++;
      continue;
    }

    // doc comment(/** ... */)
    if (trimmed.startsWith("/**")) {
      const body: string[] = [];
      let line = lines[i].replace(/^\s*\/\*\*/, "");
      let closed = false;
      while (true) {
        const end = line.indexOf("*/");
        if (end >= 0) {
          body.push(line.slice(0, end));
          closed = true;
          break;
        }
        body.push(line);
        i++;
        if (i >= lines.length) break;
        line = lines[i];
      }
      if (closed) i++;
      pending = parseDocComment(body);
      continue;
    }

    // 通常のブロックコメント(注釈としては扱わない)
    if (trimmed.startsWith("/*")) {
      while (i < lines.length && !lines[i].includes("*/")) i++;
      i++;
      continue;
    }

    // 行コメント
    if (trimmed.startsWith("--") || trimmed.startsWith("//")) {
      i++;
      continue;
    }

    // ここからが宣言。波括弧が閉じるまでを 1 つの宣言として集める
    const start = i;
    const head = declarationHead(trimmed);
    const code: string[] = [];
    let depth = 0;
    let opened = false;
    while (i < lines.length) {
      const line = lines[i];
      code.push(line.replace(/\s+$/, ""));
      depth += braceDelta(line);
      if (depth > 0) opened = true;
      i++;
      if (opened && depth <= 0) break;
      if (!opened && depth === 0) break;
    }

    declarations.push({
      kind: head.kind,
      name: head.name,
      signature: trimmed.replace(/\s*\{.*$/, "").trim(),
      code: code.join("\n").replace(/^\n+|\n+$/g, ""),
      ...(pending ? { doc: pending } : {}),
      line: start + 1,
    });
    pending = undefined;
  }

  return declarations;
}

/** `@req R-014  要件の文` を ID と文に分ける */
function parseReqTag(value: string): { id: string; text: string } {
  const match = value.match(/^(\S+)\s*(.*)$/);
  return { id: match?.[1] ?? value.trim(), text: (match?.[2] ?? "").trim() };
}

/**
 * `.als` のソースを SpecModel(モジュール・宣言・要件・検証コマンド)に読み下す。
 *
 * 要件は doc comment の `@req <ID> <文>` から集める。同じ ID が複数の宣言に
 * 付いていてよい(要件と、それを機械検証する `check` を結ぶのがトレーサビリティの本体)。
 * 要件の文を書けるのは 1 か所だけで、重複は `atf lint` が検出する。
 */
export function parseSpecModel(file: string, source: string): SpecModel {
  const declarations = parseDeclarations(source);
  const moduleDecl = declarations.find((d) => d.kind === "module");
  const requirements: SpecRequirement[] = [];
  const commands: SpecCommand[] = [];

  for (const decl of declarations) {
    for (const value of tagValues(decl.doc, "req")) {
      const { id, text } = parseReqTag(value);
      if (id === "") continue;
      const existing = requirements.find((r) => r.id === id);
      if (existing) {
        const name = decl.name || decl.kind;
        // 同じ名前の assert と check は 1 つの宣言として数える(表が読みにくくなるため)
        if (!existing.declarations.includes(name)) existing.declarations.push(name);
        if (existing.text === "" && text !== "") existing.text = text;
      } else {
        requirements.push({
          id,
          text,
          declarations: [decl.name || decl.kind],
          line: decl.line,
        });
      }
    }

    if (decl.kind !== "check" && decl.kind !== "run") continue;
    const scope = decl.code
      .split("\n")[0]
      .replace(/^(check|run)\s+[A-Za-z_][\w']*\s*/, "")
      .trim();
    commands.push({
      kind: decl.kind,
      name: decl.name,
      ...(scope ? { scope } : {}),
      requirements: tagValues(decl.doc, "req").map((v) => parseReqTag(v).id),
      ...(tagValue(decl.doc, "validation") ? { validation: tagValue(decl.doc, "validation") } : {}),
      line: decl.line,
    });
  }

  return {
    file,
    module: moduleDecl?.name || file.replace(/\.als$/, ""),
    ...(moduleDecl?.doc ? { doc: moduleDecl.doc } : {}),
    declarations,
    requirements,
    commands,
  };
}

/** 型の式から関係の相手(最初に出てくる sig らしい識別子)を取り出す */
function relationTarget(expression: string): string {
  const match = expression.match(/[A-Za-z_][\w']*/g) ?? [];
  const keywords = new Set([
    "one",
    "lone",
    "some",
    "set",
    "seq",
    "disj",
    "var",
    "univ",
    "none",
    "iden",
  ]);
  return match.find((m) => !keywords.has(m)) ?? expression.trim();
}

/**
 * sig の本体(波括弧の中)をフィールドに分解する。
 *
 * - `a, b: one C` のようなまとめ書きは 1 件ずつに展開する
 * - フィールドの直上の doc comment(`/** @term ... *␠/`)を拾う(用語集の入力)
 */
function parseSigFields(body: string): SpecField[] {
  // 本体を「doc comment」と「カンマ区切りの断片」に切り分ける。
  // `x, y: one B` のように、型を持たない断片は次の断片に合流する名前として扱う
  const segments: { doc?: SpecDoc; text: string }[] = [];
  let pending: SpecDoc | undefined;
  let buffer = "";
  let depth = 0;

  const push = () => {
    const text = buffer.trim();
    buffer = "";
    if (text === "") return;
    segments.push({ ...(pending ? { doc: pending } : {}), text });
    pending = undefined;
  };

  for (let i = 0; i < body.length; i++) {
    if (body.startsWith("/**", i)) {
      const end = body.indexOf("*/", i + 3);
      const raw = body.slice(i + 3, end < 0 ? body.length : end);
      pending = parseDocComment(raw.split("\n"));
      i = (end < 0 ? body.length : end + 1);
      continue;
    }
    const c = body[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    if (c === "," && depth === 0) {
      push();
      continue;
    }
    buffer += c;
  }
  push();

  const fields: SpecField[] = [];
  // 型を持たない断片(まとめ書きの前半)を貯めておき、型が現れたところで展開する
  let names: { name: string; doc?: SpecDoc }[] = [];
  for (const segment of segments) {
    const text = segment.text.replace(/\s+/g, " ").trim();
    if (text === "" || text.startsWith("--") || text.startsWith("//")) continue;
    const match = text.match(/^([^:]+):\s*(.+)$/);
    const name = (match?.[1] ?? text).trim().replace(/^(disj|var)\s+/, "");
    if (!match) {
      if (/^[A-Za-z_][\w']*$/.test(name)) names.push({ name, ...(segment.doc ? { doc: segment.doc } : {}) });
      continue;
    }
    names.push({ name, ...(segment.doc ? { doc: segment.doc } : {}) });
    const expression = match[2].trim();
    const multiplicity = expression.match(/^(one|lone|some|set)\b/)?.[1];
    const target = relationTarget(expression.replace(/^(one|lone|some|set)\s+/, ""));
    for (const entry of names) {
      if (!/^[A-Za-z_][\w']*$/.test(entry.name)) continue;
      fields.push({
        name: entry.name,
        ...(multiplicity ? { multiplicity } : {}),
        target,
        expression,
        ...(entry.doc ? { doc: entry.doc } : {}),
      });
    }
    names = [];
  }
  return fields;
}

/**
 * モデルの sig 宣言を、関係性グラフ・用語集の入力に読み下す。
 * `one sig Pending, Shipped extends State {}` のようなまとめ書きは 1 件ずつに展開する。
 */
export function specSigs(model: SpecModel): SpecSig[] {
  const sigs: SpecSig[] = [];
  for (const decl of model.declarations) {
    if (decl.kind !== "sig") continue;
    const header = decl.code.split("{")[0];
    const match = header.match(
      /^((?:(?:abstract|one|lone|some|var|private)\s+)*)sig\s+([^{]+?)(?:\s+(extends|in)\s+([A-Za-z_][\w']*))?\s*$/,
    );
    if (!match) continue;
    const modifiers = match[1].trim().split(/\s+/).filter(Boolean);
    const names = match[2].split(",").map((n) => n.trim()).filter(Boolean);
    const open = decl.code.indexOf("{");
    const close = decl.code.lastIndexOf("}");
    const body = open >= 0 && close > open ? decl.code.slice(open + 1, close) : "";
    const fields = parseSigFields(body);
    for (const name of names) {
      if (!/^[A-Za-z_][\w']*$/.test(name)) continue;
      sigs.push({
        name,
        ...(modifiers.includes("abstract") ? { abstract: true } : {}),
        ...(modifiers.find((m) => m === "one" || m === "lone" || m === "some")
          ? { multiplicity: modifiers.find((m) => m === "one" || m === "lone" || m === "some") }
          : {}),
        ...(match[4] ? { parent: match[4], parentKind: match[3] as "extends" | "in" } : {}),
        fields,
        ...(decl.doc ? { doc: decl.doc } : {}),
      });
    }
  }
  return sigs;
}

/**
 * ユースケース図の入力(`@actor` / `@usecase`)を取り出す。
 *
 * Alloy の言語には「誰が使うか」を書く場所がないため、doc comment のタグを情報源にする。
 *
 * - `@actor <名前> <説明>` — アクターの定義(どの宣言に書いてもよい。sig の doc comment が自然)
 * - `@usecase <アクター> <ユースケース名>` — 振る舞いの宣言(pred / run / assert など)に書く
 *
 * `@usecase` のアクターが `@actor` で定義されていない場合も**捨てずに**アクターとして返す
 * (図から消えるより、未定義として見えたほうがよい。`atf lint` が警告する)。
 */
export function specUseCases(model: SpecModel): { actors: SpecActor[]; useCases: SpecUseCase[] } {
  const actors: SpecActor[] = [];
  const byName = new Map<string, SpecActor>();
  const useCases: SpecUseCase[] = [];

  const addActor = (name: string, actor: SpecActor): void => {
    const known = byName.get(name);
    if (known) {
      // 説明つきの定義が後から来たら補う(参照が先に現れる場合があるため)
      if (!known.description && actor.description) known.description = actor.description;
      if (!known.declaration && actor.declaration) known.declaration = actor.declaration;
      return;
    }
    byName.set(name, actor);
    actors.push(actor);
  };

  for (const decl of model.declarations) {
    for (const value of tagValues(decl.doc, "actor")) {
      const [name, ...rest] = value.split(/\s+/);
      if (!name) continue;
      addActor(name, {
        name,
        ...(rest.length > 0 ? { description: rest.join(" ") } : {}),
        ...(decl.name ? { declaration: decl.name } : {}),
      });
    }
  }

  for (const decl of model.declarations) {
    const requirements = tagValues(decl.doc, "req").map((v) => v.split(/\s+/)[0]).filter(Boolean);
    for (const value of tagValues(decl.doc, "usecase")) {
      const [actor, ...rest] = value.split(/\s+/);
      if (!actor) continue;
      const name = rest.join(" ").trim();
      // 1 語だけなら「アクター未設定のユースケース名」とみなす(誤って名前だけ書いた場合を拾う)
      if (name === "") {
        useCases.push({ name: actor, declaration: decl.name, kind: decl.kind, requirements });
        continue;
      }
      addActor(actor, { name: actor });
      useCases.push({ actor, name, declaration: decl.name, kind: decl.kind, requirements });
    }
  }

  return { actors, useCases };
}

/** spec/*.als を読み込む(なければ空) */
export function loadSpecModels(repoPath: string): SpecModel[] {
  const dir = specDir(repoPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".als"))
    .sort()
    .map((f) => parseSpecModel(f, readFileSync(join(dir, f), "utf8")));
}

/**
 * 旧レイアウト(`.claude/atf-specs/`)を、いまの置き場に移す。
 *
 * 形式仕様を SSOT にする前は、`.als`・検証記録・解説ページを 1 つのディレクトリに
 * まとめて置いていた。いまは「手で書くもの(`spec/`)」「記録(`.claude/atf-formal/`)」
 * 「生成物(`docs/generated/`)」で置き場を分けるため、見つけたら移す。
 *
 * **中身の書式は変換しない**(行コメント `-- REQ-01:` → doc comment の移行は
 * 意味の対応付けが要るので人の仕事)。移したあと `atf lint` が書式の違反を報告する。
 *
 * @returns moved = 移したファイル / remaining = atf が知らないため残したファイル
 */
export function migrateLegacySpecs(repoPath: string): { moved: string[]; remaining: string[] } {
  const legacy = join(repoPath, ".claude", "atf-specs");
  const moved: string[] = [];
  const remaining: string[] = [];
  if (!existsSync(legacy)) return { moved, remaining };

  /** 移動先が空いていれば移す(既にあるものは触らない = 新しい方を正とする) */
  const relocate = (file: string, destDir: string) => {
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, file);
    if (existsSync(dest)) {
      remaining.push(file);
      return;
    }
    renameSync(join(legacy, file), dest);
    moved.push(`${file} → ${dest}`);
  };

  for (const entry of readdirSync(legacy, { withFileTypes: true })) {
    const name = entry.name;
    // 生成物は作り直せるので捨てる(古い解説ページを残さない)
    if (name.endsWith(".explain.html") || name === ".alloy-out") {
      rmSync(join(legacy, name), { recursive: true, force: true });
      continue;
    }
    // 書式ガイドは atf が配り直す
    if (name === "README.md") {
      rmSync(join(legacy, name));
      continue;
    }
    if (name.endsWith(".als") || name === "run-alloy.sh") {
      relocate(name, specDir(repoPath));
      continue;
    }
    if (name === "checks.jsonl" || name === "decisions.jsonl" || name === EXPLAIN_TEMPLATE_FILE) {
      relocate(name, formalDir(repoPath));
      continue;
    }
    // atf が知らないもの(エージェントが書いた traceability.md など)は勝手に消さない
    remaining.push(name);
  }

  // 空になったら旧ディレクトリごと片付ける(情報源を 2 つ残さない)
  if (readdirSync(legacy).length === 0) rmSync(legacy, { recursive: true, force: true });
  return { moved, remaining };
}

/**
 * 旧レイアウトに残っているファイル(atf status の点検に使う)。
 * 移行は `migrateLegacySpecs` が済ませるので、ここに残るのは
 * **atf が移し先を判断できないもの**(エージェントが書いた文書など)だけ。
 */
export function legacySpecLeftovers(repoPath: string): string[] {
  const legacy = join(repoPath, ".claude", "atf-specs");
  if (!existsSync(legacy)) return [];
  return readdirSync(legacy).sort();
}

/** ルートモジュール(main.als)のモデル。なければ undefined */
export function rootModel(models: SpecModel[]): SpecModel | undefined {
  return models.find((m) => m.file === ROOT_MODEL);
}

/** .claude/atf-formal/checks.jsonl の検証記録を読む(壊れた行は無視。なければ空) */
export function loadSpecChecks(repoPath: string): SpecCheckRecord[] {
  const path = checksPath(repoPath);
  if (!existsSync(path)) return [];
  const checks: SpecCheckRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      checks.push(JSON.parse(trimmed));
    } catch {
      // エージェントの自己申告も混ざるため、壊れた行は寛容に無視する
    }
  }
  return checks;
}

/** 検証記録を追記する(ディレクトリがなければ作成) */
export function appendSpecChecks(repoPath: string, records: SpecCheckRecord[]): void {
  if (records.length === 0) return;
  mkdirSync(formalDir(repoPath), { recursive: true });
  appendFileSync(
    checksPath(repoPath),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

/**
 * decisions.jsonl(反例から自動確定した仕様の記録)を読む(壊れた行は無視。なければ空)。
 * 書くのは spec-formalizer で、atf は読んで可視化・点検するだけ。
 */
export function loadSpecDecisions(repoPath: string): SpecDecisionRecord[] {
  const path = decisionsPath(repoPath);
  if (!existsSync(path)) return [];
  const decisions: SpecDecisionRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as SpecDecisionRecord;
      // 要件 ID と採用した仕様がない行は判断の記録として読めないため落とす
      if (parsed && typeof parsed.requirement === "string" && typeof parsed.decision === "string") {
        decisions.push(parsed);
      }
    } catch {
      // エージェントの自己申告が混ざるため、壊れた行は寛容に無視する
    }
  }
  return decisions;
}

/** ユーザーがまだ確認していない自動確定(status が auto、または未記載)だけを返す */
export function unconfirmedDecisions(decisions: SpecDecisionRecord[]): SpecDecisionRecord[] {
  return decisions.filter((d) => (d.status ?? "auto") === "auto");
}

/** そのモデル・コマンドの最新の検証記録(後の行が勝ち。なければ undefined) */
export function latestSpecCheck(
  checks: SpecCheckRecord[],
  model: string,
  command: string,
): SpecCheckRecord | undefined {
  return checks.filter((c) => c.model === model && c.command === command).slice(-1)[0];
}

/** 実装前ゲートの集計結果(単一情報源。CLI・ダッシュボード・解説 HTML・atf status で共用する) */
export interface SpecGateStatus {
  /** 充足しているコマンド数(check は反例なし / run はインスタンスあり) */
  satisfied: number;
  /** 未充足・実行エラーのコマンド数 */
  unsatisfied: number;
  /** まだ検証記録がないコマンド数 */
  unchecked: number;
  /** ゲートの状態: pass = 全部充足 / fail = 未充足あり / pending = 未検証あり(モデルなしも pending) */
  state: "pass" | "fail" | "pending";
}

/** モデルの check / run と検証記録を突き合わせ、実装前ゲートの状況を集計する */
export function specGateStatus(models: SpecModel[], checks: SpecCheckRecord[]): SpecGateStatus {
  let satisfied = 0;
  let unsatisfied = 0;
  let unchecked = 0;
  for (const model of models) {
    for (const command of model.commands) {
      const latest = latestSpecCheck(checks, model.file, command.name);
      if (!latest) unchecked++;
      else if (isSatisfied(latest.result)) satisfied++;
      else unsatisfied++;
    }
  }
  const state =
    unsatisfied > 0
      ? "fail"
      : unchecked > 0 || satisfied === 0
        ? "pending"
        : "pass";
  return { satisfied, unsatisfied, unchecked, state };
}

/** 形式仕様の状態(モデル・検証記録・自動確定の記録)をまとめて読む(ダッシュボード・点検の共通入力) */
export function loadSpecState(repoPath: string): {
  models: SpecModel[];
  checks: SpecCheckRecord[];
  decisions: SpecDecisionRecord[];
} {
  return {
    models: loadSpecModels(repoPath),
    checks: loadSpecChecks(repoPath),
    decisions: loadSpecDecisions(repoPath),
  };
}

/** 検証結果が「設計として満たされている」と言えるか(充足: check は反例なし / run はインスタンスあり) */
export function isSatisfied(result: SpecResult): boolean {
  return result === "pass" || result === "instance";
}

/** 結果 → 表示用ラベル(CLI・ダッシュボードで共通に使う) */
export const SPEC_RESULT_LABEL: Record<SpecResult, string> = {
  pass: "✅ 反例なし(表明は成立)",
  instance: "✅ 充足(インスタンスあり)",
  counterexample: "❌ 反例あり(設計の欠陥)",
  "no-instance": "❌ 充足不能(制約が矛盾)",
  error: "⚠️ 実行エラー",
  unknown: "❓ 判定不能",
};

/**
 * Alloy CLI(`java -jar alloy.jar exec model.als`)の出力を、コマンド単位の結果に分解する。
 *
 * Alloy 6 の CLI は 1 コマンド 1 行の表を出力する(充足性は SAT / UNSAT で表される):
 * ```
 * 00. check CancelledIsNeverShipped     0       UNSAT
 * 01. run   Consistent               0    1/1     SAT
 * ```
 * - `check` の UNSAT = 反例が見つからない(表明はスコープ内で成立)/ SAT = 反例あり
 * - `run` の SAT = インスタンスあり(充足可能)/ UNSAT = インスタンスなし(制約が矛盾)
 *
 * 旧来の文章形式(`No counterexample found. Assertion may be valid.`)の出力も解釈できるようにしている。
 * 構文エラーは終了コード 1 とエラーメッセージで表れるため、最初の 1 件だけを error として記録する。
 */
export function parseAlloyOutput(output: string): {
  command: string;
  kind: "check" | "run" | "unknown";
  result: SpecResult;
  detail: string;
}[] {
  const results: { command: string; kind: "check" | "run" | "unknown"; result: SpecResult; detail: string }[] = [];
  // 文章形式のフォールバック用(`Executing "Check Foo for 5"` で始まるブロック)
  let current: { command: string; kind: "check" | "run" | "unknown" } | undefined;
  let errorRecorded = false;

  const push = (
    cmd: { command: string; kind: "check" | "run" | "unknown" },
    result: SpecResult,
    detail: string,
  ) => {
    results.push({ ...cmd, result, detail: detail.trim() });
  };

  for (const raw of output.split("\n")) {
    // Alloy は進捗表示にバックスペース・ANSI エスケープを混ぜるため、記録前に取り除く
    const line = raw
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
      .replace(/[\b\r]/g, "")
      .trim();
    if (!line) continue;

    // 表形式: "00. check Foo   0   1/1   SAT"
    const row = line.match(/^\d+\.\s+(check|run)\s+(\S+)\s+.*?\b(SAT|UNSAT)\s*$/i);
    if (row) {
      const kind = row[1].toLowerCase() as "check" | "run";
      const sat = row[3].toUpperCase() === "SAT";
      const result: SpecResult =
        kind === "check" ? (sat ? "counterexample" : "pass") : sat ? "instance" : "no-instance";
      push({ command: row[2], kind }, result, line);
      continue;
    }

    // 文章形式: コマンドの開始行
    const exec = line.match(/^Executing\s+"(Check|Run)\s+([^"]+)"/i);
    if (exec) {
      if (current) push(current, "unknown", "結論行が出力されませんでした");
      const kind = exec[1].toLowerCase() === "check" ? "check" : "run";
      current = { command: exec[2].trim().split(/\s+for\s+/)[0].trim(), kind };
      continue;
    }
    if (current) {
      if (/No counterexample found/i.test(line)) {
        push(current, "pass", line);
        current = undefined;
        continue;
      }
      if (/Counterexample found/i.test(line)) {
        push(current, "counterexample", line);
        current = undefined;
        continue;
      }
      if (/No instance found/i.test(line)) {
        push(current, "no-instance", line);
        current = undefined;
        continue;
      }
      if (/Instance found/i.test(line)) {
        push(current, "instance", line);
        current = undefined;
        continue;
      }
    }

    // 構文エラー・型エラー(スタックトレースで繰り返されるため最初の 1 件のみ記録する)
    if (!errorRecorded && /(Syntax error|Type error|Fatal error|ERROR alloy)/i.test(line)) {
      errorRecorded = true;
      push({ command: "(構文・型エラー)", kind: "unknown" }, "error", line);
    }
  }
  if (current) push(current, "unknown", "結論行が出力されませんでした");
  return results;
}

/** Alloy の jar を探す順序(環境変数 ALLOY_JAR が最優先) */
export function resolveAlloyJar(repoPath: string): string | undefined {
  const candidates = [
    process.env.ALLOY_JAR,
    join(repoPath, "tools", "alloy.jar"),
    join(repoPath, "alloy.jar"),
    join(homedir(), ".atf", "alloy.jar"),
    join(homedir(), "alloy.jar"),
  ].filter((c): c is string => Boolean(c));
  return candidates.find((c) => existsSync(c));
}

/** jar が見つからないときに CLI・エージェントへ出す案内 */
export const ALLOY_JAR_HELP = `Alloy の jar が見つかりません。次のいずれかを用意してください:
  - 環境変数 ALLOY_JAR に jar のパスを設定する
  - <project-dir>/tools/alloy.jar または ~/.atf/alloy.jar に配置する
jar は https://github.com/AlloyTools/org.alloytools.alloy/releases から入手できます
(org.alloytools.alloy.dist.jar。java 17 以上が必要)。`;

export interface VerifyModelResult {
  model: string;
  /** Alloy を起動できたか(java や jar がない場合は false) */
  executed: boolean;
  checks: SpecCheckRecord[];
  /** 起動できなかった・出力を解釈できなかった場合の生の出力 */
  output: string;
}

export interface VerifyReport {
  jar?: string;
  results: VerifyModelResult[];
  /** すべての検証コマンドが充足していたか(モデルが 1 件もない場合は false) */
  satisfied: boolean;
}

/**
 * spec/*.als を Alloy CLI で検証し、結果を .claude/atf-formal/checks.jsonl に追記する。
 * 実装着手前のゲート(atf formal)として使う。
 * @param now 検証時刻(ISO 8601)。テストから固定値を渡せるようにしている
 */
export function verifySpecs(
  repoPath: string,
  opts: { now?: string; agent?: string; jar?: string } = {},
): VerifyReport {
  const models = loadSpecModels(repoPath);
  const jar = opts.jar ?? resolveAlloyJar(repoPath);
  const checkedAt = opts.now ?? new Date().toISOString();
  const agent = opts.agent ?? "atf formal";
  const results: VerifyModelResult[] = [];

  for (const model of models) {
    const file = join(specDir(repoPath), model.file);
    if (!jar) {
      results.push({ model: model.file, executed: false, checks: [], output: ALLOY_JAR_HELP });
      continue;
    }
    // exec はソリューション(反例のインスタンスなど)をディレクトリに書き出す。
    // 指定しないと実行時のカレントディレクトリを汚すため、必ず .alloy-out 配下に出す
    const outDir = join(specDir(repoPath), ".alloy-out", model.file.replace(/\.als$/, ""));
    const proc = spawnSync("java", ["-jar", jar, "exec", "-f", "-o", outDir, file], {
      encoding: "utf8",
    });
    const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
    if (proc.error) {
      results.push({
        model: model.file,
        executed: false,
        checks: [],
        output: `java を起動できませんでした: ${proc.error.message}`,
      });
      continue;
    }
    const parsed = parseAlloyOutput(output);
    const checks: SpecCheckRecord[] = parsed.map((p) => ({
      model: model.file,
      command: p.command,
      kind: p.kind,
      result: p.result,
      detail: p.detail,
      checkedAt,
      agent,
    }));
    // コマンドを 1 つも解釈できなかったが終了コードが異常なら、実行エラーとして記録する
    if (checks.length === 0 && proc.status !== 0) {
      checks.push({
        model: model.file,
        command: "(実行)",
        kind: "unknown",
        result: "error",
        detail: output.split("\n").filter(Boolean).slice(-1)[0] ?? `exit ${proc.status}`,
        checkedAt,
        agent,
      });
    }
    results.push({ model: model.file, executed: true, checks, output });
  }

  const allChecks = results.flatMap((r) => r.checks);
  appendSpecChecks(repoPath, allChecks);

  return {
    jar,
    results,
    satisfied:
      allChecks.length > 0 &&
      results.every((r) => r.executed) &&
      allChecks.every((c) => isSatisfied(c.result)),
  };
}
