import { describe, it, expect } from "vitest";
import { displayWidth, renderTable } from "./table.js";

describe("displayWidth", () => {
  it("半角は 1、全角・絵文字は 2 で数える", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("有効")).toBe(4);
    expect(displayWidth("PR フロー")).toBe(9);
    expect(displayWidth("✅")).toBe(2);
    expect(displayWidth("⭐")).toBe(2);
    // 異体字セレクタ付き(⚠️)は絵文字表示なので全角 1 文字分
    expect(displayWidth("⚠️")).toBe(2);
  });
});

/** 表の各行が同じ表示幅に揃っているか(桁ズレの検出) */
const widths = (table: string): number[] => table.split("\n").map(displayWidth);

describe("renderTable", () => {
  it("日本語を含んでも全行が同じ表示幅になる", () => {
    const table = renderTable(
      ["状態", "機能", "詳細"],
      [
        ["✅ 有効", "Issue 駆動開発", "担当: issue-manager"],
        ["🚫 無効", "形式仕様(Alloy)", "-"],
      ],
      { maxWidth: 80 },
    );
    expect(new Set(widths(table)).size).toBe(1);
    expect(table).toContain("Issue 駆動開発");
  });

  it("maxWidth を超えず、長いセルは折り返して全行を揃える", () => {
    const table = renderTable(
      ["機能", "詳細"],
      [["アーキテクチャ適合検証", "規約が未定義です。".repeat(20)]],
      { maxWidth: 60 },
    );
    expect(Math.max(...widths(table))).toBeLessThanOrEqual(60);
    expect(new Set(widths(table)).size).toBe(1);
    // 折り返しても内容は落とさない
    expect(table.split("\n").length).toBeGreaterThan(5);
  });

  it("セル内の改行は行として保たれる", () => {
    const table = renderTable(["a", "b"], [["1", "x\ny\nz"]], { maxWidth: 40 });
    const body = table.split("\n").filter((l) => l.includes("x") || l.includes("y") || l.includes("z"));
    expect(body).toHaveLength(3);
  });

  it("長いパスは / で折り返す(単語の途中で切らない)", () => {
    const table = renderTable(["詳細"], [[".claude/agents/spec-formalizer.md"]], { maxWidth: 24 });
    // `/` の直後で折れるので、セグメント名が途中で切れていない
    expect(table).toContain("spec-formalizer.md");
    expect(new Set(widths(table)).size).toBe(1);
  });

  it("字下げを付けても桁が揃う", () => {
    const table = renderTable(["a"], [["日本語"]], { maxWidth: 40, indent: "  " });
    expect(table.split("\n").every((l) => l.startsWith("  "))).toBe(true);
    expect(new Set(widths(table)).size).toBe(1);
  });

  it("行がなくてもヘッダだけの表を組める", () => {
    const table = renderTable(["状態", "機能"], [], { maxWidth: 40 });
    expect(table.split("\n")).toHaveLength(4);
    expect(new Set(widths(table)).size).toBe(1);
  });
});
