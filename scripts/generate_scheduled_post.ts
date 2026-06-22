#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { archivePost } from "./astro_paper_archive.ts";
import { validateMarkdown, renderPrompt } from "./ai_blog_writer.ts";
import { bjtDateString, ensureDir, parseArgs, repoRoot, stringArg, writeStderr, writeStdout } from "./blog_common.ts";
import { buildHnSource } from "./hn_top10_source.ts";
import { generateAsiaMarketDaily, generateCryptoMarketDaily, generateUsMarketDaily } from "./market_daily_source.ts";

const TASKS = ["hn-top10", "asia-market-daily", "crypto-market-daily", "us-market-daily"] as const;
type Task = (typeof TASKS)[number];

const TASK_META: Record<Task, { titlePrefix: string; fileName: string; tags: string[] }> = {
  "hn-top10": { titlePrefix: "HackerNews Top 10", fileName: "hackernews-{date}.md", tags: ["定时文章", "HackerNews"] },
  "asia-market-daily": { titlePrefix: "亚洲市场日报", fileName: "亚洲市场日报-{date}.md", tags: ["定时文章", "亚洲市场日报"] },
  "crypto-market-daily": { titlePrefix: "数字货币日报", fileName: "数字货币日报-{date}.md", tags: ["定时文章", "数字货币日报"] },
  "us-market-daily": { titlePrefix: "美股市场日报", fileName: "美股市场日报-{date}.md", tags: ["定时文章", "美股市场日报"] },
};

type ResultItem = ReturnType<typeof archivePost> & {
  generation?: {
    ai_model: string;
    source_artifact: string;
    prompt_artifact: string;
    ai_response_artifact: string;
    mocked_ai: boolean;
  };
};

function isTask(value: string): value is Task {
  return (TASKS as readonly string[]).includes(value);
}

function offsetBjtDate(days: number): string {
  return bjtDateString(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
}

function targetPath(task: Task, repo: string, date: string): string {
  const file = TASK_META[task].fileName.replace("{date}", date);
  return path.join(repo, "src/content/posts/zh-cn", file);
}

function skippedExisting(task: Task, repo: string, date: string): ResultItem | null {
  const postPath = targetPath(task, repo, date);
  if (!fs.existsSync(postPath)) return null;
  const meta = TASK_META[task];
  return {
    task,
    path: path.relative(repo, postPath),
    title: `${meta.titlePrefix}｜${date}`,
    created: false,
    skipped: true,
    updated_at_bjt: "",
    commit: "",
    push: "",
    tags: meta.tags,
  };
}

function fixtureSource(task: Task, sourceFixtureDir: string): string {
  const file = path.join(sourceFixtureDir, `${task}.md`);
  if (!fs.existsSync(file)) throw new Error(`source fixture not found for task ${task}: ${file}`);
  return fs.readFileSync(file, "utf8");
}

async function sourceForTask(task: Task, date: string, sourceFixtureDir = ""): Promise<string> {
  if (sourceFixtureDir) return fixtureSource(task, sourceFixtureDir);
  if (task === "hn-top10") return buildHnSource();
  if (task === "asia-market-daily") return generateAsiaMarketDaily(date);
  if (task === "us-market-daily") return generateUsMarketDaily(date);
  if (task === "crypto-market-daily") return generateCryptoMarketDaily();
  throw new Error(`unsupported task: ${task}`);
}

function writeArtifact(artifactsDir: string, task: Task, name: string, content: string): string {
  if (!artifactsDir) return "";
  ensureDir(artifactsDir);
  const file = path.join(artifactsDir, `${task}-${name}`);
  fs.writeFileSync(file, `${content.trim()}\n`, "utf8");
  return file;
}

async function callAi(prompt: string, model: string): Promise<string> {
  const apiKey = process.env.AI_API_KEY || "";
  const baseUrl = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const effectiveModel = model || process.env.AI_MODEL || "gpt-4o-mini";
  if (!apiKey) throw new Error("AI_API_KEY is required for live AI blog generation");
  if (!baseUrl) throw new Error("AI_BASE_URL is required for live AI blog generation");
  if (!effectiveModel) throw new Error("AI_MODEL is required for live AI blog generation");
  const response = await fetch(`${baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: effectiveModel,
      messages: [
        { role: "system", content: "你是严格的中文博客编辑。只输出可归档的 Markdown 正文，不输出解释、前后缀或代码围栏。" },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
      max_tokens: 4096,
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`AI provider HTTP ${response.status}: ${raw.slice(0, 1200)}`);
  const data = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content?.trim()) throw new Error(`AI response missing message content: ${raw}`);
  return content;
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

async function renderLiveAiMarkdown(prompt: string, model: string, task: Task, artifactsDir: string): Promise<string> {
  const attempts = retryAttempts();
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await sleep(retryDelayMs(attempt));
    try {
      const rawMarkdown = await callAi(prompt, model);
      return validateMarkdown(rawMarkdown);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      writeArtifact(artifactsDir, task, `ai-error-attempt-${attempt}.txt`, lastError);
      if (attempt < attempts) writeStderr(`WARN: ${task} AI generation attempt ${attempt}/${attempts} failed; retrying: ${lastError}`);
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
  const markdown = mockFile ? validateMarkdown(fs.readFileSync(mockFile, "utf8")) : await renderLiveAiMarkdown(prompt, model, task, artifactsDir);
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
  const source = await sourceForTask(task, date, sourceFixtureDir);
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
  const taskArg = stringArg(args, "task", "all");
  const repo = path.resolve(stringArg(args, "repo", repoRoot()));
  const explicitDate = stringArg(args, "date");
  const offset = Number(stringArg(args, "date-offset", "0"));
  if (!Number.isInteger(offset)) throw new Error(`invalid --date-offset: ${String(args["date-offset"])}`);
  const date = explicitDate || offsetBjtDate(offset);
  const tasks = taskArg === "all" ? [...TASKS] : [taskArg];
  if (tasks.some(task => !isTask(task))) throw new Error(`unsupported task: ${taskArg}`);
  const results = [];
  for (const task of tasks as Task[]) {
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
  }
  const output = `${JSON.stringify({ date, results }, null, 2)}\n`;
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
