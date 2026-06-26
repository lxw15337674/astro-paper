#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { archivePost } from "./astro_paper_archive.ts";
import { validateMarkdown, renderPrompt } from "./ai_blog_writer.ts";
import { type AiCallResult, callBlogAiWithFailover, envAiConfig, envFallbackAiConfig } from "./blog_ai_client.ts";
import { avoidCloudflareEmailObfuscation, bjtDateString, ensureDir, parseArgs, repoRoot, stringArg, writeStderr, writeStdout } from "./blog_common.ts";
import { DAILY_DIGEST_TASKS, SOURCE_LINK_WHITELIST_TASKS, type Task, isDailyDigestTask, isTaskInput, scheduledTaskInput, taskPostRelPath, taskTags, taskTitle, tasksForInput } from "./blog_tasks.ts";
import { buildHnSource } from "./hn_top10_source.ts";
import { PodcastSourceInsufficientEpisodesError, buildAppleTopPodcastsSource, buildForeignTechPodcastSource } from "./foreign_tech_podcast_source.ts";
import { generateAsiaMarketDaily, generateCryptoMarketDaily, generateUsMarketDaily } from "./market_daily_source.ts";
import { buildTechWeeklySource } from "./tech_weekly_source.ts";
import { buildAiWeeklySource } from "./ai_weekly_source.ts";
import { buildTechBusinessWeeklySource } from "./tech_business_weekly_source.ts";
import { buildDailyDigestSource } from "./daily_digest_source.ts";
import { buildGitHubTrendingDailySource } from "./github_trending_daily_source.ts";

type ResultItem = ReturnType<typeof archivePost> & {
  skip_reason?: string;
  failed?: boolean;
  error?: string;
  generation?: {
    ai_model: string;
    ai_base_url: string;
    ai_fallback_used: boolean;
    source_artifact: string;
    prompt_artifact: string;
    ai_response_artifact: string;
    mocked_ai: boolean;
  };
};

