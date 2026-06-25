#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { archivePost } from "./astro_paper_archive.ts";
import { validateMarkdown, renderPrompt } from "./ai_blog_writer.ts";
import { callBlogAi, envAiConfig } from "./blog_ai_client.ts";
import { bjtDateString, ensureDir, parseArgs, repoRoot, stringArg, writeStderr, writeStdout } from "./blog_common.ts";
import { DAILY_DIGEST_TASKS, SOURCE_LINK_WHITELIST_TASKS, type Task, isDailyDigestTask, isTaskInput, scheduledTaskInput, taskPostRelPath, taskTags, taskTitle, tasksForInput } from "./blog_tasks.ts";
import { buildHnSource } from "./hn_top10_source.ts";
import { buildForeignTechPodcastSource } from "./foreign_tech_podcast_source.ts";
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

async function callAi(prompt: string, model: string): Promise<string> {
  const config = envAiConfig({ model });
  return callBlogAi({ prompt, ...config });
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
  return (source.match(/^##\s+\d+\.\s+/gm) || []).length;
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
  writeArtifact(artifactsDir, "tech-business-weekly", "selector-response.json", response);
  const maxId = (source.match(/^##\s+\d+\.\s+/gm) || []).length;
  const ids = parseSelectedIds(response, maxId);
  writeArtifact(artifactsDir, "tech-business-weekly", "selector-selected-ids.json", JSON.stringify({ selected: ids }, null, 2));
  const selectedSource = filterNumberedSource(source, ids);
  writeArtifact(artifactsDir, "tech-business-weekly", "source.selected.md", selectedSource);
  return selectedSource;
}


type DailyAssignmentTask = "tech-daily" | "ai-daily" | "tech-business-daily" | "drop";

type DailyAssignmentPayload = {
  assignments?: { id?: unknown; task?: unknown; reason?: unknown }[];
};

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
  for (const task of DAILY_DIGEST_TASKS) out[task] = out[task].slice(0, 10);
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
  writeArtifact(artifactsDir, "daily-digests", "classifier-response.json", response);
  const maxId = countNumberedBlocks(source);
  const assignments = parseDailyAssignments(response, maxId);
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


function normalizedHeadingTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
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

async function renderLiveAiMarkdownWithSourceValidation(prompt: string, model: string, task: Task, artifactsDir: string, source: string): Promise<string> {
  const attempts = retryAttempts();
  let lastError = "";
  let attemptPrompt = prompt;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await sleep(retryDelayMs(attempt));
    if (attempt > 1) writeArtifact(artifactsDir, task, `retry-prompt-attempt-${attempt}.md`, attemptPrompt);
    try {
      const rawMarkdown = await callAi(attemptPrompt, model);
      const markdown = normalizeMarkdownLinksFromSourceTitles(validateMarkdown(rawMarkdown), source, task);
      assertMarkdownUsesOnlySourceLinks(markdown, source, task);
      return markdown;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      writeArtifact(artifactsDir, task, `ai-error-attempt-${attempt}.txt`, lastError);
      if (attempt < attempts) {
        attemptPrompt = promptWithValidationFeedback(prompt, task, lastError);
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
  const markdown = mockFile ? validateMarkdown(fs.readFileSync(mockFile, "utf8")) : await renderLiveAiMarkdownWithSourceValidation(prompt, model, task, artifactsDir, source);
  const responseArtifact = writeArtifact(artifactsDir, task, "ai-response.md", markdown);
  return {
    markdown,
    metadata: {
      ai_model: model || process.env.AI_MODEL || "",
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
  if (useAi && isDailyDigestTask(task) && !mockResponseDir) {
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
