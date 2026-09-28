import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityFinding, CapabilityPlan, CapabilityVerdict } from "./types.js";

/** 最新機能の調査結果・組み込み計画書の置き場 */
export function capabilitiesDir(repoPath: string): string {
  return join(repoPath, ".claude", "atf-capabilities");
}

/** 調査結果ファイル(1 行 1 機能の JSONL) */
export function findingsPath(repoPath: string): string {
  return join(capabilitiesDir(repoPath), "findings.jsonl");
}

/** 採否 → 表示用ラベル(ダッシュボード・CLI で共通に使う) */
export const VERDICT_LABEL: Record<CapabilityVerdict, string> = {
  adopt: "✅ 組み込める",
  trial: "🧪 組み込める(まず試行)",
  hold: "⏸️ 条件付き",
  reject: "🚫 組み込めない",
};

/** 組み込めると判定されたか(adopt / trial が「組み込めるもの」) */
export function isAdoptable(verdict: string): boolean {
  return verdict === "adopt" || verdict === "trial";
}

/**
 * findings.jsonl を読む(なければ空)。
 * capability-scout は再調査のたびに追記するため、**同じ id の行は後勝ち**で
 * 最新の判定だけを残す(記録の履歴は生ファイルに残る)。壊れた行は無視する。
 */
export function loadCapabilityFindings(repoPath: string): CapabilityFinding[] {
  const path = findingsPath(repoPath);
  if (!existsSync(path)) return [];
  const latest = new Map<string, CapabilityFinding>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const finding = JSON.parse(trimmed) as CapabilityFinding;
      // id と name がない行は表にできないため捨てる(エージェントの自己申告のため寛容に扱う)
      if (!finding?.id || !finding?.name) continue;
      latest.set(finding.id, finding);
    } catch {
      // 壊れた行は無視
    }
  }
  return [...latest.values()];
}

/** .claude/atf-capabilities/plan-*.md(組み込み計画書)を読む(なければ空) */
export function loadCapabilityPlans(repoPath: string): CapabilityPlan[] {
  const dir = capabilitiesDir(repoPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^plan-.+\.md$/.test(f))
    .sort()
    .map((file) => {
      const content = readFileSync(join(dir, file), "utf8");
      return {
        file,
        id: file.replace(/^plan-/, "").replace(/\.md$/, ""),
        title: content.match(/^#\s+(.+)$/m)?.[1].trim() ?? file,
      };
    });
}
