import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeRepo } from "./analyzer.js";

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
