import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Preset, RepoProfile, Requirements, ScoredPreset } from "./types.js";

/** templates/presets のルート(パッケージ同梱) */
export function presetsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ からも src/ からも見えるように 1 つ上の templates を参照する
  return join(here, "..", "templates", "presets");
}

/** 全プリセット共通のエージェントテンプレート置き場(issue-manager など) */
export function commonRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "templates", "common");
}

/** すべてのプリセットをロードする */
export function loadPresets(root: string = presetsRoot()): Preset[] {
  if (!existsSync(root)) return [];
  const presets: Preset[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const jsonPath = join(dir, "preset.json");
    if (!existsSync(jsonPath)) continue;
    const raw = JSON.parse(readFileSync(jsonPath, "utf8"));
    presets.push({ ...raw, id: entry.name, dir });
  }
  return presets;
}

/**
 * どのプリセットにもカバーされていない重視観点(focus)を返す。
 * 全 focus が未カバーなら、用意されているテンプレートでは要件に応えられない状態
 * (呼び出し側で処理を中断し、管理者へのテンプレート作成依頼を促す)。
 */
export function uncoveredFocus(presets: Preset[], requirements: Requirements): string[] {
  return requirements.focus.filter(
    (f) => !presets.some((p) => p.match.focus?.includes(f)),
  );
}

/**
 * プロファイルと要件に対してプリセットをスコアリングする。
 * match 条件との一致 1 件につき加点。focus の一致を最重視する。
 */
export function scorePresets(
  presets: Preset[],
  profile: RepoProfile,
  requirements: Requirements,
): ScoredPreset[] {
  const scored = presets.map((preset) => {
    let score = 0;
    const m = preset.match;
    for (const lang of m.languages ?? []) {
      if (profile.languages.includes(lang)) score += 2;
    }
    for (const fw of m.frameworks ?? []) {
      if (profile.frameworks.includes(fw)) score += 2;
    }
    for (const f of m.focus ?? []) {
      // ユーザーが明示した重視観点は、言語/FW の自動検出より優先する
      if (requirements.focus.includes(f)) score += 5;
    }
    if (m.phase?.includes(requirements.phase)) score += 1;
    return { preset, score };
  });
  return scored.sort((a, b) => b.score - a.score);
}
