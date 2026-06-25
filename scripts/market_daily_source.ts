#!/usr/bin/env tsx
import https from "node:https";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import YahooFinance from "yahoo-finance2";
import { bjtDateString, clipText, compact, fetchJson, fetchText, parseArgs, stripHtml, stringArg, writeStderr, writeStdout } from "./blog_common.ts";

const yahooFinance = new YahooFinance({ suppressNotices: ["ripHistorical"] });

const EASTMONEY_FIELDS = "f12,f14,f2,f3,f4,f5,f6,f17,f18";
const EASTMONEY_INDEX_SECS = {
  dji: "100.DJIA",
  nasdaq: "100.NDX",
  spx: "100.SPX",
  sh: "1.000001",
  sz: "0.399001",
  cyb: "0.399006",
  hsi: "100.HSI",
  hscei: "100.HSCEI",
  hstech: "100.HSTECH",
};

const CLOSED_TEXT = {
  us: "美股当日未产生完整常规收盘数据，本节不做涨跌与板块强弱判断。",
  aShare: "A股当日未产生完整常规交易数据，本节不做指数表现与市场结构判断。",
  hk: "港股当日未产生完整常规交易数据，本节不做指数表现与市场结构判断。",
};

const UNAVAILABLE_TEXT = {
  us: "美股当日未获取到完整常规收盘数据，本节不做涨跌与板块强弱判断。",
  aShare: "A股当日未获取到完整常规交易数据，本节不做指数表现与市场结构判断。",
  hk: "港股当日未获取到完整常规交易数据，本节不做指数表现与市场结构判断。",
};

const US_SECTOR_ETFS: Record<string, string> = {
  XLK: "科技",
  XLC: "通信服务",
  XLY: "可选消费",
  XLP: "必需消费",
  XLF: "金融",
  XLV: "医疗保健",
  XLI: "工业",
  XLE: "能源",
  XLB: "材料",
  XLU: "公用事业",
  XLRE: "房地产",
};

const US_CORE_STOCKS: YahooSymbol[] = [
  { symbol: "AAPL", code: "AAPL", name: "苹果(AAPL)" },
  { symbol: "MSFT", code: "MSFT", name: "微软(MSFT)" },
  { symbol: "NVDA", code: "NVDA", name: "英伟达(NVDA)" },
  { symbol: "AMZN", code: "AMZN", name: "亚马逊(AMZN)" },
  { symbol: "META", code: "META", name: "Meta(META)" },
  { symbol: "GOOGL", code: "GOOGL", name: "Alphabet(GOOGL)" },
  { symbol: "TSLA", code: "TSLA", name: "特斯拉(TSLA)" },
  { symbol: "AVGO", code: "AVGO", name: "博通(AVGO)" },
  { symbol: "NFLX", code: "NFLX", name: "Netflix(NFLX)" },
  { symbol: "JPM", code: "JPM", name: "摩根大通(JPM)" },
  { symbol: "XOM", code: "XOM", name: "埃克森美孚(XOM)" },
  { symbol: "UNH", code: "UNH", name: "联合健康(UNH)" },
];

const US_BROAD_ETFS: YahooSymbol[] = [
  { symbol: "SPY", code: "SPY", name: "SPY" },
  { symbol: "QQQ", code: "QQQ", name: "QQQ" },
  { symbol: "DIA", code: "DIA", name: "DIA" },
];

const YAHOO_FINANCE_RSS = "https://finance.yahoo.com/rss/stock-market-news";
const YAHOO_MARKET_SIGNAL_PATTERNS = [
  /market\s+(recap|wrap|today|close|rally|selloff)/i,
  /stock\s+market/i,
  /stocks?\s+(close|end|rise|fall|rally|drop|slip|gain|lose|retreat|plunge|advance|rebound|tank|sell[- ]off)/i,
  /s&p\s*500|nasdaq|dow\s+jones|dow\b/i,
  /\b(SPY|QQQ|DIA|AAPL|MSFT|NVDA|AMZN|META|GOOGL|TSLA|AVGO|NFLX|JPM|XOM|UNH)\b/i,
];
const YAHOO_BROAD_MARKET_TITLE_PATTERN = /market\s+(recap|wrap|today|close)|stock\s+market|stocks?\s+(close|end|rise|fall|rally|drop|slip|gain|lose|retreat|plunge|advance|rebound|tank|sell[- ]off)|s&p\s*500|nasdaq/i;

type QuoteRow = Record<string, string | number | null | undefined>;
type QuoteRows = Record<string, QuoteRow>;
type EquityKey = "us" | "aShare" | "hk";

type MarketSection = {
  key: EquityKey | "crypto";
  title: string;
  markdown: string;
  open: boolean;
  summary: string;
};

type BoardRow = { name: string; pct: number; amount?: number };
type InstrumentRow = { symbol: string; name: string; pct: number; close: number; volume?: number; avgVolume20?: number; volumeRatio?: number };
type SectorRow = InstrumentRow;
type YahooHistoryRow = { date?: Date; close?: number | null; volume?: number | null };
type YahooFinanceFeedItem = { title: string; url: string; publishedAt: string; summary: string };
type ExternalMarketArticle = { title: string; url: string; publishedAt: string; excerpt: string };
type UsIndexSnapshot = { dji: number; nasdaq: number; spx: number };
type YahooChartPayload = {
  chart?: {
    result?: {
      meta?: {
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        regularMarketVolume?: number;
        regularMarketTime?: number;
      };
    }[];
  };
};

type YahooSymbol = { symbol: string; code: string; name: string; sina?: string; sinaMarket?: "cn" | "hk" };

const YAHOO_SYMBOLS = {
  aShare: [
    { symbol: "000001.SS", code: "000001", name: "上证指数", sina: "sh000001", sinaMarket: "cn" },
    { symbol: "399001.SZ", code: "399001", name: "深证成指", sina: "sz399001", sinaMarket: "cn" },
    { symbol: "399006.SZ", code: "399006", name: "创业板指", sina: "sz399006", sinaMarket: "cn" },
  ],
  hk: [
    { symbol: "^HSI", code: "HSI", name: "恒生指数", sina: "rt_hkHSI", sinaMarket: "hk" },
    { symbol: "^HSCE", code: "HSCEI", name: "国企指数", sina: "rt_hkHSCEI", sinaMarket: "hk" },
    { symbol: "HSTECH.HK", code: "HSTECH", name: "恒生科技指数", sina: "rt_hkHSTECH", sinaMarket: "hk" },
  ],
  us: [
    { symbol: "^DJI", code: "DJIA", name: "道指" },
    { symbol: "^IXIC", code: "NDX", name: "纳指" },
    { symbol: "^GSPC", code: "SPX", name: "标普500" },
  ],
} satisfies Record<string, YahooSymbol[]>;

const REQUIRED_ASIA_QUOTES = [...YAHOO_SYMBOLS.aShare, ...YAHOO_SYMBOLS.hk];

