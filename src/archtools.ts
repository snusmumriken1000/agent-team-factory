import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArchTool } from "./types.js";

/**
 * アーキテクチャ適合検証ツールのカタログ(パッケージ同梱の templates/arch-tools.json)。
 *
 * atf は検証ツールを直接叩かず、`ARCH <規約 id> <判定>` の出力形式だけを規約にしている。
 * そのためここにあるのは実行コードではなく「arch-guard に渡す配線の知識」で、
 * ツールを増やすときは JSON に 1 エントリ足すだけでよい(コード変更は不要)。
 */
export function archToolCatalogPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ からも src/ からも見えるように 1 つ上の templates を参照する
  return join(here, "..", "templates", "arch-tools.json");
}

/** カタログをロードする(壊れていれば空。ダッシュボード・生成を落とさない) */
export function loadArchToolCatalog(path: string = archToolCatalogPath()): ArchTool[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const tools: unknown = raw?.tools;
    if (!Array.isArray(tools)) return [];
    return tools.filter(
      (t): t is ArchTool =>
        typeof t?.id === "string" && typeof t?.name === "string" && Array.isArray(t?.languages),
    );
  } catch {
    return [];
  }
}

/**
 * 言語に対応するツールを推奨順に返す。
 * 言語の指定がない(検出できていない)ときは空を返し、呼び出し側が全件表示に切り替える。
 */
export function archToolsFor(catalog: ArchTool[], languages: string[]): ArchTool[] {
  const wanted = new Set(languages.map((l) => l.toLowerCase()));
  if (wanted.size === 0) return [];
  return catalog
    .filter((t) => t.languages.some((l) => wanted.has(l.toLowerCase())))
    .sort((a, b) => Number(b.recommended ?? false) - Number(a.recommended ?? false));
}

/** 言語ごとの推奨ツール(検出言語のうち、カタログにあるものだけ) */
export function recommendedArchTools(catalog: ArchTool[], languages: string[]): ArchTool[] {
  return archToolsFor(catalog, languages).filter((t) => t.recommended);
}

/** 言語 id → その言語を対象にするツール(表示順はカタログの並び) */
export function archToolsByLanguage(catalog: ArchTool[]): Map<string, ArchTool[]> {
  const byLanguage = new Map<string, ArchTool[]>();
  for (const tool of catalog) {
    for (const language of tool.languages) {
      const list = byLanguage.get(language) ?? [];
      list.push(tool);
      byLanguage.set(language, list);
    }
  }
  return byLanguage;
}

/**
 * 「言語: ツール名」の一覧行(エージェントへの指示文・ダッシュボードで共用)。
 * 同じツールの組み合わせになる言語はまとめる(Java / Kotlin / Scala: ArchUnit)。
 */
export function formatArchTools(catalog: ArchTool[]): { languages: string[]; tools: string[] }[] {
  const grouped = new Map<string, { languages: string[]; tools: string[] }>();
  for (const [language, tools] of archToolsByLanguage(catalog)) {
    const names = tools.map((t) => t.name);
    const key = names.join("|");
    const entry = grouped.get(key) ?? { languages: [], tools: names };
    entry.languages.push(language);
    grouped.set(key, entry);
  }
  return [...grouped.values()];
}

/** 指示文に埋め込む 1 行要約(Java/Kotlin/Scala: ArchUnit / TypeScript: … ) */
export function archToolSummary(catalog: ArchTool[]): string {
  return formatArchTools(catalog)
    .map((g) => `${g.languages.map(languageLabel).join("/")}: ${g.tools.join("・")}`)
    .join(" / ");
}

/** 言語 id → 表示名(カタログとダッシュボードで共用) */
export function languageLabel(id: string): string {
  return LANGUAGE_LABEL[id] ?? id;
}

const LANGUAGE_LABEL: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  go: "Go",
  java: "Java",
  kotlin: "Kotlin",
  scala: "Scala",
  ruby: "Ruby",
  php: "PHP",
  csharp: "C#/.NET",
  rust: "Rust",
  swift: "Swift",
};
