// Reddit Top 20 规则层：模型只返回语义 JSON（中文标题 + 总结），
// 事实字段（热度/来源/帖子链接）一律取自脚本抓取的 source，
// 由这里确定性地组装成 archive 层可消费的中间契约 Markdown。
import { ARCHIVE_PAYLOAD_MARKER, hasChinese, looksLowSignal } from "./astro_paper_archive.ts";

export type RedditModelItem = {
  rank: number;
  title_zh: string;
  summary: string;
};

export type RedditSourceFact = {
  rank: number;
  subreddit: string;
  points: string;
  url: string;
};

function extractBullets(block: string): string[] {
  return block
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("- "))
    .map(line => line.slice(2).trim());
}

function bulletValue(bullets: string[], label: string): string {
  return bullets.find(b => b.startsWith(label))?.split("：").slice(1).join("：").trim() ?? "";
}

export function parseSourceFacts(source: string): RedditSourceFact[] {
  const markerIndex = source.indexOf(ARCHIVE_PAYLOAD_MARKER);
  const body = markerIndex >= 0 ? source.slice(0, markerIndex) : source;
  const blocks = body
    .split(/(?=^\d+\.\s*\[r\/)/gm)
    .map(block => block.trim())
    .filter(block => /^\d+\.\s*\[r\//.test(block));
  return blocks.map((block, index) => {
    const bullets = extractBullets(block);
    return {
      rank: index + 1,
      subreddit: block.match(/^\d+\.\s*\[r\/([^\]]+)\]/)?.[1] ?? "",
      points: bullets.find(b => b.startsWith("⭐"))?.replace(/^⭐\s*/, "").trim() ?? "",
      url: bulletValue(bullets, "帖子链接"),
    };
  });
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return trimmed;
  return trimmed.slice(start, end + 1);
}

export function parseRedditModelJson(raw: string, expectedCount?: number): RedditModelItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch (error) {
    throw new Error(`Reddit model output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rawItems = (parsed as { items?: unknown }).items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new Error("Reddit model JSON must contain a non-empty items array");
  if (typeof expectedCount === "number" && rawItems.length !== expectedCount) {
    throw new Error(`Reddit model JSON item count ${rawItems.length} does not match source count ${expectedCount}`);
  }
  return rawItems.map((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const rank = Number(item.rank);
    if (!Number.isInteger(rank) || rank < 1) throw new Error(`Reddit model item ${index + 1} has invalid rank: ${String(item.rank)}`);
    const titleZh = String(item.title_zh ?? "").trim();
    if (!titleZh) throw new Error(`Reddit model item rank ${rank} is missing title_zh`);
    if (!hasChinese(titleZh)) throw new Error(`Reddit model item rank ${rank} title_zh must use Chinese: ${titleZh}`);
    const summary = String(item.summary ?? "").trim();
    if (!summary || looksLowSignal(summary)) throw new Error(`Reddit model item rank ${rank} has empty or low-signal summary`);
    return { rank, title_zh: titleZh, summary };
  });
}

export function composeRedditBody(modelItems: RedditModelItem[], facts: RedditSourceFact[]): string {
  if (!facts.length) throw new Error("Reddit source produced no items to compose");
  const byRank = new Map(modelItems.map(item => [item.rank, item]));
  const blocks = facts.map(fact => {
    const model = byRank.get(fact.rank);
    if (!model) throw new Error(`Reddit model JSON is missing rank ${fact.rank}`);
    const lines = [`${fact.rank}. 🔴 ${model.title_zh}`];
    if (fact.points) lines.push(`- ⭐ ${fact.points}`);
    if (fact.subreddit) lines.push(`- 来源：r/${fact.subreddit}`);
    if (fact.url) lines.push(`- 帖子：${fact.url}`);
    lines.push(`- 总结：${model.summary}`);
    return lines.join("\n");
  });
  return `${blocks.join("\n\n")}\n`;
}

export function redditMarkdownFromModelJson(raw: string, source: string): string {
  const facts = parseSourceFacts(source);
  const items = parseRedditModelJson(raw, facts.length);
  return composeRedditBody(items, facts);
}
