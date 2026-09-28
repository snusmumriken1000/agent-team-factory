/**
 * Markdown 先頭の frontmatter(`---` 〜 `---`)から name / description を読む。
 * サブエージェント定義(templates/presets, templates/common)とスキル定義
 * (templates/skills)で同じ書式を使うため、両者の単一情報源としてここに置く。
 */
export function parseFrontmatter(
  source: string,
  fallbackName: string,
): { name: string; description: string } {
  const fm = source.match(/^---\n([\s\S]*?)\n---/);
  const meta: Record<string, string> = {};
  for (const line of fm?.[1].split("\n") ?? []) {
    const m = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { name: meta.name ?? fallbackName, description: meta.description ?? "" };
}
