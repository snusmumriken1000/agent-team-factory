import { existsSync, appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReverseDocKind, ReverseDocRecord, ReverseDocStatus } from "./types.js";

/** リバースドキュメント(コードから起こした文書)の記録置き場 */
export function docsDir(repoPath: string): string {
  return join(repoPath, ".claude", "atf-docs");
}

/** リバースドキュメントの索引(1 行 1 文書の JSONL) */
export function docsIndexPath(repoPath: string): string {
  return join(docsDir(repoPath), "docs.jsonl");
}

/** 文書の種類 → 表示ラベル(CLI・ダッシュボードで共通に使う) */
export const REVERSE_DOC_KIND_LABEL: Record<string, string> = {
  overview: "全体像(システム概要)",
  structure: "構造(モジュール・依存)",
  flow: "処理フロー(シーケンス)",
  data: "データ(モデル・パイプライン)",
  api: "インターフェース(API・CLI)",
  ops: "運用(実行・デプロイ・監視)",
  decision: "設計判断(コードから読み取れる意思決定)",
};

/** ダッシュボードでの表示順(全体像から詳細へ) */
const KIND_ORDER: ReverseDocKind[] = [
  "overview",
  "structure",
  "flow",
  "data",
  "api",
  "ops",
  "decision",
];

/**
 * docs.jsonl を読む(なければ空)。
 * doc-reverser は再生成のたびに追記するため、**同じ path の行は後勝ち**で
 * 最新の生成結果だけを残す(履歴は生ファイルに残る)。壊れた行は無視する。
 */
export function loadReverseDocs(repoPath: string): ReverseDocRecord[] {
  const path = docsIndexPath(repoPath);
  if (!existsSync(path)) return [];
  const latest = new Map<string, ReverseDocRecord>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as ReverseDocRecord;
      // path がない行は文書として追跡できないため捨てる(エージェントの自己申告のため寛容に扱う)
      if (!record?.path) continue;
      latest.set(record.path, record);
    } catch {
      // 壊れた行は無視
    }
  }
  return [...latest.values()].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.path.localeCompare(b.path),
  );
}

/** 記録を追記する(ディレクトリがなければ作成) */
export function appendReverseDocs(repoPath: string, records: ReverseDocRecord[]): void {
  if (records.length === 0) return;
  mkdirSync(docsDir(repoPath), { recursive: true });
  appendFileSync(docsIndexPath(repoPath), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/**
 * 記録と実ファイルを突き合わせる。リバースドキュメントは「コードが単一情報源」なので、
 * 文書・図が消えている / 根拠にしたコードが消えている(= 文書が古い可能性)を検出できるようにする。
 */
export function reverseDocStatuses(
  repoPath: string,
  records: ReverseDocRecord[] = loadReverseDocs(repoPath),
): ReverseDocStatus[] {
  return records.map((record) => ({
    record,
    docExists: existsSync(join(repoPath, record.path)),
    diagramExists: record.diagram ? existsSync(join(repoPath, record.diagram)) : undefined,
    // 根拠にしたコードが消えている = 文書が実装に追随していない疑い(要再生成)
    missingSources: (record.sources ?? []).filter((s) => !existsSync(join(repoPath, s))),
  }));
}

/** 追随できていない文書(本体・図が欠けている / 根拠のコードが消えている)だけを返す */
export function staleReverseDocs(statuses: ReverseDocStatus[]): ReverseDocStatus[] {
  return statuses.filter(
    (s) => !s.docExists || s.diagramExists === false || s.missingSources.length > 0,
  );
}
