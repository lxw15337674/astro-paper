#!/usr/bin/env tsx
import { CoinGeckoClient } from "coingecko-api-v3";
import YahooFinance from "yahoo-finance2";
import { bjtDateString, fetchJson, parseArgs, stringArg, writeStderr, writeStdout } from "./blog_common.ts";

const yahooFinance = new YahooFinance({ suppressNotices: ["ripHistorical"] });
const coinGecko = new CoinGeckoClient({ timeout: 20_000, autoRetry: false });

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
type SectorRow = { symbol: string; name: string; pct: number; close: number };
type CryptoCoin = { name: string; symbol: string; price: number; pct: number; marketCap: number; volume: number };

type YahooHistoryRow = { date?: Date; close?: number | null; volume?: number | null };

type YahooSymbol = { symbol: string; code: string; name: string };

const YAHOO_SYMBOLS = {
  aShare: [
    { symbol: "000001.SS", code: "000001", name: "上证指数" },
    { symbol: "399001.SZ", code: "399001", name: "深证成指" },
    { symbol: "399006.SZ", code: "399006", name: "创业板指" },
  ],
  hk: [
    { symbol: "^HSI", code: "HSI", name: "恒生指数" },
    { symbol: "^HSCE", code: "HSCEI", name: "国企指数" },
  ],
  us: [
    { symbol: "^DJI", code: "DJIA", name: "道指" },
    { symbol: "^IXIC", code: "NDX", name: "纳指" },
    { symbol: "^GSPC", code: "SPX", name: "标普500" },
  ],
} satisfies Record<string, YahooSymbol[]>;

function pct(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  if (Math.abs(num) < 0.005) return "0.00%";
  return `${num > 0 ? "+" : ""}${num.toFixed(2)}%`;
}

