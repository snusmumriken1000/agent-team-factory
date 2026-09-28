import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atfBinDir,
  ensureGitignore,
  installAtfBin,
  FORMAL_IGNORE_PATTERNS,
  LOCAL_IGNORE_PATTERN,
} from "./bin.js";
import type { Requirements } from "./types.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "atf-bin-"));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

const requirements = (over: Partial<Requirements> = {}): Requirements => ({
  phase: "growth",
  focus: ["quality"],
  teamSize: "standard",
  ...over,
});

describe("installAtfBin", () => {
  it("プロジェクト直下の atf-bin に共通スクリプトを配る", () => {
    const result = installAtfBin(repoDir, requirements());

    expect(result.dir).toBe(join(repoDir, "atf-bin"));
    expect(result.written).toContain("_resolve.sh");
    expect(result.written).toContain("atf.local.sh");
    expect(result.written).toContain("status.sh");
    expect(result.written).toContain("README.md");
    // 機能が無効なら、呼ぶと必ず失敗するスクリプトは置かない
    expect(existsSync(join(result.dir, "formal.sh"))).toBe(false);
    expect(existsSync(join(result.dir, "arch.sh"))).toBe(false);
    expect(existsSync(join(result.dir, "docs.sh"))).toBe(false);
    expect(existsSync(join(result.dir, "eval.sh"))).toBe(false);
  });

  it("有効な機能のぶんだけゲートのスクリプトを足す", () => {
    const result = installAtfBin(
      repoDir,
      requirements({ formalSpec: true, archCheck: true, reverseDocs: true, rubricEval: true }),
    );

    for (const file of ["formal.sh", "arch.sh", "docs.sh", "eval.sh"]) {
      expect(result.written).toContain(file);
      expect(statSync(join(result.dir, file)).mode & 0o111).toBeTruthy();
    }
    const arch = readFileSync(join(result.dir, "arch.sh"), "utf8");
    // atf のサブコマンドを呼ぶだけの薄いラッパで、判定ロジックは持たせない
    expect(arch).toContain('atf_run arch "$ATF_PROJECT_DIR"');
  });

  it("機能を切ったら、前回配ったスクリプトを取り除く", () => {
    installAtfBin(repoDir, requirements({ archCheck: true }));
    const result = installAtfBin(repoDir, requirements({ archCheck: false }));

    expect(result.removed).toContain("arch.sh");
    expect(existsSync(join(atfBinDir(repoDir), "arch.sh"))).toBe(false);
  });

  it("手で編集されていても毎回上書きする(atf が内容を決めるファイル)", () => {
    installAtfBin(repoDir, requirements({ archCheck: true }));
    const dest = join(atfBinDir(repoDir), "arch.sh");
    writeFileSync(dest, "# 手で書き換えた\n");

    installAtfBin(repoDir, requirements({ archCheck: true }));
    expect(readFileSync(dest, "utf8")).not.toContain("手で書き換えた");
  });

  it("atf.local.sh に、このマシンの atf の場所を記録する", () => {
    const result = installAtfBin(repoDir, requirements(), { home: "/opt/atf" });

    const local = readFileSync(join(result.dir, "atf.local.sh"), "utf8");
    expect(local).toContain('ATF_HOME_DIR="/opt/atf"');
    expect(local).toContain("commit しない");
  });
});

describe("_resolve.sh", () => {
  const run = (script: string, env: NodeJS.ProcessEnv = {}) =>
    execFileSync("bash", [join(atfBinDir(repoDir), script)], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      cwd: tmpdir(), // どこから実行してもリポジトリルートを渡せること
    });

  it("環境変数 ATF の実行系にサブコマンドとリポジトリルートを渡す", () => {
    installAtfBin(repoDir, requirements({ archCheck: true }));

    const out = run("arch.sh", { ATF: "echo atf" });
    expect(out.trim()).toBe(`atf arch ${repoDir}`);
  });

  it("atf が見つからないときは解決方法を示して 127 で終わる", () => {
    installAtfBin(repoDir, requirements({ archCheck: true }), { home: "/nonexistent" });

    try {
      execFileSync("/bin/bash", [join(atfBinDir(repoDir), "arch.sh")], {
        encoding: "utf8",
        // atf が PATH 上になく(ATF_HOME_DIR も存在しない)、解決に失敗する状態にする
        env: { PATH: "/usr/bin:/bin" },
      });
      throw new Error("エラーにならなかった");
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      expect(err.status).toBe(127);
      expect(err.stderr).toContain("atf を実行できませんでした");
    }
  });
});

describe("ensureGitignore", () => {
  it("マシン固有のファイルだけを無視対象にする", () => {
    expect(ensureGitignore(repoDir)).toEqual([LOCAL_IGNORE_PATTERN]);

    const body = readFileSync(join(repoDir, ".gitignore"), "utf8");
    expect(body).toContain(LOCAL_IGNORE_PATTERN);
    // atf-bin 自体は commit 対象なので、ディレクトリごと無視しない
    expect(body).not.toContain("\natf-bin/\n");
  });

  it("既存の .gitignore を残したまま追記し、二重に書かない", () => {
    writeFileSync(join(repoDir, ".gitignore"), "node_modules\n");

    expect(ensureGitignore(repoDir)).toEqual([LOCAL_IGNORE_PATTERN]);
    expect(ensureGitignore(repoDir)).toEqual([]);

    const body = readFileSync(join(repoDir, ".gitignore"), "utf8");
    expect(body).toContain("node_modules");
    expect(body.match(new RegExp(LOCAL_IGNORE_PATTERN, "g"))?.length).toBe(1);
  });

  it("形式仕様モードでは生成物と非決定的な出力も無視対象にする", () => {
    expect(ensureGitignore(repoDir, { phase: "greenfield", focus: [], teamSize: "standard", formalSpec: true })).toEqual([
      LOCAL_IGNORE_PATTERN,
      ...FORMAL_IGNORE_PATTERNS,
    ]);
    const body = readFileSync(join(repoDir, ".gitignore"), "utf8");
    // 手書きの正(spec/ と docs/adr/)は commit する
    expect(body).toContain("docs/generated/");
    const patterns = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
    expect(patterns).not.toContain("spec/");
    expect(patterns.some((p) => p.startsWith("docs/adr"))).toBe(false);
  });
});
