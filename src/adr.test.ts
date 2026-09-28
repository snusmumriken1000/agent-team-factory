import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adrDir, adrsByRequirement, loadAdrs, normalizeAdrId, parseAdr } from "./adr.js";

const ADR = `# ADR-0007: サービスアカウントを Principal に統合

Status: accepted
Date: 2026-08-14
Refs: R-014, R-021

## 決定

サービスアカウント専用の sig を設けないと決定した。

## 却下した案

- 別 sig として分離 — 権限判定が二重化するため却下した。
`;

describe("parseAdr", () => {
  const adr = parseAdr("0007-service-account.md", ADR);

  it("連番から ID を作り、見出しから ID 部分を落とす", () => {
    expect(adr.id).toBe("ADR-0007");
    expect(adr.title).toBe("サービスアカウントを Principal に統合");
  });

  it("Status / Date / Refs を読む", () => {
    expect(adr.status).toBe("accepted");
    expect(adr.date).toBe("2026-08-14");
    expect(adr.refs).toEqual(["R-014", "R-021"]);
  });

  it("「## 決定」節だけを取り出す(却下した案は含めない)", () => {
    expect(adr.decision).toBe("サービスアカウント専用の sig を設けないと決定した。");
  });

  it("superseded by から置き換え先の ID を読む", () => {
    const superseded = parseAdr("0003-old.md", "# ADR-0003: 旧\n\nStatus: superseded by ADR-12\n");
    expect(superseded.status).toBe("superseded");
    expect(superseded.supersededBy).toBe("ADR-0012");
  });

  it("Status がなければ unknown", () => {
    expect(parseAdr("0001-x.md", "# ADR-0001: x\n").status).toBe("unknown");
  });
});

describe("normalizeAdrId", () => {
  it("表記ゆれを ADR-NNNN に揃える", () => {
    expect(normalizeAdrId("adr-7")).toBe("ADR-0007");
    expect(normalizeAdrId("ADR-0007")).toBe("ADR-0007");
    expect(normalizeAdrId("0007-service-account.md")).toBe("ADR-0007");
  });
});

describe("loadAdrs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atf-adr-"));
    mkdirSync(adrDir(dir), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("番号順に読み、README.md(規約の説明)は含めない", () => {
    writeFileSync(join(adrDir(dir), "README.md"), "# 規約\n");
    writeFileSync(join(adrDir(dir), "0002-b.md"), "# ADR-0002: b\n\nRefs: R-02\n");
    writeFileSync(join(adrDir(dir), "0001-a.md"), "# ADR-0001: a\n\nRefs: R-01\n");

    expect(loadAdrs(dir).map((a) => a.id)).toEqual(["ADR-0001", "ADR-0002"]);
  });

  it("ディレクトリがなければ空", () => {
    rmSync(adrDir(dir), { recursive: true });
    expect(loadAdrs(dir)).toEqual([]);
  });
});

describe("adrsByRequirement", () => {
  it("要件 ID から、それを参照する ADR を引けるようにする", () => {
    const adrs = [
      parseAdr("0001-a.md", "# ADR-0001: a\n\nRefs: R-01, R-02\n"),
      parseAdr("0002-b.md", "# ADR-0002: b\n\nRefs: R-02\n"),
    ];
    const map = adrsByRequirement(adrs);
    expect(map.get("R-01")?.map((a) => a.id)).toEqual(["ADR-0001"]);
    expect(map.get("R-02")?.map((a) => a.id)).toEqual(["ADR-0001", "ADR-0002"]);
  });
});