function ratioPct(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  return `${num.toFixed(2)}%`;
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

async function yahooQuote({ symbol, code, name }: YahooSymbol, date: string): Promise<[string, QuoteRow] | null> {
  const rows = (await yahooFinance.historical(symbol, { period1: offsetDateString(date, -21), period2: offsetDateString(date, 1), interval: "1d" })) as YahooHistoryRow[];
  const points = rows
    .map(row => ({ close: Number(row.close), volume: Number(row.volume || 0), localDate: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : "" }))
    .filter(point => Number.isFinite(point.close) && point.close > 0 && point.localDate && point.localDate <= date);
  if (points.length < 2) return null;
  const last = points.at(-1)!;
  const prev = points.at(-2)!;
  const change = last.close - prev.close;
  const pctChange = (change / prev.close) * 100;
  return [code, { f12: code, f14: name, f2: last.close, f3: pctChange, f4: change, f6: last.volume }];
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
  const missing = yahooSymbols.filter(symbol => isMissingQuote(byCode(rows, symbol.code)));
  if (!missing.length) return rows;
  const fallback = await yahooQuotes(missing, date);
  return { ...rows, ...fallback };
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

function sectorLine(label: string, rows: SectorRow[]): string {
  if (!rows.length) return `${label}：未获取到稳定行业 ETF 数据。`;
  return `${label}：${rows.map(row => `${row.name} ${pct(row.pct)}`).join("、")}。`;
}

function cryptoLine(label: string, rows: CryptoCoin[]): string {
  if (!rows.length) return `${label}：未获取到稳定主流币数据。`;
  return `${label}：${rows.map(row => `${row.symbol.toUpperCase()} ${pct(row.pct)}`).join("、")}。`;
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
      boardLine("跌幅靠前行业", bottom),
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

function buildUsSection(rows: QuoteRows, date: string, sectors: SectorRow[]): MarketSection {
  if (!isWeekday(date)) return closedSection("us", "美股", CLOSED_TEXT.us);
  const dji = byCode(rows, "DJIA");
  const nasdaq = byCode(rows, "NDX");
  const spx = byCode(rows, "SPX");
  if ([dji, nasdaq, spx].some(isMissingQuote)) return closedSection("us", "美股", UNAVAILABLE_TEXT.us);
  const nasdaqPct = Number(nasdaq.f3 || 0);
  const djiPct = Number(dji.f3 || 0);
  const structure = nasdaqPct > djiPct ? "纳指强于道指，成长风格相对更强" : "纳指与道指表现较接近，宽基结构相对均衡";
  const { top, bottom } = topAndBottom(sectors);
  return {
    key: "us",
    title: "美股",
    open: true,
    summary: `美股三大指数分别为道指 ${pct(dji.f3)}、纳指 ${pct(nasdaq.f3)}、标普500 ${pct(spx.f3)}`,
    markdown: [
      "## 美股",
      "",
      `美股最近一个完整常规收盘交易日，道指 ${pct(dji.f3)}，纳指 ${pct(nasdaq.f3)}，标普500 ${pct(spx.f3)}。`,
      "",
      `从三大指数的相对强弱看，${structure}。`,
      "",
      "## 美股行业板块",
      "",
      sectorLine("表现靠前行业 ETF", top),
      sectorLine("表现靠后行业 ETF", bottom),
      "行业板块采用 S&P 500 行业 ETF 作为近似口径，用于观察风格结构，不等同于完整成分股贡献。",
    ].join("\n"),
  };
}

async function yahooSectorDaily(symbol: string, date: string): Promise<SectorRow | null> {
  try {
    const rows = (await yahooFinance.historical(symbol, { period1: offsetDateString(date, -21), period2: offsetDateString(date, 1), interval: "1d" })) as YahooHistoryRow[];
    const points = rows
      .map(row => ({ close: Number(row.close), localDate: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : "" }))
      .filter(point => Number.isFinite(point.close) && point.close > 0 && point.localDate && point.localDate <= date);
    if (points.length < 2) return null;
    const prevClose = points.at(-2)!.close;
    const close = points.at(-1)!.close;
    if (!Number.isFinite(prevClose) || !Number.isFinite(close) || prevClose <= 0) return null;
    return { symbol, name: US_SECTOR_ETFS[symbol] || symbol, close, pct: ((close - prevClose) / prevClose) * 100 };
  } catch {
    return null;
  }
}

async function usSectorEtfs(date: string): Promise<SectorRow[]> {
  const rows = await Promise.all(Object.keys(US_SECTOR_ETFS).map(symbol => yahooSectorDaily(symbol, date)));
  return rows.filter((row): row is SectorRow => Boolean(row));
}

async function cryptoGlobal(): Promise<{ marketCap: number; volume: number; btcDominance: number; ethDominance: number }> {
  const payload = (await coinGecko.global()) as {
    data?: {
      total_market_cap?: { usd?: number };
      total_volume?: { usd?: number };
      market_cap_percentage?: { btc?: number; eth?: number };
    };
  };
  return {
    marketCap: Number(payload.data?.total_market_cap?.usd || 0),
    volume: Number(payload.data?.total_volume?.usd || 0),
    btcDominance: Number(payload.data?.market_cap_percentage?.btc || 0),
    ethDominance: Number(payload.data?.market_cap_percentage?.eth || 0),
  };
}

async function cryptoCoins(): Promise<CryptoCoin[]> {
  const rows = (await coinGecko.coinMarket({ vs_currency: "usd", order: "market_cap_desc", per_page: 30, page: 1, sparkline: false, price_change_percentage: "24h" })) as
    {
      name?: string;
      symbol?: string;
      current_price?: number;
      price_change_percentage_24h?: number;
      market_cap?: number;
      total_volume?: number;
    }[];
  return rows
    .map(row => ({
      name: row.name || row.symbol || "",
      symbol: row.symbol || "",
      price: Number(row.current_price || 0),
      pct: Number(row.price_change_percentage_24h || 0),
      marketCap: Number(row.market_cap || 0),
      volume: Number(row.total_volume || 0),
    }))
    .filter(row => row.name && row.symbol && Number.isFinite(row.pct) && row.marketCap > 0);
}

async function cryptoCategories(): Promise<BoardRow[]> {
  try {
    const rows = (await coinGecko.coinCategoriesListWithMarketData()) as { name?: string; market_cap_change_24h?: number; market_cap?: number }[];
    return rows
      .map(row => ({ name: row.name || "", pct: Number(row.market_cap_change_24h), amount: Number(row.market_cap || 0) }))
      .filter(row => row.name && Number.isFinite(row.pct) && Number(row.amount || 0) > 1_000_000_000)
      .slice(0, 80);
  } catch {
    return [];
  }
}

async function buildCryptoSection(): Promise<MarketSection> {
  try {
    const [global, coins, categories] = await Promise.all([cryptoGlobal(), cryptoCoins(), cryptoCategories()]);
    const topCoins = coins.slice(0, 10);
    const { top: coinTop, bottom: coinBottom } = topAndBottom(coins.filter(row => row.marketCap >= 1_000_000_000));
    const { top: categoryTop, bottom: categoryBottom } = topAndBottom(categories);
    return {
      key: "crypto",
      title: "数字货币市场",
      open: true,
      summary: `数字货币总市值约 ${usdWanYi(global.marketCap)}，24小时成交量约 ${usdWanYi(global.volume)}，BTC 占比 ${ratioPct(global.btcDominance)}，ETH 占比 ${ratioPct(global.ethDominance)}`,
      markdown: [
        "## 全市场概览",
        "",
        `数字货币总市值约 ${usdWanYi(global.marketCap)}，24小时成交量约 ${usdWanYi(global.volume)}。BTC 市值占比 ${ratioPct(global.btcDominance)}，ETH 市值占比 ${ratioPct(global.ethDominance)}。`,
        "",
        "## 主流资产表现",
        "",
        topCoins.map(row => `- ${row.name}（${row.symbol.toUpperCase()}）：${usd(row.price, row.price >= 100 ? 0 : 2)}，24小时 ${pct(row.pct)}，市值约 ${usdWanYi(row.marketCap)}`).join("\n"),
        "",
        "## 市场强弱结构",
        "",
        cryptoLine("市值不低于 10 亿美元资产中涨幅靠前", coinTop),
        cryptoLine("市值不低于 10 亿美元资产中跌幅靠前", coinBottom),
        boardLine("分类板块涨幅靠前", categoryTop),
        boardLine("分类板块跌幅靠前", categoryBottom),
        "",
        "## 数据边界",
        "",
        "本篇采用公开聚合行情接口，覆盖全市场市值、成交量、BTC/ETH 占比、主流币与部分分类板块。分类板块和涨跌排行会受到接口覆盖范围、流动性过滤和稳定币权重影响，不生成交易动作或资产配置结论。",
      ].join("\n"),
    };
  } catch {
    return {
      key: "crypto",
      title: "数字货币市场",
      open: false,
      summary: "数字货币当日未获取到可用公开市场数据",
      markdown: ["## 全市场概览", "", "数字货币当日未获取到可用公开市场数据，本篇不做价格变化、分类板块或市值结构判断。"].join("\n"),
    };
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
  const rows = await quoteRowsWithFallback(
    date,
    [EASTMONEY_INDEX_SECS.sh, EASTMONEY_INDEX_SECS.sz, EASTMONEY_INDEX_SECS.cyb, EASTMONEY_INDEX_SECS.hsi, EASTMONEY_INDEX_SECS.hscei, EASTMONEY_INDEX_SECS.hstech],
    [...YAHOO_SYMBOLS.aShare, ...YAHOO_SYMBOLS.hk],
  );
  const industryRows = isWeekday(date) ? await safeBoards("m:90+t:2", 20) : [];
  const sections = [buildAShareSection(rows, date, industryRows), buildHkSection(rows, date)];
  return `${[buildSummary(sections, "A股与港股市场"), ...sections.map(section => section.markdown)].join("\n\n").trim()}\n`;
}

export async function generateUsMarketDaily(date = bjtDateString()): Promise<string> {
  const rows = await quoteRowsWithFallback(date, [EASTMONEY_INDEX_SECS.dji, EASTMONEY_INDEX_SECS.nasdaq, EASTMONEY_INDEX_SECS.spx], YAHOO_SYMBOLS.us);
  const sectors = isWeekday(date) ? await usSectorEtfs(date) : [];
  const sections = [buildUsSection(rows, date, sectors)];
  return `${[buildSummary(sections, "美股市场"), ...sections.map(section => section.markdown)].join("\n\n").trim()}\n`;
}

export async function generateCryptoMarketDaily(): Promise<string> {
  const sections = [await buildCryptoSection()];
  return `${[buildSummary(sections, "数字货币市场"), ...sections.map(section => section.markdown)].join("\n\n").trim()}\n`;
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
