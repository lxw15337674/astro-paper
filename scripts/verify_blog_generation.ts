#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { parseArgs, repoRoot, stringArg, writeStderr, writeStdout } from "./blog_common.ts";
import { isTask, taskInfo } from "./blog_tasks.ts";

const GENERATED_POST_TECHNICAL_ERROR_PATTERNS = [
  /Traceback \(most recent call last\)/i,
  /Script not found:/i,
  /归档失败/i,
  /上游 .* 未提供可归档的最终正文/i,
  /BLOCKED:/i,
  /\{\{[^}]+\}\}/,
];

const SOURCE_TECHNICAL_ERROR_PATTERNS = [
  /Traceback \(most recent call last\)/i,
  /Script not found:/i,
  /BLOCKED:/i,
  /\{\{[^}]+\}\}/,
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
  if (isTask(expectedTask)) {
    const info = taskInfo(expectedTask);
    if (!frontmatter.includes(info.tag)) throw new Error(`${file} frontmatter missing ${info.tag} tag`);
    // daily-podcasts 标题改为「节目名：本期中文标题」，不再带固定 titlePrefix。
    if (expectedTask !== "daily-podcasts" && !frontmatter.includes(info.titlePrefix)) throw new Error(`${file} frontmatter missing ${info.titlePrefix} title`);
  }
  return text;
}

function requireTerms(relPath: string, body: string, terms: string[]): void {
  const missing = terms.filter(term => !body.includes(term));
  if (missing.length) throw new Error(`${relPath} missing required source terms: ${missing.join(", ")}`);
}

function requireTermPatterns(relPath: string, body: string, terms: { label: string; pattern: RegExp }[]): void {
  const missing = terms.filter(term => !term.pattern.test(body)).map(term => term.label);
  if (missing.length) throw new Error(`${relPath} missing required source terms: ${missing.join(", ")}`);
}

function resolveArtifactPath(repo: string, artifactPath: string): string {
  return path.isAbsolute(artifactPath) ? artifactPath : path.join(repo, artifactPath);
}

function verifyNumberedSourceBlocks(relPath: string, source: string, minBlocks: number): void {
  const blocks = source.match(/^#{2,3}\s+\d+\.\s+/gm) || [];
  if (blocks.length < minBlocks) throw new Error(`${relPath} source has too few numbered items: ${blocks.length} < ${minBlocks}`);
}

function hasNoCompleteUsRegularCloseData(source: string): boolean {
  return /美股当日未(?:产生|获取到)完整常规收盘数据/.test(source);
}

function verifySourceContract(repo: string, task: string, sourceArtifact: string): void {
  if (!sourceArtifact) throw new Error(`${task || "unknown task"} generated without source artifact`);
  const sourcePath = resolveArtifactPath(repo, sourceArtifact);
  if (!fs.existsSync(sourcePath)) throw new Error(`source artifact does not exist: ${sourceArtifact}`);
  const source = fs.readFileSync(sourcePath, "utf8");
  const relPath = path.relative(repo, sourcePath) || sourceArtifact;
  if (task === "us-market-daily" && hasNoCompleteUsRegularCloseData(source)) return;
  if (source.trim().length < 80) throw new Error(`${relPath} source is too short to support generation`);
  for (const pattern of SOURCE_TECHNICAL_ERROR_PATTERNS) {
    if (pattern.test(source)) throw new Error(`${relPath} source contains technical error pattern: ${pattern.source}`);
  }

  if (task === "crypto-market-daily") {
    requireTerms(relPath, source, ["BTC", "CoinGecko", "Deribit", "Put/Call", "ATM IV", "5% OTM Put IV", "5% OTM Call IV", "Fear & Greed"]);
    return;
  }
  if (task === "us-market-daily") {
    requireTerms(relPath, source, ["道指", "纳指"]);
    requireTermPatterns(relPath, source, [
      { label: "标普500", pattern: /标普\s*500/ },
      { label: "regular close or sector ETF evidence", pattern: /完整常规收盘|行业 ETF/ },
    ]);
    return;
  }
  if (task === "asia-market-daily") {
    requireTerms(relPath, source, ["上证指数", "深证成指", "创业板指", "恒生指数", "国企指数", "恒生科技指数"]);
    return;
  }
  if (task === "hn-top10") {
    requireTerms(relPath, source, ["HN 讨论", "原文"]);
    return;
  }
  if (task === "daily-podcasts") {
    requireTermPatterns(relPath, source, [
      { label: "podcast metadata", pattern: /节目|来源|音频|链接/ },
      { label: "transcript evidence", pattern: /transcript|转写|摘录|长文|内容/i },
    ]);
    return;
  }
  if (task === "github-trending-daily") {
    verifyNumberedSourceBlocks(relPath, source, 5);
    requireTerms(relPath, source, ["GitHub Trending"]);
    requireTermPatterns(relPath, source, [{ label: "repository links", pattern: /https:\/\/github\.com\// }]);
    return;
  }
  if (task === "tech-weekly" || task === "ai-weekly") {
    verifyNumberedSourceBlocks(relPath, source, 8);
    requireTermPatterns(relPath, source, [{ label: "source links", pattern: /- 链接：https?:\/\// }]);
    return;
  }
  if (task === "tech-business-weekly") {
    verifyNumberedSourceBlocks(relPath, source, 8);
    requireTermPatterns(relPath, source, [{ label: "source links", pattern: /- 链接：https?:\/\// }]);
    return;
  }
  if (task === "tech-daily" || task === "ai-daily" || task === "tech-business-daily") {
    requireTermPatterns(relPath, source, [{ label: "classified source link", pattern: /- 链接：https?:\/\// }]);
  }
}

function verifyPostContract(repo: string, relPath: string, task: string): void {
  if (!relPath) throw new Error("post result is missing path");
  const postPath = path.join(repo, relPath);
  if (!fs.existsSync(postPath)) throw new Error(`generated post does not exist: ${relPath}`);
  const text = verifyFrontmatter(postPath, task);
  const { body } = splitFrontmatter(text);
  if (!body.trim()) throw new Error(`${relPath} body is empty`);
  if (!/^##\s+/m.test(body)) throw new Error(`${relPath} body has no section headings`);
  for (const pattern of GENERATED_POST_TECHNICAL_ERROR_PATTERNS) {
    if (pattern.test(text)) throw new Error(`${relPath} contains generated-post technical error pattern: ${pattern.source}`);
  }
}

export function verifyResultJson(repo: string, resultJson: string): number {
  const payload = parseJsonOutput(fs.readFileSync(resultJson, "utf8")) as { results?: unknown[] };
  if (!Array.isArray(payload.results) || !payload.results.length) throw new Error(`${resultJson} has no results array`);
  let verified = 0;
  for (const item of payload.results) {
    if (!item || typeof item !== "object") throw new Error(`invalid result item: ${String(item)}`);
    const row = item as { task?: string; path?: string; skipped?: boolean; failed?: boolean; error?: string; generation?: { source_artifact?: string } };
    if (row.failed) {
      if (!row.task || !row.error) throw new Error(`failed result item is missing task or error: ${JSON.stringify(row)}`);
      continue;
    }
    if (row.skipped && !row.path) continue;
    verifyPostContract(repo, row.path || "", row.task || "");
    if (row.generation?.source_artifact) verifySourceContract(repo, row.task || "", row.generation.source_artifact);
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
