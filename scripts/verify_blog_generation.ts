#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { parseArgs, repoRoot, stringArg, writeStderr, writeStdout } from "./blog_common.ts";
import { isDailyDigestTask, isTask, taskInfo } from "./blog_tasks.ts";

const COMMON_FORBIDDEN_PATTERNS = [
  /Traceback \(most recent call last\)/i,
  /Script not found:/i,
  /归档失败/i,
  /上游 .* 未提供可归档的最终正文/i,
  /BLOCKED:/i,
  /\{\{[^}]+\}\}/,
  /待补充/,
  /示例(?:标题|正文|内容|链接|数据|文章|输出)/,
  /这是一[个篇段].{0,20}示例/,
  /赚钱点子|交易建议|投资建议/,
  /@[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+@v?\d/,
];

const MARKET_FORBIDDEN_PATTERNS = [/建议关注|值得关注|继续关注|后续关注|最看好|操作|布局/];
const AI_STILTED_MARKET_PATTERNS = [/当前证据只能说明/, /不能据此(?:外推|写成)?/, /不支持进一步外推/, /就当前证据而言/, /整体看，/, /只适合作为/, /不能替代/];
const CRYPTO_STILTED_PATTERNS = [/当前证据只(?:能|是)/, /当前证据不足以/, /不能据此/, /不能单独推出/, /仅凭这些数字不能/, /整体看，/, /只适合作为/, /不能替代/, /期权市场看空信号/, /主要到期日中/, /最大 Put OI 行权价/, /ATM IV 期限结构为/, /放量|缩量|量能修复|成交修复/];
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
    if (!frontmatter.includes(info.titlePrefix)) throw new Error(`${file} frontmatter missing ${info.titlePrefix} title`);
  }
  return text;
}

function requireTerms(relPath: string, body: string, terms: string[]): void {
  const missing = terms.filter(term => !body.includes(term));
  if (missing.length) throw new Error(`${relPath} missing required terms: ${missing.join(", ")}`);
}

function requireTermPatterns(relPath: string, body: string, terms: { label: string; pattern: RegExp }[]): void {
  const missing = terms.filter(term => !term.pattern.test(body)).map(term => term.label);
  if (missing.length) throw new Error(`${relPath} missing required terms: ${missing.join(", ")}`);
}

function verifyNoMisleadingPercentageLabels(relPath: string, body: string): void {
  const declineBlocks = body.matchAll(/跌幅[^：\n。]*：([^。\n]+)/g);
  for (const match of declineBlocks) {
    const values = [...match[1].matchAll(/([+-]?\d+(?:\.\d+)?)%/g)].map(item => Number(item[1]));
    if (values.length && values.every(value => value >= 0)) {
      throw new Error(`${relPath} labels non-negative percentage list as decline: ${match[0]}`);
    }
  }
  const gainBlocks = body.matchAll(/涨幅[^：\n。]*：([^。\n]+)/g);
  for (const match of gainBlocks) {
    const values = [...match[1].matchAll(/([+-]?\d+(?:\.\d+)?)%/g)].map(item => Number(item[1]));
    if (values.some(value => value < 0)) {
      throw new Error(`${relPath} labels negative percentage as gain: ${match[0]}`);
    }
  }
}

function normalizedPodcastBlocks(body: string): string[] {
  return body
    .split(/\n{2,}/)
    .map(block => block.replace(/^[-*]\s+/gm, "").replace(/\s+/g, " ").trim())
    .filter(block => block.length >= 80 && !block.startsWith("---") && !block.startsWith("《"));
}

