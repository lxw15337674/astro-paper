#!/usr/bin/env tsx
import { JSDOM } from "jsdom";
import { avoidCloudflareEmailObfuscation, compact, fetchText, parseArgs, stringArg, writeStderr, writeStdout } from "./blog_common.ts";

type FeedSource = {
  name: string;
  url: string;
  category: "engineering" | "ai" | "platform" | "security" | "release" | "tools" | "data";
};

type TechWeeklyItem = {
  title: string;
  url: string;
  source: string;
  category: FeedSource["category"];
  publishedAt: string;
  summary: string;
};

const FEED_SOURCES: FeedSource[] = [
  { name: "GitHub Blog", url: "https://github.blog/feed/", category: "platform" },
  { name: "Cloudflare Blog", url: "https://blog.cloudflare.com/rss/", category: "platform" },
  { name: "Netflix Tech Blog", url: "https://netflixtechblog.com/feed", category: "engineering" },
  { name: "Uber Engineering", url: "https://www.uber.com/en-US/blog/engineering/rss/", category: "engineering" },
  { name: "Go Blog", url: "https://go.dev/blog/feed.atom", category: "engineering" },
  { name: "Rust Blog", url: "https://blog.rust-lang.org/feed.xml", category: "engineering" },
  { name: "PostgreSQL News", url: "https://www.postgresql.org/about/news/rss/", category: "data" },
  { name: "Docker Blog", url: "https://www.docker.com/blog/feed/", category: "tools" },
  { name: "Grafana Blog", url: "https://grafana.com/blog/index.xml", category: "tools" },
  { name: "Google Developers Blog", url: "https://developers.googleblog.com/en/rss/", category: "platform" },
  { name: "OpenAI News", url: "https://openai.com/news/rss.xml", category: "ai" },
  { name: "GitHub Security Lab", url: "https://github.blog/security/vulnerability-research/feed/", category: "security" },
  { name: "Node.js Releases", url: "https://github.com/nodejs/node/releases.atom", category: "release" },
  { name: "TypeScript Releases", url: "https://github.com/microsoft/TypeScript/releases.atom", category: "release" },
  { name: "Vite Releases", url: "https://github.com/vitejs/vite/releases.atom", category: "release" },
  { name: "Deno Releases", url: "https://github.com/denoland/deno/releases.atom", category: "release" },
  { name: "Bun Releases", url: "https://github.com/oven-sh/bun/releases.atom", category: "release" },
  { name: "uv Releases", url: "https://github.com/astral-sh/uv/releases.atom", category: "tools" },
  { name: "Kubernetes Releases", url: "https://github.com/kubernetes/kubernetes/releases.atom", category: "release" },
];

const PURE_TUTORIAL_PATTERNS = [
  /\bhow to\b/i,
  /\btutorial\b/i,
  /\bguide to\b/i,
  /\bbeginner/i,
  /\bfrom scratch\b/i,
  /\bgetting started\b/i,
  /一文[读看搞]懂/,
  /从零/,
  /入门/,
  /教程/,
  /详解/,
  /基础/,
  /面试/,
];

