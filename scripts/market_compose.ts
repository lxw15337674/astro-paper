// 资本市场日报规则层：全部三段数据一次性喂给 AI，模型返回 7 字段 JSON，规则层组装完整文章。
import { CAPITAL_MARKET_SOURCE_SEP } from "./market_daily_source.ts";
import { parseModelJsonObject } from "./compose_common.ts";

function requireProse(value: unknown, label: string): string {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is empty`);
  return text;
}

function demoteHeadings(markdown: string): string {
  return markdown.replace(/^(#{2})\s+/gm, "### ").trim();
}

// 从 source 文本里按 SECTION 分隔符提取各块：[table, asia, us, crypto]
function extractSourceSections(source: string): [string, string, string, string] {
  const parts = source.split(CAPITAL_MARKET_SOURCE_SEP);
  return [parts[0]?.trim() ?? "", parts[1]?.trim() ?? "", parts[2]?.trim() ?? "", parts[3]?.trim() ?? ""];
}

export function composeFullCapitalMarket(raw: string, source: string): string {
  const parsed = parseModelJsonObject(raw, "capital market daily");
  const overview = requireProse(parsed.overview, "overview");
  const asiaSummary = requireProse(parsed.asia_summary, "asia_summary");
  const asiaInterpretation = requireProse(parsed.asia_interpretation, "asia_interpretation");
  const usSummary = requireProse(parsed.us_summary, "us_summary");
  const usInterpretation = requireProse(parsed.us_interpretation, "us_interpretation");
  const cryptoConclusion = requireProse(parsed.crypto_conclusion, "crypto_conclusion");
  const cryptoPriceMove = requireProse(parsed.crypto_price_move, "crypto_price_move");

  const [tableBlock, asiaBlock, usBlock] = extractSourceSections(source);

  const blocks: string[] = [`## 今日总览\n\n${overview}`];

  if (tableBlock) blocks.push(tableBlock);

  const usData = demoteHeadings(usBlock);
  blocks.push(usData ? `## 美股\n\n${usSummary}\n\n${usData}\n\n${usInterpretation}` : `## 美股\n\n${usSummary}\n\n${usInterpretation}`);

  const asiaData = demoteHeadings(asiaBlock);
  blocks.push(asiaData ? `## 亚洲\n\n${asiaSummary}\n\n${asiaData}\n\n${asiaInterpretation}` : `## 亚洲\n\n${asiaSummary}\n\n${asiaInterpretation}`);

  blocks.push(["## 比特币", "", "### 一句话结论", "", cryptoConclusion, "", "### 今天价格怎么走", "", cryptoPriceMove].join("\n"));

  return `${blocks.join("\n\n")}\n`;
}