function verifyNoRepeatedPodcastContent(relPath: string, body: string): void {
  const headings = (body.match(/^##\s+(.+)$/gm) || []).map(heading => heading.replace(/^##\s+/, "").trim().toLowerCase());
  const duplicateHeading = headings.find((heading, index) => headings.indexOf(heading) !== index);
  if (duplicateHeading) throw new Error(`${relPath} contains duplicate podcast episode heading: ${duplicateHeading}`);
  const seen = new Set<string>();
  for (const block of normalizedPodcastBlocks(body)) {
    if (seen.has(block)) throw new Error(`${relPath} contains repeated podcast summary content: ${block.slice(0, 80)}`);
    seen.add(block);
  }
}

function verifyForeignTechPodcast(relPath: string, body: string): void {
  requireTerms(relPath, body, ["《今日国外热门科技访谈播客》", "### 中文主题", "### 基本信息", "### 一句话总结", "### Highlights", "### 长文笔记"]);
  for (const marker of ["## 今日总览", "## 今日播客清单"]) {
    if (body.includes(marker)) throw new Error(`${relPath} contains forbidden podcast section: ${marker}`);
  }
  verifyNoRepeatedPodcastContent(relPath, body);
  const episodeCount = (body.match(/^##\s+.+$/gm) || []).length;
  const minEpisodes = Number(process.env.PODCAST_MIN_EPISODES || "3");
  if (episodeCount < minEpisodes) throw new Error(`${relPath} needs at least ${minEpisodes} podcast episode sections, got ${episodeCount}`);
  const minLength = Math.max(1200, minEpisodes * 1000);
  if (body.length < minLength) throw new Error(`${relPath} is too short for foreign tech podcast long-form note (${body.length} < ${minLength})`);
  for (const pattern of [/待补充|示例|信息不足|无法判断|本文将/]) {
    if (pattern.test(body)) throw new Error(`${relPath} contains podcast placeholder/meta language: ${pattern.source}`);
  }
}

function verifyTechWeekly(relPath: string, body: string): void {
  const sectionCount = (body.match(/^##\s+/gm) || []).length;
  if (sectionCount < 3) throw new Error(`${relPath} tech weekly needs at least three sections`);
  requireTermPatterns(relPath, body, [
    { label: "source links", pattern: /https?:\/\// },
    { label: "engineering judgement", pattern: /影响|取舍|风险|迁移|适合|可以忽略|代价|工程|实践/ },
  ]);
  const links = body.match(/https?:\/\/\S+/g) || [];
  if (links.length < 6) throw new Error(`${relPath} tech weekly needs at least six source links, got ${links.length}`);
  for (const pattern of [/一文[读看搞]懂/, /从零(?:开始)?/, /入门教程/, /基础教程/, /面试题/, /API\s*详解/i, /使用教程/, /赋能|不容错过|革命性/]) {
    if (pattern.test(body)) throw new Error(`${relPath} contains tech-weekly forbidden pattern: ${pattern.source}`);
  }
}

function verifyNoDuplicateWeeklyLinksAndHeadings(relPath: string, body: string): void {
  const links = body.match(/https?:\/\/\S+/g) || [];
  const normalizedLinks = links.map(link => link.replace(/[)）.,，。]+$/, "").toLowerCase());
  if (new Set(normalizedLinks).size !== normalizedLinks.length) throw new Error(`${relPath} contains duplicate links`);
  const headings = (body.match(/^###\s+(.+)$/gm) || []).map(heading => heading.replace(/^###\s+/, "").replace(/\]\(.+\)/, "]").trim().toLowerCase());
  if (new Set(headings).size !== headings.length) throw new Error(`${relPath} contains duplicate headings`);
}

function verifyTechBusinessWeekly(relPath: string, body: string): void {
  const sectionCount = (body.match(/^##\s+/gm) || []).length;
  if (sectionCount < 3) throw new Error(`${relPath} tech business weekly needs at least three sections`);
  requireTermPatterns(relPath, body, [
    { label: "source links", pattern: /https?:\/\// },
    { label: "business judgement", pattern: /影响|风险|监管|政策|安全|平台|公司|商业|市场|企业|不确定|观察/ },
  ]);
  const itemCount = (body.match(/^###\s+/gm) || []).length;
  if (itemCount < 10) throw new Error(`${relPath} tech business weekly needs at least 10 items, got ${itemCount}`);
  if (body.trim().length < 3800) throw new Error(`${relPath} tech business weekly is too short (${body.trim().length} < 3800)`);
  const links = body.match(/https?:\/\/\S+/g) || [];
  if (links.length < 8) throw new Error(`${relPath} tech business weekly needs at least eight source links, got ${links.length}`);
  verifyNoDuplicateWeeklyLinksAndHeadings(relPath, body);
  for (const pattern of [/原始链接未提供|链接见候选源/, /娱乐八卦/, /购物推荐/, /工具榜单/, /融资快讯/, /投资建议/, /买卖建议/, /股价预测/, /赋能|颠覆|革命性|不容错过|值得关注/]) {
    if (pattern.test(body)) throw new Error(`${relPath} contains tech-business-weekly forbidden pattern: ${pattern.source}`);
  }
}

function verifyAiWeekly(relPath: string, body: string): void {
  const sectionCount = (body.match(/^##\s+/gm) || []).length;
  if (sectionCount < 3) throw new Error(`${relPath} AI weekly needs at least three sections`);
  requireTermPatterns(relPath, body, [
    { label: "source links", pattern: /https?:\/\// },
    { label: "AI judgement", pattern: /能力|边界|成本|风险|治理|评测|安全|上下文|推理|Agent|模型|企业|生产/ },
  ]);
  const itemCount = (body.match(/^###\s+/gm) || []).length;
  if (itemCount < 12) throw new Error(`${relPath} AI weekly needs at least 12 items, got ${itemCount}`);
  if (body.trim().length < 4500) throw new Error(`${relPath} AI weekly is too short (${body.trim().length} < 4500)`);
  const links = body.match(/https?:\/\/\S+/g) || [];
  if (links.length < 10) throw new Error(`${relPath} AI weekly needs at least ten source links, got ${links.length}`);
  verifyNoDuplicateWeeklyLinksAndHeadings(relPath, body);
  for (const pattern of [/融资/, /工具榜单/, /prompt\s*技巧/i, /提示词技巧/, /一文[读看搞]懂/, /从零(?:开始)?/, /入门教程/, /论文导读/, /赋能|颠覆|革命性|不容错过|值得关注/]) {
    if (pattern.test(body)) throw new Error(`${relPath} contains AI-weekly forbidden pattern: ${pattern.source}`);
  }
}

function verifyDailyCommon(relPath: string, body: string, label: string): void {
  const itemCount = (body.match(/^###\s+/gm) || []).length;
  if (itemCount < 1) throw new Error(`${relPath} ${label} needs at least one item, got ${itemCount}`);
  const links = body.match(/https?:\/\/\S+/g) || [];
  if (links.length < 1) throw new Error(`${relPath} ${label} needs at least one source link, got ${links.length}`);
  verifyNoDuplicateWeeklyLinksAndHeadings(relPath, body);
  for (const pattern of [/原始链接未提供|链接见候选源/, /TODO/, /待补充/, /无法判断/, /本文将/, /赋能|颠覆|革命性|不容错过|值得关注/]) {
    if (pattern.test(body)) throw new Error(`${relPath} contains daily forbidden pattern: ${pattern.source}`);
  }
}

function verifyTechDaily(relPath: string, body: string): void {
  verifyDailyCommon(relPath, body, "tech daily");
  requireTermPatterns(relPath, body, [
    { label: "engineering judgement", pattern: /影响|取舍|风险|迁移|适合|代价|工程|实践|架构|版本|安全/ },
  ]);
  for (const pattern of [/一文[读看搞]懂/, /从零(?:开始)?/, /入门教程/, /基础教程/, /面试题/, /API\s*详解/i, /使用教程/]) {
    if (pattern.test(body)) throw new Error(`${relPath} contains tech-daily forbidden pattern: ${pattern.source}`);
  }
}

function verifyAiDaily(relPath: string, body: string): void {
  verifyDailyCommon(relPath, body, "AI daily");
  requireTermPatterns(relPath, body, [
    { label: "AI judgement", pattern: /能力|边界|成本|风险|治理|评测|安全|上下文|推理|Agent|模型|企业|生产|工程/ },
  ]);
  for (const pattern of [/融资/, /工具榜单/, /prompt\s*技巧/i, /提示词技巧/, /论文导读/]) {
    if (pattern.test(body)) throw new Error(`${relPath} contains AI-daily forbidden pattern: ${pattern.source}`);
  }
}

function verifyTechBusinessDaily(relPath: string, body: string): void {
  verifyDailyCommon(relPath, body, "tech business daily");
  requireTermPatterns(relPath, body, [
    { label: "business judgement", pattern: /影响|风险|监管|政策|安全|平台|公司|商业|市场|企业|不确定|观察|供应链/ },
  ]);
  for (const pattern of [/娱乐八卦/, /购物推荐/, /工具榜单/, /融资快讯/, /投资建议/, /买卖建议/, /股价预测/]) {
    if (pattern.test(body)) throw new Error(`${relPath} contains tech-business-daily forbidden pattern: ${pattern.source}`);
  }
}

function verifyGitHubTrendingDaily(relPath: string, body: string): void {
  for (const section of ["总结", "今日项目精选", "趋势观察", "数据边界"]) {
    if (!new RegExp(`^##\\s+${section}\\s*$`, "m").test(body)) throw new Error(`${relPath} missing GitHub trending section: ${section}`);
  }
  const links = body.match(/^###\s+\[[^\]]+\]\(https:\/\/github\.com\/[^)]+\)/gm) || [];
  if (links.length < 5) throw new Error(`${relPath} GitHub trending daily needs at least five linked project headings, got ${links.length}`);
  verifyNoDuplicateWeeklyLinksAndHeadings(relPath, body);
  requireTermPatterns(relPath, body, [
    { label: "GitHub trending evidence", pattern: /GitHub Trending|Trending|README|项目自述|榜单|Stars|stars/ },
    { label: "open-source judgement", pattern: /项目|开源|开发者|工具|框架|基础设施|自动化|工程|适用|场景/ },
  ]);
  for (const pattern of [/值得关注/, /不容错过/, /革命性/, /颠覆/, /赋能/, /投资建议/, /融资猜测/, /安全背书/, /待补充/, /示例/, /无法判断/, /本文将/]) {
    if (pattern.test(body)) throw new Error(`${relPath} contains GitHub trending forbidden pattern: ${pattern.source}`);
  }
}

function verifyMarketSemantics(relPath: string, body: string, task: string): void {
  if (task === "foreign-tech-podcast") {
    verifyForeignTechPodcast(relPath, body);
    return;
  }
  if (task === "tech-weekly") {
    verifyTechWeekly(relPath, body);
    return;
  }
  if (task === "ai-weekly") {
    verifyAiWeekly(relPath, body);
    return;
  }
  if (task === "tech-business-weekly") {
    verifyTechBusinessWeekly(relPath, body);
    return;
  }
  if (task === "tech-daily") {
    verifyTechDaily(relPath, body);
    return;
  }
  if (task === "ai-daily") {
    verifyAiDaily(relPath, body);
    return;
  }
  if (task === "tech-business-daily") {
    verifyTechBusinessDaily(relPath, body);
    return;
  }
  if (task === "github-trending-daily") {
    verifyGitHubTrendingDaily(relPath, body);
    return;
  }
  verifyNoMisleadingPercentageLabels(relPath, body);
  if (task === "asia-market-daily") {
    requireTerms(relPath, body, ["上证指数", "深证成指", "创业板指", "恒生指数", "国企指数", "恒生科技指数"]);
    if (/未获取到完整数据的指数|创业板指未获取到完整数据|恒生科技指数未获取到完整数据/.test(body)) {
      throw new Error(`${relPath} contains core Asia index missing-data language`);
    }
  }
  if (task === "crypto-market-daily") {
    requireTerms(relPath, body, ["BTC", "现货", "永续", "期权", "Put/Call", "ATM IV", "数据边界"]);
    requireTerms(relPath, body, ["## 总结", "## BTC 现货状态", "## 永续与杠杆结构", "## 期权与保护需求", "## 情绪与风险边界"]);
    const headingOrder = ["## 总结", "## BTC 现货状态", "## 永续与杠杆结构", "## 期权与保护需求", "## 情绪与风险边界"].map(heading => body.indexOf(heading));
    if (headingOrder.some(index => index < 0) || headingOrder.some((index, i) => i > 0 && index < headingOrder[i - 1])) {
      throw new Error(`${relPath} crypto market daily must use fixed BTC structure`);
    }
    for (const pattern of [/ETH|Solana|SOL|BNB|山寨币|主流资产|分类板块|全市场概览/]) {
      if (pattern.test(body)) throw new Error(`${relPath} contains forbidden legacy crypto-market term: ${pattern.source}`);
    }
    for (const pattern of CRYPTO_STILTED_PATTERNS) {
      if (pattern.test(body)) throw new Error(`${relPath} contains AI-stilted crypto-market prose: ${pattern.source}`);
    }
    if (/数字货币当日未获取到可用公开市场数据|全市场总市值|BTC\/ETH 占比/.test(body)) throw new Error(`${relPath} contains legacy crypto market data language`);
  }
  if (task === "us-market-daily" && !/美股当日未产生完整常规收盘数据|美股当日未获取到完整常规收盘数据/.test(body)) {
    requireTerms(relPath, body, ["道指", "纳指", "行业 ETF", "核心个股"]);
    requireTermPatterns(relPath, body, [{ label: "标普500", pattern: /标普\s*500/ }]);
    requireTerms(relPath, body, ["## 总结", "## 宽基指数", "## 行业指数", "## 个股样本"]);
    const headingOrder = ["## 总结", "## 宽基指数", "## 行业指数", "## 个股样本"].map(heading => body.indexOf(heading));
    if (headingOrder.some(index => index < 0) || headingOrder.some((index, i) => i > 0 && index < headingOrder[i - 1])) {
      throw new Error(`${relPath} us market daily must use summary-first top-down structure`);
    }
    const broadIndexSection = body.match(/## 宽基指数\n([\s\S]*?)(?=\n## 行业指数)/)?.[1] || "";
    if (/[（(][A-Z]{2,6}[）)]/.test(broadIndexSection)) {
      throw new Error(`${relPath} discusses stock tickers before the stock-sample section`);
    }
    for (const pattern of AI_STILTED_MARKET_PATTERNS) {
      if (pattern.test(body)) throw new Error(`${relPath} contains AI-stilted market prose: ${pattern.source}`);
    }
    if (!/^##\s*外部财经文章正文线索\s*$/m.test(body)) {
      const yahooParagraphs = body.split(/\n{2,}/).filter(paragraph => /Yahoo Finance/i.test(paragraph));
      if (yahooParagraphs.length > 1) throw new Error(`${relPath} contains too many Yahoo Finance context paragraphs`);
      if (yahooParagraphs.some(paragraph => paragraph.replace(/\s+/g, "").length > 180)) {
        throw new Error(`${relPath} Yahoo Finance context should stay concise`);
      }
    }
  }
}

function verifyPostContract(repo: string, relPath: string, task: string): void {
  if (!relPath) throw new Error("post result is missing path");
  const postPath = path.join(repo, relPath);
  if (!fs.existsSync(postPath)) throw new Error(`generated post does not exist: ${relPath}`);
  const text = verifyFrontmatter(postPath, task);
  const { body } = splitFrontmatter(text);
  const minBodyLength = isDailyDigestTask(task) ? 120 : 240;
  if (body.trim().length < minBodyLength) throw new Error(`${relPath} body is too short to be a publishable blog post`);
  if (!/^##\s+/m.test(body)) throw new Error(`${relPath} body has no section headings`);
  for (const pattern of COMMON_FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) throw new Error(`${relPath} contains forbidden pattern: ${pattern.source}`);
  }
  if (task.endsWith("market-daily")) {
    for (const pattern of MARKET_FORBIDDEN_PATTERNS) {
      if (pattern.test(text)) throw new Error(`${relPath} contains forbidden market pattern: ${pattern.source}`);
    }
  }
  verifyMarketSemantics(relPath, body, task);
}

export function verifyResultJson(repo: string, resultJson: string): number {
  const payload = parseJsonOutput(fs.readFileSync(resultJson, "utf8")) as { results?: unknown[] };
  if (!Array.isArray(payload.results) || !payload.results.length) throw new Error(`${resultJson} has no results array`);
  let verified = 0;
  for (const item of payload.results) {
    if (!item || typeof item !== "object") throw new Error(`invalid result item: ${String(item)}`);
    const row = item as { task?: string; path?: string; skipped?: boolean; failed?: boolean; error?: string };
    if (row.failed) {
      if (!row.task || !row.error) throw new Error(`failed result item is missing task or error: ${JSON.stringify(row)}`);
      continue;
    }
    if (row.skipped && !row.path) continue;
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