const EVENT_SIGNAL_PATTERNS = [
  /release|released|launch|announc|introduc|preview|rc|beta|security|vulnerab|cve|incident|postmortem|migration|performance|benchmark|scale|architecture|compiler|database|runtime|agent|model|open source|governance|breaking/i,
  /发布|推出|上线|预览|候选|安全|漏洞|事故|复盘|迁移|性能|基准|扩展|架构|编译器|数据库|运行时|模型|开源|治理|破坏性/,
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

function parseRssItems(xml: string, source: FeedSource): TechWeeklyItem[] {
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

function isWithinWindow(item: TechWeeklyItem, targetDate: string, lookbackDays: number): boolean {
  if (!item.publishedAt) return true;
  const published = new Date(item.publishedAt).getTime();
  if (Number.isNaN(published)) return true;
  const target = /^\d{4}-\d{2}-\d{2}$/.test(targetDate) ? new Date(`${targetDate}T23:59:59+08:00`).getTime() : Date.now();
  const start = target - lookbackDays * 24 * 60 * 60 * 1000;
  return published >= start && published <= target + 24 * 60 * 60 * 1000;
}

function hasEngineeringSignal(item: TechWeeklyItem): boolean {
  const text = `${item.title}\n${item.summary}`;
  if (PURE_TUTORIAL_PATTERNS.some(pattern => pattern.test(text)) && !EVENT_SIGNAL_PATTERNS.some(pattern => pattern.test(text))) return false;
  return EVENT_SIGNAL_PATTERNS.some(pattern => pattern.test(text)) || item.category === "release" || item.category === "security";
}

function scoreItem(item: TechWeeklyItem): number {
  const text = `${item.title}\n${item.summary}`;
  let score = 0;
  if (item.category === "release" || item.category === "security") score += 4;
  if (item.category === "ai" || item.category === "engineering") score += 3;
  for (const pattern of EVENT_SIGNAL_PATTERNS) if (pattern.test(text)) score += 2;
  if (/breaking|security|vulnerab|cve|performance|benchmark|compiler|runtime|database|agent|model|scale/i.test(text)) score += 3;
  if (/教程|入门|getting started|beginner/i.test(text)) score -= 5;
  const date = new Date(item.publishedAt).getTime();
  if (!Number.isNaN(date)) score += Math.max(0, 3 - Math.floor((Date.now() - date) / (7 * 24 * 60 * 60 * 1000)));
  return score;
}

function dedupeItems(items: TechWeeklyItem[]): TechWeeklyItem[] {
  const seen = new Set<string>();
  const out: TechWeeklyItem[] = [];
  for (const item of items) {
    const key = (item.url || item.title).replace(/[?#].*$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function sourceLimit(item: TechWeeklyItem): number {
  if (item.source.endsWith("Releases")) return 1;
  return 2;
}

function categoryLimit(limit: number): number {
  return Math.max(2, Math.ceil(limit * 0.3));
}

function selectDiverseItems(items: TechWeeklyItem[], limit: number): TechWeeklyItem[] {
  const selected: TechWeeklyItem[] = [];
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

function displayTitle(item: TechWeeklyItem): string {
  const project = item.source.replace(/ Releases$/, "");
  const title = item.category === "release" || /^v?\d+(?:\.\d+|[-,]|$)/i.test(item.title) ? `${project} ${item.title}` : item.title;
  return avoidCloudflareEmailObfuscation(title);
}

async function fetchSource(source: FeedSource): Promise<TechWeeklyItem[]> {
  const xml = await fetchText(source.url, { timeoutMs: 20_000, maxChars: 800_000, throwOnMaxChars: true });
  return parseRssItems(xml, source);
}

export async function buildTechWeeklySource(date: string, { lookbackDays = 10, limit = 24 } = {}): Promise<string> {
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
      .filter(hasEngineeringSignal)
      .sort((a, b) => scoreItem(b) - scoreItem(a)),
    limit,
  );

  if (filtered.length < 8) throw new Error(`tech-weekly source has too few publishable items: ${filtered.length}`);

  const lines = [
    `# 技术趋势与工程观察候选源｜${date}`,
    "",
    "筛选口径：覆盖全技术领域；排除纯教程/基础讲解；优先事件性、工程判断、版本迁移、安全、性能、开源治理和工具链变化。",
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
      `- 摘要证据：${compact(item.summary || item.title)}`,
      "",
    );
  });

  return `${lines.join("\n").trim()}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const date = stringArg(args, "date") || new Date().toISOString().slice(0, 10);
  const lookbackDays = Number(stringArg(args, "lookback-days", "10"));
  const limit = Number(stringArg(args, "limit", "24"));
  const source = await buildTechWeeklySource(date, { lookbackDays, limit });
  writeStdout(source);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`ERROR: ${message}`);
    process.exit(1);
  });
}
