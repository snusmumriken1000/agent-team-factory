import { describe, it, expect } from "vitest";
import {
  detectedSelections,
  formatTechStack,
  loadTechStackCatalog,
  techLabel,
  toTechStack,
} from "./techstack.js";
import type { TechCategory } from "./types.js";

const catalog: TechCategory[] = [
  {
    id: "languages",
    name: "言語",
    target: "languages",
    always: true,
    items: [
      { id: "typescript", name: "TypeScript" },
      { id: "java", name: "Java" },
    ],
  },
  {
    id: "frameworks",
    name: "フレームワーク",
    target: "frameworks",
    always: true,
    items: [{ id: "react", name: "React" }],
  },
  {
    id: "database",
    name: "データベース・スキーマ管理",
    target: "frameworks",
    items: [
      { id: "liquibase", name: "Liquibase(マイグレーション)" },
      { id: "tbls", name: "tbls(スキーマドキュメント生成)" },
    ],
  },
];

describe("同梱の技術スタックカタログ", () => {
  const loaded = loadTechStackCatalog();

  it("言語・フレームワーク・DB 管理のカテゴリを含む", () => {
    const ids = loaded.map((c) => c.id);
    expect(ids).toContain("languages");
    expect(ids).toContain("frameworks");
    expect(ids).toContain("database");
  });

  it("DB カテゴリにマイグレーション・ドキュメント生成ツールが入っている", () => {
    const db = loaded.find((c) => c.id === "database");
    const ids = db?.items.map((i) => i.id) ?? [];
    expect(ids).toEqual(expect.arrayContaining(["liquibase", "flyway", "tbls", "liam-erd"]));
  });

  it("言語カテゴリの target は languages、他は frameworks に寄せる", () => {
    expect(loaded.find((c) => c.id === "languages")?.target).toBe("languages");
    expect(loaded.find((c) => c.id === "database")?.target).toBe("frameworks");
  });

  it("id と表示名が全カテゴリで重複しない(選択肢の取り違えを防ぐ)", () => {
    for (const category of loaded) {
      const ids = category.items.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(category.items.every((i) => i.name.trim() !== "")).toBe(true);
    }
  });

  it("カタログが無ければ空配列を返す", () => {
    expect(loadTechStackCatalog("/nonexistent/tech-stack.json")).toEqual([]);
  });
});

describe("toTechStack(カテゴリ選択 → TechStack)", () => {
  it("target ごとに languages / frameworks へ平坦化する", () => {
    const stack = toTechStack(catalog, {
      languages: ["java"],
      database: ["liquibase", "tbls"],
    });
    expect(stack.languages).toEqual(["java"]);
    expect(stack.frameworks).toEqual(["liquibase", "tbls"]);
    expect(stack.categories).toEqual({ languages: ["java"], database: ["liquibase", "tbls"] });
  });

  it("空の選択はカテゴリごと落とし、重複は除く", () => {
    const stack = toTechStack(catalog, {
      languages: ["typescript", "typescript"],
      frameworks: [],
      database: ["liquibase"],
    });
    expect(stack.languages).toEqual(["typescript"]);
    expect(stack.categories).toEqual({ languages: ["typescript"], database: ["liquibase"] });
  });
});

describe("detectedSelections(検出値のカテゴリ振り分け)", () => {
  it("カタログにある技術はそのカテゴリに割り当てる", () => {
    const selections = detectedSelections(catalog, {
      languages: ["typescript"],
      frameworks: ["react", "tbls"],
    });
    expect(selections).toEqual({
      languages: ["typescript"],
      frameworks: ["react"],
      database: ["tbls"],
    });
  });

  it("カタログにない検出値は target が一致する先頭カテゴリに寄せる(捨てない)", () => {
    const selections = detectedSelections(catalog, { languages: [], frameworks: ["maven"] });
    expect(selections).toEqual({ frameworks: ["maven"] });
  });
});

describe("表示用の整形", () => {
  it("カテゴリ名と表示名で組み立てる", () => {
    const stack = toTechStack(catalog, { languages: ["java"], database: ["tbls"] });
    expect(formatTechStack(catalog, stack)).toEqual([
      { category: "言語", items: ["Java"] },
      { category: "データベース・スキーマ管理", items: ["tbls(スキーマドキュメント生成)"] },
    ]);
  });

  it("categories を持たない古い TeamManifest でもカテゴリに振り分けて表示する", () => {
    const legacy = { languages: ["java"], frameworks: ["liquibase"] };
    expect(formatTechStack(catalog, legacy)).toEqual([
      { category: "言語", items: ["Java"] },
      { category: "データベース・スキーマ管理", items: ["Liquibase(マイグレーション)"] },
    ]);
  });

  it("未選択・未設定なら空", () => {
    expect(formatTechStack(catalog, undefined)).toEqual([]);
    expect(formatTechStack(catalog, { languages: [], frameworks: [], categories: {} })).toEqual([]);
  });

  it("カタログにない id は id をそのまま表示名にする(自由入力)", () => {
    expect(techLabel(catalog, "typescript")).toBe("TypeScript");
    expect(techLabel(catalog, "cobol")).toBe("cobol");
  });
});
