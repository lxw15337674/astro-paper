// HN Top10 规则层：模型只返回语义 JSON（中文标题 + 两段总结），
// 事实字段（热度/主题/原文/HN 讨论链接）一律取自脚本抓取的 source，
// 由这里确定性地组装成 archive 层可消费的中间契约 Markdown。
import { ARCHIVE_PAYLOAD_MARKER, hasChinese, looksLowSignal } from "./astro_paper_archive.ts";

// 模型必须产出的语义字段。
export type HnModelItem = {
  rank: number;
  title_zh: string;
  content_summary: string;
  comment_summary: string;
};

// 从 source 解析出的事实字段；这些都不经过模型。
export type HnSourceFact = {
  rank: number;
  points: string;
  topic: string;
  url: string;
  hn_link: string;
};

function extractBullets(block: string): string[] {
  return block
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("- "))
    .map(line => line.slice(2).trim());
}

function bulletValue(bullets: string[], label: string): string {
  return bullets.find(bullet => bullet.startsWith(label))?.split("：").slice(1).join("：").trim() || "";
}

// 解析 source 的编号块，取出每条的事实字段。
// 兼容两种 source：带 `===ARCHIVE_PAYLOAD===` 的真实抓取产物，以及不带 payload 的测试 fixture。
export function parseSourceFacts(source: string): HnSourceFact[] {
  const markerIndex = source.indexOf(ARCHIVE_PAYLOAD_MARKER);
  const body = markerIndex >= 0 ? source.slice(0, markerIndex) : source;
  const blocks = body
    .split(/(?=^\d+\.\s*🔥?\s+)/gm)
    .map(block => block.trim())
    .filter(block => /^\d+\.\s*🔥?\s+/.test(block) && !/今日 HackerNews 热门文章 Top 10/.test(block));
  const facts: HnSourceFact[] = [];
  blocks.forEach((block, index) => {
    const bullets = extractBullets(block);
    facts.push({
      rank: index + 1,
      points: bullets.find(bullet => bullet.startsWith("⭐"))?.replace(/^⭐\s*/, "").trim() || "",
      topic: bulletValue(bullets, "主题") || "技术 / 观察",
      url: bulletValue(bullets, "原文"),
      hn_link: bulletValue(bullets, "HN 讨论"),
    });
  });
  return facts;
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return trimmed;
  return trimmed.slice(start, end + 1);
}

// 解析并校验模型 JSON。失败抛出可读 error，交给重试循环反馈给模型。
export function parseHnModelJson(raw: string, expectedCount?: number): HnModelItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch (error) {
    throw new Error(`HN model output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rawItems = (parsed as { items?: unknown }).items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new Error("HN model JSON must contain a non-empty items array");
  if (typeof expectedCount === "number" && rawItems.length !== expectedCount) {
    throw new Error(`HN model JSON item count ${rawItems.length} does not match source count ${expectedCount}`);
  }
  return rawItems.map((entry, index) => {
    const item = (entry || {}) as Record<string, unknown>;
    const rank = Number(item.rank);
    if (!Number.isInteger(rank) || rank < 1) throw new Error(`HN model item ${index + 1} has invalid rank: ${String(item.rank)}`);
    const titleZh = String(item.title_zh || "").trim();
    if (!titleZh) throw new Error(`HN model item rank ${rank} is missing title_zh`);
    if (!hasChinese(titleZh)) throw new Error(`HN model item rank ${rank} title should use a Chinese title: ${titleZh}`);
    const contentSummary = String(item.content_summary || "").trim();
    const commentSummary = String(item.comment_summary || "").trim();
    if (!contentSummary || looksLowSignal(contentSummary)) throw new Error(`HN model item rank ${rank} has empty or low-signal content_summary`);
    if (!commentSummary || looksLowSignal(commentSummary)) throw new Error(`HN model item rank ${rank} has empty or low-signal comment_summary`);
    return { rank, title_zh: titleZh, content_summary: contentSummary, comment_summary: commentSummary };
  });
}

// 按 rank join 事实 + 语义，输出 archive 层 `formatHnTop10` 直接消费的中间契约 Markdown。
export function composeHnBody(modelItems: HnModelItem[], facts: HnSourceFact[]): string {
  if (!facts.length) throw new Error("HN source produced no items to compose");
  const byRank = new Map(modelItems.map(item => [item.rank, item]));
  const blocks = facts.map(fact => {
    const model = byRank.get(fact.rank);
    if (!model) throw new Error(`HN model JSON is missing rank ${fact.rank}`);
    const lines = [`${fact.rank}. 🔥 ${model.title_zh}`];
    if (fact.points) lines.push(`- ⭐ ${fact.points}`);
    lines.push(`- 主题：${fact.topic}`);
    if (fact.url) lines.push(`- 原文：${fact.url}`);
    if (fact.hn_link) lines.push(`- HN 讨论：${fact.hn_link}`);
    lines.push(`- 内容总结：${model.content_summary}`);
    lines.push(`- 评论总结：${model.comment_summary}`);
    return lines.join("\n");
  });
  return `${blocks.join("\n\n")}\n`;
}

// 端到端便捷入口：source + 模型原始 JSON → 中间契约 Markdown。
export function hnMarkdownFromModelJson(raw: string, source: string): string {
  const facts = parseSourceFacts(source);
  const items = parseHnModelJson(raw, facts.length);
  return composeHnBody(items, facts);
}
