#!/usr/bin/env tsx
import { JSDOM } from "jsdom";
import { avoidCloudflareEmailObfuscation, clipText, compact, fetchText, parseArgs, stringArg, writeStderr, writeStdout } from "./blog_common.ts";

type AiWeeklyCategory = "model" | "agent" | "infra" | "coding" | "safety" | "research" | "product";

type FeedSource = {
  name: string;
  url: string;
  category: AiWeeklyCategory;
};

type AiWeeklyItem = {
  title: string;
  url: string;
  source: string;
  category: AiWeeklyCategory;
  publishedAt: string;
  summary: string;
};

const FEED_SOURCES: FeedSource[] = [
  { name: "OpenAI News", url: "https://openai.com/news/rss.xml", category: "model" },
  { name: "Anthropic News", url: "https://www.anthropic.com/news/rss.xml", category: "model" },
  { name: "Google DeepMind Blog", url: "https://deepmind.google/blog/rss.xml", category: "research" },
  { name: "Google AI Developers", url: "https://developers.googleblog.com/en/rss/", category: "product" },
  { name: "Hugging Face Blog", url: "https://huggingface.co/blog/feed.xml", category: "model" },
  { name: "GitHub AI", url: "https://github.blog/ai-and-ml/feed/", category: "coding" },
  { name: "Cloudflare AI", url: "https://blog.cloudflare.com/rss/", category: "infra" },
  { name: "LangChain Blog", url: "https://blog.langchain.com/rss/", category: "agent" },
  { name: "LlamaIndex Blog", url: "https://www.llamaindex.ai/blog/rss.xml", category: "agent" },
  { name: "Vercel Blog", url: "https://vercel.com/blog/rss.xml", category: "infra" },
  { name: "Modal Blog", url: "https://modal.com/blog/rss.xml", category: "infra" },
  { name: "Replicate Blog", url: "https://replicate.com/blog/rss", category: "infra" },
  { name: "AWS Machine Learning Blog", url: "https://aws.amazon.com/blogs/machine-learning/feed/", category: "infra" },
  { name: "Databricks Blog", url: "https://www.databricks.com/feed", category: "infra" },
  { name: "Weaviate Blog", url: "https://weaviate.io/blog/rss.xml", category: "infra" },
  { name: "GitHub Security Lab", url: "https://github.blog/security/vulnerability-research/feed/", category: "safety" },
  { name: "METR Blog", url: "https://metr.org/blog/rss.xml", category: "safety" },
  { name: "Epoch AI", url: "https://epoch.ai/blog/rss.xml", category: "research" },
  { name: "Vercel AI SDK Releases", url: "https://github.com/vercel/ai/releases.atom", category: "agent" },
];

const AI_SIGNAL_PATTERNS = [
  /\bAI\b|\bLLM\b|\bmodel\b|\bagent\b|\bagents\b|\bRAG\b|\binference\b|\beval(?:uation)?\b|\bbenchmark\b|\balignment\b|\bsafety\b|\bred team\b|\bcontext\b|\brouting\b|\btoken\b|\bcopilot\b|\bcoding assistant\b|\btool calling\b|\bMCP\b|\bGPU\b|\bvector\b|\bembedding\b|\bsynthetic data\b/i,
  /大模型|模型|智能体|Agent|推理|评测|基准|对齐|安全|红队|上下文|路由|token|编程助手|工具调用|向量|嵌入|合成数据|算力|治理|幻觉/,
];

const LOW_SIGNAL_PATTERNS = [
  /funding|series [abc]|raises? \$|acquired|partnership|webinar|event recap|course|newsletter|top \d+|tools? list/i,
  /融资|榜单|工具推荐|课程|直播|大会回顾|合作伙伴|白皮书下载|预约演示/,
];

const PURE_TUTORIAL_PATTERNS = [
  /\bhow to\b/i,
  /\btutorial\b/i,
  /\bgetting started\b/i,
  /\bbeginner/i,
  /\bwhat is\b/i,
  /prompt tips/i,
  /一文[读看搞]懂/,
  /从零/,
  /入门/,
  /教程/,
  /提示词技巧/,
];

