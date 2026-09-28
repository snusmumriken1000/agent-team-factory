import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TechCategory, TechStack } from "./types.js";

/** 技術スタックカタログ(パッケージ同梱の templates/tech-stack.json) */
export function techStackCatalogPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ からも src/ からも見えるように 1 つ上の templates を参照する
  return join(here, "..", "templates", "tech-stack.json");
}

/**
 * カテゴリ定義をロードする。カテゴリと技術を増やすだけでヒアリングの選択肢が増え、
 * コードの変更は不要(target が選択結果のマージ先を決める)。
 */
export function loadTechStackCatalog(path: string = techStackCatalogPath()): TechCategory[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const categories: unknown = raw?.categories;
    if (!Array.isArray(categories)) return [];
    return categories
      .filter((c): c is TechCategory => typeof c?.id === "string" && Array.isArray(c?.items))
      .map((c) => ({ ...c, target: c.target === "languages" ? "languages" : "frameworks" }));
  } catch {
    return [];
  }
}

/** 空の技術スタック(未選択) */
export const emptyTechStack = (): TechStack => ({ languages: [], frameworks: [], categories: {} });

/**
 * カテゴリごとの選択結果を TechStack に畳み込む。
 * languages / frameworks は target ごとの平坦化結果で、プリセットのスコアリングと
 * {{languages}} / {{frameworks}} 置換に使われる。
 */
export function toTechStack(
  catalog: TechCategory[],
  selections: Record<string, string[]>,
): TechStack {
  const languages: string[] = [];
  const frameworks: string[] = [];
  const categories: Record<string, string[]> = {};
  for (const category of catalog) {
    const picked = [...new Set(selections[category.id] ?? [])].filter(Boolean);
    if (picked.length === 0) continue;
    categories[category.id] = picked;
    (category.target === "languages" ? languages : frameworks).push(...picked);
  }
  return {
    languages: [...new Set(languages)],
    frameworks: [...new Set(frameworks)],
    categories,
  };
}

/**
 * 自動検出した言語・フレームワークを、カタログのカテゴリに振り分ける
 * (ヒアリングの初期チェックに使う。どのカテゴリにも無い検出値は捨てずに
 * target が一致する最初のカテゴリ = 言語 / フレームワークに寄せる)。
 */
export function detectedSelections(
  catalog: TechCategory[],
  detected: TechStack = { languages: [], frameworks: [] },
): Record<string, string[]> {
  const selections: Record<string, string[]> = {};
  const assign = (values: string[], target: TechCategory["target"]) => {
    const fallback = catalog.find((c) => c.target === target);
    for (const value of values) {
      const owner =
        catalog.find((c) => c.target === target && c.items.some((i) => i.id === value)) ?? fallback;
      if (!owner) continue;
      (selections[owner.id] ??= []).push(value);
    }
  };
  assign(detected.languages, "languages");
  assign(detected.frameworks, "frameworks");
  return selections;
}

/** 技術 id → 表示名(カタログに無い自由入力の値は id をそのまま返す) */
export function techLabel(catalog: TechCategory[], id: string): string {
  for (const category of catalog) {
    const item = category.items.find((i) => i.id === id);
    if (item) return item.name;
  }
  return id;
}

/**
 * 「カテゴリ名: 技術1, 技術2」形式の行を組み立てる
 * (CLI の確認表示・エージェント定義への指示・ダッシュボードで共用)。
 */
export function formatTechStack(
  catalog: TechCategory[],
  stack: TechStack | undefined,
): { category: string; items: string[] }[] {
  if (!stack) return [];
  const selections = stack.categories ?? legacySelections(catalog, stack);
  const lines: { category: string; items: string[] }[] = [];
  for (const category of catalog) {
    const picked = selections[category.id] ?? [];
    if (picked.length === 0) continue;
    lines.push({
      category: category.name,
      items: picked.map((id) => techLabel(catalog, id)),
    });
  }
  return lines;
}

/**
 * categories を持たない古い TeamManifest(languages / frameworks だけ)の互換処理。
 * 検出値の振り分けと同じ規則でカテゴリに割り当てる。
 */
function legacySelections(catalog: TechCategory[], stack: TechStack): Record<string, string[]> {
  return detectedSelections(catalog, stack);
}
