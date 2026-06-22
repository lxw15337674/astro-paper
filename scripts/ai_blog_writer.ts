#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { clipText, parseArgs, readStdin, repoRoot, stringArg, writeStderr, writeStdout } from "./blog_common.ts";

const DEFAULT_AI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_AI_MODEL = "gpt-4o-mini";
const DEFAULT_MAX_TOKENS = 4096;

export function renderPrompt({ task, date, sourceText, promptDir }: { task: string; date: string; sourceText: string; promptDir: string }): string {
  const file = path.join(promptDir, `${task}.md`);
  if (!fs.existsSync(file)) throw new Error(`prompt template not found for task ${task}: ${file}`);
  return fs.readFileSync(file, "utf8").replaceAll("{task}", task).replaceAll("{date}", date).replaceAll("{source_text}", sourceText.trim());
}

export function stripMarkdownFence(text: string): string {
  return `${text.trim().replace(/^```(?:markdown|md)?\s*/i, "").replace(/\s*```\s*$/i, "").trim()}\n`;
}

export function validateMarkdown(text: string): string {
  const cleaned = stripMarkdownFence(text);
  if (cleaned.trim().length < 200) throw new Error("AI markdown output is too short to publish");
  const forbidden = [/Traceback \(most recent call last\)/i, /Script not found:/i, /归档失败/i, /\{\{[^}]+\}\}/, /TODO/i];
  for (const pattern of forbidden) {
    if (pattern.test(cleaned)) throw new Error(`AI markdown output contains forbidden pattern: ${pattern.source}`);
  }
  return cleaned;
}

export function chatCompletionsUrl(baseUrl: string): string {
  const cleaned = baseUrl.replace(/\/+$/, "");
  return cleaned.endsWith("/chat/completions") ? cleaned : `${cleaned}/chat/completions`;
}

async function callAi({
  prompt,
  apiKey,
  baseUrl,
  model,
  timeoutMs,
  maxTokens,
}: {
  prompt: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(chatCompletionsUrl(baseUrl), {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "你是严格的中文博客编辑。只输出可归档的 Markdown 正文，不输出解释、前后缀或代码围栏。" },
          { role: "user", content: prompt },
        ],
        temperature: 0.4,
        max_tokens: maxTokens,
      }),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`AI provider HTTP ${response.status}: ${clipText(raw, 1200)}`);
    const data = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content?.trim()) throw new Error(`AI response missing message content: ${raw}`);
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export async function main(): Promise<void> {
  const args = parseArgs();
  const task = stringArg(args, "task");
  const date = stringArg(args, "date");
  if (!task || !date) throw new Error("--task and --date are required");
  const sourceText = readStdin();
  if (!sourceText.trim()) throw new Error("source evidence is empty");
  const promptDir = stringArg(args, "prompt-dir", path.join(repoRoot(), "prompts", "blog"));
  const prompt = renderPrompt({ task, date, sourceText, promptDir: path.resolve(promptDir) });
  const savePrompt = stringArg(args, "save-prompt");
  if (savePrompt) fs.writeFileSync(path.resolve(savePrompt), prompt, "utf8");

  let mockFile = stringArg(args, "mock-response-file");
  const mockDir = stringArg(args, "mock-response-dir");
  if (mockDir) mockFile = path.join(path.resolve(mockDir), `${task}.md`);

  const rawMarkdown = mockFile
    ? fs.readFileSync(path.resolve(mockFile), "utf8")
    : await callAi({
        prompt,
        apiKey: stringArg(args, "api-key", process.env.AI_API_KEY || ""),
        baseUrl: stringArg(args, "base-url", process.env.AI_BASE_URL || DEFAULT_AI_BASE_URL),
        model: stringArg(args, "model", process.env.AI_MODEL || DEFAULT_AI_MODEL),
        timeoutMs: Number(stringArg(args, "timeout", "120")) * 1000,
        maxTokens: Number(stringArg(args, "max-tokens", String(DEFAULT_MAX_TOKENS))),
      });
  if (!mockFile) {
    if (!stringArg(args, "api-key", process.env.AI_API_KEY || "")) throw new Error("AI_API_KEY is required for live AI blog generation");
    if (!stringArg(args, "base-url", process.env.AI_BASE_URL || DEFAULT_AI_BASE_URL)) throw new Error("AI_BASE_URL is required for live AI blog generation");
    if (!stringArg(args, "model", process.env.AI_MODEL || DEFAULT_AI_MODEL)) throw new Error("AI_MODEL is required for live AI blog generation");
  }
  writeStdout(validateMarkdown(rawMarkdown));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`ERROR: ${message}`);
    process.exit(1);
  });
}
