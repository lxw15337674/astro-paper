#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { bjtTimestamp, compact, frontmatter, parseArgs, readStdin, repoRoot, stringArg, TOTAL_TAG, writeStderr, writeStdout } from "./blog_common.ts";

const HN_DEFAULT_OG_IMAGE = "../../../../public/images/hn-cover.svg";
const ARCHIVE_PAYLOAD_MARKER = "===ARCHIVE_PAYLOAD===";

type HnPayloadItem = {
  rank?: number;
  title?: string;
  url?: string;
  hn_link?: string;
  topic?: string;
  score?: number;
  comments?: number;
  content_summary?: string;
  comment_summary?: string;
  original_excerpt?: string;
  hn_comment_excerpt?: string;
};

type ArchiveResult = {
  task: string;
  path: string;
  title: string;
  created: boolean;
  skipped: boolean;
  updated_at_bjt: string;
  commit: string;
  push: string;
  tags: string[];
};

function stripHeaders(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/^#+\s*Final response\s*\n/i, "")
    .replace(/^\*\*Final response\*\*\s*\n/i, "")
    .trim();
}

function rejectFailureText(text: string): void {
  if (!text.trim()) throw new Error("upstream content is empty");
  for (const pattern of [/Script not found:/i, /归档失败/i, /Traceback \(most recent call last\)/i, /command failed:/i, /BLOCKED:/i]) {
    if (pattern.test(text)) throw new Error(`upstream content appears to be an error message: ${pattern.source}`);
  }
}

function normalizeMarkdown(text: string): string {
  const cleaned = stripHeaders(text).replace(/\n{3,}/g, "\n\n").trim();
  rejectFailureText(cleaned);
  return `${cleaned}\n`;
}

function sanitizeGeneratedText(text = ""): string {
  const cleaned = text
    .replace(/\r\n/g, "\n")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+.+$/gm, "")
    .replace(/[А-Яа-яЁё]+/g, "")
    .replace(/[`*_]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+([，。！？；：,.!?;:])/g, "$1");
  if (!cleaned) return "";
  return /[。！？!?]$/.test(cleaned) ? cleaned : `${cleaned}。`;
}

function looksLowSignal(text = ""): boolean {
  const c = compact(text);
  if (!c) return true;
  return /评论(?:补充)?信息不足|信息不足|评论信号不足|原文页面提取失败|页面提取失败|待补充/.test(c);
}

function extractPayload(text: string): { body: string; items: HnPayloadItem[] } {
  const index = text.indexOf(ARCHIVE_PAYLOAD_MARKER);
  if (index < 0) return { body: text, items: [] };
  const body = text.slice(0, index).trim();
  const raw = text.slice(index + ARCHIVE_PAYLOAD_MARKER.length).trim();
  try {
    const payload = JSON.parse(raw) as { items?: HnPayloadItem[] };
    return { body, items: payload.items || [] };
  } catch {
    return { body, items: [] };
  }
}

function extractBullets(block: string): string[] {
  return block
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("- "))
    .map(line => line.slice(2).trim());
}

function bulletValue(bullets: string[], label: string): string {
  return bullets.find(bullet => bullet.startsWith(label))?.split("：").slice(1).join("：").trim() || "";
}

function normalizeParagraph(text: string): string {
  return sanitizeGeneratedText(text);
}

function formatHnTop10(text: string): { markdown: string; ogImage: string } {
  const { body, items: payloadItems } = extractPayload(text);
  const blocks = body
    .split(/(?=^\d+\.\s*🔥?\s+)/gm)
    .map(block => block.trim())
    .filter(block => /^\d+\.\s*🔥?\s+/.test(block) && !/今日 HackerNews 热门文章 Top 10/.test(block));
  const formattedItems: { topic: string; block: string }[] = [];
  blocks.forEach((block, index) => {
    const rank = index + 1;
    const title = block.match(/^\d+\.\s*🔥?\s*(.+)$/m)?.[1]?.trim() || payloadItems[index]?.title || `Item ${rank}`;
    const bullets = extractBullets(block);
    const payload = payloadItems[index] || {};
    const points = bullets.find(bullet => bullet.startsWith("⭐"))?.replace(/^⭐\s*/, "") || `${payload.score || 0} points · ${payload.comments || 0} 评论`;
    const topic = bulletValue(bullets, "主题") || payload.topic || "技术 / 观察";
    const link = bulletValue(bullets, "原文") || payload.url || "";
    const hnLink = bulletValue(bullets, "HN 讨论") || payload.hn_link || "";
    let contentSummary = bulletValue(bullets, "内容总结");
    let commentSummary = bulletValue(bullets, "评论总结");
    if ((!contentSummary || looksLowSignal(contentSummary)) && payload.content_summary) contentSummary = payload.content_summary;
    if ((!commentSummary || looksLowSignal(commentSummary)) && payload.comment_summary) commentSummary = payload.comment_summary;
    if (!contentSummary && payload.original_excerpt) contentSummary = `原文主要信息：${payload.original_excerpt}`;
    if (!commentSummary && payload.hn_comment_excerpt) commentSummary = `HN 评论摘录显示：${payload.hn_comment_excerpt}`;
    contentSummary = normalizeParagraph(contentSummary);
    commentSummary = normalizeParagraph(commentSummary);
    if (!contentSummary) return;
    const out = [`## ${rank}. ${title}`, ""];
    if (points) out.push(`- **热度**：${points}`);
    if (link) out.push(`- **原文**：${link}`);
    if (hnLink) out.push(`- **HN 讨论**：${hnLink}`);
    out.push("", contentSummary, "");
    if (commentSummary) out.push(commentSummary, "");
    formattedItems.push({ topic, block: out.join("\n").trim() });
  });
  if (!formattedItems.length) throw new Error("HN source produced no publishable items");
  return {
    markdown: formattedItems.map(item => item.block).join("\n\n"),
    ogImage: HN_DEFAULT_OG_IMAGE,
  };
}

