import { bulletValue, extractBullets, hasChinese, looksLowSignal, parseModelJsonObject } from "./compose_common.ts";

export type EconomistFact = { rank: number; originalTitle: string; section: string; author: string; originUrl: string };
export type EconomistModelItem = { rank: number; titleZh: string; oneSentenceSummary: string; corePoint: string; contentSummary: string };

function sourceBlocks(source: string): string[] {
  return source.split(/(?=^##\s+\d+\.\s+)/gm).map(block => block.trim()).filter(block => /^##\s+\d+\.\s+/.test(block));
}

export function parseEconomistFacts(source: string): EconomistFact[] {
  return sourceBlocks(source).map((block, index) => {
    const bullets = extractBullets(block);
    return {
      rank: index + 1,
      originalTitle: block.match(/^##\s+\d+\.\s+(.+)$/m)?.[1]?.trim() || "",
      section: bulletValue(bullets, "栏目") || "未标明",
      author: bulletValue(bullets, "作者") || "未标明",
      originUrl: bulletValue(bullets, "原文链接") === "-" ? "" : bulletValue(bullets, "原文链接"),
    };
  });
}

function modelItems(raw: unknown, expected: number): EconomistModelItem[] {
  if (!Array.isArray(raw) || raw.length !== expected) throw new Error(`economist weekly model article count does not match source count: ${Array.isArray(raw) ? raw.length : "invalid"} vs ${expected}`);
  const ranks = new Set<number>();
  return raw.map((entry, index) => {
    const row = (entry || {}) as Record<string, unknown>;
    const rank = Number(row.rank);
    const titleZh = String(row.title_zh || "").trim();
    const oneSentenceSummary = String(row.one_sentence_summary || "").trim();
    const corePoint = String(row.core_point || "").trim();
    const contentSummary = String(row.content_summary || "").trim();
    if (!Number.isInteger(rank) || rank < 1 || rank > expected || ranks.has(rank)) throw new Error(`economist weekly article ${index + 1} has invalid or duplicate rank`);
    ranks.add(rank);
    if (!titleZh || !hasChinese(titleZh)) throw new Error(`economist weekly rank ${rank} needs a Chinese title`);
    if (!oneSentenceSummary || !corePoint || !contentSummary || [oneSentenceSummary, corePoint, contentSummary].some(looksLowSignal)) {
      throw new Error(`economist weekly rank ${rank} has empty or low-signal summary`);
    }
    return { rank, titleZh, oneSentenceSummary, corePoint, contentSummary };
  });
}

export function parseEconomistWeeklyModelJson(raw: string, expectedArticles: number): {
  description: string;
  issueOverview: string;
  readingRoute: string;
  articles: EconomistModelItem[];
} {
  const parsed = parseModelJsonObject(raw, "economist-weekly");
  const description = String(parsed.description || "").trim();
  const issueOverview = String(parsed.issue_overview || "").trim();
  const readingRoute = String(parsed.reading_route || "").trim();
  if (looksLowSignal(issueOverview) || looksLowSignal(readingRoute)) throw new Error("economist weekly model needs issue_overview and reading_route");
  return { description, issueOverview, readingRoute, articles: modelItems(parsed.articles, expectedArticles) };
}

export function economistWeeklyMarkdownFromModelJson(raw: string, source: string): string {
  const facts = parseEconomistFacts(source);
  if (facts.length < 3) throw new Error(`economist weekly source needs at least three articles, got ${facts.length}`);
  const { issueOverview, readingRoute, articles: items } = parseEconomistWeeklyModelJson(raw, facts.length);
  const byRank = new Map(items.map(item => [item.rank, item]));
  const articles = facts.map(fact => {
    const item = byRank.get(fact.rank);
    if (!item) throw new Error(`economist weekly model misses rank ${fact.rank}`);
    const meta = [`- 原题：${fact.originalTitle}`, `- 栏目：${fact.section}`, `- 作者：${fact.author}`];
    if (fact.originUrl) meta.push(`- 来源：[The Economist](${fact.originUrl})`);
    return [
      `### ${item.titleZh}（${fact.originalTitle}）`,
      "",
      ...meta,
      "",
      "#### 一句话摘要",
      "",
      item.oneSentenceSummary,
      "",
      "#### 核心观点",
      "",
      item.corePoint,
      "",
      "#### 内容总结",
      "",
      item.contentSummary,
    ].join("\n");
  });
  return ["## 本期主题脉络", "", issueOverview, "", "## 精选文章", "", articles.join("\n\n"), "", "## 阅读路线", "", readingRoute, ""].join("\n");
}
