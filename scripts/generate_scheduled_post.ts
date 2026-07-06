#!/usr/bin/env tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { archivePost } from "./astro_paper_archive.ts";
import { validateMarkdown, renderPrompt, resolvePromptFile } from "./ai_blog_writer.ts";
import { type AiCallResult, callBlogAiWithFailover, envAiConfig, envFallbackAiConfig } from "./blog_ai_client.ts";
import { avoidCloudflareEmailObfuscation, bjtDateString, dateStringInTimeZone, ensureDir, parseArgs, repoRoot, stringArg, writeStderr, writeStdout } from "./blog_common.ts";
import { DAILY_DIGEST_TASKS, SOURCE_LINK_WHITELIST_TASKS, type MarketSegment, type Task, isDailyDigestTask, isTaskInput, scheduledTaskInput, taskPostRelPath, taskTags, taskTitle, tasksForInput } from "./blog_tasks.ts";
import { buildHnSource } from "./hn_top10_source.ts";
import { hnMarkdownFromModelJson } from "./hn_compose.ts";
import { githubTrendingMarkdownFromModelJson } from "./github_trending_compose.ts";
import { mdblistMarkdownFromModelJson } from "./mdblist_compose.ts";
import { dailyDigestMarkdownFromModelJson } from "./daily_digest_compose.ts";
import { type Episode, PodcastSourceInsufficientEpisodesError, buildDailyPodcastEpisodeArticle, buildDailyPodcastSource, fetchDailyPodcastEpisodes, geminiArticleBaseUrl, geminiArticleModel } from "./foreign_tech_podcast_source.ts";
import { appendSummarizedEpisode } from "./podcast_ledger.ts";
import { MarketSourceUnavailableError, buildCapitalSegmentSource } from "./market_daily_source.ts";
import { capitalMarketMarkdownFromModelJson } from "./market_compose.ts";
import { buildMarketTable } from "./market_table_source.ts";
import { buildTechWeeklySource } from "./tech_weekly_source.ts";
import { buildAiWeeklySource } from "./ai_weekly_source.ts";
import { buildTechBusinessWeeklySource } from "./tech_business_weekly_source.ts";
import { buildDailyDigestSource } from "./daily_digest_source.ts";
import { buildGitHubTrendingDailySource } from "./github_trending_daily_source.ts";
import { buildXyzRankTopEpisodesSource, fetchXyzRankTopEpisodes } from "./xyzrank_top_episodes_source.ts";
import { buildMdblistWeeklySource } from "./mdblist_weekly_source.ts";

