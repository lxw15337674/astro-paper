#!/usr/bin/env tsx
import { bjtDateString, fetchJson, parseArgs, stringArg, writeStderr, writeStdout } from "./blog_common.ts";

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
};

const CLOSED_TEXT = {
  us: "美股当日未产生完整常规交易数据，本节不做涨跌与板块强弱判断。",
  aShare: "A股当日未产生完整常规交易数据，本节不做指数表现与市场结构判断。",
  hk: "港股当日未产生完整常规交易数据，本节不做指数表现与市场结构判断。",
};

const UNAVAILABLE_TEXT = {
  us: "美股当日未获取到完整常规交易数据，本节不做涨跌与板块强弱判断。",
  aShare: "A股当日未获取到完整常规交易数据，本节不做指数表现与市场结构判断。",
  hk: "港股当日未获取到完整常规交易数据，本节不做指数表现与市场结构判断。",
};

type QuoteRow = Record<string, string | number | null | undefined>;
type QuoteRows = Record<string, QuoteRow>;
type EquityKey = keyof typeof CLOSED_TEXT;

type MarketSection = {
  key: EquityKey | "btc";
  title: string;
  markdown: string;
  open: boolean;
  summary: string;
};

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

function amountYi(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  return `${(num / 100_000_000).toFixed(0)}亿元`;
}

function amountWanYi(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  return `${(num / 1_000_000_000_000).toFixed(2)}万亿元`;
}

