#!/usr/bin/env tsx
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import YahooFinance from "yahoo-finance2";
import { bjtDateString, compact, fetchJson, parseArgs, stringArg, writeStderr, writeStdout } from "./blog_common.ts";
import { buildMarketTableData, renderMarketTable, formatChange as formatMarketChange, formatLatest as formatMarketLatest, type MarketTableData, type MarketTableRow } from "./market_table_source.ts";

const yahooFinance = new YahooFinance({ suppressNotices: ["ripHistorical"] });

const EASTMONEY_FIELDS = "f12,f14,f2,f3,f4,f5,f6,f17,f18";
const EASTMONEY_INDEX_SECS = {
  dji: "100.DJIA",
  nasdaq: "100.NDX",
  spx: "100.SPX",
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

const US_BROAD_ETFS: YahooSymbol[] = [
  { symbol: "SPY", code: "SPY", name: "SPY" },
  { symbol: "QQQ", code: "QQQ", name: "QQQ" },
  { symbol: "DIA", code: "DIA", name: "DIA" },
];


type QuoteRow = Record<string, string | number | null | undefined>;
type QuoteRows = Record<string, QuoteRow>;
type EquityKey = "us" | "aShare" | "hk";

type MarketSection = {
  key: EquityKey | "crypto";
  title: string;
  markdown: string;
  open: boolean;
  summary: string;
  evidence: Record<string, unknown>;
};

type InstrumentRow = { symbol: string; name: string; pct: number; close: number; volume?: number; avgVolume20?: number; volumeRatio?: number };
type SectorRow = InstrumentRow;
type YahooHistoryRow = { date?: Date; close?: number | null; volume?: number | null };
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
      timestamp?: number[];
      indicators?: {
        quote?: { close?: (number | null)[]; volume?: (number | null)[] }[];
      };
    }[];
  };
};

type YahooSymbol = { symbol: string; code: string; name: string };

export class MarketSourceUnavailableError extends Error {
  constructor(
    readonly task: string,
    message: string,
  ) {
    super(message);
    this.name = "MarketSourceUnavailableError";
  }
}

const YAHOO_SYMBOLS = {
  us: [
    { symbol: "^DJI", code: "DJIA", name: "道指" },
    { symbol: "^IXIC", code: "NDX", name: "纳指" },
    { symbol: "^GSPC", code: "SPX", name: "标普500" },
  ],
} satisfies Record<string, YahooSymbol[]>;

const YAHOO_CHART_HOSTS = ["query2.finance.yahoo.com", "query1.finance.yahoo.com"];

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

function compactVolume(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "";
  if (num >= 100_000_000) return `${(num / 100_000_000).toFixed(2)}亿股`;
  if (num >= 10_000) return `${(num / 10_000).toFixed(0)}万股`;
  return `${num.toFixed(0)}股`;
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

export function quoteRowFromYahooChartPayload({ code, name, date, payload }: { code: string; name: string; date: string; payload: YahooChartPayload }): [string, QuoteRow] | null {
  const result = payload.chart?.result?.[0];
  const meta = result?.meta;
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const volumes = result?.indicators?.quote?.[0]?.volume || [];
  const close = Number(closes.at(-1) ?? meta?.regularMarketPrice);
  const previousClose = Number(closes.length >= 2 ? closes.at(-2) : meta?.chartPreviousClose);
  const timestamp = Number(timestamps.at(-1) || meta?.regularMarketTime || 0);
  const localDate = timestamp ? new Date(timestamp * 1000).toISOString().slice(0, 10) : "";
  if (!Number.isFinite(close) || !Number.isFinite(previousClose) || close <= 0 || previousClose <= 0 || !localDate || localDate > date) return null;
  const change = close - previousClose;
  return [code, { f12: code, f14: name, f2: close, f3: (change / previousClose) * 100, f4: change, f6: Number(volumes.at(-1) ?? meta?.regularMarketVolume ?? 0) }];
}

async function yahooChartQuote({ symbol, code, name }: YahooSymbol, date: string): Promise<[string, QuoteRow] | null> {
  const period1 = Math.floor(parseDate(offsetDateString(date, -7)).getTime() / 1000);
  const period2 = Math.floor(parseDate(offsetDateString(date, 1)).getTime() / 1000);
  for (const host of YAHOO_CHART_HOSTS) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=history`;
    const parsed = await fetchJson<YahooChartPayload>(url, { timeoutMs: 20_000 })
      .then(payload => quoteRowFromYahooChartPayload({ code, name, date, payload }))
      .catch(() => null);
    if (parsed) return parsed;
  }
  return null;
}

async function yahooQuote(symbolConfig: YahooSymbol, date: string): Promise<[string, QuoteRow] | null> {
  const { code, name } = symbolConfig;
  if (code === "HSTECH") return yahooChartQuote(symbolConfig, date).catch(() => null);
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
  return { ...rows, ...yahooFallback };
}

function byCode(rows: QuoteRows, code: string): QuoteRow {
  return rows[code] || {};
}

function isMissingQuote(row: QuoteRow): boolean {
  const value = row.f2;
  return value === undefined || value === null || value === "-" || value === 0 || Number.isNaN(Number(value));
}

function closedSection(key: EquityKey, title: string, text: string): MarketSection {
  return {
    key,
    title,
    open: false,
    summary: text.split("，")[0].replace(/。$/, ""),
    markdown: [`## ${title}`, "", text].join("\n"),
    evidence: { market: key, status: "closed_or_unavailable", reason: text },
  };
}

