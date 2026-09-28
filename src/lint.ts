import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { adrDir, loadAdrs } from "./adr.js";
import {
  loadSpecModels,
  rootModel,
  specDir,
  specUseCases,
  tagValue,
  tagValues,
  ROOT_MODEL,
  ROOT_REQUIRED_TAGS,
  SPEC_TAGS,
} from "./alloy.js";
import { generatedDir } from "./weave.js";
import type { AdrRecord } from "./adr.js";
import type { SpecModel } from "./types.js";

/**
 * 形式仕様の運用規約の機械検査(`atf lint`)。
 *
 * 規約は放っておくと必ず腐るため、人のレビューではなく CI で落とす。
 * ここで見るのは「SSOT が 1 つに保たれているか」だけで、仕様の中身の良し悪しは見ない:
 *
 * - ルートモジュールに必須タグ(`@title` / `@scope` / `@out-of-scope` / `@stakeholder`)があるか
 * - `@req` の重複・孤児(ADR の `Refs:` が指す先が `.als` にない)
 * - `@usecase` が参照するアクターに `@actor` の定義があるか(ユースケース図の入力)
 * - `check` に `@req` が付いているか(機械検証と業務要件を結ぶ線)
 * - 手書きの `.md` に規範文が混ざっていないか(= `.als` と内容領域が競合していないか)
 * - `.als` に履歴(過去形)が混ざっていないか / ADR に現行ルール(現在形)が混ざっていないか
 *
 * error が 1 件でもあれば `atf lint` は非ゼロで終わる。warn は落とさない。
 */

export type LintSeverity = "error" | "warn";

export interface LintFinding {
  /** 規則の id(表示・抑制の手がかり) */
  rule: string;
  severity: LintSeverity;
  /** リポジトリ相対のパス */
  file: string;
  /** 1 始まりの行番号(ファイル全体に対する指摘なら undefined) */
  line?: number;
  message: string;
  /** どう直すか */
  fix: string;
}

/** 規範的表現(手書き `.md` に現れたら SSOT 違反) */
const NORMATIVE_RE = /(なければならない|すること|してはならない|禁止する|\bMUST\b|\bSHALL\b)/;

/** 履歴の記述(`.als` に現れたら ADR 送り) */
const PAST_TENSE_RE = /(と決定した|と決めた|していた|だった|以前は|旧仕様|かつては)/;

/** `.md` を再帰的に集める */
function markdownFiles(dir: string, skip: string[]): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (skip.some((s) => path === s)) continue;
    if (statSync(path).isDirectory()) out.push(...markdownFiles(path, skip));
    else if (entry.endsWith(".md")) out.push(path);
  }
  return out;
}

/** ルートモジュールの必須タグ(§5.4) */
function lintRootTags(repoPath: string, models: SpecModel[]): LintFinding[] {
  const root = rootModel(models);
  if (!root) {
    return [
      {
        rule: "root-module",
        severity: "error",
        file: relative(repoPath, join(specDir(repoPath), ROOT_MODEL)),
        message: `ルートモジュール ${ROOT_MODEL} がありません`,
        fix: `spec/${ROOT_MODEL} を作り、@title / @scope / @out-of-scope / @stakeholder を持つ doc comment を module 宣言の直上に置く`,
      },
    ];
  }
  const decl = root.declarations.find((d) => d.kind === "module");
  const at = decl ? { line: decl.line } : {};
  const findings: LintFinding[] = [];

  for (const tag of ROOT_REQUIRED_TAGS) {
    const values = tagValues(root.doc, tag);
    if (values.length === 0) {
      findings.push({
        rule: "root-tags",
        severity: "error",
        file: `spec/${root.file}`,
        ...at,
        message: `ルートモジュールに @${tag} がありません`,
        fix: `module 宣言の直上の doc comment に @${tag} を書く`,
      });
      continue;
    }
    // 雛形のまま(TODO:)は「書いていない」のと同じ。何を作るかの合意がまだ無い状態
    if (values.every((v) => /^TODO\b/i.test(v))) {
      findings.push({
        rule: "root-tags",
        severity: "error",
        file: `spec/${root.file}`,
        ...at,
        message: `ルートモジュールの @${tag} が雛形(TODO)のままです`,
        fix: "spec-formalizer とユーザーで内容を確定する(ここが「何を作るか」の合意そのもの)",
      });
    }
  }

  // @tradeoff は必須ではないが、評価とトレードオフ判断の基準になるので促す
  const tradeoff = tagValue(root.doc, "tradeoff");
  if (tradeoff === undefined || /^TODO\b/i.test(tradeoff)) {
    findings.push({
      rule: "root-tradeoff",
      severity: "warn",
      file: `spec/${root.file}`,
      ...at,
      message: "ルートモジュールに @tradeoff(トレードオフ時の最優先)がありません",
      fix: "品質 / 期日 / スコープ / コストのどれを最優先するかを書く(評価とトレードオフ判断の基準になる)",
    });
  }
  return findings;
}

