import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTeam } from "./generator.js";
import { loadPresets } from "./presets.js";
import type { RepoProfile, Requirements, TeamManifest } from "./types.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "atf-test-"));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

const profileFor = (path: string): RepoProfile => ({
  path,
  name: "example",
  languages: ["typescript"],
  frameworks: [],
  hasCI: false,
  hasTests: false,
  fileCount: 1,
});

const preset = () => {
  const p = loadPresets().find((p) => p.id === "quality-review");
  if (!p) throw new Error("quality-review preset not found");
  return p;
};

describe("generateTeam (Issue 駆動)", () => {
  const requirements: Requirements = {
    phase: "active",
    focus: ["quality"],
    teamSize: "minimal",
    issueDriven: true,
  };

  it("issue-manager を追加し、全エージェントに Issue 駆動の指示を付与する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    expect(result.written).toContain("issue-manager.md");
    const manifest: TeamManifest = JSON.parse(
      readFileSync(join(repoDir, ".claude", "team.json"), "utf8"),
    );
    // teamSize: minimal (3) の枠を消費せず 4 人目として追加される
    expect(manifest.agents.map((a) => a.name)).toEqual([
      "code-reviewer",
      "test-engineer",
      "refactoring-advisor",
      "issue-manager",
    ]);
    // issue-manager からチーム先頭エージェントへのフローが描かれる
    expect(manifest.flow).toContainEqual(["issue-manager", "code-reviewer"]);

    for (const file of result.written) {
      const content = readFileSync(join(result.agentsDir, file), "utf8");
      expect(content).toContain("## Issue 駆動開発");
      expect(content).toContain("## 実行記録");
    }
  });

  it("issueDriven でなければ issue-manager を追加しない", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      ...requirements,
      issueDriven: false,
    });

    expect(result.written).not.toContain("issue-manager.md");
    expect(existsSync(join(result.agentsDir, "issue-manager.md"))).toBe(false);
    const content = readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8");
    expect(content).not.toContain("## Issue 駆動開発");
  });
});
