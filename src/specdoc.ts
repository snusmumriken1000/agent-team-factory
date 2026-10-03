import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formalDir,
  EXPLAIN_TEMPLATE_FILE,
  isSatisfied,
  latestSpecCheck,
  specGateStatus,
  specSigs,
  specUseCases,
  tagValue,
  tagValues,
  SPEC_RESULT_LABEL,
} from "./alloy.js";
import type {
  SpecActor,
  SpecUseCase,
  SpecCheckRecord,
  SpecDecisionRecord,
  SpecDeclaration,
  SpecModel,
  SpecSig,
} from "./types.js";

/**
 * Alloy モデル(.als)の解説ページ。
 *
 * `.als` の doc comment と宣言をテンプレート(templates/spec-explain.html)に差し込み、
 * `docs/generated/<モデル名>.explain.html` として出す**派生物**。書き出すのは weave(weave.ts)で、
 * ここは「テンプレートの読み込み」と「差し込み」だけを担う。
 *
 * 形式を変えたいときはテンプレートを編集する。プロジェクト内の
 * `.claude/atf-formal/explain-template.html` があればそれが優先されるため、
 * プロジェクトごとに形式を変えられる(atf 同梱のテンプレートが既定値)。
 *
 * 生成は決定的でなければならない(同じ入力なら常にバイト一致)。時刻など
 * 入力に無い値をページに入れないこと。
 */

/** 生成物の接尾辞(order.als → order.explain.html) */
const EXPLAIN_SUFFIX = ".explain.html";

// テンプレートのファイル名は置き場(alloy.ts)と対で決まるので、そちらを単一情報源にする
export { EXPLAIN_TEMPLATE_FILE };

/** atf 同梱のテンプレート(dist/ からも src/ からも見えるように 1 つ上の templates を参照する) */
function bundledExplainTemplatePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "spec-explain.html");
}

/** atf 同梱テンプレートの中身(プロジェクトに配る既定の形式) */
export function bundledExplainTemplate(): string {
  return readFileSync(bundledExplainTemplatePath(), "utf8");
}

/** プロジェクト側のテンプレートのパス(ユーザーが形式を変えるために編集するファイル) */
export function explainTemplatePath(repoPath: string): string {
  return join(formalDir(repoPath), EXPLAIN_TEMPLATE_FILE);
}

/** 解説ページのファイル名(order.als → order.explain.html) */
export function explainDocName(modelFile: string): string {
  return modelFile.replace(/\.als$/, "") + EXPLAIN_SUFFIX;
}

/** 使うテンプレート: プロジェクトの explain-template.html > atf 同梱 */
export function loadExplainTemplate(repoPath: string): string {
  const own = explainTemplatePath(repoPath);
  return existsSync(own) ? readFileSync(own, "utf8") : bundledExplainTemplate();
}

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** 状態ラベルの先頭に付く絵文字(ターミナル表示と共用のため、HTML では落とす) */
const STATUS_EMOJI = /^[^\p{L}\p{N}(]+/u;

/** 状態をチップで表示する(ダッシュボードと同じ見え方。絵文字は落として色で示す) */
const chip = (label: string, tone: "ok" | "ng" | "warn" | "idle" = "idle"): string =>
  `<span class="chip${tone === "idle" ? "" : ` chip-${tone}`}">${escapeHtml(
    label.replace(STATUS_EMOJI, "").trim(),
  )}</span>`;

/** 繰り返しの雛形(<!-- atf:block 名前 --> … <!-- /atf:block -->)を抜き出す正規表現 */
const BLOCK_RE = /[ \t]*<!--\s*atf:block\s+([\w-]+)\s*-->\r?\n?([\s\S]*?)<!--\s*\/atf:block\s*-->[ \t]*\r?\n?/g;

/**
 * テンプレート編集者向けの説明コメント(atf:doc)。
 * 生成物には出さない(読む人に関係がないため)。
 */
const DOC_COMMENT_RE = /<!--\s*atf:doc[\s\S]*?-->\s*/g;

export interface ExplainTemplate {
  /** 繰り返しの雛形を取り除いたページ本体 */
  shell: string;
  /** 名前 → 繰り返しの雛形 */
  blocks: Map<string, string>;
}

/** テンプレートをページ本体と繰り返しの雛形に分解する */
export function parseExplainTemplate(template: string): ExplainTemplate {
  const blocks = new Map<string, string>();
  const shell = template
    .replace(BLOCK_RE, (_all, name: string, body: string) => {
      blocks.set(name, body.replace(/\r?\n$/, ""));
      return "";
    })
    .replace(DOC_COMMENT_RE, "");
  return { shell, blocks };
}

/**
 * `{{名前}}` を差し込む。渡していない名前はそのまま残す
 * (テンプレートの書き間違いに気づけるようにするため、空文字で消さない)。
 */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (all, key: string) =>
    key in vars ? vars[key] : all,
  );
}