/** 未知のタグ(書き間違いを拾う) */
function lintUnknownTags(models: SpecModel[]): LintFinding[] {
  const known = new Set<string>(SPEC_TAGS);
  const findings: LintFinding[] = [];
  for (const model of models) {
    for (const decl of model.declarations) {
      for (const tag of decl.doc?.tags ?? []) {
        if (known.has(tag.name)) continue;
        findings.push({
          rule: "unknown-tag",
          severity: "warn",
          file: `spec/${model.file}`,
          line: decl.line,
          message: `未知のタグ @${tag.name}`,
          fix: `タグ語彙は ${[...known].map((t) => `@${t}`).join(" / ")}。散文として書くなら @ を外す`,
        });
      }
    }
  }
  return findings;
}

/**
 * `@req` の重複と、`check` の `@req` 欠落(§5.3)。
 *
 * 同じ要件 ID が複数の宣言に付くのは正しい(要件と、それを検証する `check` を結ぶ)。
 * 落とすのは「要件の文を 2 か所以上で定義している」場合で、
 * 文の置き場が 1 つに定まらないと SSOT が割れるため。
 */
function lintRequirements(models: SpecModel[]): LintFinding[] {
  const findings: LintFinding[] = [];
  const defined = new Map<string, { file: string; line: number; text: string }[]>();

  for (const model of models) {
    // 要件の文は「宣言ごと」に数える(同じモデル内の重複も見逃さないため、
    // モデル単位にまとめた model.requirements ではなく宣言の @req を直接見る)
    for (const decl of model.declarations) {
      for (const value of tagValues(decl.doc, "req")) {
        const text = value.replace(/^\S+\s*/, "").trim();
        if (text === "") continue;
        const id = value.split(/\s+/)[0];
        defined.set(id, [
          ...(defined.get(id) ?? []),
          { file: `spec/${model.file}`, line: decl.line, text },
        ]);
      }
    }
    for (const command of model.commands) {
      if (command.name === "") {
        findings.push({
          rule: "command-unnamed",
          severity: "error",
          file: `spec/${model.file}`,
          line: command.line,
          message: `無名の ${command.kind} コマンドがあります`,
          fix: "名前を付ける(無名コマンドは検証記録とトレーサビリティに残せない)",
        });
        continue;
      }
      if (command.kind === "check" && command.requirements.length === 0) {
        findings.push({
          rule: "check-req",
          severity: "error",
          file: `spec/${model.file}`,
          line: command.line,
          message: `check ${command.name} に @req がありません`,
          fix: "この検証が何の業務要件の証拠なのかを @req <ID> で書く",
        });
      }
    }
  }

  for (const [id, places] of [...defined.entries()].sort()) {
    if (places.length < 2) continue;
    findings.push({
      rule: "req-duplicate",
      severity: "error",
      file: places[1].file,
      line: places[1].line,
      message: `要件 ${id} の文が ${places.length} か所で定義されています(${places.map((p) => `${p.file}:${p.line}`).join(", ")})`,
      fix: "要件の文を書くのは 1 か所だけにし、他の宣言からは @req <ID> と ID だけで参照する",
    });
  }
  return findings;
}

