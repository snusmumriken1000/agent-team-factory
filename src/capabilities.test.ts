import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capabilitiesDir,
  findingsPath,
  isAdoptable,
  loadCapabilityFindings,
  loadCapabilityPlans,
} from "./capabilities.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "atf-cap-"));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

const writeFindings = (lines: string[]) => {
  mkdirSync(capabilitiesDir(repoDir), { recursive: true });
  writeFileSync(findingsPath(repoDir), lines.join("\n") + "\n");
};

describe("loadCapabilityFindings", () => {
  it("記録がなければ空を返す", () => {
    expect(loadCapabilityFindings(repoDir)).toEqual([]);
  });

  it("同じ id の行は後勝ちで最新の判定だけを残す", () => {
    writeFindings([
      JSON.stringify({ id: "cc-foo", product: "claude-code", name: "Foo", summary: "s", verdict: "hold", reason: "版が古い" }),
      JSON.stringify({ id: "cx-bar", product: "codex", name: "Bar", summary: "s", verdict: "reject", reason: "合わない" }),
      JSON.stringify({ id: "cc-foo", product: "claude-code", name: "Foo", summary: "s", verdict: "adopt", reason: "更新して動作確認" }),
    ]);

    const findings = loadCapabilityFindings(repoDir);
    expect(findings).toHaveLength(2);
    expect(findings.find((f) => f.id === "cc-foo")?.verdict).toBe("adopt");
    expect(findings.find((f) => f.id === "cc-foo")?.reason).toBe("更新して動作確認");
  });

  it("壊れた行・id や name のない行は無視する(エージェントの自己申告のため)", () => {
    writeFindings([
      "{壊れた JSON",
      "",
      JSON.stringify({ product: "claude-code", name: "id なし", summary: "s", verdict: "adopt", reason: "r" }),
      JSON.stringify({ id: "cc-ok", product: "claude-code", name: "OK", summary: "s", verdict: "adopt", reason: "r" }),
    ]);

    expect(loadCapabilityFindings(repoDir).map((f) => f.id)).toEqual(["cc-ok"]);
  });
});

describe("loadCapabilityPlans", () => {
  it("plan-*.md を見出し付きで読む(それ以外のファイルは対象外)", () => {
    mkdirSync(capabilitiesDir(repoDir), { recursive: true });
    writeFileSync(join(capabilitiesDir(repoDir), "plan-cc-foo.md"), "# Foo の組み込み計画\n\n本文\n");
    writeFileSync(join(capabilitiesDir(repoDir), "plan-cx-bar.md"), "見出しなし\n");
    writeFileSync(join(capabilitiesDir(repoDir), "README.md"), "# 書式ガイド\n");

    const plans = loadCapabilityPlans(repoDir);
    expect(plans.map((p) => p.file)).toEqual(["plan-cc-foo.md", "plan-cx-bar.md"]);
    expect(plans[0]).toMatchObject({ id: "cc-foo", title: "Foo の組み込み計画" });
    expect(plans[1].title).toBe("plan-cx-bar.md"); // 見出しがなければファイル名
  });
});

describe("isAdoptable", () => {
  it("adopt と trial だけを「組み込めるもの」とする", () => {
    expect(isAdoptable("adopt")).toBe(true);
    expect(isAdoptable("trial")).toBe(true);
    expect(isAdoptable("hold")).toBe(false);
    expect(isAdoptable("reject")).toBe(false);
  });
});
