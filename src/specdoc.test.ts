import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checksPath, decisionsPath, formalDir, parseSpecModel, specDir, specSigs } from "./alloy.js";
import {
  buildSpecGraph,
  bundledExplainTemplate,
  explainDocName,
  explainTemplatePath,
  loadExplainTemplate,
  parseExplainTemplate,
} from "./specdoc.js";
import { generatedDir, runWeave } from "./weave.js";

const MODEL = `/**
 * @module order
 * @scope  注文と出荷。
 * @out-of-scope 出荷通知は 5 分以内に送る(性能要件のため検証しない)
 */
module order

abstract sig State {}
one sig Pending, Shipped extends State {}

/**
 * @actor 顧客 注文を出す人
 */
sig Customer {}

/**
 * 注文は顧客なしでは存在できない。
 * @term 注文 / Order
 */
sig Order { customer: one Customer, state: one State }

/**
 * @req R-01  すべての注文はちょうど 1 人の顧客に属する
 * @usecase 顧客 注文を確定する
 */
assert NoOrphanOrder { all o: Order | one o.customer }

/**
 * @req R-01
 */
check NoOrphanOrder for 5

/**
 * @req R-02  注文が 1 件もない仕様にはしない
 */
pred Consistent { some Order }

/**
 * @req R-02
 */
run Consistent for 5
`;

const CHECKS = [
  {
    model: "order.als",
    command: "NoOrphanOrder",
    kind: "check" as const,
    result: "counterexample" as const,
    detail: "Counterexample found.",
    checkedAt: "2026-01-01T00:00:00Z",
  },
  {
    model: "order.als",
    command: "Consistent",
    kind: "run" as const,
    result: "instance" as const,
    detail: "Instance found.",
    checkedAt: "2026-01-02T00:00:00Z",
  },
];

const DECISIONS = [
  {
    requirement: "R-01",
    model: "order.als",
    finding: "顧客のいない注文が作れる反例が出た",
    decision: "注文は必ず 1 人の顧客に属する",
    rationale: "請求の整合性が崩れる案しか他にない",
    alternatives: ["顧客なしの注文を許す"],
    changed: ["spec/order.als", "docs/adr/0002-order-customer.md"],
    decidedAt: "2026-01-02T00:00:00Z",
    status: "auto" as const,
  },
];

describe("parseExplainTemplate", () => {
  it("繰り返しの雛形を名前で取り出し、本体からは取り除く", () => {
    const { shell, blocks } = parseExplainTemplate(
      `<p>{{title}}</p>\n<!-- atf:block row -->\n<li>{{text}}</li>\n<!-- /atf:block -->\n<ul>{{rows}}</ul>\n`,
    );
    expect(blocks.get("row")).toBe("<li>{{text}}</li>");
    expect(shell).not.toContain("atf:block");
    expect(shell).toContain("<ul>{{rows}}</ul>");
  });

  it("テンプレート編集者向けの説明(atf:doc)は生成物に残さない", () => {
    const { shell } = parseExplainTemplate(`<!-- atf:doc 説明 -->\n<p>本体</p>`);
    expect(shell).toBe("<p>本体</p>");
  });

  it("同梱テンプレートは 3 つのタブ(ユースケース / 検証事項 / Alloy コード解説)を左からこの順で持つ", () => {
    const { shell } = parseExplainTemplate(bundledExplainTemplate());
    for (const id of ["usecase", "verify", "explain"]) {
      expect(shell).toContain(`id="tab-${id}"`);
      expect(shell).toContain(`id="panel-${id}"`);
    }
    // タブの並びは左から ユースケース → 検証事項 → Alloy コード解説
    const labels = [...shell.matchAll(/<label for="tab-(\w+)">([^<]+)<\/label>/g)];
    expect(labels.map((m) => m[1])).toEqual(["usecase", "verify", "explain"]);
    expect(labels.map((m) => m[2])).toEqual(["ユースケース", "検証事項", "Alloy コード解説"]);
    // ユースケースタブ = 図 + 一覧、検証タブ = 検証事項の一覧だけ、解説タブ = コードの読み下し
    expect(shell).toContain("ユースケース図");
    expect(shell).toContain("検証事項一覧");
    expect(shell).toContain("要件とコードを順に読む");
  });

  it("Alloy コード解説タブは記法の読み方と文芸的プログラミングだけ", () => {
    const { shell } = parseExplainTemplate(bundledExplainTemplate());
    const explain = shell.slice(shell.indexOf('id="panel-explain"'));
    expect(explain).toContain("Alloy の記法の読み方");
    expect(explain).toContain("要件とコードを順に読む");
    expect(explain).toContain("{{blocks}}");
    expect(explain).toContain('<details class="notation-guide">');
    expect(explain).toContain("<summary>Alloy の記法の読み方</summary>");
    expect(explain).not.toContain('<details class="notation-guide" open>');
    // 関係性グラフ・sig 一覧・反例から確定した仕様・モデル全文は載せない
    for (const gone of ["関係性グラフ", "{{graph}}", "{{sigs}}", "{{decisions}}", "{{source}}", "モデル全文"]) {
      expect(explain).not.toContain(gone);
    }
  });

  it("検証タブに載せるのは検証事項の一覧だけ(関係性グラフ・sig 一覧は解説タブ)", () => {
    const { shell } = parseExplainTemplate(bundledExplainTemplate());
    const verify = shell.slice(
      shell.indexOf('id="panel-verify"'),
      shell.indexOf('id="panel-explain"'),
    );
    expect(verify).toContain("検証事項一覧");
    expect(verify).toContain("{{commands}}");
    expect(verify).not.toContain("関係性グラフ");
    expect(verify).not.toContain("{{sigs}}");
    expect(verify).not.toContain("{{decisions}}");
  });

  it("同梱テンプレートには必要な差し込み口と雛形がそろっている", () => {
    const { shell, blocks } = parseExplainTemplate(bundledExplainTemplate());
    for (const slot of ["useCaseGraph", "actors", "useCases", "blocks", "commands", "outOfScope", "gate"]) {
      expect(shell).toContain(`{{${slot}}}`);
    }
    for (const name of ["useCaseGraph", "actor", "useCase", "block", "command", "outOfScope"]) {
      expect(blocks.has(name)).toBe(true);
      expect(blocks.has(`${name}-empty`)).toBe(true);
    }
  });

  it("生成を決定的に保つため、時刻の差し込み口を持たない", () => {
    expect(bundledExplainTemplate()).not.toContain("{{generatedAt}}");
  });

  it("序文(このページは〜)を持たない", () => {
    const { shell } = parseExplainTemplate(bundledExplainTemplate());
    expect(shell).not.toContain("このページは");
    expect(shell).not.toContain('class="lead"');
  });
});

