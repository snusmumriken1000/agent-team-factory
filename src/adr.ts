import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * ADR(Architecture Decision Record)の読み取り。
 *
 * ADR は**現在の状態を記述しない**(現行ルールは `spec/*.als` が単一情報源)。
 * ここに残すのは「いつ・何を・なぜ決めたか」と「却下した案」だけで、追記のみ・書き換えない。
 * atf は読んで突き合わせる(トレーサビリティ・孤児検出)だけで、内容は書かない。
 */

/** ADR の置き場(プロジェクトの一級成果物なので docs/ に置く) */
export function adrDir(repoPath: string): string {
  return join(repoPath, "docs", "adr");
}

/** ADR の状態。superseded は後続の ADR に置き換えられたもの */
export type AdrStatus = "proposed" | "accepted" | "rejected" | "superseded" | "unknown";

export interface AdrRecord {
  /** ファイル名(例: 0007-role-inheritance.md) */
  file: string;
  /** 連番から作る ID(例: ADR-0007) */
  id: string;
  /** 見出し(先頭の `# ` 行。ID 部分は落とす) */
  title: string;
  status: AdrStatus;
  /** `Status: superseded by ADR-0012` の参照先 ID */
  supersededBy?: string;
  /** `Date:` の日付(YYYY-MM-DD。なければ undefined) */
  date?: string;
  /** `Refs:` に並ぶ要件 ID(孤児検出の対象) */
  refs: string[];
  /** 「## 決定」節の本文(現在形の規範文が混ざっていないかの検査に使う) */
  decision: string;
}

/** `Status:` 行を状態と置き換え先に読み下す */
function parseStatus(value: string): { status: AdrStatus; supersededBy?: string } {
  const text = value.trim().toLowerCase();
  const superseded = text.match(/superseded\s+by\s+(adr-?\d+)/);
  if (superseded) {
    return { status: "superseded", supersededBy: normalizeAdrId(superseded[1]) };
  }
  if (text.startsWith("accepted")) return { status: "accepted" };
  if (text.startsWith("proposed")) return { status: "proposed" };
  if (text.startsWith("rejected")) return { status: "rejected" };
  return { status: "unknown" };
}

/** `ADR-7` / `adr-0007` / `0007` を `ADR-0007` に揃える */
export function normalizeAdrId(text: string): string {
  const digits = text.match(/(\d+)/)?.[1];
  return digits ? `ADR-${digits.padStart(4, "0")}` : text.trim();
}

/** 1 件の ADR(Markdown)を読み下す */
export function parseAdr(file: string, source: string): AdrRecord {
  const lines = source.split("\n");
  const heading = lines.find((l) => l.startsWith("# "))?.slice(2).trim() ?? "";
  const meta = (key: string): string | undefined =>
    lines.find((l) => new RegExp(`^${key}\\s*:`, "i").test(l.trim()))?.split(":").slice(1).join(":").trim();

  const { status, supersededBy } = parseStatus(meta("Status") ?? "");
  const refs = (meta("Refs") ?? "")
    .split(/[,、]/)
    .map((r) => r.trim())
    .filter((r) => r !== "" && r !== "-");

  // 「## 決定」節(次の h2 まで)。現在形の規範文が混ざっていないかの検査に使う
  const start = lines.findIndex((l) => /^##\s+決定/.test(l.trim()));
  let decision = "";
  if (start >= 0) {
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^##\s/.test(l.trim()));
    decision = (end >= 0 ? rest.slice(0, end) : rest).join("\n").trim();
  }

  return {
    file,
    id: normalizeAdrId(file),
    title: heading.replace(/^ADR-?\d+\s*[:：]\s*/i, "").trim(),
    status,
    ...(supersededBy ? { supersededBy } : {}),
    ...(meta("Date") ? { date: meta("Date") } : {}),
    refs,
    decision,
  };
}

/** docs/adr/*.md を番号順に読む(README.md は規約の説明なので除く) */
export function loadAdrs(repoPath: string): AdrRecord[] {
  const dir = adrDir(repoPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && /^\d+/.test(f))
    .sort()
    .map((f) => parseAdr(f, readFileSync(join(dir, f), "utf8")));
}

/** 要件 ID → その要件を参照している ADR(トレーサビリティ表の入力) */
export function adrsByRequirement(adrs: AdrRecord[]): Map<string, AdrRecord[]> {
  const map = new Map<string, AdrRecord[]>();
  for (const adr of adrs) {
    for (const ref of adr.refs) {
      map.set(ref, [...(map.get(ref) ?? []), adr]);
    }
  }
  return map;
}
