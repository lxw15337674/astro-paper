// 资本市场日报规则层：source 生成的行情数据由规则原样发布，模型只返回解读/普通人话（JSON）。
// - 美股/亚洲：数据正文原样保留（降级为 ###），模型只写「小结 + 解读」。数字 100% 来自 source。
// - 比特币：source 是技术证据，模型翻成 4 个普通人小节；规则层只保证 JSON 字段可组装。
import type { MarketSegment } from "./blog_tasks.ts";
import { parseModelJsonObject } from "./compose_common.ts";

const SEGMENT_HEADING: Record<MarketSegment, string> = { us: "美股", asia: "亚洲", crypto: "比特币" };

function demoteHeadings(markdown: string): string {
  // 数据段将嵌在 `## 美股|亚洲` 之下，把内部 `## 小节` 降为 `### 小节`。
  return markdown.replace(/^(#{2})\s+/gm, "### ").trim();
}

function requireProse(value: unknown, label: string): string {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is empty`);
  return text;
}

// 美股/亚洲：{ summary, interpretation }，数据来自 source。
function composeDataSegment(segment: "us" | "asia", raw: string, source: string): string {
  const heading = SEGMENT_HEADING[segment];
  const parsed = parseModelJsonObject(raw, `capital ${segment}`);
  const summary = requireProse(parsed.summary, `capital ${segment} summary`);
  const interpretation = requireProse(parsed.interpretation, `capital ${segment} interpretation`);
  const data = demoteHeadings(source);
  if (!data) throw new Error(`capital ${segment} has no source data to publish`);
  return `## ${heading}\n\n${summary}\n\n${data}\n\n${interpretation}\n`;
}

function composeCryptoSegment(raw: string): string {
  const parsed = parseModelJsonObject(raw, "capital crypto");
  const conclusion = requireProse(parsed.conclusion, "capital crypto conclusion");
  const priceMove = requireProse(parsed.price_move, "capital crypto price_move");
  const sentiment = requireProse(parsed.sentiment, "capital crypto sentiment");
  const shortTermRisk = requireProse(parsed.short_term_risk, "capital crypto short_term_risk");
  const block = [
    "## 比特币",
    "",
    "### 一句话结论",
    "",
    conclusion,
    "",
    "### 今天价格怎么走",
    "",
    priceMove,
    "",
    "### 市场情绪冷不冷",
    "",
    sentiment,
    "",
    "### 短线风险在哪里",
    "",
    shortTermRisk,
  ].join("\n");
  return `${block}\n`;
}

export function capitalMarketMarkdownFromModelJson(raw: string, source: string, segment: MarketSegment): string {
  if (segment === "crypto") return composeCryptoSegment(raw);
  return composeDataSegment(segment, raw, source);
}
