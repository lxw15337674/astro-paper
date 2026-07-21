import { bulletValue, extractBullets, hasChinese, looksLowSignal, parseModelJsonObject } from "./compose_common.ts";

export type EconomistArticleSummary = {
  rank: number;
  originUrl: string;
  titleZh: string;
  oneSentenceSummary: string;
  corePoint: string;
  contentSummary: string;
};

function sourceBlocks(source: string): string[] {
  return source
    .split(/(?=^##\s+\d+\.\s+)/gm)
    .map(block => block.trim())
    .filter(block => /^##\s+\d+\.\s+/.test(block));
}

export function parseEconomistArticleSummaries(source: string): EconomistArticleSummary[] {
  const ranks = new Set<number>();
  return sourceBlocks(source).map((block, index) => {
    const rank = Number(block.match(/^##\s+(\d+)\./m)?.[1]);
    const bullets = extractBullets(block);
    const originUrl = bulletValue(bullets, "原文链接") === "-" ? "" : bulletValue(bullets, "原文链接");
    const titleZh = bulletValue(bullets, "中文标题");
    const oneSentenceSummary = bulletValue(bullets, "一句话摘要");
    const corePoint = bulletValue(bullets, "核心观点");
    const contentSummary = bulletValue(bullets, "内容总结");
    if (!Number.isInteger(rank) || rank < 1 || ranks.has(rank)) throw new Error(`economist weekly article ${index + 1} has invalid or duplicate rank`);
    ranks.add(rank);
    if (!titleZh || !hasChinese(titleZh)) throw new Error(`economist weekly rank ${rank} needs a Chinese title`);
    if ([oneSentenceSummary, corePoint, contentSummary].some(looksLowSignal)) throw new Error(`economist weekly rank ${rank} has empty or low-signal summary`);
    if (![oneSentenceSummary, corePoint, contentSummary].every(hasChinese)) throw new Error(`economist weekly rank ${rank} summaries must be Chinese`);
    return { rank, originUrl, titleZh, oneSentenceSummary, corePoint, contentSummary };
  });
}

export function parseEconomistWeeklyModelJson(raw: string): {
  description: string;
  issueOverview: string;
  readingRoute: string;
} {
  const parsed = parseModelJsonObject(raw, "economist-weekly");
  const description = String(parsed.description || "").trim();
  const issueOverview = String(parsed.issue_overview || "").trim();
  const readingRoute = String(parsed.reading_route || "").trim();
  if ([description, issueOverview, readingRoute].some(looksLowSignal)) throw new Error("economist weekly model needs description, issue_overview and reading_route");
  return { description, issueOverview, readingRoute };
}

export function economistWeeklyMarkdownFromModelJson(raw: string, source: string): string {
  const articles = parseEconomistArticleSummaries(source);
  if (articles.length < 3) throw new Error(`economist weekly source needs at least three articles, got ${articles.length}`);
  const { issueOverview, readingRoute } = parseEconomistWeeklyModelJson(raw);
  const renderedArticles = articles.map(article => {
    const lines = [`### ${article.titleZh}`, ""];
    if (article.originUrl) lines.push(`- 原文：[The Economist](${article.originUrl})`, "");
    lines.push(
      "#### 一句话摘要",
      "",
      article.oneSentenceSummary,
      "",
      "#### 核心观点",
      "",
      article.corePoint,
      "",
      "#### 内容总结",
      "",
      article.contentSummary,
    );
    return lines.join("\n");
  });
  return ["## 本期主题脉络", "", issueOverview, "", "## 全部文章", "", renderedArticles.join("\n\n"), "", "## 阅读路线", "", readingRoute, ""].join("\n");
}