function pct(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  if (Math.abs(num) < 0.005) return "0.00%";
  return `${num > 0 ? "+" : ""}${num.toFixed(2)}%`;
}

function number(value: unknown, digits = 2): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  return num.toFixed(digits);
}

function usd(value: unknown, digits = 0): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  return `${num.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })} 美元`;
}

function amountYi(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  return `${(num / 100_000_000).toFixed(0)}亿元`;
}

function compactVolume(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "";
  if (num >= 100_000_000) return `${(num / 100_000_000).toFixed(2)}亿股`;
  if (num >= 10_000) return `${(num / 10_000).toFixed(0)}万股`;
  return `${num.toFixed(0)}股`;
}

function textOf(element: Element | null): string {
  return compact(element?.textContent || "");
}

function attr(element: Element | null, name: string): string {
  return compact(element?.getAttribute(name) || "");
}

function parseFeedDate(value = ""): string {
  const time = Date.parse(value);
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function stripCdata(text: string): string {
  return text.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function parseYahooFinanceFeedItems(xml: string): YahooFinanceFeedItem[] {
  const dom = new JSDOM(xml, { contentType: "text/xml" });
  const document = dom.window.document;
  return [...document.querySelectorAll("item")]
    .map(item => ({
      title: textOf(item.querySelector("title")),
      url: textOf(item.querySelector("link")) || textOf(item.querySelector("guid")),
      publishedAt: parseFeedDate(textOf(item.querySelector("pubDate"))),
      summary: stripHtml(stripCdata(textOf(item.querySelector("description")) || textOf(item.querySelector("content\\:encoded")))),
    }))
    .filter(item => item.title && item.url && item.url.startsWith("https://finance.yahoo.com/"));
}

function feedWindowEnd(date: string): number {
  return parseDate(offsetDateString(date, 1)).getTime() + 12 * 60 * 60 * 1000;
}

function isWithinFeedWindow(item: YahooFinanceFeedItem, date: string): boolean {
  if (!item.publishedAt) return true;
  const published = new Date(item.publishedAt).getTime();
  if (Number.isNaN(published)) return true;
  const end = feedWindowEnd(date);
  return published >= end - 72 * 60 * 60 * 1000 && published <= end;
}

function scoreYahooMarketItem(item: YahooFinanceFeedItem): number {
  const text = `${item.title}\n${item.summary}`;
  let score = 0;
  if (YAHOO_BROAD_MARKET_TITLE_PATTERN.test(item.title)) score += 8;
  for (const pattern of YAHOO_MARKET_SIGNAL_PATTERNS) if (pattern.test(text)) score += 4;
  if (/recap|wrap|close|today/i.test(item.title)) score += 4;
  if (/motley fool|simply wall st|insider monkey/i.test(text)) score -= 4;
  if (/underperforming|outperforming|compared to other|stock performance compared|prediction:|focused value strategy|wall street sees|upside|act now|earnings up/i.test(text)) score -= 12;
  return score;
}

function findArticleBody(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findArticleBody(item);
      if (found) return found;
    }
    return "";
  }
  const record = value as Record<string, unknown>;
  if (typeof record.articleBody === "string" && compact(record.articleBody).length >= 160) return record.articleBody;
  for (const child of Object.values(record)) {
    const found = findArticleBody(child);
    if (found) return found;
  }
  return "";
}

export function extractYahooFinanceArticleText(html: string, url: string): string {
  const dom = new JSDOM(html, { url });
  for (const script of [...dom.window.document.querySelectorAll('script[type="application/ld+json"]')]) {
    const raw = script.textContent?.trim();
    if (!raw) continue;
    try {
      const body = compact(findArticleBody(JSON.parse(raw)));
      if (body.length >= 160) return body;
    } catch {
      // Fall back to readability for pages with non-JSON script payloads.
    }
  }
  const article = new Readability(dom.window.document, { keepClasses: false }).parse();
  return compact(article?.textContent || "");
}

function explicitIndexMove(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const window = match[0];
    const raw = Number(match.at(-1));
    if (!Number.isFinite(raw)) continue;
    if (/\bdown|lower|falls?|drops?|slips?|retreats?|plunges?\b/i.test(window) && raw > 0) return -raw;
    if (/\bup|higher|rises?|gains?|advances?|rall(?:y|ies)\b/i.test(window) && raw < 0) return Math.abs(raw);
    return raw;
  }
  return null;
}

export function articleConflictsWithIndexSnapshot(text: string, snapshot: UsIndexSnapshot): boolean {
  const compacted = compact(text).slice(0, 1400);
  const moves = [
    explicitIndexMove(compacted, [/\b(?:S&P\s*500|SPX|SPY)\b[^.。]{0,160}?([+-]?\d+(?:\.\d+)?)%/i]),
    explicitIndexMove(compacted, [/\b(?:Nasdaq(?:\s*100)?|NDX|QQQ)\b[^.。]{0,160}?([+-]?\d+(?:\.\d+)?)%/i]),
    explicitIndexMove(compacted, [/\b(?:Dow(?:\s*Jones)?|DJIA|DIA)\b[^.。]{0,160}?([+-]?\d+(?:\.\d+)?)%/i]),
  ];
  const expected = [snapshot.spx, snapshot.nasdaq, snapshot.dji];
  let explicitCount = 0;
  let conflictCount = 0;
  for (let index = 0; index < moves.length; index += 1) {
    const move = moves[index];
    if (move === null) continue;
    explicitCount += 1;
    const expectedMove = expected[index];
    if (Math.sign(move) !== Math.sign(expectedMove) && Math.abs(move) >= 0.1 && Math.abs(expectedMove) >= 0.1) conflictCount += 1;
    else if (Math.abs(move - expectedMove) >= 1.0) conflictCount += 1;
  }
  return explicitCount >= 2 && conflictCount >= 1;
}

async function fetchYahooFinanceArticle(item: YahooFinanceFeedItem, snapshot: UsIndexSnapshot): Promise<ExternalMarketArticle | null> {
  try {
    const html = await fetchTextWithLargeHeaders(item.url, { timeoutMs: 14_000, maxChars: 1_500_000 });
    const text = compact(
      extractYahooFinanceArticleText(html, item.url)
        .replace(/\b(?:More News from|Most Read from) [\s\S]*$/i, "")
        .replace(/^.{0,180}\b\d+\s+min\s+read\s+/i, ""),
    );
    if (text.length < 240) return null;
    if (articleConflictsWithIndexSnapshot(text, snapshot)) return null;
    return { title: item.title, url: item.url, publishedAt: item.publishedAt, excerpt: clipText(text, 900) };
  } catch {
    return null;
  }
}

