#!/usr/bin/env tsx
import { JSDOM } from "jsdom";
import { clipText, compact, fetchText, parseArgs, stringArg, writeStderr, writeStdout } from "./blog_common.ts";

type DailyRoughCategory = "tech" | "ai" | "business" | "security" | "release" | "infra" | "data";

type FeedSource = {
  name: string;
  url: string;
  category: DailyRoughCategory;
};

type DailyDigestItem = {
  title: string;
  url: string;
  source: string;
  category: DailyRoughCategory;
  publishedAt: string;
  summary: string;
};

const FEED_SOURCES: FeedSource[] = [
  { name: "GitHub Blog", url: "https://github.blog/feed/", category: "tech" },
  { name: "Cloudflare Blog", url: "https://blog.cloudflare.com/rss/", category: "infra" },
  { name: "Netflix Tech Blog", url: "https://netflixtechblog.com/feed", category: "tech" },
  { name: "Uber Engineering", url: "https://www.uber.com/en-US/blog/engineering/rss/", category: "tech" },
  { name: "Go Blog", url: "https://go.dev/blog/feed.atom", category: "tech" },
  { name: "Rust Blog", url: "https://blog.rust-lang.org/feed.xml", category: "tech" },
  { name: "PostgreSQL News", url: "https://www.postgresql.org/about/news/rss/", category: "data" },
  { name: "Docker Blog", url: "https://www.docker.com/blog/feed/", category: "tech" },
  { name: "Grafana Blog", url: "https://grafana.com/blog/index.xml", category: "tech" },
  { name: "Google Developers Blog", url: "https://developers.googleblog.com/en/rss/", category: "tech" },
  { name: "Node.js Releases", url: "https://github.com/nodejs/node/releases.atom", category: "release" },
  { name: "TypeScript Releases", url: "https://github.com/microsoft/TypeScript/releases.atom", category: "release" },
  { name: "Vite Releases", url: "https://github.com/vitejs/vite/releases.atom", category: "release" },
  { name: "Deno Releases", url: "https://github.com/denoland/deno/releases.atom", category: "release" },
  { name: "Bun Releases", url: "https://github.com/oven-sh/bun/releases.atom", category: "release" },
  { name: "Kubernetes Releases", url: "https://github.com/kubernetes/kubernetes/releases.atom", category: "release" },
  { name: "uv Releases", url: "https://github.com/astral-sh/uv/releases.atom", category: "release" },

  { name: "OpenAI News", url: "https://openai.com/news/rss.xml", category: "ai" },
  { name: "Google DeepMind Blog", url: "https://deepmind.google/blog/rss.xml", category: "ai" },
  { name: "Google AI Developers", url: "https://developers.googleblog.com/en/rss/", category: "ai" },
  { name: "Hugging Face Blog", url: "https://huggingface.co/blog/feed.xml", category: "ai" },
  { name: "GitHub AI", url: "https://github.blog/ai-and-ml/feed/", category: "ai" },
  { name: "LangChain Blog", url: "https://blog.langchain.com/rss/", category: "ai" },
  { name: "LlamaIndex Blog", url: "https://www.llamaindex.ai/blog/rss.xml", category: "ai" },
  { name: "Vercel Blog", url: "https://vercel.com/blog/rss.xml", category: "ai" },
  { name: "Vercel AI SDK Releases", url: "https://github.com/vercel/ai/releases.atom", category: "ai" },
  { name: "Modal Blog", url: "https://modal.com/blog/rss.xml", category: "infra" },
  { name: "Replicate Blog", url: "https://replicate.com/blog/rss", category: "infra" },
  { name: "AWS Machine Learning Blog", url: "https://aws.amazon.com/blogs/machine-learning/feed/", category: "ai" },
  { name: "Databricks Blog", url: "https://www.databricks.com/feed", category: "data" },
  { name: "Weaviate Blog", url: "https://weaviate.io/blog/rss.xml", category: "data" },
  { name: "METR Blog", url: "https://metr.org/blog/rss.xml", category: "ai" },
  { name: "Epoch AI", url: "https://epoch.ai/blog/rss.xml", category: "ai" },

  { name: "TechCrunch", url: "https://techcrunch.com/feed/", category: "business" },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml", category: "business" },
  { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index", category: "business" },
  { name: "WIRED Business", url: "https://www.wired.com/feed/category/business/latest/rss", category: "business" },
  { name: "WIRED Security", url: "https://www.wired.com/feed/category/security/latest/rss", category: "security" },
  { name: "MIT Technology Review", url: "https://www.technologyreview.com/feed/", category: "business" },
  { name: "The Register", url: "https://www.theregister.com/headlines.atom", category: "business" },
  { name: "The Hacker News", url: "https://feeds.feedburner.com/TheHackersNews", category: "security" },
  { name: "CISA Alerts", url: "https://www.cisa.gov/news.xml", category: "security" },
  { name: "GitHub Security Lab", url: "https://github.blog/security/vulnerability-research/feed/", category: "security" },
  { name: "NVIDIA Blog", url: "https://blogs.nvidia.com/feed/", category: "business" },
  { name: "Amazon News Technology", url: "https://www.aboutamazon.com/news/technology/rss", category: "business" },
];

const SIGNAL_PATTERNS = [
  /release|launch|announc|introduc|security|vulnerab|cve|incident|postmortem|migration|performance|benchmark|scale|architecture|compiler|database|runtime|cloud|platform|developer|open source|governance|breaking|AI|LLM|agent|model|inference|eval|benchmark|safety|context|routing|copilot|MCP|GPU|chip|semiconductor|privacy|antitrust|regulation|policy|law|lawsuit|court|FTC|CISA|supply chain|enterprise|datacenter|data center/i,
  /发布|推出|上线|安全|漏洞|事故|复盘|迁移|性能|基准|架构|编译器|数据库|运行时|云|平台|开发者|开源|治理|模型|智能体|推理|评测|上下文|芯片|半导体|隐私|反垄断|监管|政策|诉讼|供应链|企业|数据中心/,
];

const LOW_SIGNAL_PATTERNS = [
  /gift guide|deal|coupon|black friday|prime day|best .* gadgets?|movie|trailer|streaming|game review|hands-on|unboxing|podcast|newsletter|webinar|sponsored|buying guide|steam deck|gaming handheld|camera assistant/i,
  /sexual assault|coal investment|coal investments|exactly as bad|yoo-hoo|i’m not giving up|i'm not giving up|following user outcry|companywide ai hackathon|employees absolutely hate|smart glasses|ray-ban|elon musk.*broadband|hijack america.*broadband|kennedy space center|super heavy rockets|rocket launch infrastructure/i,
  /融资|榜单|优惠|折扣|直播|播客|赞助|开箱|影评|剧集|游戏评测|购物指南/,
];

const PURE_TUTORIAL_PATTERNS = [
  /\bhow to\b/i,
  /\btutorial\b/i,
  /\bguide to\b/i,
  /\bgetting started\b/i,
  /\bbeginner\b/i,
  /\bwhat is\b/i,
  /一文[读看搞]懂/,
  /从零/,
  /入门/,
  /教程/,
  /详解/,
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

function parseFeedItems(xml: string, source: FeedSource): DailyDigestItem[] {
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

function isWithinWindow(item: DailyDigestItem, targetDate: string, lookbackHours: number): boolean {
  if (!item.publishedAt) return true;
  const published = new Date(item.publishedAt).getTime();
  if (Number.isNaN(published)) return true;
  const target = /^\d{4}-\d{2}-\d{2}$/.test(targetDate) ? new Date(`${targetDate}T23:59:59+08:00`).getTime() : Date.now();
  const start = target - lookbackHours * 60 * 60 * 1000;
  return published >= start && published <= target + 60 * 60 * 1000;
}

function hasDailySignal(item: DailyDigestItem): boolean {
  const text = `${item.title}\n${item.summary}`;
  if (LOW_SIGNAL_PATTERNS.some(pattern => pattern.test(text))) return false;
  if (PURE_TUTORIAL_PATTERNS.some(pattern => pattern.test(text)) && !SIGNAL_PATTERNS.some(pattern => pattern.test(text))) return false;
  return SIGNAL_PATTERNS.some(pattern => pattern.test(text));
}

function scoreItem(item: DailyDigestItem): number {
  const text = `${item.title}\n${item.summary}`;
  let score = 0;
  if (["ai", "security", "business"].includes(item.category)) score += 4;
  if (["tech", "infra", "data", "release"].includes(item.category)) score += 3;
  for (const pattern of SIGNAL_PATTERNS) if (pattern.test(text)) score += 2;
  if (/breaking|security|vulnerab|CVE|performance|benchmark|runtime|database|agent|model|scale|regulation|lawsuit|chip|GPU|datacenter|enterprise|open source/i.test(text)) score += 3;
  if (LOW_SIGNAL_PATTERNS.some(pattern => pattern.test(text))) score -= 10;
  const date = new Date(item.publishedAt).getTime();
  if (!Number.isNaN(date)) score += Math.max(0, 4 - Math.floor((Date.now() - date) / (24 * 60 * 60 * 1000)));
  return score;
}

function normalizedTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/openai|anthropic|google|microsoft|amazon|aws|nvidia|meta|apple|cloudflare|github|cisa/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\b(the|a|an|and|with|for|to|of|in|on|about|new)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function eventFamilyKey(item: DailyDigestItem): string {
  const text = `${item.title}\n${item.summary}`.toLowerCase();
  if (/daybreak|patch the planet|open-source bugs|open source bugs|gpt-5\.5-cyber/.test(text)) return "openai-open-source-security";
  if (/agentcore|aws summit.*agent|amazon.*agent/.test(text)) return "aws-agent-platform";
  if (/blackwell|agentic.*infrastructure|agentic.*supercomputing|nvidia.*agent/.test(text)) return "nvidia-agentic-infra";
  if (/cisa.*3 days|five eyes.*ai|ai threats.*security|infosec incidents/.test(text)) return "ai-security-response-window";
  if (/ai overviews|false statements generated by ai/.test(text)) return "google-ai-overviews-liability";
  if (/post[-\s]?quantum|quantum[-\s]?vulnerable|executive order.*quantum|eo.*quantum/.test(text)) return "post-quantum-executive-order";
  return normalizedTitleKey(item.title);
}

export function dedupeItems(items: DailyDigestItem[]): DailyDigestItem[] {
  const byUrl = new Map<string, DailyDigestItem>();
  for (const item of items) {
    const key = (item.url || item.title).replace(/[?#].*$/, "").toLowerCase();
    const current = byUrl.get(key);
    if (!current || scoreItem(item) > scoreItem(current)) byUrl.set(key, item);
  }
  const byFamily = new Map<string, DailyDigestItem>();
  for (const item of byUrl.values()) {
    const key = eventFamilyKey(item);
    const current = byFamily.get(key);
    if (!current || scoreItem(item) > scoreItem(current)) byFamily.set(key, item);
  }
  return [...byFamily.values()];
}

function sourceLimit(item: DailyDigestItem): number {
  if (item.source.endsWith("Releases")) return 1;
  if (item.source.includes("OpenAI") || item.source.includes("GitHub") || item.source.includes("Cloudflare")) return 3;
  return 4;
}

function selectDiverseItems(items: DailyDigestItem[], limit: number): DailyDigestItem[] {
  const selected: DailyDigestItem[] = [];
  const sourceCounts = new Map<string, number>();
  for (const item of items) {
    const currentSource = sourceCounts.get(item.source) || 0;
    if (currentSource >= sourceLimit(item)) continue;
    selected.push(item);
    sourceCounts.set(item.source, currentSource + 1);
    if (selected.length >= limit) return selected;
  }
  return selected;
}

async function fetchSource(source: FeedSource): Promise<DailyDigestItem[]> {
  const xml = await fetchText(source.url, { timeoutMs: 20_000, maxChars: 800_000 });
  return parseFeedItems(xml, source);
}

export async function buildDailyDigestSource(date: string, { lookbackHours = 24, limit = 80 } = {}): Promise<string> {
  const settled = await Promise.allSettled(FEED_SOURCES.map(fetchSource));
  const failures: string[] = [];
  const items = settled.flatMap((result, index) => {
    if (result.status === "fulfilled") return result.value;
    failures.push(`${FEED_SOURCES[index].name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    return [];
  });
  const filtered = selectDiverseItems(
    dedupeItems(items)
      .filter(item => isWithinWindow(item, date, lookbackHours))
      .filter(hasDailySignal)
      .sort((a, b) => scoreItem(b) - scoreItem(a)),
    limit,
  );

  if (filtered.length < 1) throw new Error("daily digest source has no publishable items");

  const lines = [
    `# 全局日报候选池｜${date}`,
    "",
    "筛选口径：过去 24 小时内的技术工程、AI 工程、科技商业/监管/安全候选；排除消费硬件体验、娱乐、购物、普通融资、营销稿和纯教程。",
    "",
    `候选数量：${filtered.length}`,
    failures.length ? `抓取失败源：${failures.join("；")}` : "抓取失败源：无",
    "",
  ];

  filtered.forEach((item, index) => {
    lines.push(
      `## ${index + 1}. ${item.title}`,
      "",
      `- 来源：${item.source}`,
      `- 粗分类：${item.category}`,
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
  const lookbackHours = Number(stringArg(args, "lookback-hours", "24"));
  const limit = Number(stringArg(args, "limit", "80"));
  const source = await buildDailyDigestSource(date, { lookbackHours, limit });
  writeStdout(source);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`ERROR: ${message}`);
    process.exit(1);
  });
}
