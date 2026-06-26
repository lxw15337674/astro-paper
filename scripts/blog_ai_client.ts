import { clipText } from "./blog_common.ts";

export const DEFAULT_AI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_AI_MODEL = "gpt-4o-mini";
export const DEFAULT_MAX_TOKENS = 4096;

function envDurationMs(name: string, fallback: number): number {
  const value = Number(process.env[name] || "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function chatCompletionsUrl(baseUrl: string): string {
  const cleaned = baseUrl.replace(/\/+$/, "");
  return cleaned.endsWith("/chat/completions") ? cleaned : `${cleaned}/chat/completions`;
}

export async function callBlogAi({
  prompt,
  apiKey,
  baseUrl,
  model,
  timeoutMs = envDurationMs("AI_TIMEOUT_MS", 120_000),
  maxTokens = DEFAULT_MAX_TOKENS,
}: {
  prompt: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
}): Promise<string> {
  if (!apiKey) throw new Error("AI_API_KEY is required for live AI blog generation");
  if (!baseUrl) throw new Error("AI_BASE_URL is required for live AI blog generation");
  if (!model) throw new Error("AI_MODEL is required for live AI blog generation");
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
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.message === "This operation was aborted")) throw new Error(`AI request timed out after ${timeoutMs}ms`);
    if (error instanceof Error && /^(AI provider HTTP|AI response missing message content:)/.test(error.message)) throw error;
    if (error instanceof Error) throw new Error(`AI request failed: ${error.message}`);
    throw new Error(`AI request failed: ${String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

export function envAiConfig({
  model = "",
  baseUrl = "",
  apiKey = "",
}: {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
} = {}): { apiKey: string; baseUrl: string; model: string } {
  return {
    apiKey: apiKey || process.env.AI_API_KEY || "",
    baseUrl: baseUrl || process.env.AI_BASE_URL || DEFAULT_AI_BASE_URL,
    model: model || process.env.AI_MODEL || DEFAULT_AI_MODEL,
  };
}