function fetchTextWithLargeHeaders(url: string, { timeoutMs, maxChars }: { timeoutMs: number; maxChars: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        timeout: timeoutMs,
        maxHeaderSize: 128 * 1024,
        headers: {
          "Accept-Encoding": "identity",
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        },
      },
      response => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          fetchTextWithLargeHeaders(new URL(response.headers.location, url).toString(), { timeoutMs, maxChars }).then(resolve, reject);
          return;
        }
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode || "unknown"} for ${url}`));
          return;
        }
        response.setEncoding("utf8");
        let text = "";
        response.on("data", chunk => {
          if (text.length < maxChars) text += String(chunk).slice(0, maxChars - text.length);
        });
        response.on("end", () => resolve(text));
      },
    );
    request.on("timeout", () => request.destroy(new Error(`timeout fetching ${url}`)));
    request.on("error", reject);
  });
}

async function yahooFinanceMarketArticles(date: string, snapshot: UsIndexSnapshot): Promise<ExternalMarketArticle[]> {
  try {
    const xml = await fetchText(YAHOO_FINANCE_RSS, { timeoutMs: 15_000, maxChars: 800_000 });
    const candidates = parseYahooFinanceFeedItems(xml)
      .filter(item => isWithinFeedWindow(item, date))
      .map(item => ({ item, score: scoreYahooMarketItem(item) }))
      .filter(({ score }) => score >= 8)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ item }) => item);
    const articles: ExternalMarketArticle[] = [];
    for (const item of candidates) {
      const article = await fetchYahooFinanceArticle(item, snapshot);
      if (article) articles.push(article);
      if (articles.length >= 3) break;
    }
    return articles;
  } catch {
    return [];
  }
}

function usdWanYi(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  return `${(num / 1_000_000_000_000).toFixed(2)}万亿美元`;
}

function parseDate(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid date: ${date}`);
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function offsetDateString(date: string, days: number): string {
  const next = parseDate(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function isWeekday(date: string): boolean {
  const day = parseDate(date).getUTCDay();
  return day >= 1 && day <= 5;
}

async function eastmoneyIndices(secids: string[]): Promise<QuoteRows> {
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=${EASTMONEY_FIELDS}&secids=${secids.join(",")}`;
  const payload = await fetchJson<{ data?: { diff?: QuoteRow[] } }>(url, { timeoutMs: 20_000 });
  const rows: QuoteRows = {};
  for (const row of payload.data?.diff || []) {
    if (row.f12) rows[String(row.f12)] = row;
  }
  return rows;
}

async function yahooChartQuote({ symbol, code, name }: YahooSymbol, date: string): Promise<[string, QuoteRow] | null> {
  const period1 = Math.floor(parseDate(offsetDateString(date, -7)).getTime() / 1000);
  const period2 = Math.floor(parseDate(offsetDateString(date, 1)).getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=history`;
  const payload = await fetchJson<YahooChartPayload>(url, { timeoutMs: 20_000 });
  const meta = payload.chart?.result?.[0]?.meta;
  const close = Number(meta?.regularMarketPrice);
  const previousClose = Number(meta?.chartPreviousClose);
  const timestamp = Number(meta?.regularMarketTime || 0);
  const localDate = timestamp ? new Date(timestamp * 1000).toISOString().slice(0, 10) : "";
  if (!Number.isFinite(close) || !Number.isFinite(previousClose) || close <= 0 || previousClose <= 0 || !localDate || localDate > date) return null;
  const change = close - previousClose;
  return [code, { f12: code, f14: name, f2: close, f3: (change / previousClose) * 100, f4: change, f6: Number(meta?.regularMarketVolume || 0) }];
}

async function yahooQuote(symbolConfig: YahooSymbol, date: string): Promise<[string, QuoteRow] | null> {
  const { code, name } = symbolConfig;
  try {
    const rows = (await yahooFinance.historical(symbolConfig.symbol, { period1: offsetDateString(date, -21), period2: offsetDateString(date, 1), interval: "1d" })) as YahooHistoryRow[];
    const points = rows
      .map(row => ({ close: Number(row.close), volume: Number(row.volume || 0), localDate: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : "" }))
      .filter(point => Number.isFinite(point.close) && point.close > 0 && point.localDate && point.localDate <= date);
    if (points.length >= 2) {
      const last = points.at(-1)!;
      const prev = points.at(-2)!;
      const change = last.close - prev.close;
      const pctChange = (change / prev.close) * 100;
      return [code, { f12: code, f14: name, f2: last.close, f3: pctChange, f4: change, f6: last.volume }];
    }
  } catch {
    // Some Greater China index symbols intermittently fail yahoo-finance2 schema validation.
  }
  return yahooChartQuote(symbolConfig, date).catch(() => null);
}

async function yahooQuotes(symbols: YahooSymbol[], date: string): Promise<QuoteRows> {
  const entries = await Promise.all(symbols.map(symbol => yahooQuote(symbol, date).catch(() => null)));
  return Object.fromEntries(entries.filter((entry): entry is [string, QuoteRow] => Boolean(entry)));
}

function parseSinaDate(value: string): string {
  return value.replaceAll("/", "-");
}

function parseSinaRow(symbol: YahooSymbol, raw: string, date: string): [string, QuoteRow] | null {
  const parts = raw.split(",");
  if (symbol.sinaMarket === "cn") {
    const previousClose = Number(parts[2]);
    const close = Number(parts[3]);
    const volume = Number(parts[8] || 0);
    const rowDate = parseSinaDate(parts[30] || "");
    if (!Number.isFinite(close) || !Number.isFinite(previousClose) || close <= 0 || previousClose <= 0 || rowDate !== date) return null;
    const change = close - previousClose;
    return [symbol.code, { f12: symbol.code, f14: symbol.name, f2: close, f3: (change / previousClose) * 100, f4: change, f6: volume }];
  }
  const close = Number(parts[6]);
  const change = Number(parts[7]);
  const pctChange = Number(parts[8]);
  const volume = Number(parts[10] || 0);
  const rowDate = parseSinaDate(parts[17] || "");
  if (!Number.isFinite(close) || !Number.isFinite(pctChange) || close <= 0 || rowDate !== date) return null;
  return [symbol.code, { f12: symbol.code, f14: symbol.name, f2: close, f3: pctChange, f4: change, f6: volume }];
}

async function sinaQuotes(symbols: YahooSymbol[], date: string): Promise<QuoteRows> {
  const sinaSymbols = symbols.filter(symbol => symbol.sina);
  if (!sinaSymbols.length) return {};
  const url = `https://hq.sinajs.cn/list=${sinaSymbols.map(symbol => symbol.sina).join(",")}`;
  const text = await fetchText(url, { timeoutMs: 20_000, headers: { Referer: "https://finance.sina.com.cn/" } });
  const entries: [string, QuoteRow][] = [];
  for (const symbol of sinaSymbols) {
    const match = new RegExp(`var hq_str_${symbol.sina}="([^"]*)"`).exec(text);
    if (!match) continue;
    const parsed = parseSinaRow(symbol, match[1], date);
    if (parsed) entries.push(parsed);
  }
  return Object.fromEntries(entries);
}

async function quoteRowsForDate(date: string, secids: string[]): Promise<QuoteRows> {
  if (!isWeekday(date)) return {};
  try {
    return await eastmoneyIndices(secids);
  } catch {
    return {};
  }
}

async function quoteRowsWithFallback(date: string, secids: string[], yahooSymbols: YahooSymbol[]): Promise<QuoteRows> {
  const rows = await quoteRowsForDate(date, secids);
  const yahooMissing = yahooSymbols.filter(symbol => isMissingQuote(byCode(rows, symbol.code)));
  const yahooFallback = yahooMissing.length ? await yahooQuotes(yahooMissing, date) : {};
  const withYahoo = { ...rows, ...yahooFallback };
  const sinaMissing = yahooSymbols.filter(symbol => isMissingQuote(byCode(withYahoo, symbol.code)));
  if (!sinaMissing.length) return withYahoo;
  const sinaFallback = await sinaQuotes(sinaMissing, date).catch(() => ({}));
  return { ...withYahoo, ...sinaFallback };
}

async function eastmoneyBoards(fs: string, limit = 8): Promise<BoardRow[]> {
  const fields = "f12,f14,f3,f20";
  const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${limit}&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${encodeURIComponent(fs)}&fields=${fields}`;
  const payload = await fetchJson<{ data?: { diff?: QuoteRow[] } }>(url, { timeoutMs: 20_000 });
  return (payload.data?.diff || [])
    .map(row => ({ name: String(row.f14 || row.f12 || ""), pct: Number(row.f3), amount: Number(row.f20 || 0) }))
    .filter(row => row.name && Number.isFinite(row.pct));
}

async function safeBoards(fs: string, limit = 8): Promise<BoardRow[]> {
  try {
    return await eastmoneyBoards(fs, limit);
  } catch {
    return [];
  }
}

function byCode(rows: QuoteRows, code: string): QuoteRow {
  return rows[code] || {};
}

function isMissingQuote(row: QuoteRow): boolean {
  const value = row.f2;
  return value === undefined || value === null || value === "-" || value === 0 || Number.isNaN(Number(value));
}

function assertRequiredQuotes(rows: QuoteRows, required: YahooSymbol[], context: string): void {
  const missing = required.filter(item => isMissingQuote(byCode(rows, item.code))).map(item => item.name);
  if (missing.length) throw new Error(`${context}核心指数数据未完整获取，停止生成：${missing.join("、")}`);
}

function closedSection(key: EquityKey, title: string, text: string): MarketSection {
  return {
    key,
    title,
    open: false,
    summary: text.split("，")[0].replace(/。$/, ""),
    markdown: [`## ${title}`, "", text].join("\n"),
  };
}

function boardLine(label: string, rows: BoardRow[]): string {
  if (!rows.length) return `${label}：未获取到稳定板块数据。`;
  return `${label}：${rows.map(row => `${row.name} ${pct(row.pct)}`).join("、")}。`;
}

function laggingLabel(base: string, rows: { pct: number }[]): string {
  if (!rows.length) return base;
  if (rows.some(row => row.pct < -0.005)) return base;
  if (rows.every(row => row.pct > 0.005)) return base.replace("跌幅靠前", "涨幅相对靠后");
  return base.replace("跌幅靠前", "表现靠后");
}

function sectorLine(label: string, rows: SectorRow[]): string {
  if (!rows.length) return `${label}：未获取到稳定行业 ETF 数据。`;
  return `${label}：${rows.map(row => `${row.name} ${pct(row.pct)}`).join("、")}。`;
}

function instrumentLine(label: string, rows: InstrumentRow[]): string {
  if (!rows.length) return `${label}：未获取到稳定数据。`;
  return `${label}：${rows.map(row => `${row.name} ${pct(row.pct)}`).join("、")}。`;
}

function volumeActivity(row: InstrumentRow): string | null {
  if (!Number.isFinite(row.volumeRatio) || !row.volumeRatio || !Number.isFinite(row.volume) || !row.volume) return null;
  const ratioText = `${row.volumeRatio.toFixed(2)} 倍`;
  const volumeText = compactVolume(row.volume);
  if (row.volumeRatio >= 1.2) return `${row.name} 当日成交量约 ${volumeText}，约为近 20 个交易日均量的 ${ratioText}，成交活跃度偏高`;
  if (row.volumeRatio <= 0.8) return `${row.name} 当日成交量约 ${volumeText}，约为近 20 个交易日均量的 ${ratioText}，成交活跃度偏低`;
  return `${row.name} 当日成交量约 ${volumeText}，约为近 20 个交易日均量的 ${ratioText}，接近近 20 日均量`;
}

function volumeActivityLine(label: string, rows: InstrumentRow[]): string {
  const activities = rows.map(volumeActivity).filter((item): item is string => Boolean(item));
  if (activities.length) return `${label}：${activities.join("；")}。`;
  if (rows.some(row => Number.isFinite(row.volume) && Number(row.volume) > 0)) return `${label}：已获取当日成交量，但近 20 个交易日均量不足，暂不判断放量或缩量。`;
  return `${label}：未获取到稳定成交量数据，暂不判断放量或缩量。`;
}

function externalArticleLines(articles: ExternalMarketArticle[]): string[] {
  if (!articles.length) {
    return [
      "## 外部财经文章正文线索",
      "",
      "未获取到可公开访问且正文足够完整的 Yahoo Finance 相关文章；本篇不使用外部文章解释行情原因。",
    ];
  }
  return [
    "## 外部财经文章正文线索",
    "",
    "以下线索来自 Yahoo Finance 公开可访问文章页的短摘录，只作为市场叙事辅助证据；不包含 MarketWatch 或 Seeking Alpha 正文，不代表完整新闻归因。",
    "",
    ...articles.flatMap((article, index) => [
      `### ${index + 1}. ${article.title}`,
      "",
      `- 来源：Yahoo Finance`,
      `- 链接：${article.url}`,
      article.publishedAt ? `- 发布时间：${article.publishedAt}` : "- 发布时间：未获取到稳定发布时间",
      `- 正文短摘录：${article.excerpt}`,
      "",
    ]),
    "外部文章短摘录只能用于辅助识别当日市场叙事；不得复制原文大段内容，也不得在没有明确证据时把标题或摘录写成确定因果。",
  ];
}

function topAndBottom<T extends { pct: number }>(rows: T[], limit = 5): { top: T[]; bottom: T[] } {
  const sorted = rows.toSorted((a, b) => b.pct - a.pct);
  return { top: sorted.slice(0, limit), bottom: sorted.slice(-limit).reverse() };
}

function buildAShareSection(rows: QuoteRows, date: string, industryRows: BoardRow[]): MarketSection {
  if (!isWeekday(date)) return closedSection("aShare", "A股", CLOSED_TEXT.aShare);
  const quotes = [
    { name: "上证指数", row: byCode(rows, "000001") },
    { name: "深证成指", row: byCode(rows, "399001") },
    { name: "创业板指", row: byCode(rows, "399006") },
  ];
  const available = quotes.filter(item => !isMissingQuote(item.row));
  if (!available.length) return closedSection("aShare", "A股", UNAVAILABLE_TEXT.aShare);
  const missingNames = quotes.filter(item => isMissingQuote(item.row)).map(item => item.name);
  const sorted = available.toSorted((a, b) => Number(b.row.f3 || 0) - Number(a.row.f3 || 0));
  const indexText = available.map(({ name, row }) => `${row.f14 || name}收报 ${number(row.f2)} 点，${pct(row.f3)}`).join("；");
  const turnoverText = "成交额口径未获取到完整可比数据。";
  const missingText = missingNames.length ? `未获取到完整数据的指数：${missingNames.join("、")}。` : "";
  const { top, bottom } = topAndBottom(industryRows);
  const boardBoundary = industryRows.length ? "当前板块口径来自公开行业板块涨跌排行，用于描述市场结构，不替代个股分布或资金流向。" : "未获取到稳定行业板块数据时，本节只保留板块数据边界，不外推行业强弱。";
  return {
    key: "aShare",
    title: "A股",
    open: true,
    summary: `A股可用宽基指数为${available.map(({ name, row }) => `${row.f14 || name} ${pct(row.f3)}`).join("、")}`,
    markdown: [
      "## A股",
      "",
      `A股最近一个交易日，${indexText}。${turnoverText}${missingText}`,
      "",
      `从已获取的宽基指数强弱看，${sorted[0].row.f14 || sorted[0].name}相对占优，${sorted.at(-1)?.row.f14 || sorted.at(-1)?.name}表现偏弱。`,
      "",
      "## A股行业板块",
      "",
      boardLine("涨幅靠前行业", top),
      boardLine(laggingLabel("跌幅靠前行业", bottom), bottom),
      boardBoundary,
    ].join("\n"),
  };
}

function buildHkSection(rows: QuoteRows, date: string): MarketSection {
  if (!isWeekday(date)) return closedSection("hk", "港股", CLOSED_TEXT.hk);
  const hsi = byCode(rows, "HSI");
  const hscei = byCode(rows, "HSCEI");
  const hstech = byCode(rows, "HSTECH");
  if ([hsi, hscei].some(isMissingQuote)) return closedSection("hk", "港股", UNAVAILABLE_TEXT.hk);
  const totalTurnover = Number(hsi.f6 || 0) + Number(hscei.f6 || 0) + Number(hstech.f6 || 0);
  const turnoverText = totalTurnover > 0 ? `主要指数口径成交额合计约 ${amountYi(totalTurnover)}。` : "成交额口径未获取到完整可比数据。";
  const techText = isMissingQuote(hstech) ? "恒生科技指数未获取到完整数据" : `恒生科技指数收报 ${number(hstech.f2)} 点，${pct(hstech.f3)}`;
  return {
    key: "hk",
    title: "港股",
    open: true,
    summary: `港股主要指数分别为恒生指数 ${pct(hsi.f3)}、国企指数 ${pct(hscei.f3)}${isMissingQuote(hstech) ? "" : `、恒生科技指数 ${pct(hstech.f3)}`}`,
    markdown: [
      "## 港股",
      "",
      `港股最近一个交易日，恒生指数收报 ${number(hsi.f2)} 点，${pct(hsi.f3)}；国企指数收报 ${number(hscei.f2)} 点，${pct(hscei.f3)}；${techText}。${turnoverText}`,
      "",
      "当前港股部分使用主要指数与成交额数据描述大盘方向；若未获取到稳定行业板块数据，本节不外推行业强弱、南向资金或个别成分股影响。",
    ].join("\n"),
  };
}

function indexStructure(rows: { name: string; pct: number }[]): string {
  const sorted = rows.toSorted((a, b) => b.pct - a.pct);
  const strongest = sorted[0];
  const weakest = sorted.at(-1)!;
  const allPositive = rows.every(row => row.pct > 0.005);
  const allNegative = rows.every(row => row.pct < -0.005);
  const mixed = rows.some(row => row.pct > 0.005) && rows.some(row => row.pct < -0.005);
  const direction = allPositive ? "三大指数同涨" : allNegative ? "三大指数同跌" : mixed ? "三大指数表现分化" : "三大指数整体接近平盘";
  return `${direction}，${strongest.name}相对更强，${weakest.name}相对更弱`;
}

export function buildUsSection(rows: QuoteRows, date: string, sectors: SectorRow[], stocks: InstrumentRow[] = [], broadEtfs: InstrumentRow[] = [], externalArticles: ExternalMarketArticle[] = []): MarketSection {
  if (!isWeekday(date)) return closedSection("us", "美股", CLOSED_TEXT.us);
  const dji = byCode(rows, "DJIA");
  const nasdaq = byCode(rows, "NDX");
  const spx = byCode(rows, "SPX");
  if ([dji, nasdaq, spx].some(isMissingQuote)) return closedSection("us", "美股", UNAVAILABLE_TEXT.us);
  const structure = indexStructure([
    { name: "道指", pct: Number(dji.f3 || 0) },
    { name: "纳指", pct: Number(nasdaq.f3 || 0) },
    { name: "标普500", pct: Number(spx.f3 || 0) },
  ]);
  const { top, bottom } = topAndBottom(sectors);
  const { top: stockTop, bottom: stockBottom } = topAndBottom(stocks, 4);
  const sectorVolumeLeaders = sectors.filter(row => Number.isFinite(row.volumeRatio)).toSorted((a, b) => Number(b.volumeRatio || 0) - Number(a.volumeRatio || 0)).slice(0, 3);
  const stockSummary = stocks.length ? `核心个股方面，${stockTop.slice(0, 3).map(row => `${row.name} ${pct(row.pct)}`).join("、")}表现靠前，${stockBottom.slice(0, 3).map(row => `${row.name} ${pct(row.pct)}`).join("、")}表现靠后。` : "核心个股样本未获取到稳定数据，本篇不使用个股表现解释指数结构。";
  return {
    key: "us",
    title: "美股",
    open: true,
    summary: `美股三大指数分别为道指 ${pct(dji.f3)}、纳指 ${pct(nasdaq.f3)}、标普500 ${pct(spx.f3)}`,
    markdown: [
      "## 美股",
      "",
      `按已获取的完整常规收盘口径，道指 ${pct(dji.f3)}，纳指 ${pct(nasdaq.f3)}，标普500 ${pct(spx.f3)}。`,
      "",
      `从三大指数的相对强弱看，${structure}。`,
      "",
      volumeActivityLine("主要宽基 ETF 成交活跃度", broadEtfs),
      "",
      instrumentLine("核心个股涨幅靠前", stockTop),
      instrumentLine(laggingLabel("核心个股跌幅靠前", stockBottom), stockBottom),
      stockSummary,
      "",
      "## 美股行业板块",
      "",
      sectorLine("表现靠前行业 ETF", top),
      sectorLine("表现靠后行业 ETF", bottom),
      sectorVolumeLeaders.length ? volumeActivityLine("成交活跃度靠前的行业 ETF", sectorVolumeLeaders) : "行业 ETF 近 20 个交易日成交量均值不足，暂不判断行业 ETF 放量或缩量。",
      "行业板块采用 S&P 500 行业 ETF 作为近似口径，用于观察风格结构，不等同于完整成分股贡献；成交量只能描述活跃度，不等同于真实资金流。",
      "",
      ...externalArticleLines(externalArticles),
    ].join("\n"),
  };
}

async function yahooInstrumentDaily(symbol: string, name: string, date: string): Promise<InstrumentRow | null> {
  try {
    const rows = (await yahooFinance.historical(symbol, { period1: offsetDateString(date, -45), period2: offsetDateString(date, 1), interval: "1d" })) as YahooHistoryRow[];
    const points = rows
      .map(row => ({ close: Number(row.close), localDate: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : "" }))
      .filter(point => Number.isFinite(point.close) && point.close > 0 && point.localDate && point.localDate <= date);
    if (points.length < 2) return null;
    const prevClose = points.at(-2)!.close;
    const close = points.at(-1)!.close;
    if (!Number.isFinite(prevClose) || !Number.isFinite(close) || prevClose <= 0) return null;
    const lastVolume = Number(rows.find(row => row.date instanceof Date && row.date.toISOString().slice(0, 10) === points.at(-1)!.localDate)?.volume || 0);
    const historyVolumes = rows
      .map(row => ({ volume: Number(row.volume || 0), localDate: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : "" }))
      .filter(point => Number.isFinite(point.volume) && point.volume > 0 && point.localDate && point.localDate < points.at(-1)!.localDate)
      .slice(-20)
      .map(point => point.volume);
    const avgVolume20 = historyVolumes.length >= 20 ? historyVolumes.reduce((sum, volume) => sum + volume, 0) / historyVolumes.length : undefined;
    const volumeRatio = avgVolume20 && lastVolume > 0 ? lastVolume / avgVolume20 : undefined;
    return { symbol, name, close, pct: ((close - prevClose) / prevClose) * 100, volume: lastVolume || undefined, avgVolume20, volumeRatio };
  } catch {
    return null;
  }
}

async function yahooSectorDaily(symbol: string, date: string): Promise<SectorRow | null> {
  return yahooInstrumentDaily(symbol, US_SECTOR_ETFS[symbol] || symbol, date);
}

async function yahooInstruments(symbols: YahooSymbol[], date: string): Promise<InstrumentRow[]> {
  const rows = await Promise.all(symbols.map(symbol => yahooInstrumentDaily(symbol.symbol, symbol.name, date)));
  return rows.filter((row): row is InstrumentRow => Boolean(row));
}

async function usSectorEtfs(date: string): Promise<SectorRow[]> {
  const rows = await Promise.all(Object.keys(US_SECTOR_ETFS).map(symbol => yahooSectorDaily(symbol, date)));
  return rows.filter((row): row is SectorRow => Boolean(row));
}

type BtcSpot = { price: number; pct24h: number; pct7d: number; volume: number; marketCap: number; updatedAt: string };
type DeribitBookSummaryPayload<T> = { result?: T[] };
type DeribitPerpRow = {
  instrument_name?: string;
  open_interest?: number;
  volume_usd?: number;
  current_funding?: number;
  funding_8h?: number;
  price_change?: number;
  mark_price?: number;
};
type DeribitOptionRow = {
  instrument_name?: string;
  open_interest?: number;
  volume?: number;
  mark_iv?: number;
  underlying_price?: number;
  estimated_delivery_price?: number;
};
type ParsedBtcOption = {
  instrument: string;
  expiry: string;
  expiryMs: number;
  strike: number;
  type: "C" | "P";
  openInterest: number;
  volume: number;
  markIv: number;
  underlyingPrice: number;
};
type OptionExpirySummary = { expiry: string; totalOi: number; putCallOiRatio: number; putOi: number; callOi: number };
type BtcOptionSummary = {
  putCallOiRatio: number;
  putCallVolumeRatio: number;
  topExpiries: OptionExpirySummary[];
  maxPutOi: ParsedBtcOption | null;
  maxCallOi: ParsedBtcOption | null;
  nearExpiry: string;
  nearAtmIv: number;
  nearOtmPutIv: number;
  nearOtmCallIv: number;
  nearOtmIvSkew: number;
  atmTermStructure: { expiry: string; atmIv: number }[];
};
type FearGreed = { value: number; classification: string; timestamp: string };

const DERIBIT_MONTHS: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

async function btcSpot(): Promise<BtcSpot> {
  const rows = (await fetchJson<
    {
      current_price?: number;
      price_change_percentage_24h_in_currency?: number;
      price_change_percentage_7d_in_currency?: number;
      total_volume?: number;
      market_cap?: number;
      last_updated?: string;
    }[]
  >("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin&price_change_percentage=24h,7d&per_page=1&page=1&sparkline=false", { timeoutMs: 20_000 })) as {
    current_price?: number;
    price_change_percentage_24h_in_currency?: number;
    price_change_percentage_7d_in_currency?: number;
    total_volume?: number;
    market_cap?: number;
    last_updated?: string;
  }[];
  const row = rows[0] || {};
  const spot = {
    price: Number(row.current_price || 0),
    pct24h: Number(row.price_change_percentage_24h_in_currency || 0),
    pct7d: Number(row.price_change_percentage_7d_in_currency || 0),
    volume: Number(row.total_volume || 0),
    marketCap: Number(row.market_cap || 0),
    updatedAt: row.last_updated || "",
  };
  if (!(spot.price > 0) || !Number.isFinite(spot.pct24h) || !Number.isFinite(spot.pct7d)) throw new Error("BTC 现货价格或涨跌幅");
  return spot;
}

async function btcPerpetual(): Promise<DeribitPerpRow> {
  const payload = await fetchJson<DeribitBookSummaryPayload<DeribitPerpRow>>("https://www.deribit.com/api/v2/public/get_book_summary_by_instrument?instrument_name=BTC-PERPETUAL", { timeoutMs: 20_000 });
  const row = payload.result?.[0] || {};
  if (!(Number(row.mark_price || 0) > 0)) throw new Error("Deribit BTC-PERPETUAL mark price");
  return row;
}

function parseDeribitBtcOption(row: DeribitOptionRow): ParsedBtcOption | null {
  const instrument = row.instrument_name || "";
  const match = /^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-([CP])$/.exec(instrument);
  if (!match) return null;
  const month = DERIBIT_MONTHS[match[2]];
  if (month === undefined) return null;
  const day = Number(match[1]);
  const year = 2000 + Number(match[3]);
  const expiryMs = Date.UTC(year, month, day);
  const option = {
    instrument,
    expiry: `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    expiryMs,
    strike: Number(match[4]),
    type: match[5] as "C" | "P",
    openInterest: Number(row.open_interest || 0),
    volume: Number(row.volume || 0),
    markIv: Number(row.mark_iv || 0),
    underlyingPrice: Number(row.underlying_price || row.estimated_delivery_price || 0),
  };
  if (!Number.isFinite(option.strike) || !(option.strike > 0) || !Number.isFinite(option.expiryMs)) return null;
  return option;
}

function safeRatio(numerator: number, denominator: number): number {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0 ? numerator / denominator : 0;
}

function avg(values: number[]): number {
  const finite = values.filter(value => Number.isFinite(value) && value > 0);
  if (!finite.length) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function atmIv(rows: ParsedBtcOption[], underlying: number): number {
  if (!(underlying > 0)) return 0;
  return avg(
    rows
      .filter(row => row.markIv > 0)
      .toSorted((a, b) => Math.abs(a.strike - underlying) - Math.abs(b.strike - underlying))
      .slice(0, 6)
      .map(row => row.markIv),
  );
}

function closestOption(rows: ParsedBtcOption[], targetStrike: number, type: "C" | "P"): ParsedBtcOption | null {
  return (
    rows
      .filter(row => row.type === type && row.markIv > 0)
      .toSorted((a, b) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike))[0] || null
  );
}

function summarizeBtcOptions(rows: ParsedBtcOption[], underlying: number): BtcOptionSummary {
  const valid = rows.filter(row => row.openInterest > 0 || row.volume > 0 || row.markIv > 0);
  if (valid.length < 20) throw new Error("Deribit BTC option book rows");
  const puts = valid.filter(row => row.type === "P");
  const calls = valid.filter(row => row.type === "C");
  const putOi = puts.reduce((sum, row) => sum + row.openInterest, 0);
  const callOi = calls.reduce((sum, row) => sum + row.openInterest, 0);
  const putVolume = puts.reduce((sum, row) => sum + row.volume, 0);
  const callVolume = calls.reduce((sum, row) => sum + row.volume, 0);
  const byExpiry = new Map<string, ParsedBtcOption[]>();
  for (const row of valid) byExpiry.set(row.expiry, [...(byExpiry.get(row.expiry) || []), row]);
  const expiries = [...byExpiry.entries()].toSorted((a, b) => a[1][0].expiryMs - b[1][0].expiryMs);
  const topExpiries = expiries
    .map(([expiry, expiryRows]) => {
      const expiryPutOi = expiryRows.filter(row => row.type === "P").reduce((sum, row) => sum + row.openInterest, 0);
      const expiryCallOi = expiryRows.filter(row => row.type === "C").reduce((sum, row) => sum + row.openInterest, 0);
      return { expiry, putOi: expiryPutOi, callOi: expiryCallOi, totalOi: expiryPutOi + expiryCallOi, putCallOiRatio: safeRatio(expiryPutOi, expiryCallOi) };
    })
    .toSorted((a, b) => b.totalOi - a.totalOi)
    .slice(0, 5);
  const near = expiries.find(([, expiryRows]) => expiryRows.some(row => row.expiryMs >= Date.now() - 24 * 60 * 60 * 1000)) || expiries[0];
  const nearRows = near?.[1] || valid;
  const nearUnderlying = underlying || avg(nearRows.map(row => row.underlyingPrice));
  const otmPut = closestOption(nearRows.filter(row => row.strike <= nearUnderlying), nearUnderlying * 0.95, "P");
  const otmCall = closestOption(nearRows.filter(row => row.strike >= nearUnderlying), nearUnderlying * 1.05, "C");
  const atmTermStructure = expiries.slice(0, 6).map(([expiry, expiryRows]) => ({ expiry, atmIv: atmIv(expiryRows, underlying || avg(expiryRows.map(row => row.underlyingPrice))) })).filter(item => item.atmIv > 0);
  return {
    putCallOiRatio: safeRatio(putOi, callOi),
    putCallVolumeRatio: safeRatio(putVolume, callVolume),
    topExpiries,
    maxPutOi: puts.toSorted((a, b) => b.openInterest - a.openInterest)[0] || null,
    maxCallOi: calls.toSorted((a, b) => b.openInterest - a.openInterest)[0] || null,
    nearExpiry: near?.[0] || "",
    nearAtmIv: atmIv(nearRows, nearUnderlying),
    nearOtmPutIv: otmPut?.markIv || 0,
    nearOtmCallIv: otmCall?.markIv || 0,
    nearOtmIvSkew: (otmPut?.markIv || 0) - (otmCall?.markIv || 0),
    atmTermStructure,
  };
}

async function btcOptions(underlying: number): Promise<BtcOptionSummary> {
  const payload = await fetchJson<DeribitBookSummaryPayload<DeribitOptionRow>>("https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option", { timeoutMs: 20_000 });
  const rows = (payload.result || []).map(parseDeribitBtcOption).filter((row): row is ParsedBtcOption => Boolean(row));
  return summarizeBtcOptions(rows, underlying);
}

async function fearGreed(): Promise<FearGreed | null> {
  try {
    const payload = await fetchJson<{ data?: { value?: string; value_classification?: string; timestamp?: string }[] }>("https://api.alternative.me/fng/?limit=1&format=json", { timeoutMs: 20_000 });
    const row = payload.data?.[0];
    const value = Number(row?.value || 0);
    if (!Number.isFinite(value) || value <= 0) return null;
    return { value, classification: row?.value_classification || "", timestamp: row?.timestamp || "" };
  } catch {
    return null;
  }
}

function formatRatio(value: number): string {
  return Number.isFinite(value) && value > 0 ? value.toFixed(2) : "未获取";
}

function formatIv(value: number): string {
  return Number.isFinite(value) && value > 0 ? `${value.toFixed(2)}%` : "未获取";
}

function formatIvDiff(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(2)}%` : "未获取";
}

function optionOiLabel(option: ParsedBtcOption | null): string {
  if (!option) return "未获取";
  return `${option.expiry} ${usd(option.strike, 0)} ${option.type}，OI ${number(option.openInterest, 1)}`;
}

async function buildCryptoSection(): Promise<MarketSection> {
  try {
    const spot = await btcSpot();
    const [perp, options, sentiment] = await Promise.all([btcPerpetual(), btcOptions(spot.price), fearGreed()]);
    const funding8h = Number(perp.funding_8h || 0) * 100;
    const perpOi = Number(perp.open_interest || 0);
    const perpVolumeUsd = Number(perp.volume_usd || 0);
    const sentimentText = sentiment ? `Fear & Greed：${sentiment.value}（${sentiment.classification || "未分类"}）` : "Fear & Greed：未获取";
    return {
      key: "crypto",
      title: "比特币市场",
      open: true,
      summary: `BTC 约 ${usd(spot.price, 0)}，24小时 ${pct(spot.pct24h)}，7日 ${pct(spot.pct7d)}；Deribit 永续资金费率 ${pct(funding8h)}，期权全期限 Put/Call OI ${formatRatio(options.putCallOiRatio)}；${sentimentText}`,
      markdown: [
        "## BTC 现货状态",
        "",
        `BTC 现货约 ${usd(spot.price, 0)}，24小时 ${pct(spot.pct24h)}，7日 ${pct(spot.pct7d)}。24小时成交额约 ${usdWanYi(spot.volume)}，市值约 ${usdWanYi(spot.marketCap)}。`,
        spot.updatedAt ? `CoinGecko 更新时间：${spot.updatedAt}。` : "",
        "",
        "## 永续与杠杆结构",
        "",
        `Deribit BTC-PERPETUAL mark price 约 ${usd(Number(perp.mark_price || spot.price), 0)}，8小时资金费率 ${pct(funding8h)}，当前 funding ${pct(Number(perp.current_funding || 0) * 100)}。`,
        `永续 OI 约 ${usd(perpOi, 0)}，24小时成交额约 ${usd(perpVolumeUsd, 0)}，价格变化 ${pct(Number(perp.price_change || 0))}。`,
        "",
        "## 期权市场看空信号",
        "",
        `Deribit BTC option book 全期限 Put/Call OI ratio：${formatRatio(options.putCallOiRatio)}；Put/Call volume ratio：${formatRatio(options.putCallVolumeRatio)}。`,
        `主要到期日 OI/P-C 分布：${options.topExpiries.map(item => `${item.expiry} OI ${number(item.totalOi, 1)}，P/C ${formatRatio(item.putCallOiRatio)}`).join("；")}。`,
        `最大 Put OI 行权价：${optionOiLabel(options.maxPutOi)}。最大 Call OI 行权价：${optionOiLabel(options.maxCallOi)}。`,
        `近端 ${options.nearExpiry || "未获取"} ATM IV：${formatIv(options.nearAtmIv)}；约 5% OTM Put IV：${formatIv(options.nearOtmPutIv)}，约 5% OTM Call IV：${formatIv(options.nearOtmCallIv)}，Put-Call IV 差：${formatIvDiff(options.nearOtmIvSkew)}。`,
        `ATM IV 期限结构：${options.atmTermStructure.map(item => `${item.expiry} ${formatIv(item.atmIv)}`).join("；")}。`,
        "",
        "## 情绪与风险边界",
        "",
        `${sentimentText}。现货涨跌、永续资金费率、期权 OI/volume 与 IV 偏斜只能描述当前公开市场结构，不能单独推出单边崩盘或反转结论。`,
        "数据边界：本篇只覆盖 BTC；现货使用 CoinGecko 聚合报价，永续与期权使用 Deribit public book summary，情绪使用 Alternative.me Fear & Greed。Deribit OI、volume 与 IV 是交易所公开口径，不等同于全市场持仓、链上资金流或交易动作。",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`比特币日报核心数据未完整获取，停止生成：${reason}`);
  }
}

function buildSummary(sections: MarketSection[], scope: string): string {
  const openSections = sections.filter(section => section.open);
  const closedSections = sections.filter(section => !section.open);
  const paragraphs: string[] = [];

  if (openSections.length) paragraphs.push(`${scope}可复核状态：${openSections.map(section => section.summary).join("；")}。`);
  if (closedSections.length) paragraphs.push(`${closedSections.map(section => section.summary).join("；")}。`);
  if (!openSections.length && closedSections.length) paragraphs.push(`${scope}未产生或未获取到完整可用数据，日报以休市状态、数据边界和可用报价为主。`);
  paragraphs.push("以上内容只描述已获取数据对应的市场状态与数据边界，不生成交易动作或资产配置结论。");

  return ["## 总结", ...paragraphs].join("\n\n");
}

export async function generateAsiaMarketDaily(date = bjtDateString()): Promise<string> {
  const coreRows = isWeekday(date) ? await sinaQuotes(REQUIRED_ASIA_QUOTES, date) : {};
  const fallbackRows = REQUIRED_ASIA_QUOTES.some(symbol => isMissingQuote(byCode(coreRows, symbol.code)))
    ? await quoteRowsWithFallback(
        date,
        [EASTMONEY_INDEX_SECS.sh, EASTMONEY_INDEX_SECS.sz, EASTMONEY_INDEX_SECS.cyb, EASTMONEY_INDEX_SECS.hsi, EASTMONEY_INDEX_SECS.hscei, EASTMONEY_INDEX_SECS.hstech],
        REQUIRED_ASIA_QUOTES,
      )
    : {};
  const rows = { ...fallbackRows, ...coreRows };
  if (isWeekday(date)) assertRequiredQuotes(rows, REQUIRED_ASIA_QUOTES, "亚洲市场日报");
  const industryRows = isWeekday(date) ? await safeBoards("m:90+t:2", 20) : [];
  const sections = [buildAShareSection(rows, date, industryRows), buildHkSection(rows, date)];
  return `${[buildSummary(sections, "A股与港股市场"), ...sections.map(section => section.markdown)].join("\n\n").trim()}\n`;
}

export async function generateUsMarketDaily(date = bjtDateString()): Promise<string> {
  const rows = await quoteRowsWithFallback(date, [EASTMONEY_INDEX_SECS.dji, EASTMONEY_INDEX_SECS.nasdaq, EASTMONEY_INDEX_SECS.spx], YAHOO_SYMBOLS.us);
  const dji = byCode(rows, "DJIA");
  const nasdaq = byCode(rows, "NDX");
  const spx = byCode(rows, "SPX");
  const snapshot = { dji: Number(dji.f3 || 0), nasdaq: Number(nasdaq.f3 || 0), spx: Number(spx.f3 || 0) };
  const [sectors, stocks, broadEtfs, externalArticles] = isWeekday(date)
    ? await Promise.all([usSectorEtfs(date), yahooInstruments(US_CORE_STOCKS, date), yahooInstruments(US_BROAD_ETFS, date), yahooFinanceMarketArticles(date, snapshot)])
    : [[], [], [], []];
  const sections = [buildUsSection(rows, date, sectors, stocks, broadEtfs, externalArticles)];
  return `${[buildSummary(sections, "美股市场"), ...sections.map(section => section.markdown)].join("\n\n").trim()}\n`;
}

export async function generateCryptoMarketDaily(): Promise<string> {
  const sections = [await buildCryptoSection()];
  return `${[buildSummary(sections, "BTC 市场"), ...sections.map(section => section.markdown)].join("\n\n").trim()}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  const date = stringArg(args, "date", bjtDateString());
  const task = stringArg(args, "task", "asia-market-daily");
  const generators: Record<string, () => Promise<string>> = {
    "asia-market-daily": () => generateAsiaMarketDaily(date),
    "us-market-daily": () => generateUsMarketDaily(date),
    "crypto-market-daily": () => generateCryptoMarketDaily(),
  };
  const generator = generators[task];
  if (!generator) {
    writeStderr(`ERROR: unsupported market task: ${task}`);
    process.exit(1);
  }
  generator()
    .then(text => writeStdout(text))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      writeStderr(`ERROR: ${message}`);
      process.exit(1);
    });
}