function reorderMarketSummaryFirst(markdown: string): string {
  const blocks = markdown
    .split(/(?=^##\s+)/gm)
    .map(block => block.trim())
    .filter(Boolean);
  const frontMatter = blocks.filter(block => !block.startsWith("## "));
  const headingBlocks = blocks.filter(block => block.startsWith("## "));
  const summaryIndex = headingBlocks.findIndex(block => /^##\s+总结(?:\s|$)/m.test(block));
  if (summaryIndex < 0) throw new Error("market daily missing top-level summary section");
  const [summary] = headingBlocks.splice(summaryIndex, 1);
  return [...frontMatter, summary, ...headingBlocks].join("\n\n").trim();
}

function rejectMarketGuidance(markdown: string): void {
  const forbidden = [/建议关注/, /值得关注/, /继续关注/, /后续.*关注/, /最看好/, /赚钱点子/, /操作/, /布局/, /机会/, /交易建议/, /投资建议/];
  for (const pattern of forbidden) {
    if (pattern.test(markdown)) throw new Error(`market daily contains action-guidance language: ${pattern.source}`);
  }
}

function formatMarketDaily(text: string): string {
  const normalized = normalizeMarkdown(text);
  rejectMarketGuidance(normalized);
  const ordered = reorderMarketSummaryFirst(normalized);
  if (!ordered.startsWith("## 总结")) throw new Error("market daily summary must be the first section");
  return `${ordered}\n`;
}

function formatForeignTechPodcast(text: string): string {
  const normalized = normalizeMarkdown(text).replace(/\n---\n\n---\n/g, "\n\n---\n");
  const required = ["《今日国外热门科技访谈播客》", "## 今日总览", "## 今日播客清单", "### 中文主题", "### 基本信息", "### 一句话总结", "### Highlights", "### 长文笔记"];
  for (const marker of required) {
    if (!normalized.includes(marker)) throw new Error(`foreign tech podcast missing required section: ${marker}`);
  }
  const episodeCount = (normalized.match(/^##\s+.+$/gm) || []).filter(heading => !/今日总览|今日播客清单/.test(heading)).length;
  if (episodeCount < 3) throw new Error(`foreign tech podcast needs at least 3 episode sections, got ${episodeCount}`);
  if (normalized.length < 3200) throw new Error("foreign tech podcast note is too short to be a long-form article");
  return `${normalized.trim()}\n`;
}

function taskInfo(task: string): { titlePrefix: string; tag: string; description: string; fileName: string } {
  const tasks: Record<string, { titlePrefix: string; tag: string; description: string; fileName: string }> = {
    "hn-top10": {
      titlePrefix: "HackerNews Top 10",
      tag: "HackerNews",
      description: "每日 Hacker News 热门文章 Top 10 中文整理，按当天归档并覆盖更新。",
      fileName: "hackernews-{date}.md",
    },
    "asia-market-daily": {
      titlePrefix: "亚洲市场日报",
      tag: "亚洲市场日报",
      description: "每日 A股与港股市场日报，按北京时间自然日汇总主要指数、成交与板块结构。",
      fileName: "亚洲市场日报-{date}.md",
    },
    "crypto-market-daily": {
      titlePrefix: "数字货币日报",
      tag: "数字货币日报",
      description: "每日数字货币市场日报，汇总全市场市值、成交量、主流资产与分类板块结构。",
      fileName: "数字货币日报-{date}.md",
    },
    "us-market-daily": {
      titlePrefix: "美股市场日报",
      tag: "美股市场日报",
      description: "每日美股市场日报，按完整常规收盘口径汇总主要指数与行业板块结构。",
      fileName: "美股市场日报-{date}.md",
    },
    "foreign-tech-podcast": {
      titlePrefix: "海外科技访谈播客笔记",
      tag: "海外科技播客",
      description: "每日海外科技访谈播客中文长文笔记，整理技术、产品、产业与职业判断。",
      fileName: "海外科技播客-{date}.md",
    },
  };
  const info = tasks[task];
  if (!info) throw new Error(`unsupported task: ${task}`);
  return info;
}

export function archivePost({ task, date, repo, body, force }: { task: string; date: string; repo: string; body: string; force: boolean }): ArchiveResult {
  const info = taskInfo(task);
  const relPath = path.join("src/content/posts/zh-cn", info.fileName.replace("{date}", date));
  const absPath = path.join(repo, relPath);
  if (!force && fs.existsSync(absPath)) {
    return { task, path: relPath, title: `${info.titlePrefix}｜${date}`, created: false, skipped: true, updated_at_bjt: bjtTimestamp(), commit: "", push: "", tags: [TOTAL_TAG, info.tag] };
  }
  const formatted = task === "hn-top10" ? formatHnTop10(body) : task === "foreign-tech-podcast" ? { markdown: formatForeignTechPodcast(body), ogImage: "" } : { markdown: formatMarketDaily(body), ogImage: "" };
  const title = `${info.titlePrefix}｜${date}`;
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const existed = fs.existsSync(absPath);
  fs.writeFileSync(
    absPath,
    `${frontmatter({ title, date, description: info.description, tags: [TOTAL_TAG, info.tag], ogImage: formatted.ogImage })}${formatted.markdown.trim()}\n`,
    "utf8",
  );
  return { task, path: relPath, title, created: !existed, skipped: false, updated_at_bjt: bjtTimestamp(), commit: "", push: "", tags: [TOTAL_TAG, info.tag] };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const task = stringArg(args, "task");
  const date = stringArg(args, "date") || stringArg(args, "period");
  const repo = path.resolve(stringArg(args, "repo", repoRoot()));
  if (!task || !date) throw new Error("--task and --date are required");
  const result = archivePost({ task, date, repo, body: readStdin(), force: args.force === true || args["no-overwrite"] !== true });
  writeStdout(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`ERROR: ${message}`);
    process.exit(1);
  });
}