/**
 * ユースケース図のタグ(`@actor` / `@usecase`)の書き方。
 *
 * 図に描く「誰が何をするか」は doc comment だけが情報源なので、
 * 参照しているアクターが定義されていない・アクターを書き忘れている、を拾う。
 * 図そのものは描けるため警告にとどめる(仕様の正しさは落とさない)。
 */
function lintUseCases(models: SpecModel[]): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const model of models) {
    const { actors, useCases } = specUseCases(model);
    const defined = new Set(
      actors.filter((a) => a.declaration !== undefined).map((a) => a.name),
    );
    const lineOf = new Map(model.declarations.map((d) => [d.name, d.line]));
    for (const uc of useCases) {
      const at = lineOf.get(uc.declaration);
      if (uc.actor === undefined) {
        findings.push({
          rule: "usecase-actor",
          severity: "warn",
          file: `spec/${model.file}`,
          ...(at ? { line: at } : {}),
          message: `@usecase ${uc.name} にアクターがありません`,
          fix: "`@usecase <アクター> <ユースケース名>` の形で、先頭にアクター名を書く",
        });
        continue;
      }
      if (defined.has(uc.actor)) continue;
      findings.push({
        rule: "usecase-actor",
        severity: "warn",
        file: `spec/${model.file}`,
        ...(at ? { line: at } : {}),
        message: `@usecase が参照するアクター ${uc.actor} に @actor の定義がありません`,
        fix: `どこかの宣言の doc comment に \`@actor ${uc.actor} <説明>\` を書く(sig の doc comment が自然)`,
      });
    }
  }
  return findings;
}

/** ADR の孤児参照・存在しない supersede 先(§5.3) */
function lintAdrRefs(models: SpecModel[], adrs: AdrRecord[]): LintFinding[] {
  const ids = new Set(models.flatMap((m) => m.requirements.map((r) => r.id)));
  const adrIds = new Set(adrs.map((a) => a.id));
  const findings: LintFinding[] = [];

  for (const adr of adrs) {
    for (const ref of adr.refs) {
      if (ids.has(ref)) continue;
      findings.push({
        rule: "adr-orphan",
        severity: "error",
        file: `docs/adr/${adr.file}`,
        message: `Refs: の ${ref} に対応する @req が spec/*.als にありません`,
        fix: "要件 ID を直すか、対応する宣言に @req <ID> を付ける(要件が消えたなら ADR を supersede する)",
      });
    }
    if (adr.supersededBy && !adrIds.has(adr.supersededBy)) {
      findings.push({
        rule: "adr-supersede",
        severity: "error",
        file: `docs/adr/${adr.file}`,
        message: `Status: superseded by ${adr.supersededBy} の参照先がありません`,
        fix: "置き換え先の ADR を作るか、参照先の番号を直す",
      });
    }
    if (adr.decision !== "" && NORMATIVE_RE.test(adr.decision)) {
      findings.push({
        rule: "adr-present-tense",
        severity: "warn",
        file: `docs/adr/${adr.file}`,
        message: "「## 決定」に現行ルール(規範文)が書かれています",
        fix: "ADR は過去形で「いつ・何を決めたか」だけを書く。現行ルールは spec/*.als を参照させる",
      });
    }
    if (!adr.date) {
      findings.push({
        rule: "adr-date",
        severity: "warn",
        file: `docs/adr/${adr.file}`,
        message: "Date: がありません",
        fix: "決定した日付(YYYY-MM-DD)を書く(履歴として読めるようにするため)",
      });
    }
  }
  return findings;
}

