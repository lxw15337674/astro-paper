#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { parseArgs, repoRoot, stringArg, writeStderr, writeStdout } from "./blog_common.ts";

const FORBIDDEN_PATTERNS = [
  /Traceback \(most recent call last\)/i,
  /Script not found:/i,
  /归档失败/i,
  /上游 .* 未提供可归档的最终正文/i,
  /BLOCKED:/i,
  /\{\{[^}]+\}\}/,
  /待补充/,
  /示例(?:标题|正文|内容|链接|数据|文章|输出)/,
  /这是一[个篇段].{0,20}示例/,
  /建议关注|值得关注|继续关注|后续关注|最看好|赚钱点子|操作|布局|交易建议|投资建议/,
];

function parseJsonOutput(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const start = trimmed.indexOf("{");
  if (start >= 0) return JSON.parse(trimmed.slice(start));
  throw new Error("no JSON object found");
}

function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("post has no frontmatter");
  return { frontmatter: match[1], body: match[2] };
}

function verifyFrontmatter(file: string, expectedTask: string): string {
  const text = fs.readFileSync(file, "utf8");
  const { frontmatter } = splitFrontmatter(text);
  for (const field of ["author:", "pubDatetime:", "title:", "featured:", "draft: false", "tags:", "description:", "timezone: Asia/Shanghai"]) {
    if (!frontmatter.includes(field)) throw new Error(`${file} frontmatter missing ${field}`);
  }
  if (expectedTask === "hn-top10" && !frontmatter.includes("HackerNews")) throw new Error(`${file} frontmatter missing HackerNews tag/title`);
  const marketLabels: Record<string, string> = {
    "asia-market-daily": "亚洲市场日报",
    "crypto-market-daily": "数字货币日报",
    "us-market-daily": "美股市场日报",
  };
  const expectedMarketLabel = marketLabels[expectedTask];
  if (expectedMarketLabel && !frontmatter.includes(expectedMarketLabel)) throw new Error(`${file} frontmatter missing ${expectedMarketLabel} tag/title`);
  return text;
}

function requireTerms(relPath: string, body: string, terms: string[]): void {
  const missing = terms.filter(term => !body.includes(term));
  if (missing.length) throw new Error(`${relPath} missing required terms: ${missing.join(", ")}`);
}

function verifyNoPositiveDeclineLabel(relPath: string, body: string): void {
  const blocks = body.matchAll(/跌幅[^：\n。]*：([^。\n]+)/g);
  for (const match of blocks) {
    const values = [...match[1].matchAll(/([+-]?\d+(?:\.\d+)?)%/g)].map(item => Number(item[1]));
    if (values.length && values.every(value => value >= 0)) {
      throw new Error(`${relPath} labels non-negative percentage list as decline: ${match[0]}`);
    }
  }
}

function verifyMarketSemantics(relPath: string, body: string, task: string): void {
  verifyNoPositiveDeclineLabel(relPath, body);
  if (task === "asia-market-daily") {
    requireTerms(relPath, body, ["上证指数", "深证成指", "创业板指", "恒生指数", "国企指数", "恒生科技指数"]);
    if (/未获取到完整数据的指数|创业板指未获取到完整数据|恒生科技指数未获取到完整数据/.test(body)) {
      throw new Error(`${relPath} contains core Asia index missing-data language`);
    }
  }
  if (task === "crypto-market-daily") {
    requireTerms(relPath, body, ["总市值", "24小时成交量", "BTC", "ETH", "主流资产"]);
    if (/数字货币当日未获取到可用公开市场数据/.test(body)) throw new Error(`${relPath} contains missing core crypto market data`);
  }
  if (task === "us-market-daily" && !/美股当日未产生完整常规收盘数据|美股当日未获取到完整常规收盘数据/.test(body)) {
    requireTerms(relPath, body, ["道指", "纳指", "标普500"]);
  }
}

function verifyPostContract(repo: string, relPath: string, task: string): void {
  if (!relPath) throw new Error("post result is missing path");
  const postPath = path.join(repo, relPath);
  if (!fs.existsSync(postPath)) throw new Error(`generated post does not exist: ${relPath}`);
  const text = verifyFrontmatter(postPath, task);
  const { body } = splitFrontmatter(text);
  if (body.trim().length < 240) throw new Error(`${relPath} body is too short to be a publishable blog post`);
  if (!/^##\s+/m.test(body)) throw new Error(`${relPath} body has no section headings`);
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) throw new Error(`${relPath} contains forbidden pattern: ${pattern.source}`);
  }
  verifyMarketSemantics(relPath, body, task);
}

export function verifyResultJson(repo: string, resultJson: string): number {
  const payload = parseJsonOutput(fs.readFileSync(resultJson, "utf8")) as { results?: unknown[] };
  if (!Array.isArray(payload.results) || !payload.results.length) throw new Error(`${resultJson} has no results array`);
  let verified = 0;
  for (const item of payload.results) {
    if (!item || typeof item !== "object") throw new Error(`invalid result item: ${String(item)}`);
    const row = item as { task?: string; path?: string };
    verifyPostContract(repo, row.path || "", row.task || "");
    verified += 1;
  }
  return verified;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const resultJson = stringArg(args, "result-json");
  if (!resultJson) throw new Error("--result-json is required");
  const repo = path.resolve(stringArg(args, "repo", repoRoot()));
  const verified = verifyResultJson(repo, path.resolve(resultJson));
  writeStdout(`${JSON.stringify({ mode: "result-json", verified })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`ERROR: ${message}`);
    process.exit(1);
  });
}
