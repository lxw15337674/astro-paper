#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { bjtTimestamp, compact, frontmatter, parseArgs, readStdin, repoRoot, stringArg, TOTAL_TAG, writeStderr, writeStdout } from "./blog_common.ts";
import { assertNoHistoricalPodcastDuplicates } from "./foreign_tech_podcast_dedupe.ts";

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

function normalizedPodcastBlocks(markdown: string): string[] {
  return markdown
    .split(/\n{2,}/)
    .map(block => block.replace(/^[-*]\s+/gm, "").replace(/\s+/g, " ").trim())
    .filter(block => block.length >= 80 && !block.startsWith("---") && !block.startsWith("《"));
}

function rejectRepeatedPodcastContent(markdown: string): void {
  const headings = (markdown.match(/^##\s+(.+)$/gm) || []).map(heading => heading.replace(/^##\s+/, "").trim().toLowerCase());
  const duplicateHeading = headings.find((heading, index) => headings.indexOf(heading) !== index);
  if (duplicateHeading) throw new Error(`foreign tech podcast contains duplicate episode heading: ${duplicateHeading}`);
  const seen = new Set<string>();
  for (const block of normalizedPodcastBlocks(markdown)) {
    if (seen.has(block)) throw new Error(`foreign tech podcast contains repeated summary content: ${block.slice(0, 80)}`);
    seen.add(block);
  }
}

function formatForeignTechPodcast(text: string): string {
  const normalized = normalizeMarkdown(text).replace(/\n---\n\n---\n/g, "\n\n---\n");
  const required = ["《今日国外热门科技访谈播客》", "### 中文主题", "### 基本信息", "### 一句话总结", "### Highlights", "### 长文笔记"];
  for (const marker of required) {
    if (!normalized.includes(marker)) throw new Error(`foreign tech podcast missing required section: ${marker}`);
  }
  for (const marker of ["## 今日总览", "## 今日播客清单"]) {
    if (normalized.includes(marker)) throw new Error(`foreign tech podcast contains forbidden section: ${marker}`);
  }
  rejectRepeatedPodcastContent(normalized);
  const episodeCount = (normalized.match(/^##\s+.+$/gm) || []).length;
  const minEpisodes = Number(process.env.PODCAST_MIN_EPISODES || "3");
  if (episodeCount < minEpisodes) throw new Error(`foreign tech podcast needs at least ${minEpisodes} episode sections, got ${episodeCount}`);
  const minLength = Math.max(1200, minEpisodes * 1000);
  if (normalized.length < minLength) throw new Error(`foreign tech podcast note is too short to be a long-form article (${normalized.length} < ${minLength})`);
  return `${normalized.trim()}\n`;
}

function rejectPureTutorialWeekly(markdown: string): void {
  const forbidden = [/一文[读看搞]懂/, /从零(?:开始)?/, /入门教程/, /基础教程/, /面试题/, /API\s*详解/i, /使用教程/];
  for (const pattern of forbidden) {
    if (pattern.test(markdown)) throw new Error(`tech weekly contains pure tutorial language: ${pattern.source}`);
  }
}

function formatTechWeekly(text: string): string {
  const normalized = normalizeMarkdown(text);
  rejectPureTutorialWeekly(normalized);
  const requiredAny = [/^##\s+本周快讯\s*$/m, /^##\s+工程观察\s*$/m, /^##\s+工具与项目\s*$/m, /^##\s+版本与安全\s*$/m, /^##\s+值得读的长文\s*$/m];
  const matched = requiredAny.filter(pattern => pattern.test(normalized)).length;
  if (matched < 3) throw new Error("tech weekly needs at least three expected sections");
  const links = normalized.match(/https?:\/\/\S+/g) || [];
  if (links.length < 6) throw new Error(`tech weekly needs source links, got ${links.length}`);
  if (!/影响|取舍|风险|迁移|适合|可以忽略|代价|工程|实践/.test(normalized)) throw new Error("tech weekly lacks engineering judgement language");
  return `${normalized.trim()}\n`;
}

function rejectAiWeeklyNoise(markdown: string): void {
  const forbidden = [/融资/, /工具榜单/, /prompt\s*技巧/i, /提示词技巧/, /一文[读看搞]懂/, /从零(?:开始)?/, /入门教程/, /论文导读/, /赋能|颠覆|革命性|不容错过|值得关注/];
  for (const pattern of forbidden) {
    if (pattern.test(markdown)) throw new Error(`ai weekly contains low-signal language: ${pattern.source}`);
  }
}

function formatTechBusinessWeekly(text: string): string {
  const normalized = normalizeMarkdown(text);
  const requiredAny = [/^##\s+本周大事件\s*$/m, /^##\s+公司与平台\s*$/m, /^##\s+政策、监管与安全\s*$/m, /^##\s+市场与商业信号\s*$/m, /^##\s+值得继续观察\s*$/m];
  const matched = requiredAny.filter(pattern => pattern.test(normalized)).length;
  if (matched < 3) throw new Error("tech business weekly needs at least three expected sections");
  const links = normalized.match(/https?:\/\/\S+/g) || [];
  if (links.length < 8) throw new Error(`tech business weekly needs source links, got ${links.length}`);
  if (!/影响|风险|监管|政策|安全|平台|公司|商业|市场|企业|不确定|观察/.test(normalized)) throw new Error("tech business weekly lacks business judgement language");
  for (const pattern of [/原始链接未提供|链接见候选源/, /娱乐八卦/, /购物推荐/, /工具榜单/, /融资快讯/, /投资建议/, /买卖建议/, /股价预测/, /赋能|颠覆|革命性|不容错过|值得关注/]) {
    if (pattern.test(normalized)) throw new Error(`tech business weekly contains low-signal language: ${pattern.source}`);
  }
  return `${normalized.trim()}\n`;
}

function formatAiWeekly(text: string): string {
  const normalized = normalizeMarkdown(text);
  rejectAiWeeklyNoise(normalized);
  const requiredAny = [/^##\s+本周模型与产品\s*$/m, /^##\s+Agent 与工程化\s*$/m, /^##\s+AI Infra 与成本\s*$/m, /^##\s+安全、评测与治理\s*$/m, /^##\s+值得读的案例\/长文\s*$/m];
  const matched = requiredAny.filter(pattern => pattern.test(normalized)).length;
  if (matched < 3) throw new Error("ai weekly needs at least three expected sections");
  const links = normalized.match(/https?:\/\/\S+/g) || [];
  if (links.length < 6) throw new Error(`ai weekly needs source links, got ${links.length}`);
  if (!/能力|边界|成本|风险|治理|评测|安全|上下文|推理|Agent|模型|企业|生产/.test(normalized)) throw new Error("ai weekly lacks AI judgement language");
  return `${normalized.trim()}\n`;
}

function rejectDuplicateLinksAndHeadings(markdown: string, label: string): void {
  const links = (markdown.match(/https?:\/\/\S+/g) || []).map(link => link.replace(/[)）.,，。]+$/, "").toLowerCase());
  if (new Set(links).size !== links.length) throw new Error(`${label} contains duplicate links`);
  const headings = (markdown.match(/^###\s+(.+)$/gm) || []).map(heading => heading.replace(/^###\s+/, "").replace(/\]\(.+\)/, "]").trim().toLowerCase());
  if (new Set(headings).size !== headings.length) throw new Error(`${label} contains duplicate headings`);
}

function formatTechDaily(text: string): string {
  const normalized = normalizeMarkdown(text);
  rejectPureTutorialWeekly(normalized);
  rejectDuplicateLinksAndHeadings(normalized, "tech daily");
  const links = normalized.match(/https?:\/\/\S+/g) || [];
  if (links.length < 1) throw new Error(`tech daily needs source links, got ${links.length}`);
  if (!/影响|取舍|风险|迁移|适合|代价|工程|实践|架构|版本|安全/.test(normalized)) throw new Error("tech daily lacks engineering judgement language");
  return `${normalized.trim()}\n`;
}

function formatAiDaily(text: string): string {
  const normalized = normalizeMarkdown(text);
  rejectAiWeeklyNoise(normalized);
  rejectDuplicateLinksAndHeadings(normalized, "AI daily");
  const links = normalized.match(/https?:\/\/\S+/g) || [];
  if (links.length < 1) throw new Error(`AI daily needs source links, got ${links.length}`);
  if (!/能力|边界|成本|风险|治理|评测|安全|上下文|推理|Agent|模型|企业|生产|工程/.test(normalized)) throw new Error("AI daily lacks AI judgement language");
  return `${normalized.trim()}\n`;
}

function formatTechBusinessDaily(text: string): string {
  const normalized = normalizeMarkdown(text);
  const links = normalized.match(/https?:\/\/\S+/g) || [];
  if (links.length < 1) throw new Error(`tech business daily needs source links, got ${links.length}`);
  rejectDuplicateLinksAndHeadings(normalized, "tech business daily");
  if (!/影响|风险|监管|政策|安全|平台|公司|商业|市场|企业|不确定|观察|供应链/.test(normalized)) throw new Error("tech business daily lacks business judgement language");
  for (const pattern of [/原始链接未提供|链接见候选源/, /娱乐八卦/, /购物推荐/, /工具榜单/, /融资快讯/, /投资建议/, /买卖建议/, /股价预测/, /赋能|颠覆|革命性|不容错过|值得关注/]) {
    if (pattern.test(normalized)) throw new Error(`tech business daily contains low-signal language: ${pattern.source}`);
  }
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
    "tech-weekly": {
      titlePrefix: "技术趋势与工程观察",
      tag: "技术周刊",
      description: "每周技术趋势与工程观察，覆盖全技术领域的事件、工具、版本、安全与工程实践变化，不做纯教程搬运。",
      fileName: "技术周刊-{date}.md",
    },
    "ai-weekly": {
      titlePrefix: "AI 周刊",
      tag: "AI周刊",
      description: "每周 AI 模型、Agent、AI infra、安全评测与企业落地观察，过滤融资、营销、工具榜单和纯论文导读。",
      fileName: "AI周刊-{date}.md",
    },
    "tech-daily": {
      titlePrefix: "技术工程日报",
      tag: "技术工程日报",
      description: "每日技术工程深度整理，覆盖过去 24 小时的工程实践、开源项目、版本、安全、架构与工具链变化。",
      fileName: "技术工程日报-{date}.md",
    },
    "ai-daily": {
      titlePrefix: "AI 工程日报",
      tag: "AI工程日报",
      description: "每日 AI 工程深度整理，覆盖过去 24 小时的模型、Agent、AI infra、评测、安全治理与企业落地。",
      fileName: "AI工程日报-{date}.md",
    },
    "tech-business-daily": {
      titlePrefix: "科技商业观察日报",
      tag: "科技商业观察日报",
      description: "每日科技商业观察，覆盖过去 24 小时的科技公司、平台政策、监管、安全事件、芯片/云供应链与产业竞争。",
      fileName: "科技商业观察日报-{date}.md",
    },
    "tech-business-weekly": {
      titlePrefix: "科技商业观察周刊",
      tag: "科技商业观察",
      description: "每周科技商业观察，覆盖科技公司、平台政策、AI/芯片/云、监管、安全事件、开源生态与商业落地。",
      fileName: "科技商业观察-{date}.md",
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
  const formatted = task === "hn-top10" ? formatHnTop10(body) : task === "foreign-tech-podcast" ? { markdown: formatForeignTechPodcast(body), ogImage: "" } : task === "tech-weekly" ? { markdown: formatTechWeekly(body), ogImage: "" } : task === "ai-weekly" ? { markdown: formatAiWeekly(body), ogImage: "" } : task === "tech-business-weekly" ? { markdown: formatTechBusinessWeekly(body), ogImage: "" } : task === "tech-daily" ? { markdown: formatTechDaily(body), ogImage: "" } : task === "ai-daily" ? { markdown: formatAiDaily(body), ogImage: "" } : task === "tech-business-daily" ? { markdown: formatTechBusinessDaily(body), ogImage: "" } : { markdown: formatMarketDaily(body), ogImage: "" };
  if (task === "foreign-tech-podcast") assertNoHistoricalPodcastDuplicates(formatted.markdown, path.join(repo, "src/content/posts/zh-cn"), date);
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
