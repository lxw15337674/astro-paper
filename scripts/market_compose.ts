// 资本市场日报规则层：确定性表格置顶，AI 负责其余完整正文，规则层做事实边界校验。
import { CAPITAL_MARKET_SOURCE_SEP } from "./market_daily_source.ts";
import { parseModelJsonObject, stripJsonFence } from "./compose_common.ts";

type MarketDirection = "up" | "down" | "mixed" | "flat";

type MarketEvidence = {
  direction?: MarketDirection;
  status?: string;
  strongest_index?: string;
  weakest_index?: string;
};

type CapitalMarketEvidence = {
  date?: string;
  market_overview?: unknown;
  markets?: Record<"us" | "ashare" | "hk" | "crypto", MarketEvidence>;
};

function requireProse(value: unknown, label: string): string {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is empty`);
  if (/^#{1,6}\s+/m.test(text)) throw new Error(`${label} must not contain headings`);
  if (/^(?:[-*+]\s+|\d+\.\s+)/m.test(text)) throw new Error(`${label} must use prose paragraphs, not lists`);
  return text;
}

function extractSource(source: string): { table: string; evidence: CapitalMarketEvidence } {
  const [table = "", evidenceBlock = ""] = source.split(CAPITAL_MARKET_SOURCE_SEP, 2);
  if (!table.trim() || !/^##\s+市场速览/m.test(table)) throw new Error("capital market source is missing the market overview table");
  const fencedJson = evidenceBlock.match(/```json\s*([\s\S]*?)\s*```/i)?.[1] || stripJsonFence(evidenceBlock);
  try {
    const evidence = JSON.parse(fencedJson) as CapitalMarketEvidence;
    if (!evidence.markets) throw new Error("markets is missing");
    return { table: table.trim(), evidence };
  } catch (error) {
    throw new Error(`capital market structured evidence is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonicalNumber(raw: string): string {
  const value = Number(raw.replaceAll(",", ""));
  return Number.isFinite(value) ? String(Object.is(value, -0) ? 0 : value) : raw;
}

function numbersIn(text: string): string[] {
  return (text.match(/(?<!\d)[+-]?\d[\d,]*(?:\.\d+)?/g) || []).map(canonicalNumber);
}

function evidenceNumbers(value: unknown, output = new Set<string>()): Set<string> {
  if (typeof value === "number" && Number.isFinite(value)) output.add(canonicalNumber(String(value)));
  else if (typeof value === "string") numbersIn(value).forEach(number => output.add(number));
  else if (Array.isArray(value)) value.forEach(item => evidenceNumbers(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach(item => evidenceNumbers(item, output));
  return output;
}

function assertNumbersComeFromEvidence(text: string, label: string, evidence: unknown): void {
  const allowed = evidenceNumbers(evidence);
  for (const number of numbersIn(text)) {
    if (!allowed.has(number)) {
      throw new Error(`${label} prose contains a number absent from its source evidence: ${number}`);
    }
  }
}

function assertDirection(text: string, market: string, evidence: MarketEvidence | undefined): void {
  if (!evidence || evidence.status !== "open" || !evidence.direction) return;
  const broad = "(?:三大[^。；，]{0,8}指数|主要[^。；，]{0,8}指数|宽基[^。；，]{0,8}指数|指数走势|宽基走势)";
  const contradiction: Partial<Record<MarketDirection, RegExp>> = {
    up: new RegExp(`${broad}[^。；，]{0,16}(?:同跌|全线下跌|普跌|下跌|走低|收跌|涨跌分化|走势分化)`),
    down: new RegExp(`${broad}[^。；，]{0,16}(?:同涨|全线上涨|普涨|上涨|走高|收涨|涨跌分化|走势分化)`),
    mixed: new RegExp(`${broad}[^。；，]{0,16}(?:同涨|同跌|全线上涨|全线下跌|普涨|普跌)`),
    flat: new RegExp(`${broad}[^。；，]{0,16}(?:大涨|大跌|全线上涨|全线下跌)`),
  };
  if (contradiction[evidence.direction]?.test(text)) {
    throw new Error(`${market} prose contradicts source direction ${evidence.direction}`);
  }
}

function assertRelativeStrength(text: string, market: string, evidence: MarketEvidence | undefined): void {
  if (!evidence || evidence.status !== "open") return;
  const strongest = evidence.strongest_index;
  const weakest = evidence.weakest_index;
  if (weakest && new RegExp(`${weakest}[^。；，]{0,10}(?:最强|领涨|占优|相对更强)`).test(text)) {
    throw new Error(`${market} prose describes the weakest index as strongest`);
  }
  if (strongest && new RegExp(`${strongest}[^。；，]{0,10}(?:最弱|领跌|垫底|相对更弱)`).test(text)) {
    throw new Error(`${market} prose describes the strongest index as weakest`);
  }
}

export function composeFullCapitalMarket(raw: string, source: string): string {
  const parsed = parseModelJsonObject(raw, "capital market daily");
  const description = requireProse(parsed.description, "description");
  const overview = requireProse(parsed.overview, "overview");
  const us = requireProse(parsed.us, "us");
  const ashare = requireProse(parsed.ashare, "ashare");
  const hk = requireProse(parsed.hk, "hk");
  const crypto = requireProse(parsed.crypto, "crypto");
  const { table, evidence } = extractSource(source);

  assertNumbersComeFromEvidence(description, "description", evidence);
  assertNumbersComeFromEvidence(overview, "overview", evidence);
  assertNumbersComeFromEvidence(us, "us", evidence.markets?.us);
  assertNumbersComeFromEvidence(ashare, "ashare", evidence.markets?.ashare);
  assertNumbersComeFromEvidence(hk, "hk", evidence.markets?.hk);
  assertNumbersComeFromEvidence(crypto, "crypto", evidence.markets?.crypto);
  assertDirection(us, "us", evidence.markets?.us);
  assertDirection(ashare, "ashare", evidence.markets?.ashare);
  assertDirection(hk, "hk", evidence.markets?.hk);
  assertDirection(crypto, "crypto", evidence.markets?.crypto);
  assertRelativeStrength(us, "us", evidence.markets?.us);
  assertRelativeStrength(ashare, "ashare", evidence.markets?.ashare);
  assertRelativeStrength(hk, "hk", evidence.markets?.hk);

  return `${[
    table,
    `## 今日总览\n\n${overview}`,
    `## 美股\n\n${us}`,
    `## A股\n\n${ashare}`,
    `## 港股\n\n${hk}`,
    `## 比特币\n\n${crypto}`,
  ].join("\n\n")}\n`;
}