/** 繰り返しの雛形を項目ごとに複製する(0 件なら <名前>-empty の雛形を 1 度だけ使う) */
function repeat(
  tpl: ExplainTemplate,
  name: string,
  items: Record<string, string>[],
): string {
  const body = tpl.blocks.get(name);
  if (!body) return "";
  if (items.length === 0) return tpl.blocks.get(`${name}-empty`) ?? "";
  return items.map((item) => fill(body, item)).join("\n");
}

/** 検証結果 → チップの色(実行エラー・判定不能は違反と分けて警告色にする) */
const resultTone = (record: SpecCheckRecord): "ok" | "ng" | "warn" =>
  isSatisfied(record.result)
    ? "ok"
    : record.result === "error" || record.result === "unknown"
      ? "warn"
      : "ng";

/** Mermaid のノード ID として安全な文字列にする */
const nodeId = (name: string): string => `s_${name.replace(/[^\w]/g, "_")}`;

/** Mermaid のラベルに入れられる形にする(引用符と改行を落とす) */
const nodeLabel = (text: string): string => text.replace(/["\n]/g, " ").trim();

/**
 * sig とフィールドから関係性グラフ(Mermaid の flowchart)を組み立てる。
 *
 * - 実線の矢印 = フィールド(関係)。ラベルは「フィールド名: 多重度」
 * - 破線の矢印 = extends / in(種類の分類)
 * - モデルに定義がない相手(Int や未定義の名前)は薄い色のノードにする
 */
export function buildSpecGraph(sigs: SpecSig[]): string {
  if (sigs.length === 0) return "";
  const defined = new Set(sigs.map((s) => s.name));
  const lines = ["flowchart LR"];
  const external = new Set<string>();

  for (const sig of sigs) {
    const marks = [sig.abstract ? "abstract" : "", sig.multiplicity ?? ""].filter(Boolean);
    const label = marks.length > 0 ? `${sig.name}(${marks.join(" ")})` : sig.name;
    lines.push(`  ${nodeId(sig.name)}["${nodeLabel(label)}"]`);
  }
  for (const sig of sigs) {
    if (sig.parent) {
      if (!defined.has(sig.parent)) external.add(sig.parent);
      lines.push(
        `  ${nodeId(sig.name)} -.->|"${nodeLabel(sig.parentKind ?? "extends")}"| ${nodeId(sig.parent)}`,
      );
    }
    for (const field of sig.fields) {
      if (!defined.has(field.target)) external.add(field.target);
      const label = field.multiplicity ? `${field.name}: ${field.multiplicity}` : field.name;
      lines.push(`  ${nodeId(sig.name)} -->|"${nodeLabel(label)}"| ${nodeId(field.target)}`);
    }
  }
  for (const name of external) {
    lines.push(`  ${nodeId(name)}["${nodeLabel(name)}"]:::ext`);
  }
  if (external.size > 0) {
    lines.push("  classDef ext fill:#f9f9f8,stroke:#d9d8d4,color:#787774;");
  }
  return lines.join("\n");
}

/**
 * `@actor` / `@usecase` からユースケース図(Mermaid の flowchart)を組み立てる。
 *
 * Mermaid にユースケース図の記法はないため、UML の見え方に寄せて描く:
 * 左に四角のアクター、右のシステム境界(subgraph)の中に角丸のユースケース、
 * アクター → ユースケースの実線でつなぐ。アクターのないユースケースは境界の中に置くだけ。
 */
export function buildUseCaseGraph(
  actors: SpecActor[],
  useCases: SpecUseCase[],
  systemName: string,
): string {
  if (useCases.length === 0 && actors.length === 0) return "";
  const lines = ["flowchart LR"];
  const actorId = new Map<string, string>();
  actors.forEach((actor, i) => {
    const id = `a${i}`;
    actorId.set(actor.name, id);
    lines.push(`  ${id}["${nodeLabel(actor.name)}"]:::actor`);
  });
  lines.push(`  subgraph sys["${nodeLabel(systemName)}"]`);
  lines.push("    direction TB");
  useCases.forEach((uc, i) => {
    lines.push(`    u${i}("${nodeLabel(uc.name)}")`);
  });
  if (useCases.length === 0) lines.push('    uNone[" "]:::empty');
  lines.push("  end");
  useCases.forEach((uc, i) => {
    const from = uc.actor ? actorId.get(uc.actor) : undefined;
    if (from) lines.push(`  ${from} --> u${i}`);
  });
  lines.push("  classDef actor fill:#ffffff,stroke:#2f3437,color:#2f3437;");
  if (useCases.length === 0) lines.push("  classDef empty fill:#f9f9f8,stroke:#d9d8d4,color:#9b9a95;");
  return lines.join("\n");
}

const DECISION_STATUS_LABEL: Record<string, string> = {
  auto: "未確認(自動確定)",
  confirmed: "ユーザー確認済み",
  reverted: "ユーザーが差し戻し",
};

/** 宣言の見出し(doc comment の 1 行目、なければシグネチャ) */
function declarationTitle(decl: SpecDeclaration): string {
  const req = tagValues(decl.doc, "req")[0];
  if (req) {
    const text = req.replace(/^\S+\s*/, "").trim();
    if (text !== "") return text;
  }
  const prose = decl.doc?.prose.find((p) => p !== "");
  if (prose) return prose;
  return decl.signature;
}

/** 宣言の doc comment を、解説タブの本文(散文 + タグ)に組み立てる */
function declarationProse(decl: SpecDeclaration): string[] {
  const lines: string[] = [];
  const title = declarationTitle(decl);
  for (const p of decl.doc?.prose ?? []) {
    if (p === "" || p === title) continue;
    lines.push(p);
  }
  for (const [tag, label] of [
    ["rationale", "なぜこの形か"],
    ["relaxed", "意図的に緩くしている点"],
    ["validation", "何の証拠になるか"],
    ["term", "業務用語"],
    ["adr", "関連する決定(ADR)"],
    ["scope", "対象範囲"],
    ["stakeholder", "承認"],
    ["tradeoff", "トレードオフの最優先"],
  ] as const) {
    for (const value of tagValues(decl.doc, tag)) {
      lines.push(`${label}: ${value}`);
    }
  }
  return lines;
}

export interface RenderExplainArgs {
  projectName: string;
  model: SpecModel;
  /** .als の全文(モデル全文のセクションに載せる) */
  source: string;
  checks: SpecCheckRecord[];
  decisions: SpecDecisionRecord[];
  template: string;
}

/** 1 つの .als について解説ページを組み立てる(決定的。同じ入力なら同じ出力) */
export function renderSpecExplainHtml(args: RenderExplainArgs): string {
  const { projectName, model, source, checks, decisions, template } = args;
  const tpl = parseExplainTemplate(template);
  const reqText = new Map(model.requirements.map((r) => [r.id, r.text]));
  const gate = specGateStatus([model], checks);
  const sigs = specSigs(model);

  // 宣言ごとの解説(doc comment を持たない宣言も、コードとして順に載せる)
  const blockItems = model.declarations.map((decl) => {
    const prose = declarationProse(decl);
    const reqs = tagValues(decl.doc, "req").map((v) => v.split(/\s+/)[0]);
    return {
      id: escapeHtml(reqs.length > 0 ? reqs.join(" / ") : decl.kind),
      title: escapeHtml(declarationTitle(decl)),
      notes:
        prose.length > 0
          ? prose.map((n) => `<div>${escapeHtml(n)}</div>`).join("\n")
          : `<span class="note">説明(doc comment)がありません</span>`,
      code: escapeHtml(decl.code),
      commands:
        decl.kind === "check" || decl.kind === "run" ? chip(`${decl.kind} ${decl.name}`) : "",
    };
  });

  // ユースケース図(@actor / @usecase)。図の情報源は doc comment だけ(推測はしない)
  const { actors, useCases } = specUseCases(model);
  const systemTitle = tagValue(model.doc, "title") ?? model.module;
  const useCaseGraph = buildUseCaseGraph(actors, useCases, systemTitle);
  const useCaseGraphItems = useCaseGraph ? [{ source: escapeHtml(useCaseGraph) }] : [];
  const actorItems = actors.map((actor) => ({
    name: escapeHtml(actor.name),
    description: actor.description
      ? escapeHtml(actor.description)
      : `<span class="note">-</span>`,
    declaration: actor.declaration
      ? `<code>${escapeHtml(actor.declaration)}</code>`
      : `<span class="note">@usecase からの参照のみ(@actor の定義なし)</span>`,
  }));
  const useCaseItems = useCases.map((uc) => ({
    actor: uc.actor ? escapeHtml(uc.actor) : `<span class="note">(アクター未設定)</span>`,
    name: escapeHtml(uc.name),
    declaration: `<code>${escapeHtml(`${uc.kind} ${uc.declaration}`.trim())}</code>`,
    requirement:
      uc.requirements.length > 0
        ? uc.requirements
            .map((id) => `<b>${escapeHtml(id)}</b> ${escapeHtml(reqText.get(id) ?? "")}`)
            .join("<br>")
        : `<span class="note">-</span>`,
  }));

  const latestCommandChecks: SpecCheckRecord[] = [];
  const requirementIdOrder = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
  const sortedCommandItems = model.commands
    .map((cmd, sourceIndex) => {
      const check = latestSpecCheck(checks, model.file, cmd.name);
      if (check) latestCommandChecks.push(check);
      const requirementIds = cmd.requirements.map((id) => escapeHtml(id));
      const requirements = cmd.requirements.map((id) => escapeHtml(reqText.get(id) ?? ""));
      const command = `<code>${escapeHtml(`${cmd.kind} ${cmd.name}`)}</code>${
        cmd.scope ? ` <span class="note">${escapeHtml(cmd.scope)}</span>` : ""
      }`;
      const meaning =
        cmd.kind === "check"
          ? "主張を破る例(反例)がないか"
          : "条件を満たす例(インスタンス)があるか";
      return {
        requirementIds:
          requirementIds.length > 0 ? requirementIds.join("<br>") : `<span class="note">-</span>`,
        requirements:
          requirements.length > 0 ? requirements.join("<br>") : `<span class="note">(@req なし)</span>`,
        verification:
          `${command}<div>${meaning}</div>` +
          (cmd.validation ? `<div class="note">${escapeHtml(cmd.validation)}</div>` : ""),
        result: check
          ? chip(SPEC_RESULT_LABEL[check.result] ?? check.result, resultTone(check))
          : chip("未検証"),
        detail: escapeHtml(check?.detail ?? ""),
        sortRequirementId: cmd.requirements[0],
        sourceIndex,
      };
    })
    .sort((a, b) => {
      if (!a.sortRequirementId) return b.sortRequirementId ? 1 : a.sourceIndex - b.sourceIndex;
      if (!b.sortRequirementId) return -1;
      return (
        requirementIdOrder.compare(a.sortRequirementId, b.sortRequirementId) ||
        a.sourceIndex - b.sourceIndex
      );
    });
  const commandItems = sortedCommandItems.map((item, index) => {
    const previous = sortedCommandItems[index - 1];
    const sameRequirement =
      Boolean(item.sortRequirementId) &&
      item.requirementIds === previous?.requirementIds &&
      item.requirements === previous.requirements;
    let rowspan = 1;
    if (!sameRequirement && item.sortRequirementId) {
      while (
        sortedCommandItems[index + rowspan]?.requirementIds === item.requirementIds &&
        sortedCommandItems[index + rowspan]?.requirements === item.requirements
      ) {
        rowspan++;
      }
    }
    const rowspanAttribute = rowspan > 1 ? ` rowspan="${rowspan}"` : "";
    return {
      requirementIdCell: sameRequirement
        ? ""
        : `<td${rowspanAttribute}>${item.requirementIds}</td>`,
      requirementCell: sameRequirement
        ? ""
        : `<td${rowspanAttribute}>${item.requirements}</td>`,
      verification: item.verification,
      result: item.result,
      detail: item.detail,
    };
  });
  const latestCheckedAt = latestCommandChecks
    .map((check) => check.checkedAt)
    .filter((checkedAt): checkedAt is string => Boolean(checkedAt))
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1);

  // 意図的に扱わない範囲(ルートモジュールの @out-of-scope)
  const outOfScopeItems = tagValues(model.doc, "out-of-scope").map((text) => ({
    text: escapeHtml(text),
  }));

  // 関係性グラフ(Mermaid)と、その読み下しになる sig 一覧
  const graph = buildSpecGraph(sigs);
  const graphItems = graph ? [{ source: escapeHtml(graph) }] : [];
  const sigItems = sigs.map((sig) => ({
    name: escapeHtml(sig.name),
    kind: escapeHtml(
      [sig.abstract ? "abstract" : "", sig.multiplicity ?? ""].filter(Boolean).join(" ") || "sig",
    ),
    parent: sig.parent
      ? `${escapeHtml(sig.parentKind ?? "extends")} <b>${escapeHtml(sig.parent)}</b>`
      : `<span class="note">-</span>`,
    fields:
      sig.fields.length > 0
        ? sig.fields
            .map(
              (f) =>
                `<div><code>${escapeHtml(f.name)}</code> → <b>${escapeHtml(f.target)}</b> <span class="note">${escapeHtml(f.expression)}</span></div>`,
            )
            .join("\n")
        : `<span class="note">なし</span>`,
    term: tagValue(sig.doc, "term")
      ? escapeHtml(tagValue(sig.doc, "term")!)
      : `<span class="note">-</span>`,
  }));

  const decisionItems = decisions
    .filter((d) => !d.model || d.model === model.file)
    .slice()
    .reverse()
    .map((d) => ({
      requirement: escapeHtml(d.requirement),
      finding: escapeHtml(d.finding),
      decision: escapeHtml(d.decision),
      rationale: escapeHtml(d.rationale),
      alternatives: escapeHtml(d.alternatives?.join(" / ") || "(記載なし)"),
      changed: escapeHtml(d.changed?.join(" / ") || "(記載なし)"),
      status: escapeHtml(DECISION_STATUS_LABEL[d.status ?? "auto"] ?? (d.status ?? "auto")),
      decidedAt: escapeHtml(d.decidedAt ?? "-"),
    }));

  const gateText =
    gate.state === "fail"
      ? `<p class="gate gate-ng">実装前ゲート: <b>未通過</b> — 未充足・実行エラーが ${gate.unsatisfied} 件あります。仕様(.als)を直して再検証するまで実装に進みません。</p>`
      : gate.state === "pending"
        ? `<p class="gate gate-todo">実装前ゲート: <b>未確認</b> — 未検証の検証コマンドが ${gate.unchecked} 件あります(<code>bash atf-bin/formal.sh</code> で検証してください)。</p>`
        : `<p class="gate gate-ok">実装前ゲート: <b>通過</b> — ${gate.satisfied} 件の検証コマンドがすべて充足しています。</p>`;

  return fill(tpl.shell, {
    projectName: escapeHtml(projectName),
    model: escapeHtml(model.file),
    module: escapeHtml(model.module),
    file: escapeHtml(`spec/${model.file}`),
    requirementCount: String(model.requirements.length),
    commandCount: String(model.commands.length),
    useCaseCount: String(useCases.length),
    gate: gateText,
    latestCheckedAt: escapeHtml(latestCheckedAt ?? "未検証"),
    blocks: repeat(tpl, "block", blockItems),
    graph: repeat(tpl, "graph", graphItems),
    useCaseGraph: repeat(tpl, "useCaseGraph", useCaseGraphItems),
    actors: repeat(tpl, "actor", actorItems),
    useCases: repeat(tpl, "useCase", useCaseItems),
    sigs: repeat(tpl, "sig", sigItems),
    commands: repeat(tpl, "command", commandItems),
    outOfScope: repeat(tpl, "outOfScope", outOfScopeItems),
    decisions: repeat(tpl, "decision", decisionItems),
    source: escapeHtml(source),
  });
}