/**
 * 手書き `.md` の規範的表現(§5.2)。ADR(引用の都合がある)と生成物は対象外。
 *
 * リバースドキュメント(`docs/architecture/`)は「コードがこうなっている」を書く場所で、
 * 単一情報源はコードなので仕様とは競合しない。ただし規範文が混ざるのは書き方の乱れなので
 * 警告にとどめる(仕様を隠せる抜け穴にしないため、対象からは外さない)。
 */
function lintNormativeDocs(repoPath: string): LintFinding[] {
  const docs = join(repoPath, "docs");
  const files = markdownFiles(docs, [adrDir(repoPath), generatedDir(repoPath)]);
  const reverseDocs = join(repoPath, "docs", "architecture");
  const findings: LintFinding[] = [];

  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    const hit = lines.findIndex((l) => NORMATIVE_RE.test(l));
    if (hit < 0) continue;
    const descriptive = file.startsWith(`${reverseDocs}/`);
    findings.push({
      rule: "doc-normative",
      severity: descriptive ? "warn" : "error",
      file: relative(repoPath, file),
      line: hit + 1,
      message: `手書きの文書に規範文があります: ${lines[hit].trim().slice(0, 60)}`,
      fix: descriptive
        ? "リバースドキュメントは「コードがこうなっている」を書く場所。規範(こうあるべき)は spec/*.als へ"
        : "仕様は spec/*.als に書き、この文書は docs/generated/ への生成(atf weave)に置き換える。履歴なら docs/adr/ へ",
    });
  }
  return findings;
}

/** `.als` に混ざった履歴(§3.4) */
function lintSpecHistory(models: SpecModel[]): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const model of models) {
    for (const decl of model.declarations) {
      const text = [...(decl.doc?.prose ?? []), ...(decl.doc?.tags ?? []).map((t) => t.value)].join(
        "\n",
      );
      if (!PAST_TENSE_RE.test(text)) continue;
      findings.push({
        rule: "spec-history",
        severity: "warn",
        file: `spec/${model.file}`,
        line: decl.line,
        message: "doc comment に履歴(過去形の記述)が混ざっています",
        fix: "「なぜ現在この形なのか」だけを @rationale に残し、経緯・却下案は docs/adr/ に切り出す",
      });
    }
  }
  return findings;
}

/** 生成物が .gitignore されているか(§5.1) */
function lintGeneratedIgnored(repoPath: string): LintFinding[] {
  const path = join(repoPath, ".gitignore");
  const body = existsSync(path) ? readFileSync(path, "utf8") : "";
  const ignored = body
    .split("\n")
    .some((line) => line.trim().replace(/\/$/, "") === "docs/generated");
  if (ignored) return [];
  return [
    {
      rule: "generated-ignored",
      severity: "warn",
      file: ".gitignore",
      message: "docs/generated/(weave の出力)が .gitignore に入っていません",
      fix: "`docs/generated/` を .gitignore に追加する(人が編集する余地をなくすのがいちばん確実)",
    },
  ];
}

/** すべての検査をまとめて実行する(error が 1 件でもあれば CI を落とす) */
export function lintFormal(repoPath: string): LintFinding[] {
  const models = loadSpecModels(repoPath);
  const adrs = loadAdrs(repoPath);
  return [
    ...lintRootTags(repoPath, models),
    ...lintRequirements(models),
    ...lintUseCases(models),
    ...lintAdrRefs(models, adrs),
    ...lintNormativeDocs(repoPath),
    ...lintSpecHistory(models),
    ...lintUnknownTags(models),
    ...lintGeneratedIgnored(repoPath),
  ];
}

/** error が含まれるか(終了コードの判定) */
export function hasLintErrors(findings: LintFinding[]): boolean {
  return findings.some((f) => f.severity === "error");
}