function textOf(element: Element | null | undefined): string {
  return compact(element?.textContent || "");
}

function attr(element: Element | null | undefined, name: string): string {
  return element?.getAttribute(name) || "";
}

function parseDate(raw: string): string {
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}

function stripCdata(text: string): string {
  return text.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function stripHtml(text: string): string {
  return compact(stripCdata(text).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " "));
}

function parseFeedItems(xml: string, source: FeedSource): AiWeeklyItem[] {
  const dom = new JSDOM(xml, { contentType: "text/xml" });
  const document = dom.window.document;
  const rssItems = [...document.querySelectorAll("item")].map(item => {
    const title = textOf(item.querySelector("title"));
    const url = textOf(item.querySelector("link")) || textOf(item.querySelector("guid"));
    const publishedAt = parseDate(textOf(item.querySelector("pubDate")) || textOf(item.querySelector("dc\\:date")));
    const summary = stripHtml(textOf(item.querySelector("description")) || textOf(item.querySelector("content\\:encoded")));
    return { title, url, source: source.name, category: source.category, publishedAt, summary };
  });
  const atomItems = [...document.querySelectorAll("entry")].map(entry => {
    const link = entry.querySelector("link[rel='alternate']") || entry.querySelector("link[href]");
    const title = textOf(entry.querySelector("title"));
    const url = attr(link, "href") || textOf(entry.querySelector("id"));
    const publishedAt = parseDate(textOf(entry.querySelector("published")) || textOf(entry.querySelector("updated")));
    const summary = stripHtml(textOf(entry.querySelector("summary")) || textOf(entry.querySelector("content")));
    return { title, url, source: source.name, category: source.category, publishedAt, summary };
  });
  return [...rssItems, ...atomItems].filter(item => item.title && item.url);
}

function isWithinWindow(item: AiWeeklyItem, targetDate: string, lookbackDays: number): boolean {
  if (!item.publishedAt) return true;
  const published = new Date(item.publishedAt).getTime();
  if (Number.isNaN(published)) return true;
  const target = /^\d{4}-\d{2}-\d{2}$/.test(targetDate) ? new Date(`${targetDate}T23:59:59+08:00`).getTime() : Date.now();
  const start = target - lookbackDays * 24 * 60 * 60 * 1000;
  return published >= start && published <= target + 24 * 60 * 60 * 1000;
}

function hasAiSignal(item: AiWeeklyItem): boolean {
  const text = `${item.title}\n${item.summary}`;
  if (LOW_SIGNAL_PATTERNS.some(pattern => pattern.test(text))) return false;
  if (PURE_TUTORIAL_PATTERNS.some(pattern => pattern.test(text)) && !/release|launch|announc|case study|postmortem|evaluation|benchmark|security|architecture/i.test(text)) return false;
  return AI_SIGNAL_PATTERNS.some(pattern => pattern.test(text)) || ["model", "agent", "safety"].includes(item.category);
}

function scoreItem(item: AiWeeklyItem): number {
  const text = `${item.title}\n${item.summary}`;
  let score = 0;
  if (["agent", "infra", "safety", "coding"].includes(item.category)) score += 4;
  if (["model", "research"].includes(item.category)) score += 3;
  for (const pattern of AI_SIGNAL_PATTERNS) if (pattern.test(text)) score += 2;
  if (/agent|tool calling|MCP|eval|benchmark|safety|security|cost|routing|context|inference|coding|enterprise|governance/i.test(text)) score += 4;
  if (LOW_SIGNAL_PATTERNS.some(pattern => pattern.test(text))) score -= 8;
  if (/prompt tips|top \d+|getting started|beginner/i.test(text)) score -= 5;
  const date = new Date(item.publishedAt).getTime();
  if (!Number.isNaN(date)) score += Math.max(0, 3 - Math.floor((Date.now() - date) / (7 * 24 * 60 * 60 * 1000)));
  return score;
}

