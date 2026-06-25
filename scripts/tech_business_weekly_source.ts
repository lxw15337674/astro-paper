#!/usr/bin/env tsx
import { JSDOM } from "jsdom";
import { compact, fetchText, parseArgs, stringArg, writeStderr, writeStdout } from "./blog_common.ts";

type TechBusinessCategory = "big-tech" | "platform" | "regulation" | "security" | "market" | "chips" | "open-source" | "ai";

type FeedSource = {
  name: string;
  url: string;
  category: TechBusinessCategory;
};

type TechBusinessItem = {
  title: string;
  url: string;
  source: string;
  category: TechBusinessCategory;
  publishedAt: string;
  summary: string;
};

const FEED_SOURCES: FeedSource[] = [
  { name: "TechCrunch", url: "https://techcrunch.com/feed/", category: "market" },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml", category: "big-tech" },
  { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index", category: "platform" },
  { name: "WIRED Business", url: "https://www.wired.com/feed/category/business/latest/rss", category: "market" },
  { name: "WIRED Security", url: "https://www.wired.com/feed/category/security/latest/rss", category: "security" },
  { name: "MIT Technology Review", url: "https://www.technologyreview.com/feed/", category: "ai" },
  { name: "The Register", url: "https://www.theregister.com/headlines.atom", category: "platform" },
  { name: "The Hacker News", url: "https://feeds.feedburner.com/TheHackersNews", category: "security" },
  { name: "CISA Alerts", url: "https://www.cisa.gov/news.xml", category: "security" },
  { name: "GitHub Blog", url: "https://github.blog/feed/", category: "open-source" },
  { name: "Cloudflare Blog", url: "https://blog.cloudflare.com/rss/", category: "platform" },
  { name: "OpenAI News", url: "https://openai.com/news/rss.xml", category: "ai" },
  { name: "NVIDIA Blog", url: "https://blogs.nvidia.com/feed/", category: "chips" },
  { name: "Amazon News Technology", url: "https://www.aboutamazon.com/news/technology/rss", category: "big-tech" },
];

const TECH_BUSINESS_SIGNAL_PATTERNS = [
  /AI|artificial intelligence|agent|model|chip|semiconductor|GPU|cloud|platform|developer|open source|security|cyber|privacy|antitrust|regulation|regulator|policy|law|lawsuit|court|EU|FTC|CISA|supply chain|enterprise|datacenter|data center|infrastructure|NVIDIA|Apple|Google|Microsoft|Amazon|Meta|OpenAI|Anthropic|GitHub|Cloudflare/i,
  /科技|平台|公司|监管|政策|安全|隐私|反垄断|芯片|半导体|云|开源|供应链|企业|数据中心|开发者|诉讼|法规|漏洞|攻击|AI|模型|智能体/,
];

const LOW_SIGNAL_PATTERNS = [
  /gift guide|deal|coupon|black friday|prime day|best .* gadgets?|movie|trailer|streaming|game review|hands-on|unboxing|podcast|newsletter|webinar|sponsored|buying guide|steam deck|gaming handheld|camera assistant/i,
  /融资|榜单|优惠|折扣|直播|播客|赞助|开箱|影评|剧集|游戏评测|购物指南/,
  /sexual assault|coal investment|coal investments|exactly as bad|yoo-hoo|i’m not giving up|i'm not giving up|following user outcry|companywide ai hackathon|employees absolutely hate|smart glasses|ray-ban|elon musk.*broadband|hijack america.*broadband/i,
];

const FUNDING_NOISE_PATTERNS = [
  /raises? \$|series [abcdef]|seed round|funding round|valuation/i,
  /完成.*融资|种子轮|[ABCDEF]轮|估值/,
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

const STRATEGIC_EVENT_PATTERNS = [
  /launch|announc|release|rollout|expand|acquire|merger|spin off|layoff|earnings|revenue|profit|ban|fine|probe|investigat|lawsuit|ruling|settlement|regulation|policy|security|breach|hack|vulnerab|CVE|sanction|export control|partnership|enterprise|datacenter|chip|GPU|cloud|open source/i,
  /发布|推出|上线|收购|并购|裁员|财报|营收|利润|禁令|罚款|调查|诉讼|裁决|和解|监管|政策|安全|漏洞|攻击|制裁|出口管制|合作|企业|数据中心|芯片|开源/,
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

function parseFeedItems(xml: string, source: FeedSource): TechBusinessItem[] {
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

function isWithinWindow(item: TechBusinessItem, targetDate: string, lookbackDays: number): boolean {
  if (!item.publishedAt) return true;
  const published = new Date(item.publishedAt).getTime();
  if (Number.isNaN(published)) return true;
  const target = /^\d{4}-\d{2}-\d{2}$/.test(targetDate) ? new Date(`${targetDate}T23:59:59+08:00`).getTime() : Date.now();
  const start = target - lookbackDays * 24 * 60 * 60 * 1000;
  return published >= start && published <= target + 24 * 60 * 60 * 1000;
}

function hasTechBusinessSignal(item: TechBusinessItem): boolean {
  const text = `${item.title}\n${item.summary}`;
  if (LOW_SIGNAL_PATTERNS.some(pattern => pattern.test(text))) return false;
  if (FUNDING_NOISE_PATTERNS.some(pattern => pattern.test(text)) && !/acquire|merger|strategic|NVIDIA|OpenAI|Anthropic|Microsoft|Google|Amazon|Meta|Apple|IPO|public/i.test(text)) return false;
  if (PURE_TUTORIAL_PATTERNS.some(pattern => pattern.test(text)) && !STRATEGIC_EVENT_PATTERNS.some(pattern => pattern.test(text))) return false;
  return TECH_BUSINESS_SIGNAL_PATTERNS.some(pattern => pattern.test(text)) && STRATEGIC_EVENT_PATTERNS.some(pattern => pattern.test(text));
}

function scoreItem(item: TechBusinessItem): number {
  const text = `${item.title}\n${item.summary}`;
  let score = 0;
  if (["regulation", "security", "chips", "ai"].includes(item.category)) score += 4;
  if (["big-tech", "platform", "market", "open-source"].includes(item.category)) score += 3;
  for (const pattern of TECH_BUSINESS_SIGNAL_PATTERNS) if (pattern.test(text)) score += 2;
  for (const pattern of STRATEGIC_EVENT_PATTERNS) if (pattern.test(text)) score += 2;
  if (/antitrust|regulation|FTC|EU|court|lawsuit|security|breach|CVE|export control|chip|GPU|datacenter|enterprise|open source/i.test(text)) score += 4;
  if (LOW_SIGNAL_PATTERNS.some(pattern => pattern.test(text))) score -= 8;
  if (FUNDING_NOISE_PATTERNS.some(pattern => pattern.test(text))) score -= 6;
  const date = new Date(item.publishedAt).getTime();
  if (!Number.isNaN(date)) score += Math.max(0, 3 - Math.floor((Date.now() - date) / (7 * 24 * 60 * 60 * 1000)));
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

function eventFamilyKey(item: TechBusinessItem): string {
  const text = `${item.title}\n${item.summary}`.toLowerCase();
  if (/daybreak|patch the planet|open-source bugs|open source bugs|gpt-5\.5-cyber/.test(text)) return "openai-open-source-security";
  if (/agentcore|aws summit.*agent|amazon.*agent/.test(text)) return "aws-agent-platform";
  if (/blackwell|agentic.*infrastructure|agentic.*supercomputing|nvidia.*agent/.test(text)) return "nvidia-agentic-infra";
  if (/cisa.*3 days|five eyes.*ai|ai threats.*security|infosec incidents/.test(text)) return "ai-security-response-window";
  if (/ai overviews|false statements generated by ai/.test(text)) return "google-ai-overviews-liability";
  return normalizedTitleKey(item.title);
}

function dedupeItems(items: TechBusinessItem[]): TechBusinessItem[] {
  const byUrl = new Map<string, TechBusinessItem>();
  for (const item of items) {
    const key = (item.url || item.title).replace(/[?#].*$/, "").toLowerCase();
    const current = byUrl.get(key);
    if (!current || scoreItem(item) > scoreItem(current)) byUrl.set(key, item);
  }

  const byFamily = new Map<string, TechBusinessItem>();
  for (const item of byUrl.values()) {
    const key = eventFamilyKey(item);
    const current = byFamily.get(key);
    if (!current || scoreItem(item) > scoreItem(current)) byFamily.set(key, item);
  }
  return [...byFamily.values()];
}

function sourceLimit(item: TechBusinessItem): number {
  if (item.source === "The Register" || item.source === "The Hacker News") return 3;
  if (item.source.includes("OpenAI") || item.source.includes("GitHub") || item.source.includes("Cloudflare")) return 2;
  return 3;
}

function categoryLimit(limit: number): number {
  return Math.max(2, Math.ceil(limit * 0.34));
}

function selectDiverseItems(items: TechBusinessItem[], limit: number): TechBusinessItem[] {
  const selected: TechBusinessItem[] = [];
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

async function fetchSource(source: FeedSource): Promise<TechBusinessItem[]> {
  const xml = await fetchText(source.url, { timeoutMs: 20_000, maxChars: 800_000, throwOnMaxChars: true });
  return parseFeedItems(xml, source);
}

export async function buildTechBusinessWeeklySource(date: string, { lookbackDays = 14, limit = 28 } = {}): Promise<string> {
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
      .filter(hasTechBusinessSignal)
      .sort((a, b) => scoreItem(b) - scoreItem(a)),
    limit,
  );

  if (filtered.length < 10) throw new Error(`tech-business-weekly source has too few publishable items: ${filtered.length}`);

  const lines = [
    `# 科技商业观察候选源｜${date}`,
    "",
    "筛选口径：覆盖科技公司、平台政策、AI/芯片/云、监管、安全事件、开源生态与商业落地；排除娱乐八卦、购物推荐、普通融资快讯、营销稿和纯教程。",
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
  const lookbackDays = Number(stringArg(args, "lookback-days", "14"));
  const limit = Number(stringArg(args, "limit", "28"));
  const source = await buildTechBusinessWeeklySource(date, { lookbackDays, limit });
  writeStdout(source);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`ERROR: ${message}`);
    process.exit(1);
  });
}