function rounded(value: unknown, digits = 2): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(digits)) : null;
}

function directionFromChanges(changes: number[]): "up" | "down" | "mixed" | "flat" {
  const positive = changes.some(value => value > 0.005);
  const negative = changes.some(value => value < -0.005);
  if (positive && negative) return "mixed";
  if (positive) return "up";
  if (negative) return "down";
  return "flat";
}

function instrumentEvidence(row: InstrumentRow): Record<string, unknown> {
  return {
    symbol: row.symbol,
    name: row.name,
    close: rounded(row.close),
    change_pct: rounded(row.pct),
    change_display: pct(row.pct),
    volume_shares: rounded(row.volume, 0),
    volume_display: compactVolume(row.volume),
    average_volume_20d_shares: rounded(row.avgVolume20, 0),
    volume_vs_20d_average: rounded(row.volumeRatio),
    volume_vs_20d_average_display: Number.isFinite(row.volumeRatio) ? `${Number(row.volumeRatio).toFixed(2)} 倍` : "unavailable",
    average_period_days: 20,
  };
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

function topAndBottom<T extends { pct: number }>(rows: T[], limit = 5): { top: T[]; bottom: T[] } {
  const sorted = rows.toSorted((a, b) => b.pct - a.pct);
  const top = sorted.slice(0, limit);
  const bottomPool = sorted.slice(top.length);
  return { top, bottom: bottomPool.slice(-limit).reverse() };
}

const EQUITY_CATEGORIES = new Set(["股票", "A股", "港股"]);

const A_SHARE_INDEX_NAMES = ["上证指数", "深证成指", "创业板指数", "沪深300", "中证500", "科创50"];
const HK_INDEX_NAMES = ["恒生指数", "国企指数", "恒生科技指数"];

function marketTableRowsByName(data: MarketTableData): Map<string, MarketTableRow> {
  return new Map(data.rows.filter(row => EQUITY_CATEGORIES.has(row.category)).map(row => [row.name, row]));
}

function isAvailableMarketTableRow(row: MarketTableRow | undefined): row is MarketTableRow {
  return Boolean(row && row.latest !== null && Number.isFinite(row.latest) && row.prev_close !== null && Number.isFinite(row.prev_close));
}

function tablePct(row: MarketTableRow): number {
  return row.latest !== null && row.prev_close !== null && Number.isFinite(row.latest) && Number.isFinite(row.prev_close) && row.prev_close !== 0
    ? (row.latest / row.prev_close - 1) * 100
    : 0;
}

function tableIndexLine(row: MarketTableRow): string {
  return `${row.name}收报 ${formatMarketLatest(row.latest, row.decimals)} 点，${formatMarketChange(row.latest, row.prev_close, row.unit)}`;
}

function tableIndexSummary(row: MarketTableRow): string {
  return `${row.name} ${formatMarketChange(row.latest, row.prev_close, row.unit)}`;
}

function buildAsiaSectionFromMarketTable(data: MarketTableData, date: string, names: string[], key: "aShare" | "hk", title: string, closedText: string, unavailableText: string): MarketSection {
  if (!isWeekday(date)) return closedSection(key, title, closedText);
  const byName = marketTableRowsByName(data);
  const rows = names.map(name => byName.get(name)).filter(isAvailableMarketTableRow);
  if (!rows.length) return closedSection(key, title, unavailableText);
  const missing = names.filter(name => !isAvailableMarketTableRow(byName.get(name)));
  const sorted = rows.toSorted((a, b) => tablePct(b) - tablePct(a));
  const missingText = missing.length ? `未获取到完整数据的指数：${missing.join("、")}。` : "";
  const changes = rows.map(tablePct);
  return {
    key,
    title,
    open: true,
    summary: `${title}可用指数为${rows.map(tableIndexSummary).join("、")}`,
    markdown: [
      `## ${title}`,
      "",
      `${title}最近一个交易日，${rows.map(tableIndexLine).join("；")}。${missingText}`,
      "",
      `从已获取的宽基指数强弱看，${sorted[0].name}相对占优，${sorted.at(-1)?.name || sorted[0].name}表现偏弱。`,
      "",
      `数据口径：本节与顶部市场速览使用同一份 AkShare 指数历史数据，日期为 ${data.asof || data.date}；缺失项不由其它行情源补数。`,
    ].join("\n"),
    evidence: {
      market: key,
      status: "open",
      as_of: data.asof || data.date,
      direction: directionFromChanges(changes),
      strongest_index: sorted[0].name,
      weakest_index: sorted.at(-1)?.name || sorted[0].name,
      indices: rows.map(row => ({
        name: row.name,
        close: rounded(row.latest, row.decimals),
        change_pct: rounded(tablePct(row)),
        close_display: formatMarketLatest(row.latest, row.decimals),
        change_display: formatMarketChange(row.latest, row.prev_close, row.unit),
      })),
      missing_indices: missing,
      source: "AkShare index history; missing values are not backfilled from other providers",
    },
  };
}

export function buildAsiaMarketDailyFromTable(data: MarketTableData, date = data.date): string {
  const sections = [
    buildAsiaSectionFromMarketTable(data, date, A_SHARE_INDEX_NAMES, "aShare", "A股", CLOSED_TEXT.aShare, UNAVAILABLE_TEXT.aShare),
    buildAsiaSectionFromMarketTable(data, date, HK_INDEX_NAMES, "hk", "港股", CLOSED_TEXT.hk, UNAVAILABLE_TEXT.hk),
  ];
  return `${[buildSummary(sections, "A股与港股市场"), ...sections.map(section => section.markdown)].join("\n\n").trim()}\n`;
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

export function buildUsSection(rows: QuoteRows, date: string, sectors: SectorRow[], broadEtfs: InstrumentRow[] = []): MarketSection {
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
  const indexRows = [
    { name: "道指", close: Number(dji.f2), pct: Number(dji.f3 || 0) },
    { name: "纳指", close: Number(nasdaq.f2), pct: Number(nasdaq.f3 || 0) },
    { name: "标普500", close: Number(spx.f2), pct: Number(spx.f3 || 0) },
  ];
  const { top, bottom } = topAndBottom(sectors);
  const sectorVolumeLeaders = sectors.filter(row => Number.isFinite(row.volumeRatio)).toSorted((a, b) => Number(b.volumeRatio || 0) - Number(a.volumeRatio || 0)).slice(0, 3);
  const sectorSummary = sectors.length
    ? `行业层面，${top.slice(0, 3).map(row => `${row.name} ${pct(row.pct)}`).join("、")}表现靠前，${bottom.slice(0, 3).map(row => `${row.name} ${pct(row.pct)}`).join("、")}表现靠后`
    : "行业 ETF 样本未获取到稳定数据，本篇不外推行业强弱";
  return {
    key: "us",
    title: "美股",
    open: true,
    summary: `宽基指数：道指 ${pct(dji.f3)}、纳指 ${pct(nasdaq.f3)}、标普500 ${pct(spx.f3)}；${sectorSummary}`,
    markdown: [
      "## 指数与行业结构",
      "",
      `按已获取的完整常规收盘口径，道指 ${pct(dji.f3)}，纳指 ${pct(nasdaq.f3)}，标普500 ${pct(spx.f3)}。从三大指数的相对强弱看，${structure}。${sectorSummary}。`,
      "",
      volumeActivityLine("主要宽基 ETF 成交活跃度", broadEtfs),
      sectorVolumeLeaders.length ? volumeActivityLine("成交活跃度靠前的行业 ETF", sectorVolumeLeaders) : "行业 ETF 近 20 个交易日成交量均值不足，暂不判断行业 ETF 放量或缩量。",
      "行业板块采用 S&P 500 行业 ETF 作为近似口径，用于观察风格结构，不等同于完整成分股贡献；成交量只能描述活跃度，不等同于真实资金流。",
    ].join("\n"),
    evidence: {
      market: "us",
      status: "open",
      as_of: date,
      direction: directionFromChanges(indexRows.map(row => row.pct)),
      strongest_index: indexRows.toSorted((a, b) => b.pct - a.pct)[0].name,
      weakest_index: indexRows.toSorted((a, b) => a.pct - b.pct)[0].name,
      indices: indexRows.map(row => ({
        name: row.name,
        close: rounded(row.close),
        change_pct: rounded(row.pct),
        close_display: number(row.close),
        change_display: pct(row.pct),
      })),
      sectors: sectors.map(instrumentEvidence),
      broad_etfs: broadEtfs.map(instrumentEvidence),
      methodology: [
        "Sector performance uses S&P 500 sector ETFs as a style proxy, not full constituent contribution.",
        "Volume and the 20-day comparison describe trading activity, not capital flows.",
      ],
    },
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
        "## 期权与保护需求",
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
      evidence: {
        market: "crypto",
        status: "open",
        asset_scope: "BTC only",
        direction: directionFromChanges([spot.pct24h]),
        spot: {
          price_usd: rounded(spot.price, 0),
          change_24h_pct: rounded(spot.pct24h),
          change_7d_pct: rounded(spot.pct7d),
          change_period_hours: 24,
          longer_change_period_days: 7,
          volume_24h_usd: rounded(spot.volume, 0),
          volume_24h_trillion_usd: rounded(spot.volume / 1_000_000_000_000),
          market_cap_usd: rounded(spot.marketCap, 0),
          market_cap_trillion_usd: rounded(spot.marketCap / 1_000_000_000_000),
          updated_at: spot.updatedAt,
          source: "CoinGecko aggregated spot quote",
        },
        perpetual: {
          venue: "Deribit",
          instrument: "BTC-PERPETUAL",
          mark_price_usd: rounded(Number(perp.mark_price || spot.price), 0),
          funding_8h_pct: rounded(funding8h),
          funding_period_hours: 8,
          current_funding_pct: rounded(Number(perp.current_funding || 0) * 100),
          open_interest_usd: rounded(perpOi, 0),
          volume_24h_usd: rounded(perpVolumeUsd, 0),
          price_change_pct: rounded(Number(perp.price_change || 0)),
        },
        options: {
          venue: "Deribit",
          put_call_open_interest_ratio: rounded(options.putCallOiRatio),
          put_call_volume_ratio: rounded(options.putCallVolumeRatio),
          largest_expiries: options.topExpiries.map(item => ({
            expiry: item.expiry,
            total_open_interest: rounded(item.totalOi, 1),
            put_call_open_interest_ratio: rounded(item.putCallOiRatio),
          })),
          largest_put_open_interest: options.maxPutOi
            ? { expiry: options.maxPutOi.expiry, strike_usd: rounded(options.maxPutOi.strike, 0), open_interest: rounded(options.maxPutOi.openInterest, 1) }
            : null,
          largest_call_open_interest: options.maxCallOi
            ? { expiry: options.maxCallOi.expiry, strike_usd: rounded(options.maxCallOi.strike, 0), open_interest: rounded(options.maxCallOi.openInterest, 1) }
            : null,
          near_expiry: options.nearExpiry,
          near_atm_iv_pct: rounded(options.nearAtmIv),
          near_5pct_otm_put_iv_pct: rounded(options.nearOtmPutIv),
          near_5pct_otm_call_iv_pct: rounded(options.nearOtmCallIv),
          otm_distance_pct: 5,
          near_put_minus_call_iv_pct: rounded(options.nearOtmIvSkew),
          atm_iv_term_structure: options.atmTermStructure.map(item => ({ expiry: item.expiry, atm_iv_pct: rounded(item.atmIv) })),
        },
        sentiment: sentiment
          ? { fear_greed_value: sentiment.value, classification: sentiment.classification || "unclassified", source: "Alternative.me" }
          : { fear_greed_value: null, classification: "unavailable", source: "Alternative.me" },
        methodology: [
          "Deribit open interest, volume, funding and implied volatility are venue-level public data, not whole-market positions or trading actions.",
          "Price, funding, option ratios and volatility skew do not by themselves establish a crash or reversal.",
        ],
      },
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
  return buildAsiaMarketDailyFromTable(buildMarketTableData(date), date);
}

async function buildUsMarketSection(date: string): Promise<MarketSection> {
  const rows = await quoteRowsWithFallback(date, [EASTMONEY_INDEX_SECS.dji, EASTMONEY_INDEX_SECS.nasdaq, EASTMONEY_INDEX_SECS.spx], YAHOO_SYMBOLS.us);
  const [sectors, broadEtfs] = isWeekday(date)
    ? await Promise.all([usSectorEtfs(date), yahooInstruments(US_BROAD_ETFS, date)])
    : [[], []];
  const section = buildUsSection(rows, date, sectors, broadEtfs);
  if (!section.open) {
    throw new MarketSourceUnavailableError("us-market-daily", section.summary || "美股市场未产生或未获取到完整常规收盘数据");
  }
  return section;
}

export async function generateUsMarketDaily(date = bjtDateString()): Promise<string> {
  const sections = [await buildUsMarketSection(date)];
  return `${[buildSummary(sections, "美股市场"), ...sections.map(section => section.markdown)].join("\n\n").trim()}\n`;
}

export async function generateCryptoMarketDaily(): Promise<string> {
  const sections = [await buildCryptoSection()];
  return `${[buildSummary(sections, "BTC 市场"), ...sections.map(section => section.markdown)].join("\n\n").trim()}\n`;
}

// 去掉开头的 `## 总结` 块，只留数据/证据段，作为资本市场日报某段给模型的 source。
function stripSummaryBlock(markdown: string): string {
  return markdown.replace(/^##\s+总结[\s\S]*?(?=\n##\s+)/, "").trim();
}

// 市场速览表与结构化证据之间的分隔符，供 composeFullCapitalMarket 提取确定性表格。
export const CAPITAL_MARKET_SOURCE_SEP = "\n\n<!-- ===SECTION=== -->\n\n";

function marketOverviewEvidence(data: MarketTableData): Record<string, unknown> {
  return {
    as_of: data.asof || data.date,
    rows: data.rows.map(row => ({
      category: row.category,
      name: row.name,
      latest: rounded(row.latest, row.decimals),
      daily_change: formatMarketChange(row.latest, row.prev_close, row.unit),
      year_to_date_change: formatMarketChange(row.latest, row.year_open, row.unit),
      change_unit: row.unit,
    })),
  };
}

function structuredEvidenceBlock(evidence: Record<string, unknown>): string {
  return [`## 结构化市场证据`, "", "```json", JSON.stringify(evidence, null, 2), "```"].join("\n");
}

// 一次性拉取全部市场数据。市场速览继续确定性渲染；其它市场只向模型提供结构化证据。
// 市场速览表格与 A股/港股段共享同一次 buildMarketTableData 调用，避免 Python/AkShare 被调用两次。
// 美股数据不可用（休市）时抛 MarketSourceUnavailableError("capital-market-daily", ...)，触发任务级跳过。
export async function buildAllCapitalMarketSource(date: string): Promise<string> {
  const tableData = buildMarketTableData(date);
  const tableBlock = renderMarketTable(tableData);
  const ashareSection = buildAsiaSectionFromMarketTable(tableData, date, A_SHARE_INDEX_NAMES, "aShare", "A股", CLOSED_TEXT.aShare, UNAVAILABLE_TEXT.aShare);
  const hkSection = buildAsiaSectionFromMarketTable(tableData, date, HK_INDEX_NAMES, "hk", "港股", CLOSED_TEXT.hk, UNAVAILABLE_TEXT.hk);

  const [usResult, cryptoResult] = await Promise.allSettled([
    buildUsMarketSection(date),
    buildCryptoSection(),
  ]);

  if (usResult.status === "rejected") {
    const err = usResult.reason;
    const msg = err instanceof Error ? err.message : String(err);
    throw new MarketSourceUnavailableError("capital-market-daily", msg);
  }

  let cryptoEvidence: Record<string, unknown>;
  if (cryptoResult.status === "fulfilled") {
    cryptoEvidence = cryptoResult.value.evidence;
  } else {
    const msg = cryptoResult.reason instanceof Error ? cryptoResult.reason.message : String(cryptoResult.reason);
    writeStderr(`WARN: capital-market-daily crypto source fetch failed: ${msg}`);
    cryptoEvidence = { market: "crypto", status: "unavailable", reason: msg };
  }

  const evidence = {
    schema_version: 1,
    date,
    market_overview: marketOverviewEvidence(tableData),
    markets: {
      us: usResult.value.evidence,
      ashare: ashareSection.evidence,
      hk: hkSection.evidence,
      crypto: cryptoEvidence,
    },
  };

  return [tableBlock.trim(), structuredEvidenceBlock(evidence)].join(CAPITAL_MARKET_SOURCE_SEP);
}

// 保留旧接口供 CLI 调试用（market_table.py / generateAsiaMarketDaily 等单独调用）。
export type MarketSegment = "us" | "asia" | "crypto";
export async function buildCapitalSegmentSource(segment: MarketSegment, date = bjtDateString()): Promise<string> {
  const full = segment === "us" ? await generateUsMarketDaily(date) : segment === "asia" ? await generateAsiaMarketDaily(date) : await generateCryptoMarketDaily();
  return `${stripSummaryBlock(full)}\n`;
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
