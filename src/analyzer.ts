import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { RepoProfile } from "./types.js";

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".php": "php",
  ".cs": "csharp",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
};

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  "vendor",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
]);

/** package.json の依存名 → フレームワーク名 */
const DEP_TO_FRAMEWORK: Record<string, string> = {
  react: "react",
  next: "next",
  vue: "vue",
  nuxt: "nuxt",
  svelte: "svelte",
  express: "express",
  fastify: "fastify",
  nestjs: "nest",
  "@nestjs/core": "nest",
  electron: "electron",
};

/** 存在すればフレームワーク検出とみなすファイル */
const FILE_TO_FRAMEWORK: Record<string, string> = {
  "manage.py": "django",
  "Gemfile": "rails",
  "go.mod": "go-module",
  "Cargo.toml": "cargo",
  "pom.xml": "maven",
  "build.gradle": "gradle",
  "pyproject.toml": "python-project",
  "Dockerfile": "docker",
  "docker-compose.yml": "docker",
};

const TEST_MARKERS = [
  "test",
  "tests",
  "__tests__",
  "spec",
  "vitest.config.ts",
  "jest.config.js",
  "pytest.ini",
];

/** 対象リポジトリを走査してプロファイルを作る */
export function analyzeRepo(repoPath: string): RepoProfile {
  const path = resolve(repoPath);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`リポジトリが見つかりません: ${path}`);
  }

  const langCounts = new Map<string, number>();
  const frameworks = new Set<string>();
  let hasTests = false;
  let fileCount = 0;

  const walk = (dir: string, depth: number) => {
    if (depth > 6) return; // 深すぎる階層は打ち切り
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (TEST_MARKERS.includes(entry.name)) hasTests = true;
        walk(join(dir, entry.name), depth + 1);
      } else {
        fileCount++;
        if (TEST_MARKERS.includes(entry.name) || /\.(test|spec)\./.test(entry.name)) {
          hasTests = true;
        }
        const fw = FILE_TO_FRAMEWORK[entry.name];
        if (fw) frameworks.add(fw);
        const lang = EXT_TO_LANG[extname(entry.name)];
        if (lang) langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
      }
    }
  };
  walk(path, 0);

  // package.json から依存ベースでフレームワーク検出
  const pkgPath = join(path, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [dep, fw] of Object.entries(DEP_TO_FRAMEWORK)) {
        if (deps?.[dep]) frameworks.add(fw);
      }
    } catch {
      // 壊れた package.json は無視
    }
  }

  const hasCI =
    existsSync(join(path, ".github", "workflows")) ||
    existsSync(join(path, ".gitlab-ci.yml")) ||
    existsSync(join(path, ".circleci"));

  const languages = [...langCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang);

  return {
    path,
    name: basename(path),
    languages,
    frameworks: [...frameworks],
    hasCI,
    hasTests,
    fileCount,
  };
}