function offsetBjtDate(days: number): string {
  return bjtDateString(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
}

function targetPath(task: Task, repo: string, date: string): string {
  return path.join(repo, taskPostRelPath(task, date));
}

function skippedExisting(task: Task, repo: string, date: string): ResultItem | null {
  const postPath = targetPath(task, repo, date);
  if (!fs.existsSync(postPath)) return null;
  return {
    task,
    path: path.relative(repo, postPath),
    title: taskTitle(task, date),
    created: false,
    skipped: true,
    updated_at_bjt: "",
    commit: "",
    push: "",
    tags: taskTags(task),
  };
}

function skippedLowQuality(task: Task, date: string, reason: string): ResultItem {
  return {
    task,
    path: "",
    title: taskTitle(task, date),
    created: false,
    skipped: true,
    updated_at_bjt: "",
    commit: "",
    push: "",
    tags: taskTags(task),
    skip_reason: reason,
  };
}


function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

function shouldSkipInsufficientAppleTopPodcasts(error: unknown, task: Task): error is PodcastSourceInsufficientEpisodesError {
  return task === "apple-top-podcasts" && error instanceof PodcastSourceInsufficientEpisodesError && envFlag("APPLE_TOP_PODCASTS_SKIP_ON_INSUFFICIENT", false);
}

function failedTask(task: Task, date: string, error: unknown): ResultItem {
  const message = error instanceof Error ? error.message : String(error);
  return {
    task,
    path: "",
    title: taskTitle(task, date),
    created: false,
    skipped: false,
    failed: true,
    error: message,
    updated_at_bjt: "",
    commit: "",
    push: "",
    tags: taskTags(task),
  };
}

function fixtureSource(task: Task, sourceFixtureDir: string): string {
  const file = path.join(sourceFixtureDir, `${task}.md`);
  if (!fs.existsSync(file)) throw new Error(`source fixture not found for task ${task}: ${file}`);
  return fs.readFileSync(file, "utf8");
}

const SOURCE_BUILDERS: Record<Task, (date: string) => Promise<string>> = {
  "hn-top10": () => buildHnSource(),
  "asia-market-daily": date => generateAsiaMarketDaily(date),
  "crypto-market-daily": () => generateCryptoMarketDaily(),
  "us-market-daily": date => generateUsMarketDaily(date),
  "github-trending-daily": date => buildGitHubTrendingDailySource(date, { dataDir: path.join(repoRoot(), "data/github-trending") }),
  "foreign-tech-podcast": date => buildForeignTechPodcastSource(date),
  "apple-top-podcasts": date => buildAppleTopPodcastsSource(date),
  "tech-weekly": date => buildTechWeeklySource(date),
  "ai-weekly": date => buildAiWeeklySource(date),
  "tech-business-weekly": date => buildTechBusinessWeeklySource(date),
  "tech-daily": date => buildDailyDigestSource(date),
  "ai-daily": date => buildDailyDigestSource(date),
  "tech-business-daily": date => buildDailyDigestSource(date),
};

async function sourceForTask(task: Task, date: string, sourceFixtureDir = ""): Promise<string> {
  if (sourceFixtureDir) return fixtureSource(task, sourceFixtureDir);
  return SOURCE_BUILDERS[task](date);
}

function writeArtifact(artifactsDir: string, task: string, name: string, content: string): string {
  if (!artifactsDir) return "";
  ensureDir(artifactsDir);
  const file = path.join(artifactsDir, `${task}-${name}`);
  fs.writeFileSync(file, `${content.trim()}\n`, "utf8");
  return file;
}

async function callAi(prompt: string, model: string): Promise<AiCallResult> {
  const result = await callBlogAiWithFailover({
    prompt,
    primaryConfig: envAiConfig({ model }),
    fallbackConfig: envFallbackAiConfig(),
  });
  if (result.usedFallback) {
    writeStderr(`WARN: primary AI request failed; using fallback model ${result.config.model} via ${result.config.baseUrl}`);
  }
  return result;
}

function retryAttempts(): number {
  const raw = Number(process.env.AI_RETRY_ATTEMPTS || "3");
  return Number.isInteger(raw) && raw > 0 ? raw : 3;
}

function retryDelayMs(attempt: number): number {
  const raw = Number(process.env.AI_RETRY_DELAY_MS || "10000");
  const base = Number.isFinite(raw) && raw >= 0 ? raw : 10_000;
  return attempt <= 1 ? 0 : base * (attempt - 1);
}

async function sleep(ms: number): Promise<void> {
  if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error("AI selector response did not contain a JSON object");
}

function parseSelectedIds(text: string, maxId: number): number[] {
  const payload = parseJsonObject(text) as { selected?: unknown };
  if (!Array.isArray(payload.selected)) throw new Error("AI selector response missing selected array");
  const ids = payload.selected.map(value => Number(value)).filter(value => Number.isInteger(value) && value >= 1 && value <= maxId);
  const unique = [...new Set(ids)].slice(0, 14);
  if (unique.length < 8) throw new Error(`AI selector kept too few tech business items: ${unique.length}`);
  return unique;
}

function splitNumberedSource(source: string): { header: string; blocks: Map<number, string> } {
  const match = source.match(/^([\s\S]*?)(?=^##\s+\d+\.\s+)/m);
  const header = match ? match[1].trimEnd() : "";
  const remainder = match ? source.slice(match[1].length) : source;
  const blocks = new Map<number, string>();
  for (const block of remainder.split(/(?=^##\s+\d+\.\s+)/m).map(part => part.trim()).filter(Boolean)) {
    const id = Number(block.match(/^##\s+(\d+)\.\s+/)?.[1]);
    if (Number.isInteger(id)) blocks.set(id, block);
  }
  return { header, blocks };
}

function filterNumberedSourceWithMin(source: string, ids: number[], minItems: number, label: string): string {
  const { header, blocks } = splitNumberedSource(source);
  const selectedBlocks = ids.map(id => blocks.get(id)).filter((block): block is string => Boolean(block));
  if (selectedBlocks.length < minItems) throw new Error(`${label} selected source has too few blocks: ${selectedBlocks.length}`);
  const rewrittenHeader = header.replace(/候选数量：\d+/, `候选数量：${selectedBlocks.length}`);
  return `${rewrittenHeader}\n\n${selectedBlocks.join("\n\n")}\n`;
}

function countNumberedBlocks(source: string): number {
  return (source.match(/^#{2,3}\s+\d+\.\s+/gm) || []).length;
}

function filterNumberedSource(source: string, ids: number[]): string {
  return filterNumberedSourceWithMin(source, ids, 8, "tech-business-weekly");
}

async function selectTechBusinessSource({
  source,
  date,
  repo,
  model,
  promptDir,
  artifactsDir,
}: {
  source: string;
  date: string;
  repo: string;
  model: string;
  promptDir: string;
  artifactsDir: string;
}): Promise<string> {
  const resolvedPromptDir = promptDir || path.join(repo, "prompts/blog");
  const selectorPromptFile = path.join(resolvedPromptDir, "tech-business-weekly-selector.md");
  const selectorTemplate = fs.readFileSync(selectorPromptFile, "utf8");
  const selectorPrompt = selectorTemplate.replaceAll("{task}", "tech-business-weekly").replaceAll("{date}", date).replaceAll("{source_text}", source.trim());
  writeArtifact(artifactsDir, "tech-business-weekly", "selector-source.raw.md", source);
  writeArtifact(artifactsDir, "tech-business-weekly", "selector-prompt.md", selectorPrompt);
  const response = await callAi(selectorPrompt, model);
  writeArtifact(artifactsDir, "tech-business-weekly", "selector-response.json", response.content);
  const maxId = (source.match(/^##\s+\d+\.\s+/gm) || []).length;
  const ids = parseSelectedIds(response.content, maxId);
  writeArtifact(artifactsDir, "tech-business-weekly", "selector-selected-ids.json", JSON.stringify({ selected: ids }, null, 2));
  const selectedSource = filterNumberedSource(source, ids);
  writeArtifact(artifactsDir, "tech-business-weekly", "source.selected.md", selectedSource);
  return selectedSource;
}


type DailyAssignmentTask = "tech-daily" | "ai-daily" | "tech-business-daily" | "drop";

type DailyAssignmentPayload = {
  assignments?: { id?: unknown; task?: unknown; reason?: unknown }[];
};

const FIXED_DAILY_ASSIGNMENT_TASKS = ["tech-daily", "ai-daily", "tech-business-daily"] as const satisfies readonly Task[];

function parseDailyAssignments(text: string, maxId: number): Record<string, number[]> {
  const payload = parseJsonObject(text) as DailyAssignmentPayload;
  if (!Array.isArray(payload.assignments)) throw new Error("daily classifier response missing assignments array");
  const out: Record<string, number[]> = { "tech-daily": [], "ai-daily": [], "tech-business-daily": [] };
  const seen = new Set<number>();
  for (const row of payload.assignments) {
    const id = Number(row.id);
    const task = String(row.task || "") as DailyAssignmentTask;
    if (!Number.isInteger(id) || id < 1 || id > maxId) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    if (task === "tech-daily" || task === "ai-daily" || task === "tech-business-daily") out[task].push(id);
  }
  for (const task of FIXED_DAILY_ASSIGNMENT_TASKS) out[task] = out[task].slice(0, 10);
  return out;
}

const dailyClassifiedSourceCache = new Map<string, Promise<Record<string, string>>>();

async function classifyDailyDigestSources({
  source,
  date,
  repo,
  model,
  promptDir,
  artifactsDir,
}: {
  source: string;
  date: string;
  repo: string;
  model: string;
  promptDir: string;
  artifactsDir: string;
}): Promise<Record<string, string>> {
  const resolvedPromptDir = promptDir || path.join(repo, "prompts/blog");
  const classifierPromptFile = path.join(resolvedPromptDir, "daily-digest-classifier.md");
  const classifierTemplate = fs.readFileSync(classifierPromptFile, "utf8");
  const classifierPrompt = classifierTemplate.replaceAll("{date}", date).replaceAll("{source_text}", source.trim());
  writeArtifact(artifactsDir, "daily-digests", "classifier-source.raw.md", source);
  writeArtifact(artifactsDir, "daily-digests", "classifier-prompt.md", classifierPrompt);
  const response = await callAi(classifierPrompt, model);
  writeArtifact(artifactsDir, "daily-digests", "classifier-response.json", response.content);
  const maxId = countNumberedBlocks(source);
  const assignments = parseDailyAssignments(response.content, maxId);
  writeArtifact(artifactsDir, "daily-digests", "classifier-assignments.json", JSON.stringify(assignments, null, 2));
  const result: Record<string, string> = {};
  for (const task of DAILY_DIGEST_TASKS) {
    result[task] = filterNumberedSourceWithMin(source, assignments[task] || [], 0, task);
    writeArtifact(artifactsDir, task, "source.classified.md", result[task]);
  }
  return result;
}

async function classifiedDailySourceForTask({
  task,
  source,
  date,
  repo,
  model,
  promptDir,
  artifactsDir,
}: {
  task: Task;
  source: string;
  date: string;
  repo: string;
  model: string;
  promptDir: string;
  artifactsDir: string;
}): Promise<string> {
  const key = `${date}:${model || process.env.AI_MODEL || ""}`;
  if (!dailyClassifiedSourceCache.has(key)) {
    dailyClassifiedSourceCache.set(key, classifyDailyDigestSources({ source, date, repo, model, promptDir, artifactsDir }));
  }
  const classified = await dailyClassifiedSourceCache.get(key)!;
  return classified[task] || "";
}

type DailyCandidateMeta = {
  id: number;
  title: string;
  sourceName: string;
  publishedAt: string;
  url: string;
  block: string;
};

type DailyItemSummary = DailyCandidateMeta & {
  include: boolean;
  tags: string[];
  summary: string;
  whyItMatters: string;
  impact: string;
  concerns: string;
  importance: number;
};

type DailySectionPlan = {
  title: string;
  thesis: string;
  itemIds: number[];
};

function dailySummaryConcurrency(): number {
  const raw = Number(process.env.DAILY_DIGEST_SUMMARY_CONCURRENCY || "4");
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, 8) : 4;
}

function dailySummaryMaxCandidates(): number {
  const raw = Number(process.env.DAILY_DIGEST_MAX_CANDIDATES || "40");
  return Number.isInteger(raw) && raw > 0 ? raw : 40;
}

function truncateField(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function candidateMetaFromBlock(id: number, block: string): DailyCandidateMeta {
  const title = block.match(/^##\s+\d+\.\s+(.+)$/m)?.[1]?.trim() || `候选 ${id}`;
  const sourceName = block.match(/^- 来源：(.+)$/m)?.[1]?.trim() || "未知来源";
  const publishedAt = block.match(/^- 发布时间：(.+)$/m)?.[1]?.trim() || "";
  const url = block.match(/^- 链接：(.+)$/m)?.[1]?.trim().replace(/[)）.,，。]+$/, "") || "";
  return { id, title, sourceName, publishedAt, url, block };
}

function parseDailyItemSummaryResponse(text: string, meta: DailyCandidateMeta): DailyItemSummary {
  const payload = parseJsonObject(text) as Record<string, unknown>;
  const rawTags = Array.isArray(payload.tags) ? payload.tags : [];
  const tags = rawTags.map(tag => truncateField(tag, 24)).filter(Boolean).slice(0, 6);
  const importance = Math.max(1, Math.min(5, Number(payload.importance) || 3));
  return {
    ...meta,
    include: payload.include !== false,
    tags,
    summary: truncateField(payload.summary, 360),
    whyItMatters: truncateField(payload.why_it_matters ?? payload.whyItMatters, 360),
    impact: truncateField(payload.impact, 360),
    concerns: truncateField(payload.concerns, 260),
    importance,
  };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function summarizeDailyItem({
  meta,
  date,
  repo,
  model,
  promptDir,
  artifactsDir,
}: {
  meta: DailyCandidateMeta;
  date: string;
  repo: string;
  model: string;
  promptDir: string;
  artifactsDir: string;
}): Promise<DailyItemSummary> {
  const resolvedPromptDir = promptDir || path.join(repo, "prompts/blog");
  const template = fs.readFileSync(path.join(resolvedPromptDir, "daily-digest-item-summary.md"), "utf8");
  const prompt = template.replaceAll("{date}", date).replaceAll("{item_id}", String(meta.id)).replaceAll("{item_text}", meta.block.trim());
  writeArtifact(artifactsDir, "daily-digests", `item-${String(meta.id).padStart(3, "0")}-prompt.md`, prompt);
  const response = await callAi(prompt, model);
  writeArtifact(artifactsDir, "daily-digests", `item-${String(meta.id).padStart(3, "0")}-summary.json`, response.content);
  return parseDailyItemSummaryResponse(response.content, meta);
}

function formatDailyItemCards(summaries: DailyItemSummary[]): string {
  return summaries
    .map(item => {
      const out = [`### ${item.id}. ${item.title}`, `- 来源：${item.sourceName}`, `- 链接：${item.url}`];
      if (item.publishedAt) out.push(`- 发布时间：${item.publishedAt}`);
      out.push(`- AI 建议保留：${item.include ? "yes" : "no"}`);
      out.push(`- 重要性：${item.importance}/5`);
      out.push(`- 动态标签：${item.tags.join("、") || "未标注"}`);
      out.push(`- 文章级摘要：${item.summary}`);
      out.push(`- 重要性判断：${item.whyItMatters}`);
      out.push(`- 影响/边界：${item.impact}`);
      if (item.concerns) out.push(`- 信息缺口/降权理由：${item.concerns}`);
      return out.join("\n");
    })
    .join("\n\n");
}

function parseDailySectionPlan(text: string, summaries: DailyItemSummary[]): DailySectionPlan[] {
  const payload = parseJsonObject(text) as { sections?: unknown };
  if (!Array.isArray(payload.sections)) throw new Error("daily section planner response missing sections array");
  const validIds = new Set(summaries.filter(item => item.include).map(item => item.id));
  const used = new Set<number>();
  const sections: DailySectionPlan[] = [];
  for (const raw of payload.sections) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as { title?: unknown; thesis?: unknown; item_ids?: unknown; itemIds?: unknown };
    const title = truncateField(row.title, 80);
    const thesis = truncateField(row.thesis, 280);
    const rawIds = Array.isArray(row.item_ids) ? row.item_ids : Array.isArray(row.itemIds) ? row.itemIds : [];
    const itemIds = rawIds
      .map(id => Number(id))
      .filter(id => Number.isInteger(id) && validIds.has(id) && !used.has(id));
    for (const id of itemIds) used.add(id);
    if (title && itemIds.length) sections.push({ title, thesis, itemIds });
  }
  if (!sections.length) throw new Error("daily section planner produced no usable sections");
  return sections.slice(0, 6);
}

function formatCombinedTechDailySource(date: string, summaries: DailyItemSummary[], sections: DailySectionPlan[], failureHeader: string): string {
  const keptIds = new Set(sections.flatMap(section => section.itemIds));
  const keptSummaries = summaries.filter(item => keptIds.has(item.id));
  const dropped = summaries.filter(item => !keptIds.has(item.id));
  return `# 技术日报动态摘要池｜${date}

生成流程：每篇候选先由 AI 单独总结和打标签，再由 AI 按当天真实标签分布动态规划栏目，最后汇总成一篇《技术日报》。

${failureHeader ? `${failureHeader.trim()}\n\n` : ""}## AI 动态栏目规划

${sections
    .map(
      (section, index) =>
        `### 栏目 ${index + 1}：${section.title}\n- 栏目判断：${section.thesis || "按当天候选自然聚合。"}\n- 包含候选：${section.itemIds.join(", ")}`,
    )
    .join("\n\n")}

## 入选文章级摘要

${formatDailyItemCards(keptSummaries)}

## 降权或排除候选

${
    dropped.length
      ? dropped
          .map(item => `- ${item.id}. ${item.title}｜${item.include ? "未被栏目采用" : "AI 建议排除"}｜${item.concerns || item.summary}`)
          .join("\n")
      : "- 无"
  }
`;
}

async function buildCombinedTechDailySource({
  source,
  date,
  repo,
  model,
  promptDir,
  artifactsDir,
}: {
  source: string;
  date: string;
  repo: string;
  model: string;
  promptDir: string;
  artifactsDir: string;
}): Promise<string> {
  const { header, blocks } = splitNumberedSource(source);
  const metas = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .slice(0, dailySummaryMaxCandidates())
    .map(([id, block]) => candidateMetaFromBlock(id, block));
  if (!metas.length) throw new Error("tech daily source has no candidate items");
  writeArtifact(artifactsDir, "daily-digests", "combined-source.raw.md", source);
  const summaries = await mapWithConcurrency(metas, dailySummaryConcurrency(), meta =>
    summarizeDailyItem({ meta, date, repo, model, promptDir, artifactsDir }),
  );
  const kept = summaries.filter(item => item.include);
  if (!kept.length) throw new Error("tech daily item summaries kept no candidates");
  const summaryCards = formatDailyItemCards(summaries);
  writeArtifact(artifactsDir, "daily-digests", "item-summaries.md", summaryCards);
  const resolvedPromptDir = promptDir || path.join(repo, "prompts/blog");
  const plannerTemplate = fs.readFileSync(path.join(resolvedPromptDir, "daily-digest-section-planner.md"), "utf8");
  const plannerPrompt = plannerTemplate.replaceAll("{date}", date).replaceAll("{item_summaries}", summaryCards);
  writeArtifact(artifactsDir, "daily-digests", "section-planner-prompt.md", plannerPrompt);
  const plannerResponse = await callAi(plannerPrompt, model);
  writeArtifact(artifactsDir, "daily-digests", "section-planner-response.json", plannerResponse.content);
  const sections = parseDailySectionPlan(plannerResponse.content, summaries);
  writeArtifact(artifactsDir, "daily-digests", "section-plan.json", JSON.stringify({ sections }, null, 2));
  const combined = formatCombinedTechDailySource(date, summaries, sections, header.match(/^抓取失败源：.+$/m)?.[0] || "");
  writeArtifact(artifactsDir, "tech-daily", "source.dynamic.md", combined);
  return combined;
}


function normalizedHeadingTitle(title: string): string {
  return avoidCloudflareEmailObfuscation(title).replace(/\s+/g, " ").trim().toLowerCase();
}

function sourceTitleLinks(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const { blocks } = splitNumberedSource(source);
  for (const block of blocks.values()) {
    const title = block.match(/^##\s+\d+\.\s+(.+)$/m)?.[1]?.trim();
    const link = block.match(/^- 链接：(.+)$/m)?.[1]?.trim();
    if (title && link) map.set(normalizedHeadingTitle(title), link.replace(/[)）.,，。]+$/, ""));
  }
  return map;
}

function normalizeMarkdownLinksFromSourceTitles(markdown: string, source: string, task: Task): string {
  if (!SOURCE_LINK_WHITELIST_TASKS.has(task)) return markdown;
  const titleLinks = sourceTitleLinks(source);
  return markdown.replace(/^###\s+\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/gm, (line, title: string) => {
    const sourceLink = titleLinks.get(normalizedHeadingTitle(title));
    return sourceLink ? `### [${title}](${sourceLink})` : line;
  });
}

function sourceLinks(source: string): Set<string> {
  return new Set(
    (source.match(/^- 链接：(.+)$/gm) || [])
      .map(line => line.replace(/^- 链接：/, "").replace(/[)）.,，。]+$/, "").toLowerCase())
      .filter(Boolean),
  );
}

function markdownHeadingLinks(markdown: string): string[] {
  return [...markdown.matchAll(/^###\s+\[[^\]]+\]\((https?:\/\/[^)]+)\)/gm)].map(match => match[1].replace(/[)）.,，。]+$/, "").toLowerCase());
}

function assertMarkdownUsesOnlySourceLinks(markdown: string, source: string, task: Task): void {
  if (!SOURCE_LINK_WHITELIST_TASKS.has(task)) return;
  const allowed = sourceLinks(source);
  const links = markdownHeadingLinks(markdown);
  const minLinks = isDailyDigestTask(task) ? 1 : 8;
  if (links.length < minLinks) throw new Error(`${task} generated too few linked item headings: ${links.length}`);
  if (links.length > allowed.size) throw new Error(`${task} generated more linked item headings than selected sources: ${links.length} > ${allowed.size}`);
  const duplicate = links.find((link, index) => links.indexOf(link) !== index);
  if (duplicate) throw new Error(`${task} generated duplicate source link: ${duplicate}`);
  const unexpected = links.find(link => !allowed.has(link));
  if (unexpected) throw new Error(`${task} generated link outside selected source whitelist: ${unexpected}`);
}

function promptWithValidationFeedback(prompt: string, task: Task, previousError: string): string {
  return `${prompt.trim()}

---

上一轮 ${task} 输出被发布质量检查拒绝，原因：${previousError}
请重新生成完整 Markdown 正文，并严格避开上述失败原因；不要复述错误原因，不要输出解释，不要输出代码围栏。`;
}

function shouldRetryWithValidationFeedback(error: string): boolean {
  return !/^(AI request timed out after|AI request failed:)/.test(error);
}

async function renderLiveAiMarkdownWithSourceValidation(
  prompt: string,
  model: string,
  task: Task,
  artifactsDir: string,
  source: string,
): Promise<{ markdown: string; ai: AiCallResult }> {
  const attempts = retryAttempts();
  let lastError = "";
  let attemptPrompt = prompt;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await sleep(retryDelayMs(attempt));
    if (attempt > 1) writeArtifact(artifactsDir, task, `retry-prompt-attempt-${attempt}.md`, attemptPrompt);
    try {
      const ai = await callAi(attemptPrompt, model);
      const markdown = normalizeMarkdownLinksFromSourceTitles(validateMarkdown(ai.content), source, task);
      assertMarkdownUsesOnlySourceLinks(markdown, source, task);
      return { markdown, ai };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      writeArtifact(artifactsDir, task, `ai-error-attempt-${attempt}.txt`, lastError);
      if (attempt < attempts) {
        attemptPrompt = shouldRetryWithValidationFeedback(lastError) ? promptWithValidationFeedback(prompt, task, lastError) : prompt;
        writeStderr(`WARN: ${task} AI generation attempt ${attempt}/${attempts} failed; retrying with validation feedback: ${lastError}`);
      }
    }
  }
  throw new Error(`${task} AI generation failed after ${attempts} attempts: ${lastError}`);
}

async function renderWithAi({
  task,
  date,
  source,
  repo,
  model,
  promptDir,
  mockResponseDir,
  artifactsDir,
}: {
  task: Task;
  date: string;
  source: string;
  repo: string;
  model: string;
  promptDir: string;
  mockResponseDir: string;
  artifactsDir: string;
}): Promise<{ markdown: string; metadata: NonNullable<ResultItem["generation"]> }> {
  const sourceArtifact = writeArtifact(artifactsDir, task, "source.md", source);
  const resolvedPromptDir = promptDir || path.join(repo, "prompts/blog");
  const prompt = renderPrompt({ task, date, sourceText: source, promptDir: resolvedPromptDir });
  const promptArtifact = writeArtifact(artifactsDir, task, "prompt.md", prompt);
  const mockFile = mockResponseDir ? path.join(mockResponseDir, `${task}.md`) : "";
  const rendered = mockFile
    ? {
        markdown: validateMarkdown(fs.readFileSync(mockFile, "utf8")),
        ai: {
          content: "",
          config: envAiConfig({ model }),
          usedFallback: false,
        },
      }
    : await renderLiveAiMarkdownWithSourceValidation(prompt, model, task, artifactsDir, source);
  const responseArtifact = writeArtifact(artifactsDir, task, "ai-response.md", rendered.markdown);
  return {
    markdown: rendered.markdown,
    metadata: {
      ai_model: rendered.ai.config.model,
      ai_base_url: rendered.ai.config.baseUrl,
      ai_fallback_used: rendered.ai.usedFallback,
      source_artifact: sourceArtifact,
      prompt_artifact: promptArtifact,
      ai_response_artifact: responseArtifact,
      mocked_ai: Boolean(mockFile),
    },
  };
}

async function generateTask({
  task,
  repo,
  date,
  force,
  useAi,
  model,
  promptDir,
  sourceFixtureDir,
  mockResponseDir,
  artifactsDir,
}: {
  task: Task;
  repo: string;
  date: string;
  force: boolean;
  useAi: boolean;
  model: string;
  promptDir: string;
  sourceFixtureDir: string;
  mockResponseDir: string;
  artifactsDir: string;
}): Promise<ResultItem> {
  if (!force) {
    const skipped = skippedExisting(task, repo, date);
    if (skipped) return skipped;
  }
  let source = await sourceForTask(task, date, sourceFixtureDir);
  if (useAi && task === "tech-business-weekly" && !mockResponseDir) {
    source = await selectTechBusinessSource({ source, date, repo, model, promptDir, artifactsDir });
  }
  if (useAi && task === "tech-daily" && !mockResponseDir) {
    source = await buildCombinedTechDailySource({ source, date, repo, model, promptDir, artifactsDir });
    const itemCount = countNumberedBlocks(source);
    if (itemCount < 1) return skippedLowQuality(task, date, "tech-daily has no high-quality daily items");
  }
  if (useAi && (task === "ai-daily" || task === "tech-business-daily") && !mockResponseDir) {
    source = await classifiedDailySourceForTask({ task, source, date, repo, model, promptDir, artifactsDir });
    const itemCount = countNumberedBlocks(source);
    if (itemCount < 1) return skippedLowQuality(task, date, `${task} has no high-quality daily items`);
  }
  let body = source;
  let generation: ResultItem["generation"];
  if (useAi) {
    const rendered = await renderWithAi({ task, date, source, repo, model, promptDir, mockResponseDir, artifactsDir });
    body = rendered.markdown;
    generation = rendered.metadata;
  }
  const result: ResultItem = archivePost({ task, date, repo, body, force });
  if (generation) result.generation = generation;
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const scheduled = scheduledTaskInput(process.env.EVENT_SCHEDULE || "");
  const taskArg = stringArg(args, "task", scheduled.task);
  if (!isTaskInput(taskArg)) throw new Error(`unsupported task: ${taskArg}`);
  const repo = path.resolve(stringArg(args, "repo", repoRoot()));
  const explicitDate = stringArg(args, "date");
  const offsetArg = stringArg(args, "date-offset");
  const offset = Number(offsetArg || scheduled.dateOffset);
  if (!Number.isInteger(offset)) throw new Error(`invalid --date-offset: ${offsetArg || scheduled.dateOffset}`);
  const date = explicitDate || offsetBjtDate(offset);
  const tasks = tasksForInput(taskArg);
  const results: ResultItem[] = [];
  for (const task of tasks as Task[]) {
    try {
      results.push(
        await generateTask({
          task,
          repo,
          date,
          force: args.force === true,
          useAi: args.ai === true,
          model: stringArg(args, "model"),
          promptDir: stringArg(args, "prompt-dir"),
          sourceFixtureDir: stringArg(args, "source-fixture-dir"),
          mockResponseDir: stringArg(args, "mock-response-dir"),
          artifactsDir: stringArg(args, "artifacts-dir"),
        }),
      );
    } catch (error) {
      if (shouldSkipInsufficientAppleTopPodcasts(error, task)) {
        const message = error instanceof Error ? error.message : String(error);
        const skipped = skippedLowQuality(task, date, message);
        results.push(skipped);
        writeStderr(`WARN: ${task} skipped: ${message}`);
        continue;
      }
      const failed = failedTask(task, date, error);
      results.push(failed);
      writeStderr(`ERROR: ${task} generation failed: ${failed.error}`);
    }
  }
  const failures = results.filter(result => result.failed);
  const output = `${JSON.stringify({ date, results, failed: failures.length }, null, 2)}\n`;
  const resultJson = stringArg(args, "result-json");
  if (resultJson) {
    fs.writeFileSync(path.resolve(repo, resultJson), output, "utf8");
  } else {
    writeStdout(output);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`ERROR: ${message}`);
    process.exit(1);
  });
}