describe("解説ページの生成(weave 経由)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atf-specdoc-"));
    mkdirSync(specDir(dir), { recursive: true });
    mkdirSync(formalDir(dir), { recursive: true });
    writeFileSync(join(specDir(dir), "order.als"), MODEL);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const render = () => {
    writeFileSync(checksPath(dir), CHECKS.map((c) => JSON.stringify(c)).join("\n") + "\n");
    writeFileSync(decisionsPath(dir), DECISIONS.map((d) => JSON.stringify(d)).join("\n") + "\n");
    runWeave(dir, "demo");
    return readFileSync(join(generatedDir(dir), "order.explain.html"), "utf8");
  };

  it(".als ごとに docs/generated/<モデル名>.explain.html を書き出す", () => {
    const result = runWeave(dir, "demo");
    expect(result.written).toContain(explainDocName("order.als"));
    expect(result.dir).toBe(generatedDir(dir));
  });

  it("要件・doc comment の散文・数式・扱わない範囲を載せる", () => {
    const html = render();
    expect(html).toContain("R-01");
    expect(html).toContain("すべての注文はちょうど 1 人の顧客に属する");
    expect(html).toContain("注文は顧客なしでは存在できない。");
    expect(html).toContain("assert NoOrphanOrder");
    expect(html).toContain("出荷通知は 5 分以内に送る");
  });

  it("最新の検証結果と実装前ゲートの状況を載せる", () => {
    const html = render();
    expect(html).toContain("反例あり");
    expect(html).toContain("Counterexample found.");
    expect(html).toContain("実装前ゲート");
    expect(html).toContain("未通過");
  });

  it("検証事項一覧は要件を分離し、コマンドを検証事項に含め、最新の検証時刻を表外に1件だけ載せる", () => {
    const html = render();
    const verify = html.slice(html.indexOf('id="panel-verify"'), html.indexOf('id="panel-explain"'));
    expect(verify).toContain("<th>要件ID</th><th>要件</th><th>検証事項</th><th>最新の結果</th>");
    expect(verify).not.toContain("対応する要件");
    expect(verify).not.toContain("確かめていること");
    expect(verify).not.toContain("<th>検証時刻</th>");
    expect(verify).toContain("最終検証時刻: 2026-01-02T00:00:00Z");
    expect(verify.match(/2026-01-02T00:00:00Z/g)).toHaveLength(1);
    expect(verify).toContain("<td>R-01</td>");
    expect(verify).toContain("<td>すべての注文はちょうど 1 人の顧客に属する</td>");
    expect(verify).toContain("<td><code>check NoOrphanOrder</code>");
  });

  it("検証事項は要件IDの自然な昇順で並べ、要件IDなしは末尾に置く", () => {
    writeFileSync(
      join(specDir(dir), "order.als"),
      `module order
/** @req REQ-10 10番目 */
run Ten {} for 3
/** @req REQ-2 2番目 */
run Two {} for 3
run WithoutRequirement {} for 3
`,
    );
    runWeave(dir, "demo");
    const html = readFileSync(join(generatedDir(dir), "order.explain.html"), "utf8");
    const verify = html.slice(html.indexOf('id="panel-verify"'), html.indexOf('id="panel-explain"'));
    expect(verify.indexOf("REQ-2")).toBeLessThan(verify.indexOf("REQ-10"));
    expect(verify.indexOf("REQ-10")).toBeLessThan(verify.indexOf("run WithoutRequirement"));
  });

  it("連続する同じ要件IDと要件は rowspan でセル結合する", () => {
    writeFileSync(
      join(specDir(dir), "order.als"),
      `module order
/** @req R-01 同じ要件 */
run First {} for 3
/** @req R-01 */
run Second {} for 3
`,
    );
    runWeave(dir, "demo");
    const html = readFileSync(join(generatedDir(dir), "order.explain.html"), "utf8");
    const verify = html.slice(html.indexOf('id="panel-verify"'), html.indexOf('id="panel-explain"'));
    expect(verify).toContain('<td rowspan="2">R-01</td>');
    expect(verify).toContain('<td rowspan="2">同じ要件</td>');
    expect(verify.match(/>R-01<\/td>/g)).toHaveLength(1);
  });

  it("反例から確定した仕様は既定ページに出さない(ダッシュボードが担う)", () => {
    const html = render();
    expect(html).not.toContain("未確認(自動確定)");
    expect(html).not.toContain("顧客なしの注文を許す");
  });

  it("関係性グラフは既定ページに出さない(buildSpecGraph は独自テンプレート向けに残る)", () => {
    const html = render();
    expect(html).not.toContain("s_Order");
    const graph = buildSpecGraph(specSigs(parseSpecModel("order.als", MODEL)));
    // フィールドは実線、extends は破線
    expect(graph).toContain('s_Order -->|"customer: one"| s_Customer');
    expect(graph).toContain('s_Pending -.->|"extends"| s_State');
  });

  it("ユースケース図を @actor / @usecase から組み立て、一覧にも出す", () => {
    const html = render();
    // アクターは四角、ユースケースはシステム境界(subgraph)の中の角丸
    expect(html).toContain('a0[&quot;顧客&quot;]:::actor');
    expect(html).toContain("subgraph sys[&quot;order&quot;]");
    expect(html).toContain("u0(&quot;注文を確定する&quot;)");
    expect(html).toContain("a0 --&gt; u0");
    // 一覧には説明と、書いてある宣言・対応する要件も出す
    expect(html).toContain("注文を出す人");
    expect(html).toContain("assert NoOrphanOrder");
  });

  it("@actor / @usecase がなければ、書き方の案内を出して図は描かない", () => {
    writeFileSync(join(specDir(dir), "order.als"), `module order

sig A {}
`);
    runWeave(dir, "demo");
    const html = readFileSync(join(generatedDir(dir), "order.explain.html"), "utf8");
    expect(html).toContain("@usecase 顧客 注文を確定する");
    expect(html).toContain("@usecase がまだありません");
    expect(html).not.toContain("subgraph sys");
  });

  it("差し込みが済んでおり、雛形の目印も未置換の差し込み口も残らない", () => {
    const html = render();
    expect(html).not.toContain("atf:block");
    expect(html).not.toContain("atf:doc");
    expect(html.match(/\{\{\w+\}\}/g)).toBeNull();
  });

  it("記録がなくても空の状態(<名前>-empty)で生成できる", () => {
    runWeave(dir, "demo");
    const html = readFileSync(join(generatedDir(dir), "order.explain.html"), "utf8");
    expect(html).toContain("未検証");
    expect(html.match(/\{\{\w+\}\}/g)).toBeNull();
  });

  it("エージェント由来の文字列は HTML としてエスケープする", () => {
    writeFileSync(
      join(specDir(dir), "order.als"),
      `/**\n * @req R-01  <script>alert(1)</script> を含む要件\n */\nsig A {}\n`,
    );
    runWeave(dir, "demo");
    const html = readFileSync(join(generatedDir(dir), "order.explain.html"), "utf8");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("プロジェクトの explain-template.html があればそちらの形式で出す", () => {
    writeFileSync(
      explainTemplatePath(dir),
      `<h1>{{model}}</h1>\n<!-- atf:block block -->\n<p>{{id}} {{title}}</p>\n<!-- /atf:block -->\n{{blocks}}\n`,
    );
    expect(loadExplainTemplate(dir)).toContain("<h1>{{model}}</h1>");
    runWeave(dir, "demo");
    const html = readFileSync(join(generatedDir(dir), "order.explain.html"), "utf8");
    expect(html).toContain("<h1>order.als</h1>");
    expect(html).toContain("<p>R-01");
    // 独自テンプレートに無いセクションは出さない(形式はテンプレートが決める)
    expect(html).not.toContain("Alloy の記法の読み方");
  });
});