function parseDate(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid date: ${date}`);
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
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

function buildUsSection(rows: QuoteRows, date: string): MarketSection {
  if (!isWeekday(date)) return closedSection("us", "美股", CLOSED_TEXT.us);
  const dji = byCode(rows, "DJIA");
  const nasdaq = byCode(rows, "NDX");
  const spx = byCode(rows, "SPX");
  if ([dji, nasdaq, spx].some(isMissingQuote)) return closedSection("us", "美股", UNAVAILABLE_TEXT.us);
  const nasdaqPct = Number(nasdaq.f3 || 0);
  const djiPct = Number(dji.f3 || 0);
  const structure = nasdaqPct > djiPct ? "纳指强于道指，风险偏好相对偏向成长资产" : "纳指与道指表现较接近，宽基结构相对均衡";
  return {
    key: "us",
    title: "美股",
    open: true,
    summary: `美股三大指数分别为道指 ${pct(dji.f3)}、纳指 ${pct(nasdaq.f3)}、标普500 ${pct(spx.f3)}`,
    markdown: [
      "## 美股",
      "",
      `本自然日归档的美股部分，采用最近一次已完整落地的收盘数据。道指 ${pct(dji.f3)}，纳指 ${pct(nasdaq.f3)}，标普500 ${pct(spx.f3)}。`,
      "",
      `从宽基结构看，${structure}。当前口径只覆盖主要指数，不外推具体行业、个股或资金来源。`,
    ].join("\n"),
  };
}

function buildAShareSection(rows: QuoteRows, date: string): MarketSection {
  if (!isWeekday(date)) return closedSection("aShare", "A股", CLOSED_TEXT.aShare);
  const sh = byCode(rows, "000001");
  const sz = byCode(rows, "399001");
  const cyb = byCode(rows, "399006");
  if ([sh, sz, cyb].some(isMissingQuote)) return closedSection("aShare", "A股", UNAVAILABLE_TEXT.aShare);
  const turnover = [sh, sz, cyb].reduce((sum, row) => sum + Number(row.f6 || 0), 0);
  const sorted = [sh, sz, cyb].toSorted((a, b) => Number(b.f3 || 0) - Number(a.f3 || 0));
  return {
    key: "aShare",
    title: "A股",
    open: true,
    summary: `A股三大宽基同步记录为上证指数 ${pct(sh.f3)}、深证成指 ${pct(sz.f3)}、创业板指 ${pct(cyb.f3)}`,
    markdown: [
      "## A股",
      "",
      `A股最近一个交易日，上证指数收报 ${number(sh.f2)} 点，${pct(sh.f3)}；深证成指收报 ${number(sz.f2)} 点，${pct(sz.f3)}；创业板指收报 ${number(cyb.f2)} 点，${pct(cyb.f3)}。三项指数口径合计成交额约 ${amountWanYi(turnover)}。`,
      "",
      `从宽基指数强弱看，${sorted[0].f14}相对占优，${sorted.at(-1)?.f14}表现偏弱。当前数据能够描述指数层面的风险偏好，不替代行业涨跌幅、资金流向或个股分布。`,
    ].join("\n"),
  };
}

function buildHkSection(rows: QuoteRows, date: string): MarketSection {
  if (!isWeekday(date)) return closedSection("hk", "港股", CLOSED_TEXT.hk);
  const hsi = byCode(rows, "HSI");
  const hscei = byCode(rows, "HSCEI");
  if ([hsi, hscei].some(isMissingQuote)) return closedSection("hk", "港股", UNAVAILABLE_TEXT.hk);
  const totalTurnover = Number(hsi.f6 || 0) + Number(hscei.f6 || 0);
  return {
    key: "hk",
    title: "港股",
    open: true,
    summary: `港股主要指数记录为恒生指数 ${pct(hsi.f3)}、国企指数 ${pct(hscei.f3)}`,
    markdown: [
      "## 港股",
      "",
      `港股最近一个交易日，恒生指数收报 ${number(hsi.f2)} 点，${pct(hsi.f3)}；国企指数收报 ${number(hscei.f2)} 点，${pct(hscei.f3)}。两项指数口径成交额合计约 ${amountYi(totalTurnover)}。`,
      "",
      "当前港股部分只使用主要指数与成交额数据，能够描述大盘方向与粗粒度风险偏好，不外推行业强弱、南向资金或个别成分股影响。",
    ].join("\n"),
  };
}

async function buildBtcSection(): Promise<MarketSection> {
  try {
    const payload = await fetchJson<{ bitcoin?: { usd?: number; usd_24h_change?: number } }>(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
      { timeoutMs: 15_000 },
    );
    const price = number(payload.bitcoin?.usd, 0);
    const change = pct(payload.bitcoin?.usd_24h_change);
    if (!price && !change) {
      return {
        key: "btc",
        title: "BTC 市场动态",
        open: false,
        summary: "BTC 当日未获取到可用公开报价",
        markdown: ["## BTC 市场动态", "", "BTC 当日未获取到可用公开报价，本节不做价格变化判断。"].join("\n"),
      };
    }
    return {
      key: "btc",
      title: "BTC 市场动态",
      open: true,
      summary: `BTC 参考价约 ${price} 美元，近 24 小时变动 ${change}`,
      markdown: [
        "## BTC 市场动态",
        "",
        `BTC 当前参考价约为 ${price} 美元，近 24 小时变动 ${change}。`,
        "",
        "BTC 部分采用公开报价接口生成，仅作为风险资产情绪的辅助观察；当前口径不包含成交量、链上数据或更长周期价格结构。",
      ].join("\n"),
    };
  } catch {
    return {
      key: "btc",
      title: "BTC 市场动态",
      open: false,
      summary: "BTC 当日未获取到可用公开报价",
      markdown: ["## BTC 市场动态", "", "BTC 当日未获取到可用公开报价，本节不做价格变化判断。"].join("\n"),
    };
  }
}

function buildSummary(sections: MarketSection[]): string {
  const equities = sections.filter(section => ["us", "aShare", "hk"].includes(section.key));
  const openEquities = equities.filter(section => section.open);
  const closedEquities = equities.filter(section => !section.open);
  const btc = sections.find(section => section.key === "btc");
  const paragraphs: string[] = [];

  if (openEquities.length) {
    paragraphs.push(`本篇日报先汇总当天可复核市场状态：${openEquities.map(section => section.summary).join("；")}。`);
  }
  if (closedEquities.length) {
    paragraphs.push(`${closedEquities.map(section => section.summary).join("；")}。`);
  }
  if (!openEquities.length && closedEquities.length) {
    paragraphs.push("主要权益市场未产生或未获取到完整常规交易数据，日报以休市状态、数据边界和可用资产报价为主。");
  }
  if (btc) {
    paragraphs.push(`${btc.summary}。`);
  }
  paragraphs.push("以上内容只描述已获取数据的市场状态与数据边界，不生成交易动作或资产配置结论。");

  return ["## 总结", ...paragraphs].join("\n\n");
}

async function quoteRowsForDate(date: string): Promise<QuoteRows> {
  if (!isWeekday(date)) return {};
  try {
    return await eastmoneyIndices(Object.values(EASTMONEY_INDEX_SECS));
  } catch {
    return {};
  }
}

export async function generateMarketDaily(date = bjtDateString()): Promise<string> {
  const rows = await quoteRowsForDate(date);
  const sections = [buildUsSection(rows, date), buildAShareSection(rows, date), buildHkSection(rows, date), await buildBtcSection()];
  return `${[buildSummary(sections), ...sections.map(section => section.markdown)].join("\n\n").trim()}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  const date = stringArg(args, "date", bjtDateString());
  generateMarketDaily(date)
    .then(text => writeStdout(text))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      writeStderr(`ERROR: ${message}`);
      process.exit(1);
    });
}