function dedupeItems(items: AiWeeklyItem[]): AiWeeklyItem[] {
  const seen = new Set<string>();
  const out: AiWeeklyItem[] = [];
  for (const item of items) {
    const key = (item.url || item.title).replace(/[?#].*$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function sourceLimit(item: AiWeeklyItem): number {
  if (item.source.endsWith("Releases")) return 1;
  if (item.source.includes("OpenAI") || item.source.includes("Anthropic") || item.source.includes("GitHub")) return 2;
  return 3;
}

function categoryLimit(limit: number): number {
  return Math.max(2, Math.ceil(limit * 0.36));
}

function selectDiverseItems(items: AiWeeklyItem[], limit: number): AiWeeklyItem[] {
  const selected: AiWeeklyItem[] = [];
  const sourceCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  const maxCategory = categoryLimit(limit);

  for (const item of items) {
    const currentSource = sourceCounts.get(item.source) || 0;
    const currentCategory = categoryCounts.get(item.category) || 0;
    if (currentSource >= sourceLimit(item)) continue;
    if (currentCategory >= maxCategory) continue;
    selected.push(item);
    sourceCounts.set(item.source, currentSource + 1);
    categoryCounts.set(item.category, currentCategory + 1);
    if (selected.length >= limit) return selected;
  }

  for (const item of items) {
    if (selected.includes(item)) continue;
    const currentSource = sourceCounts.get(item.source) || 0;
    if (currentSource >= sourceLimit(item)) continue;
    selected.push(item);
    sourceCounts.set(item.source, currentSource + 1);
    if (selected.length >= limit) return selected;
  }

  return selected;
}

function displayTitle(item: AiWeeklyItem): string {
  const project = item.source.replace(/ Releases$/, "");
  const title = /^v?\d+(?:\.\d+|[-,]|$)/i.test(item.title) ? `${project} ${item.title}` : item.title;
  return avoidCloudflareEmailObfuscation(title);
}

async function fetchSource(source: FeedSource): Promise<AiWeeklyItem[]> {
  const xml = await fetchText(source.url, { timeoutMs: 20_000, maxChars: 800_000 });
  return parseFeedItems(xml, source);
}

export async function buildAiWeeklySource(date: string, { lookbackDays = 10, limit = 26 } = {}): Promise<string> {
  const settled = await Promise.allSettled(FEED_SOURCES.map(fetchSource));
  const failures: string[] = [];
  const items = settled.flatMap((result, index) => {
    if (result.status === "fulfilled") return result.value;
    failures.push(`${FEED_SOURCES[index].name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    return [];
  });
  const filtered = selectDiverseItems(
    dedupeItems(items)
      .filter(item => isWithinWindow(item, date, lookbackDays))
      .filter(hasAiSignal)
      .sort((a, b) => scoreItem(b) - scoreItem(a)),
    limit,
  );

  if (filtered.length < 8) throw new Error(`ai-weekly source has too few publishable items: ${filtered.length}`);

  const lines = [
    `# AI 周刊候选源｜${date}`,
    "",
    "筛选口径：覆盖模型、Agent、AI infra、AI 编程、安全评测与企业落地；排除融资、营销、工具榜单、纯 prompt 技巧和低信号论文搬运。",
    "",
    `候选数量：${filtered.length}`,
    failures.length ? `抓取失败源：${failures.join("；")}` : "抓取失败源：无",
    "",
  ];

  filtered.forEach((item, index) => {
    lines.push(
      `## ${index + 1}. ${displayTitle(item)}`,
      "",
      `- 来源：${item.source}`,
      `- 分类：${item.category}`,
      `- 发布时间：${item.publishedAt || "未知"}`,
      `- 链接：${item.url}`,
      `- 摘要证据：${clipText(item.summary || item.title, 700)}`,
      "",
    );
  });

  return `${lines.join("\n").trim()}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const date = stringArg(args, "date") || new Date().toISOString().slice(0, 10);
  const lookbackDays = Number(stringArg(args, "lookback-days", "10"));
  const limit = Number(stringArg(args, "limit", "26"));
  const source = await buildAiWeeklySource(date, { lookbackDays, limit });
  writeStdout(source);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`ERROR: ${message}`);
    process.exit(1);
  });
}
