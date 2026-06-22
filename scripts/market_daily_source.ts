#!/usr/bin/env tsx
import { fetchJson, parseArgs, stringArg, writeStderr, writeStdout } from "./blog_common.ts";

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

type QuoteRow = Record<string, string | number | null | undefined>;
type QuoteRows = Record<string, QuoteRow>;

function pct(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
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

function buildUsSection(rows: QuoteRows): string {
  const dji = byCode(rows, "DJIA");
  const nasdaq = byCode(rows, "NDX");
  const spx = byCode(rows, "SPX");
  if ([dji, nasdaq, spx].some(isMissingQuote)) return "";
  const direction = Number(nasdaq.f3 || 0) > Number(dji.f3 || 0) ? "风险偏好回升" : "大盘权重相对均衡";
  return [
    "## 美股",
    "",
    "### 指数表现",
    "",
    `本自然日归档的美股部分，采用最近一次已完整落地的收盘数据。三大指数表现为：道指 ${pct(dji.f3)}；纳指 ${pct(nasdaq.f3)}；标普500 ${pct(spx.f3)}。`,
    "",
    "### 科技股与结构",
    "",
    `从指数结构看，纳指表现为 ${pct(nasdaq.f3)}，标普500表现为 ${pct(spx.f3)}，道指表现为 ${pct(dji.f3)}，整体呈现${direction}。`,
    "",
    "### 消息面",
    "",
    "美股部分以主要指数的已落地收盘表现为准；若需要进一步拆解个股和行业新闻，应以后续人工复盘或更完整的行情源为准。",
  ].join("\n");
}

function buildAShareSection(rows: QuoteRows): string {
  const sh = byCode(rows, "000001");
  const sz = byCode(rows, "399001");
  const cyb = byCode(rows, "399006");
  if ([sh, sz, cyb].some(isMissingQuote)) return "";
  const turnover = [sh, sz, cyb].reduce((sum, row) => sum + Number(row.f6 || 0), 0);
  const sorted = [sh, sz, cyb].sort((a, b) => Number(b.f3 || 0) - Number(a.f3 || 0));
  return [
    "## A股",
    "",
    "### 指数与成交",
    "",
    `A股最近一个交易日，上证指数收报 ${number(sh.f2)} 点，${pct(sh.f3)}；深证成指收报 ${number(sz.f2)} 点，${pct(sz.f3)}；创业板指收报 ${number(cyb.f2)} 点，${pct(cyb.f3)}。三项指数口径合计成交额约 ${amountWanYi(turnover)}。`,
    "",
    "### 强弱板块",
    "",
    `从宽基指数强弱看，${sorted[0].f14}相对占优，${sorted.at(-1)?.f14}表现偏弱。这个口径只能说明指数层面的风险偏好，不能替代完整行业涨跌幅。`,
    "",
    "### 当日主线",
    "",
    "A股部分暂以公开指数和成交额作为自动化日报底稿；若指数分化扩大，后续应优先补充行业和资金流数据，再判断真实主线。",
  ].join("\n");
}

function buildHkSection(rows: QuoteRows): string {
  const hsi = byCode(rows, "HSI");
  const hscei = byCode(rows, "HSCEI");
  if ([hsi, hscei].some(isMissingQuote)) return "";
  const totalTurnover = Number(hsi.f6 || 0) + Number(hscei.f6 || 0);
  return [
    "## 港股",
    "",
    "### 指数与资金",
    "",
    `港股最近一个交易日，恒生指数收报 ${number(hsi.f2)} 点，${pct(hsi.f3)}；国企指数收报 ${number(hscei.f2)} 点，${pct(hscei.f3)}。两项指数口径成交额合计约 ${amountYi(totalTurnover)}。`,
    "",
    "### 强弱板块",
    "",
    "自动化口径目前只使用主要指数数据，能够判断大盘风险偏好，但不足以可靠还原行业强弱。后续若接入行业涨跌幅和南向资金，可再扩展这一节。",
    "",
    "### 当日主线",
    "",
    "港股部分先以恒生指数和国企指数的方向为主线观察；若两者同步走弱，说明市场风险偏好偏谨慎，若国企指数相对更强，则更偏向权重和中资资产修复。",
  ].join("\n");
}

async function buildBtcSection(): Promise<string> {
  try {
    const payload = await fetchJson<{ bitcoin?: { usd?: number; usd_24h_change?: number } }>(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
      { timeoutMs: 15_000 },
    );
    const price = number(payload.bitcoin?.usd, 0);
    const change = pct(payload.bitcoin?.usd_24h_change);
    if (!price && !change) return "";
    return [
      "## BTC 市场动态",
      "",
      "### 自然日价格与涨跌",
      "",
      `BTC 当前参考价约为 ${price} 美元，近 24 小时变动 ${change}。`,
      "",
      "### 市场观察",
      "",
      "BTC 部分采用公开报价接口生成，仅作为风险资产情绪的辅助观察；若接口不可用或波动异常，应以后续人工复核为准。",
    ].join("\n");
  } catch {
    return "";
  }
}

function buildSummary(sections: string[]): string {
  const names = [];
  if (sections.some(section => section.startsWith("## 美股"))) names.push("美股");
  if (sections.some(section => section.startsWith("## A股"))) names.push("A股");
  if (sections.some(section => section.startsWith("## 港股"))) names.push("港股");
  if (sections.some(section => section.startsWith("## BTC"))) names.push("BTC");
  if (!names.length) return "";
  return [
    "## 总结",
    "",
    `本篇自动化日报覆盖 ${names.join("、")}。当前版本优先保证关键指数、成交额与 BTC 报价可复核，不在数据不足时硬编行业结论。`,
  ].join("\n");
}

export async function generateMarketDaily(): Promise<string> {
  const rows = await eastmoneyIndices(Object.values(EASTMONEY_INDEX_SECS));
  const sections = [buildUsSection(rows), buildAShareSection(rows), buildHkSection(rows), await buildBtcSection()].filter(section => section.trim());
  const summary = buildSummary(sections);
  if (summary) sections.push(summary);
  if (!sections.length) throw new Error("no publishable market sections generated");
  return `${sections.join("\n\n").trim()}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  void stringArg(args, "date");
  generateMarketDaily()
    .then(text => writeStdout(text))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      writeStderr(`ERROR: ${message}`);
      process.exit(1);
    });
}
