// GitHub Trending 规则层：模型只返回语义字段（项目总结/技术栈/使用场景），
// 事实字段（owner/repo、链接、Stars/Forks/今日新增 Stars）一律取自 source。
import { bulletValue, extractBullets, looksLowSignal, parseModelJsonObject } from "./compose_common.ts";

export type GitHubTrendingModelItem = {
  rank: number;
  project_summary: string;
  tech_stack: string;
  use_case: string;
};

export type GitHubTrendingFact = {
  rank: number;
  repo: string; // owner/repo
  url: string;
  stars: string;
  forks: string;
  today_stars: string;
};

// 解析 source `### N. [owner/repo](url)` 证据块的事实字段。
export function parseGitHubTrendingFacts(source: string): GitHubTrendingFact[] {
  const blocks = source
    .split(/(?=^###\s+\d+\.\s+\[)/gm)
    .map(block => block.trim())
    .filter(block => /^###\s+\d+\.\s+\[[^\]]+\]\(https:\/\/github\.com\/[^)]+\)/.test(block));
  return blocks.map((block, index) => {
    const heading = block.match(/^###\s+\d+\.\s+\[([^\]]+)\]\((https:\/\/github\.com\/[^)]+)\)/) || [];
    const bullets = extractBullets(block);
    return {
      rank: index + 1,
      repo: (heading[1] || "").trim(),
      url: (heading[2] || "").trim(),
      stars: bulletValue(bullets, "Stars"),
      forks: bulletValue(bullets, "Forks"),
      today_stars: bulletValue(bullets, "今日新增 Stars"),
    };
  });
}

export function parseGitHubTrendingModelJson(raw: string, expectedCount?: number): GitHubTrendingModelItem[] {
  const parsed = parseModelJsonObject(raw, "GitHub trending");
  const rawItems = parsed.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new Error("GitHub trending model JSON must contain a non-empty items array");
  if (typeof expectedCount === "number" && rawItems.length !== expectedCount) {
    throw new Error(`GitHub trending model JSON item count ${rawItems.length} does not match source count ${expectedCount}`);
  }
  return rawItems.map((entry, index) => {
    const item = (entry || {}) as Record<string, unknown>;
    const rank = Number(item.rank);
    if (!Number.isInteger(rank) || rank < 1) throw new Error(`GitHub trending item ${index + 1} has invalid rank: ${String(item.rank)}`);
    const projectSummary = String(item.project_summary || "").trim();
    const techStack = String(item.tech_stack || "").trim();
    const useCase = String(item.use_case || "").trim();
    if (!projectSummary || looksLowSignal(projectSummary)) throw new Error(`GitHub trending item rank ${rank} has empty or low-signal project_summary`);
    if (!techStack || /^未明确$|^未提供$/.test(techStack)) throw new Error(`GitHub trending item rank ${rank} has empty tech_stack`);
    if (!useCase || looksLowSignal(useCase)) throw new Error(`GitHub trending item rank ${rank} has empty or low-signal use_case`);
    return { rank, project_summary: projectSummary, tech_stack: techStack, use_case: useCase };
  });
}

export function composeGitHubTrendingBody(modelItems: GitHubTrendingModelItem[], facts: GitHubTrendingFact[]): string {
  if (facts.length < 5) throw new Error(`GitHub trending source has too few projects to compose: ${facts.length}`);
  const byRank = new Map(modelItems.map(item => [item.rank, item]));
  const blocks = facts.map(fact => {
    const model = byRank.get(fact.rank);
    if (!model) throw new Error(`GitHub trending model JSON is missing rank ${fact.rank}`);
    return [
      `## ${fact.rank}. [${fact.repo}](${fact.url})`,
      "",
      `- 项目总结：${model.project_summary}`,
      `- 技术栈：${model.tech_stack}`,
      `- 使用场景：${model.use_case}`,
      `- Stars：${fact.stars}`,
      `- Forks：${fact.forks}`,
      `- 今日新增 Stars：${fact.today_stars}`,
    ].join("\n");
  });
  return `${blocks.join("\n\n")}\n`;
}

export function githubTrendingMarkdownFromModelJson(raw: string, source: string): string {
  const facts = parseGitHubTrendingFacts(source);
  const items = parseGitHubTrendingModelJson(raw, facts.length);
  return composeGitHubTrendingBody(items, facts);
}