export type ResultItem = ReturnType<typeof archivePost> & {
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

function offsetDate(days: number, timeZone?: string): string {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return timeZone ? dateStringInTimeZone(date, timeZone) : bjtDateString(date);
}

function titleForVariant(task: Task, date: string, titleSuffix = ""): string {
  return titleSuffix ? `${taskTitle(task, date)}｜${titleSuffix}` : taskTitle(task, date);
}

function variantPostRelPath(task: Task, date: string, fileNameSuffix = ""): string {
  return fileNameSuffix ? taskPostRelPath(task, `${date}-${fileNameSuffix}`) : taskPostRelPath(task, date);
}

function skippedExisting(task: Task, repo: string, date: string): ResultItem | null {
  return skippedExistingVariant(task, repo, date);
}

function skippedExistingVariant(task: Task, repo: string, date: string, fileNameSuffix = "", titleSuffix = ""): ResultItem | null {
  const relPath = variantPostRelPath(task, date, fileNameSuffix);
  const postPath = path.join(repo, relPath);
  if (!fs.existsSync(postPath)) return null;
  return {
    task,
    path: relPath,
    title: titleForVariant(task, date, titleSuffix),
    created: false,
    skipped: true,
    updated_at_bjt: "",
    commit: "",
    push: "",
    tags: taskTags(task),
  };
}

function slugForFile(text: string): string {
  const slug = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "podcast";
}

function dailyPodcastFileNameSuffix(episode: Episode, index: number): string {
  return `${String(index + 1).padStart(2, "0")}-${slugForFile(episode.show)}`;
}

const PODCAST_COVER_REL_DIR = path.join("public", "images", "podcast");
// 封面在 frontmatter 里按内容 schema 的 image() 解析：必须用相对 md 文件的路径（与 HN 封面一致），
// 绝对 public 路径 (/images/...) 会被当成可导入资源而在构建期 ImageNotFound。
// 帖子固定位于 src/content/posts/zh-cn/，到 public/ 固定上溯 4 层。
const PODCAST_COVER_OGIMAGE_PREFIX = "../../../../public/images/podcast/";

// 播客封面原图多为 3000×3000，直接当远程封面太重也不稳；生成时下载→sharp 压成小 webp 自托管。
// 压缩或下载失败则回落到远程 URL（仍有封面），再不行由上层回落动态卡。
async function localizePodcastCover(episode: Episode, repo: string, date: string, fileNameSuffix: string): Promise<string> {
  const remote = episode.imageUrl;
  if (!remote) return "";
  const timeoutMs = envPositiveInt("PODCAST_COVER_TIMEOUT_MS", 20_000);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let input: Buffer;
    try {
      const response = await fetch(remote, {
        redirect: "follow",
        headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`cover download HTTP ${response.status}`);
      input = Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
    const size = envPositiveInt("PODCAST_COVER_SIZE", 800);
    const quality = envPositiveInt("PODCAST_COVER_QUALITY", 80);
    const webp = await sharp(input).resize(size, size, { fit: "inside", withoutEnlargement: true }).webp({ quality }).toBuffer();
    ensureDir(path.join(repo, PODCAST_COVER_REL_DIR));
    const fileName = `${date}-${fileNameSuffix}.webp`;
    fs.writeFileSync(path.join(repo, PODCAST_COVER_REL_DIR, fileName), webp);
    return `${PODCAST_COVER_OGIMAGE_PREFIX}${fileName}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`WARN: podcast cover localization failed; using remote URL: ${message}`);
    return remote;
  }
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

function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] || "");
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function dailyPodcastMinEpisodes(): number {
  return envPositiveInt("PODCAST_MIN_EPISODES", 1);
}

function usablePodcastArticleCount(results: ResultItem[]): number {
  return results.filter(result => !result.failed && Boolean(result.path) && !result.skip_reason).length;
}

function skippedPodcastEpisode(result: ResultItem): ResultItem {
  const target = result.path ? ` (${result.path})` : "";
  return {
    ...result,
    path: "",
    created: false,
    skipped: true,
    failed: undefined,
    error: undefined,
    skip_reason: `episode generation skipped${target}: ${result.error || "unknown error"}`,
  };
}

export function settleDailyPodcastArticleResults(results: ResultItem[], date: string, minEpisodes = dailyPodcastMinEpisodes()): ResultItem[] {
  return settlePodcastArticleResults(results, date, minEpisodes);
}

function settlePodcastArticleResults(results: ResultItem[], date: string, minEpisodes = dailyPodcastMinEpisodes(), task: Task = "daily-podcasts"): ResultItem[] {
  const usableCount = usablePodcastArticleCount(results);
  const settled = results.map(result => {
    if (!result.failed) return result;
    return skippedPodcastEpisode(result);
  });
  if (usableCount >= minEpisodes) return settled;
  return [
    ...settled,
    failedTask(
      task,
      date,
      new PodcastSourceInsufficientEpisodesError(task, usableCount, minEpisodes),
    ),
  ];
}

function isPodcastArticleTask(task: Task): boolean {
  return task === "daily-podcasts" || task === "xyzrank-top-episodes";
}

function shouldSkipSourceUnavailable(error: unknown, task: Task): boolean {
  if (error instanceof MarketSourceUnavailableError && error.task === task) return true;
  if (!(error instanceof PodcastSourceInsufficientEpisodesError)) return false;
  return isPodcastArticleTask(task);
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

function fixtureSource(fixtureName: string, sourceFixtureDir: string): string {
  const file = path.join(sourceFixtureDir, `${fixtureName}.md`);
  if (!fs.existsSync(file)) throw new Error(`source fixture not found for ${fixtureName}: ${file}`);
  return fs.readFileSync(file, "utf8");
}

// capital-market-daily 不在此表：它按 marketSegment 取 source，见 sourceForTask。
const SOURCE_BUILDERS: Partial<Record<Task, (date: string) => Promise<string>>> = {
  "hn-top10": () => buildHnSource(),
  "github-trending-daily": date => buildGitHubTrendingDailySource(date, { dataDir: path.join(repoRoot(), "data/github-trending") }),
  "daily-podcasts": date => buildDailyPodcastSource(date),
  "xyzrank-top-episodes": date => buildXyzRankTopEpisodesSource(date),
  "mdblist-weekly": date => buildMdblistWeeklySource(date),
  "tech-weekly": date => buildTechWeeklySource(date),
  "ai-weekly": date => buildAiWeeklySource(date),
  "tech-business-weekly": date => buildTechBusinessWeeklySource(date),
  "tech-daily": date => buildDailyDigestSource(date),
  "ai-daily": date => buildDailyDigestSource(date),
  "tech-business-daily": date => buildDailyDigestSource(date),
};

// capital-market-daily 的 source fixture 按段命名：capital-market-daily-{segment}.md。
function fixtureKey(task: Task, marketSegment: MarketSegment | ""): string {
  return task === "capital-market-daily" && marketSegment ? `${task}-${marketSegment}` : task;
}

async function sourceForTask(task: Task, date: string, sourceFixtureDir = "", marketSegment: MarketSegment | "" = ""): Promise<string> {
  if (sourceFixtureDir) return fixtureSource(fixtureKey(task, marketSegment), sourceFixtureDir);
  if (task === "capital-market-daily") {
    if (!marketSegment) throw new Error("capital-market-daily requires a marketSegment");
    return buildCapitalSegmentSource(marketSegment, date);
  }
  const builder = SOURCE_BUILDERS[task];
  if (!builder) throw new Error(`no source builder for task: ${task}`);
  return builder(date);
}

function writeArtifact(artifactsDir: string, task: string, name: string, content: string): string {
  if (!artifactsDir) return "";
  ensureDir(artifactsDir);
  const file = path.join(artifactsDir, `${task}-${name}`);
  fs.writeFileSync(file, `${content.trim()}\n`, "utf8");
  return file;
}

async function callAi(prompt: string, model: string, jsonMode = false): Promise<AiCallResult> {
  const result = await callBlogAiWithFailover({
    prompt,
    primaryConfig: envAiConfig({ model }),
    fallbackConfig: envFallbackAiConfig(),
    jsonMode,
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
  const selectorPromptFile = resolvePromptFile(resolvedPromptDir, "tech-business-weekly-selector");
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
  const classifierPromptFile = resolvePromptFile(resolvedPromptDir, "daily-digest-classifier");
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
  const template = fs.readFileSync(resolvePromptFile(resolvedPromptDir, "daily-digest-item-summary"), "utf8");
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
  const plannerTemplate = fs.readFileSync(resolvePromptFile(resolvedPromptDir, "daily-digest-section-planner"), "utf8");
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

export function validateGeneratedMarkdownForTask(markdown: string, task: Task, date: string, marketSegment: MarketSegment | "" = ""): string {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-task-validation-"));
  try {
    archivePost({ task, date, repo: sandbox, body: markdown, force: true, marketSegment });
    return markdown;
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// JSON 组装家族：模型只返回语义字段，事实由 source 提供，规则层确定性组装成既有中间契约 Markdown。
// 新增任务只需在此登记一个 composer；其余任务保持模型直接产出 Markdown 的原路径。
const JSON_COMPOSERS: Partial<Record<Task, (rawJson: string, source: string) => string>> = {
  "hn-top10": hnMarkdownFromModelJson,
  "github-trending-daily": githubTrendingMarkdownFromModelJson,
  "mdblist-weekly": mdblistMarkdownFromModelJson,
  "tech-daily": (raw, src) => dailyDigestMarkdownFromModelJson(raw, src, "tech-daily"),
  "ai-daily": (raw, src) => dailyDigestMarkdownFromModelJson(raw, src, "ai-daily"),
  "tech-business-daily": (raw, src) => dailyDigestMarkdownFromModelJson(raw, src, "tech-business-daily"),
};

export function usesJsonComposer(task: Task): boolean {
  return task in JSON_COMPOSERS || task === "capital-market-daily";
}

function contentToMarkdown(content: string, source: string, task: Task, marketSegment: MarketSegment | "" = ""): string {
  if (task === "capital-market-daily") {
    if (!marketSegment) throw new Error("capital-market-daily requires a marketSegment");
    return capitalMarketMarkdownFromModelJson(content, source, marketSegment);
  }
  const composer = JSON_COMPOSERS[task];
  if (composer) return composer(content, source);
  return normalizeMarkdownLinksFromSourceTitles(validateMarkdown(content), source, task);
}

async function renderLiveAiMarkdownWithSourceValidation(
  prompt: string,
  model: string,
  task: Task,
  date: string,
  artifactsDir: string,
  source: string,
  artifactKey: string = task,
  marketSegment: MarketSegment | "" = "",
): Promise<{ markdown: string; ai: AiCallResult }> {
  const attempts = retryAttempts();
  const jsonMode = usesJsonComposer(task);
  let lastError = "";
  let attemptPrompt = prompt;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await sleep(retryDelayMs(attempt));
    if (attempt > 1) writeArtifact(artifactsDir, artifactKey, `retry-prompt-attempt-${attempt}.md`, attemptPrompt);
    try {
      const ai = await callAi(attemptPrompt, model, jsonMode);
      const markdown = contentToMarkdown(ai.content, source, task, marketSegment);
      assertMarkdownUsesOnlySourceLinks(markdown, source, task);
      validateGeneratedMarkdownForTask(markdown, task, date, marketSegment);
      return { markdown, ai };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      writeArtifact(artifactsDir, artifactKey, `ai-error-attempt-${attempt}.txt`, lastError);
      if (attempt < attempts) {
        attemptPrompt = shouldRetryWithValidationFeedback(lastError) ? promptWithValidationFeedback(prompt, task, lastError) : prompt;
        writeStderr(`WARN: ${artifactKey} AI generation attempt ${attempt}/${attempts} failed; retrying with validation feedback: ${lastError}`);
      }
    }
  }
  throw new Error(`${artifactKey} AI generation failed after ${attempts} attempts: ${lastError}`);
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
  artifactKey = task,
  marketSegment = "",
}: {
  task: Task;
  date: string;
  source: string;
  repo: string;
  model: string;
  promptDir: string;
  mockResponseDir: string;
  artifactsDir: string;
  artifactKey?: string;
  marketSegment?: MarketSegment | "";
}): Promise<{ markdown: string; metadata: NonNullable<ResultItem["generation"]> }> {
  const sourceArtifact = writeArtifact(artifactsDir, artifactKey, "source.md", source);
  const resolvedPromptDir = promptDir || path.join(repo, "prompts/blog");
  // capital-market-daily 每段一个 prompt / mock fixture：capital-market-{segment}。
  const promptName = task === "capital-market-daily" && marketSegment ? `capital-market-${marketSegment}` : task;
  const fixtureName = task === "capital-market-daily" && marketSegment ? `${task}-${marketSegment}` : task;
  const prompt = renderPrompt({ task: promptName, date, sourceText: source, promptDir: resolvedPromptDir });
  const promptArtifact = writeArtifact(artifactsDir, artifactKey, "prompt.md", prompt);
  const mockExt = usesJsonComposer(task) ? "json" : "md";
  const mockFile = mockResponseDir ? path.join(mockResponseDir, `${fixtureName}.${mockExt}`) : "";
  const rendered = mockFile
    ? {
        markdown: contentToMarkdown(fs.readFileSync(mockFile, "utf8"), source, task, marketSegment),
        ai: {
          content: "",
          config: envAiConfig({ model }),
          usedFallback: false,
        },
      }
    : await renderLiveAiMarkdownWithSourceValidation(prompt, model, task, date, artifactsDir, source, artifactKey, marketSegment);
  const responseArtifact = writeArtifact(artifactsDir, artifactKey, "ai-response.md", rendered.markdown);
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

type GenerateTaskOptions = {
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
  marketSegment?: MarketSegment | "";
};

async function fetchPodcastArticleEpisodes(task: Task, date: string, force: boolean): Promise<Episode[]> {
  if (task === "daily-podcasts") return fetchDailyPodcastEpisodes(date, force);
  if (task === "xyzrank-top-episodes") return fetchXyzRankTopEpisodes(date, force);
  throw new Error(`unsupported podcast article task: ${task}`);
}

// 播客音频任务逐集走多模态，一集一篇。
async function generatePodcastArticles({ task, repo, date, force, promptDir, artifactsDir }: GenerateTaskOptions): Promise<ResultItem[]> {
  const episodes = await fetchPodcastArticleEpisodes(task, date, force);
  const resolvedPromptDir = promptDir || path.join(repo, "prompts/blog");
  const results: ResultItem[] = [];
  for (const [index, episode] of episodes.entries()) {
    const fileNameSuffix = dailyPodcastFileNameSuffix(episode, index);
    if (!force) {
      const skipped = skippedExistingVariant(task, repo, date, fileNameSuffix);
      if (skipped) {
        results.push(skipped);
        continue;
      }
    }
    const artifactKey = `${task}-${fileNameSuffix}`;
    try {
      const article = await buildDailyPodcastEpisodeArticle(episode, date, { promptDir: resolvedPromptDir });
      const markdown = validateMarkdown(article);
      const responseArtifact = writeArtifact(artifactsDir, artifactKey, "ai-response.md", markdown);
      const ogImage = await localizePodcastCover(episode, repo, date, fileNameSuffix);
      const result: ResultItem = archivePost({ task, date, repo, body: markdown, force, fileNameSuffix, ogImage });
      result.generation = {
        ai_model: geminiArticleModel(),
        ai_base_url: geminiArticleBaseUrl(),
        ai_fallback_used: false,
        source_artifact: "",
        prompt_artifact: "",
        ai_response_artifact: responseArtifact,
        mocked_ai: false,
      };
      if (!result.skipped) appendSummarizedEpisode(episode, { archivedAt: date, postPath: result.path });
      results.push(result);
    } catch (error) {
      const failed = failedTask(task, date, error);
      failed.path = variantPostRelPath(task, date, fileNameSuffix);
      failed.title = titleForVariant(task, date);
      results.push(failed);
      writeStderr(`ERROR: ${artifactKey} generation failed: ${failed.error}`);
    }
  }
  if (!results.length) throw new PodcastSourceInsufficientEpisodesError(task, 0, 1);
  return settlePodcastArticleResults(results, date, dailyPodcastMinEpisodes(), task);
}

async function generateTask(options: GenerateTaskOptions): Promise<ResultItem[]> {
  const { task, repo, date, force, useAi, model, promptDir, sourceFixtureDir, mockResponseDir, artifactsDir, marketSegment = "" } = options;
  if (isPodcastArticleTask(task) && useAi && !sourceFixtureDir && !mockResponseDir) return generatePodcastArticles(options);
  // capital-market-daily 增量拼一篇：每段独立文件不做 skip，force 由归档层按段合并处理。
  if (!force && task !== "capital-market-daily") {
    const skipped = skippedExisting(task, repo, date);
    if (skipped) return [skipped];
  }
  let source = await sourceForTask(task, date, sourceFixtureDir, marketSegment);
  if (useAi && task === "tech-business-weekly" && !mockResponseDir) {
    source = await selectTechBusinessSource({ source, date, repo, model, promptDir, artifactsDir });
  }
  if (useAi && task === "tech-daily" && !mockResponseDir) {
    source = await buildCombinedTechDailySource({ source, date, repo, model, promptDir, artifactsDir });
    const itemCount = countNumberedBlocks(source);
    if (itemCount < 1) return [skippedLowQuality(task, date, "tech-daily has no high-quality daily items")];
  }
  if (useAi && (task === "ai-daily" || task === "tech-business-daily") && !mockResponseDir) {
    source = await classifiedDailySourceForTask({ task, source, date, repo, model, promptDir, artifactsDir });
    const itemCount = countNumberedBlocks(source);
    if (itemCount < 1) return [skippedLowQuality(task, date, `${task} has no high-quality daily items`)];
  }
  const artifactKey = task === "capital-market-daily" && marketSegment ? `${task}-${marketSegment}` : task;
  let body = source;
  let generation: ResultItem["generation"];
  if (useAi) {
    const rendered = await renderWithAi({ task, date, source, repo, model, promptDir, mockResponseDir, artifactsDir, artifactKey, marketSegment });
    body = rendered.markdown;
    generation = rendered.metadata;
  }
  const result: ResultItem = archivePost({ task, date, repo, body, force, marketSegment });
  if (generation) result.generation = generation;
  // 顶部「市场速览」纯数据表格由亚洲那次跑生成，增量并入同一篇（不过大模型）。
  // 取数失败（Python/AkShare 不可用或网络异常）时降级：保留占位段，不让整篇日报失败。
  if (task === "capital-market-daily" && marketSegment === "asia") {
    try {
      const tableBlock = buildMarketTable(date, { fixtureDir: sourceFixtureDir });
      archivePost({ task, date, repo, body: tableBlock, force, marketSegment: "table" });
    } catch (error) {
      writeStderr(`WARN: capital-market-daily market table skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [result];
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
  const date = explicitDate || offsetDate(offset, scheduled.dateTimeZone);
  const tasks = tasksForInput(taskArg);
  const results: ResultItem[] = [];
  for (const task of tasks as Task[]) {
    try {
      results.push(
        ...(await generateTask({
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
          marketSegment: (stringArg(args, "market-segment", scheduled.marketSegment || "") as MarketSegment | ""),
        })),
      );
    } catch (error) {
      if (shouldSkipSourceUnavailable(error, task)) {
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
