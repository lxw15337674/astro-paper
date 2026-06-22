#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { archivePost } from "./astro_paper_archive.ts";
import { validateMarkdown, renderPrompt } from "./ai_blog_writer.ts";
import { bjtDateString, ensureDir, parseArgs, repoRoot, stringArg, writeStderr, writeStdout } from "./blog_common.ts";
import { buildHnSource } from "./hn_top10_source.ts";
import { generateMarketDaily } from "./market_daily_source.ts";

const TASKS = ["hn-top10", "global-market-daily"] as const;
type Task = (typeof TASKS)[number];

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

function targetPath(task: Task, repo: string, date: string): string {
  const file = task === "hn-top10" ? `hackernews-${date}.md` : `全球市场日报-${date}.md`;
  return path.join(repo, "src/content/posts/zh-cn", file);
}

function skippedExisting(task: Task, repo: string, date: string): ResultItem | null {
  const postPath = targetPath(task, repo, date);
  if (!fs.existsSync(postPath)) return null;
  return {
    task,
    path: path.relative(repo, postPath),
    title: task === "hn-top10" ? `HackerNews Top 10｜${date}` : `全球市场日报｜${date}`,
    created: false,
    skipped: true,
    updated_at_bjt: "",
    commit: "",
    push: "",
    tags: task === "hn-top10" ? ["定时文章", "HackerNews"] : ["定时文章", "全球市场日报"],
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
  if (task === "global-market-daily") return generateMarketDaily(date);
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
  const rawMarkdown = mockFile ? fs.readFileSync(mockFile, "utf8") : await callAi(prompt, model);
  const markdown = validateMarkdown(rawMarkdown);
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
  const date = stringArg(args, "date", bjtDateString());
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
  writeStdout(`${JSON.stringify({ date, results }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`ERROR: ${message}`);
    process.exit(1);
  });
}
