import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendReverseDocs,
  docsDir,
  docsIndexPath,
  loadReverseDocs,
  reverseDocStatuses,
  staleReverseDocs,
} from "./reverse.js";
import type { ReverseDocRecord } from "./types.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "atf-docs-"));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

const record = (over: Partial<ReverseDocRecord> = {}): ReverseDocRecord => ({
  path: "docs/architecture/overview.md",
  title: "システム全体像",
  kind: "overview",
  sources: ["src/cli.ts"],
  generatedAt: "2026-01-01T00:00:00Z",
  agent: "doc-reverser",
  ...over,
});

/** リポジトリ内にファイルを作る(記録と実ファイルの突き合わせ用) */
function touch(relative: string, content = "x"): void {
  const path = join(repoDir, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function writeIndex(lines: string[]): void {
  mkdirSync(docsDir(repoDir), { recursive: true });
  writeFileSync(docsIndexPath(repoDir), lines.join("\n"));
}

describe("loadReverseDocs", () => {
  it("記録がなければ空", () => {
    expect(loadReverseDocs(repoDir)).toEqual([]);
  });

  it("同じ path の行は後勝ちで最新の生成結果だけを残す", () => {
    writeIndex([
      JSON.stringify(record({ commit: "old" })),
      JSON.stringify(record({ commit: "new", summary: "更新後" })),
    ]);

    const docs = loadReverseDocs(repoDir);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ commit: "new", summary: "更新後" });
  });

  it("壊れた行・path のない行は無視する", () => {
    writeIndex([
      JSON.stringify(record()),
      "{ 壊れた行",
      JSON.stringify({ title: "path がない" }),
      "",
    ]);
    expect(loadReverseDocs(repoDir)).toHaveLength(1);
  });

  it("全体像から詳細の順に並べる", () => {
    writeIndex([
      JSON.stringify(record({ path: "d/ops.md", kind: "ops" })),
      JSON.stringify(record({ path: "d/overview.md", kind: "overview" })),
      JSON.stringify(record({ path: "d/flow.md", kind: "flow" })),
    ]);
    expect(loadReverseDocs(repoDir).map((d) => d.kind)).toEqual(["overview", "flow", "ops"]);
  });
});

describe("appendReverseDocs", () => {
  it("ディレクトリを作って追記する", () => {
    appendReverseDocs(repoDir, [record()]);
    expect(readFileSync(docsIndexPath(repoDir), "utf8")).toContain("システム全体像");
    // 追記なので既存行は残る
    appendReverseDocs(repoDir, [record({ path: "docs/architecture/api.md", kind: "api" })]);
    expect(loadReverseDocs(repoDir)).toHaveLength(2);
  });
});

describe("reverseDocStatuses", () => {
  it("文書・図・根拠コードの存在を突き合わせる", () => {
    touch("docs/architecture/overview.md");
    touch("docs/architecture/diagrams/overview.html");
    touch("src/cli.ts");
    const statuses = reverseDocStatuses(repoDir, [
      record({ diagram: "docs/architecture/diagrams/overview.html" }),
    ]);

    expect(statuses[0]).toMatchObject({
      docExists: true,
      diagramExists: true,
      missingSources: [],
    });
    expect(staleReverseDocs(statuses)).toEqual([]);
  });

  it("根拠にしたコードが消えている文書を要再生成として検出する", () => {
    touch("docs/architecture/overview.md");
    const statuses = reverseDocStatuses(repoDir, [
      record({ sources: ["src/cli.ts", "src/removed.ts"] }),
    ]);

    expect(statuses[0].missingSources).toEqual(["src/cli.ts", "src/removed.ts"]);
    expect(staleReverseDocs(statuses)).toHaveLength(1);
  });

  it("図の記録がない文書では図の判定をしない", () => {
    touch("docs/architecture/overview.md");
    touch("src/cli.ts");
    const statuses = reverseDocStatuses(repoDir, [record()]);

    expect(statuses[0].diagramExists).toBeUndefined();
    expect(staleReverseDocs(statuses)).toEqual([]);
  });

  it("文書本体が消えていれば要再生成", () => {
    touch("src/cli.ts");
    const statuses = reverseDocStatuses(repoDir, [record()]);
    expect(statuses[0].docExists).toBe(false);
    expect(staleReverseDocs(statuses)).toHaveLength(1);
  });
});
