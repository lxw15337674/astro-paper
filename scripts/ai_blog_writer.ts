#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { avoidCloudflareEmailObfuscation, parseArgs, readStdin, repoRoot, stringArg, writeStderr, writeStdout } from "./blog_common.ts";
import { DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, DEFAULT_MAX_TOKENS, callBlogAiWithFailover, chatCompletionsUrl, envAiConfig, envFallbackAiConfig } from "./blog_ai_client.ts";

export { chatCompletionsUrl };

// prompts/blog 下按 daily/weekly/market/podcast 分类到子目录；解析时先查根目录再查一层子目录，
// 这样任务名与 promptDir 都不变，只有物理位置改变。找不到返回根目录路径，由调用方处理不存在。
export function resolvePromptFile(promptDir: string, name: string): string {
  const direct = path.join(promptDir, `${name}.md`);
  if (fs.existsSync(direct)) return direct;
  if (fs.existsSync(promptDir)) {
    for (const entry of fs.readdirSync(promptDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(promptDir, entry.name, `${name}.md`);
      if (fs.existsSync(nested)) return nested;
    }
  }
  return direct;
}

export function renderPrompt({ task, date, sourceText, promptDir }: { task: string; date: string; sourceText: string; promptDir: string }): string {
  const file = resolvePromptFile(promptDir, task);
  if (!fs.existsSync(file)) throw new Error(`prompt template not found for task ${task}: ${file}`);
  const commonFile = resolvePromptFile(promptDir, "_common-article-rules");
  const common = fs.existsSync(commonFile) ? `${fs.readFileSync(commonFile, "utf8").trim()}\n\n` : "";
  const taskPrompt = fs.readFileSync(file, "utf8").replaceAll("{task}", task).replaceAll("{date}", date).replaceAll("{source_text}", sourceText.trim());
  return `${common}${taskPrompt.trimStart()}`;
}

export function stripMarkdownFence(text: string): string {
  return `${text.trim().replace(/^```(?:markdown|md)?\s*/i, "").replace(/\s*```\s*$/i, "").trim()}\n`;
}

export function validateMarkdown(text: string): string {
  const cleaned = avoidCloudflareEmailObfuscation(stripMarkdownFence(text));
  if (cleaned.trim().length < 200) throw new Error("AI markdown output is too short to publish");
  const forbidden = [/Traceback \(most recent call last\)/i, /Script not found:/i, /归档失败/i, /\{\{[^}]+\}\}/];
  for (const pattern of forbidden) {
    if (pattern.test(cleaned)) throw new Error(`AI markdown output contains forbidden pattern: ${pattern.source}`);
  }
  return cleaned;
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

  let rawMarkdown = mockFile ? fs.readFileSync(path.resolve(mockFile), "utf8") : "";
  if (!mockFile) {
    const result = await callBlogAiWithFailover({
      prompt,
      primaryConfig: envAiConfig({
        apiKey: stringArg(args, "api-key", process.env.AI_API_KEY || ""),
        baseUrl: stringArg(args, "base-url", process.env.AI_BASE_URL || DEFAULT_AI_BASE_URL),
        model: stringArg(args, "model", process.env.AI_MODEL || DEFAULT_AI_MODEL),
      }),
      fallbackConfig: envFallbackAiConfig(),
      timeoutMs: Number(stringArg(args, "timeout", "120")) * 1000,
      maxTokens: Number(stringArg(args, "max-tokens", String(DEFAULT_MAX_TOKENS))),
    });
    rawMarkdown = result.content;
    if (result.usedFallback) {
      writeStderr(`WARN: primary AI request failed; using fallback model ${result.config.model} via ${result.config.baseUrl}`);
    }
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
