// 资本市场日报规则层：五段数据一次性喂给 AI，模型返回 10 字段 JSON，规则层组装完整文章。
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

// 从 source 文本里按 SECTION 分隔符提取各块：[table, ashare, hk, us, crypto]
function extractSourceSections(source: string): [string, string, string, string, string] {
  const parts = source.split(CAPITAL_MARKET_SOURCE_SEP);
  return [0, 1, 2, 3, 4].map(i => parts[i]?.trim() ?? "") as [string, string, string, string, string];
}

// 单个市场段：`## 标题` + 小结 + 数据块（降级标题）+ 解读；数据缺失则跳过数据块。
function marketSection(title: string, summary: string, dataBlock: string, interpretation: string): string {
  const data = demoteHeadings(dataBlock);
  return data ? `## ${title}\n\n${summary}\n\n${data}\n\n${interpretation}` : `## ${title}\n\n${summary}\n\n${interpretation}`;
}

export function composeFullCapitalMarket(raw: string, source: string): string {
  const parsed = parseModelJsonObject(raw, "capital market daily");
  const overview = requireProse(parsed.overview, "overview");
  const usSummary = requireProse(parsed.us_summary, "us_summary");
  const usInterpretation = requireProse(parsed.us_interpretation, "us_interpretation");
  const ashareSummary = requireProse(parsed.ashare_summary, "ashare_summary");
  const ashareInterpretation = requireProse(parsed.ashare_interpretation, "ashare_interpretation");
  const hkSummary = requireProse(parsed.hk_summary, "hk_summary");
  const hkInterpretation = requireProse(parsed.hk_interpretation, "hk_interpretation");
  const cryptoSummary = requireProse(parsed.crypto_summary, "crypto_summary");
  const cryptoInterpretation = requireProse(parsed.crypto_interpretation, "crypto_interpretation");

  const [tableBlock, ashareBlock, hkBlock, usBlock, cryptoBlock] = extractSourceSections(source);

  const blocks: string[] = [`## 今日总览\n\n${overview}`];

  if (tableBlock) blocks.push(tableBlock);

  blocks.push(marketSection("美股", usSummary, usBlock, usInterpretation));
  blocks.push(marketSection("A股", ashareSummary, ashareBlock, ashareInterpretation));
  blocks.push(marketSection("港股", hkSummary, hkBlock, hkInterpretation));
  blocks.push(marketSection("比特币", cryptoSummary, cryptoBlock, cryptoInterpretation));

  return `${blocks.join("\n\n")}\n`;
}
