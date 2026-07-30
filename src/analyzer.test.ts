import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeRepo, applyTechStack } from "./analyzer.js";
import type { RepoProfile } from "./types.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "atf-analyzer-test-"));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

const writeGitConfig = (url: string) => {
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  writeFileSync(
    join(repoDir, ".git", "config"),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
};

describe("applyTechStack (ヒアリングで選択した技術スタックの統合)", () => {
  const profile: RepoProfile = {
    path: "/tmp/example",
    name: "example",
    languages: ["javascript"],
    frameworks: ["docker"],
    hasCI: false,
    hasTests: false,
    fileCount: 0,
  };

  it("選択値を先頭に置き、検出値と重複なく統合する", () => {
    const merged = applyTechStack(profile, {
      languages: ["typescript", "javascript"],
      frameworks: ["react"],
    });

    expect(merged.languages).toEqual(["typescript", "javascript"]);
    expect(merged.frameworks).toEqual(["react", "docker"]);
    // 元のプロファイルは変更しない
    expect(profile.languages).toEqual(["javascript"]);
  });

  it("選択なし(未定)の場合は検出値をそのまま残す", () => {
    const merged = applyTechStack(profile, { languages: [], frameworks: [] });
    expect(merged.languages).toEqual(["javascript"]);
    expect(merged.frameworks).toEqual(["docker"]);
  });
});

describe("analyzeRepo (GitHub リポジトリ検出)", () => {
  it("https 形式の remote URL から owner/repo を検出する", () => {
    writeGitConfig("https://github.com/octocat/hello-world.git");
    expect(analyzeRepo(repoDir).githubRepo).toBe("octocat/hello-world");
  });

  it("ssh 形式の remote URL から owner/repo を検出する", () => {
    writeGitConfig("git@github.com:octocat/hello-world.git");
    expect(analyzeRepo(repoDir).githubRepo).toBe("octocat/hello-world");
  });

  it("GitHub 以外の remote や .git がない場合は undefined", () => {
    writeGitConfig("https://gitlab.com/octocat/hello-world.git");
    expect(analyzeRepo(repoDir).githubRepo).toBeUndefined();

    rmSync(join(repoDir, ".git"), { recursive: true, force: true });
    expect(analyzeRepo(repoDir).githubRepo).toBeUndefined();
  });
});
