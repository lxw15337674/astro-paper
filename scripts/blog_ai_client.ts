import { clipText } from "./blog_common.ts";

export const DEFAULT_AI_BASE_URL = "https://www.right.codes/codex/v1";
export const DEFAULT_AI_MODEL = "gpt-5.6-luna";
export const DEFAULT_FALLBACK_AI_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_FALLBACK_AI_MODEL = "deepseek-v4-flash";
export const DEFAULT_MAX_TOKENS = 4096;

export type AiApiStyle = "responses" | "chat";

export type AiConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  apiStyle?: AiApiStyle;
};

const SYSTEM_PROMPT_JSON = "你是严格的中文技术编辑。只输出一个合法 JSON 对象，不要输出解释、Markdown、前后缀或代码围栏。";
const SYSTEM_PROMPT_MARKDOWN = "你是严格的中文博客编辑。只输出可归档的 Markdown 正文，不输出解释、前后缀或代码围栏。";

function systemPrompt(jsonMode: boolean): string {
  return jsonMode ? SYSTEM_PROMPT_JSON : SYSTEM_PROMPT_MARKDOWN;
}

export type AiCallResult = {
  content: string;
  config: AiConfig;
  usedFallback: boolean;
  // Populated when the primary target failed (whether or not a fallback then succeeded).
  primaryError?: string;
};

function envDurationMs(name: string, fallback: number): number {
  const value = Number(process.env[name] || "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] || "");
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Transient = worth retrying the same target: dropped connections, resets, timeouts, 5xx, 429.
// Permanent (4xx other than 429, empty/invalid content) is not retried.
export function isTransientAiError(message: string): boolean {
  if (/^AI request timed out/.test(message)) return true;
  if (/^AI provider HTTP (?:5\d\d|429)\b/.test(message)) return true;
  if (/^AI request failed:/.test(message)) return true; // network/TLS/connection layer
  return false;
}

function envApiStyle(name: string, fallback: AiApiStyle): AiApiStyle {
  const value = (process.env[name] || "").trim().toLowerCase();
  return value === "responses" || value === "chat" ? value : fallback;
}

export function chatCompletionsUrl(baseUrl: string): string {
  const cleaned = baseUrl.replace(/\/+$/, "");
  return cleaned.endsWith("/chat/completions") ? cleaned : `${cleaned}/chat/completions`;
}

export function responsesUrl(baseUrl: string): string {
  const cleaned = baseUrl.replace(/\/+$/, "");
  return cleaned.endsWith("/responses") ? cleaned : `${cleaned}/responses`;
}

// Parse an OpenAI Responses API SSE stream (buffered) into final text.
// Prefers the authoritative text on response.completed; falls back to accumulated deltas.
export function parseResponsesSse(sse: string): string {
  const deltas: string[] = [];
  let finalText = "";
  let failure = "";
  for (const block of sse.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    let event: {
      type?: string;
      delta?: string;
      message?: string;
      error?: { message?: string };
      response?: { error?: { message?: string }; output?: { content?: { type?: string; text?: string }[] }[] };
    };
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    switch (event.type) {
      case "response.output_text.delta":
        if (typeof event.delta === "string") deltas.push(event.delta);
        break;
      case "response.completed": {
        const output = event.response?.output;
        if (Array.isArray(output)) {
          finalText = output
            .flatMap(item => (Array.isArray(item?.content) ? item.content : []))
            .filter(part => part?.type === "output_text" && typeof part.text === "string")
            .map(part => part.text as string)
            .join("");
        }
        break;
      }
      case "response.failed":
      case "response.error":
      case "error":
        failure = event.response?.error?.message || event.error?.message || event.message || "unknown responses API error";
        break;
    }
  }
  if (failure) throw new Error(`AI responses API error: ${failure}`);
  return finalText.trim() ? finalText : deltas.join("");
}

export async function callBlogAi({
  prompt,
  apiKey,
  baseUrl,
  model,
  apiStyle = "chat",
  timeoutMs = envDurationMs("AI_TIMEOUT_MS", 120_000),
  maxTokens = DEFAULT_MAX_TOKENS,
  jsonMode = false,
}: {
  prompt: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  apiStyle?: AiApiStyle;
  timeoutMs?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}): Promise<string> {
  if (!apiKey) throw new Error("AI_API_KEY is required for live AI blog generation");
  if (!baseUrl) throw new Error("AI_BASE_URL is required for live AI blog generation");
  if (!model) throw new Error("AI_MODEL is required for live AI blog generation");
  const useResponses = apiStyle === "responses";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = useResponses
      ? {
          model,
          instructions: systemPrompt(jsonMode),
          input: prompt,
          max_output_tokens: maxTokens,
          ...(jsonMode ? { text: { format: { type: "json_object" } } } : {}),
        }
      : {
          model,
          messages: [
            { role: "system", content: systemPrompt(jsonMode) },
            { role: "user", content: prompt },
          ],
          temperature: 0.4,
          max_tokens: maxTokens,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        };
    const response = await fetch(useResponses ? responsesUrl(baseUrl) : chatCompletionsUrl(baseUrl), {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`AI provider HTTP ${response.status}: ${clipText(raw, 1200)}`);
    let content: string | undefined;
    if (useResponses) {
      content = parseResponsesSse(raw);
    } else {
      const data = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] };
      content = data.choices?.[0]?.message?.content;
    }
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
} = {}): AiConfig {
  return {
    apiKey: apiKey || process.env.AI_API_KEY || "",
    baseUrl: baseUrl || process.env.AI_BASE_URL || DEFAULT_AI_BASE_URL,
    model: model || process.env.AI_MODEL || DEFAULT_AI_MODEL,
    apiStyle: envApiStyle("AI_API_STYLE", "responses"),
  };
}

export function envFallbackAiConfig({
  model = "",
  baseUrl = "",
  apiKey = "",
}: {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
} = {}): AiConfig {
  return {
    apiKey: apiKey || process.env.AI_FALLBACK_API_KEY || "",
    baseUrl: baseUrl || process.env.AI_FALLBACK_BASE_URL || DEFAULT_FALLBACK_AI_BASE_URL,
    model: model || process.env.AI_FALLBACK_MODEL || DEFAULT_FALLBACK_AI_MODEL,
    apiStyle: envApiStyle("AI_FALLBACK_API_STYLE", "chat"),
  };
}

function sameAiTarget(left: AiConfig, right: AiConfig): boolean {
  return left.apiKey === right.apiKey && left.baseUrl === right.baseUrl && left.model === right.model;
}

function missingConfigField(config: AiConfig): keyof AiConfig | "" {
  if (!config.apiKey) return "apiKey";
  if (!config.baseUrl) return "baseUrl";
  if (!config.model) return "model";
  return "";
}

function configErrorMessage(config: AiConfig, label: "primary" | "fallback"): string {
  const field = missingConfigField(config);
  if (!field) return "";
  const name = label === "fallback"
    ? field === "apiKey"
      ? "AI_FALLBACK_API_KEY"
      : field === "baseUrl"
        ? "AI_FALLBACK_BASE_URL"
        : "AI_FALLBACK_MODEL"
    : field === "apiKey"
      ? "AI_API_KEY"
      : field === "baseUrl"
        ? "AI_BASE_URL"
        : "AI_MODEL";
  return `${label} AI config missing ${name}`;
}

function withPriorFailureContext(error: Error, previousError: string): Error {
  error.message = `${error.message} | primary failure: ${clipText(previousError, 400)}`;
  return error;
}

export async function callBlogAiWithFailover({
  prompt,
  primaryConfig = envAiConfig(),
  fallbackConfig = envFallbackAiConfig(),
  timeoutMs = envDurationMs("AI_TIMEOUT_MS", 120_000),
  maxTokens = DEFAULT_MAX_TOKENS,
  jsonMode = false,
}: {
  prompt: string;
  primaryConfig?: AiConfig;
  fallbackConfig?: AiConfig;
  timeoutMs?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}): Promise<AiCallResult> {
  const primaryConfigError = configErrorMessage(primaryConfig, "primary");
  const fallbackConfigError = configErrorMessage(fallbackConfig, "fallback");
  let primaryError = primaryConfigError;

  if (!primaryConfigError) {
    // Retry the primary target on transient failures (dropped connections under load, 5xx, 429)
    // before falling back — the provider drops a fraction of concurrent connections.
    const attempts = envPositiveInt("AI_PRIMARY_RETRY_ATTEMPTS", 3);
    const baseDelayMs = envPositiveInt("AI_PRIMARY_RETRY_DELAY_MS", 800);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const content = await callBlogAi({ prompt, ...primaryConfig, timeoutMs, maxTokens, jsonMode });
        return { content, config: primaryConfig, usedFallback: false, primaryError: attempt > 1 ? primaryError : undefined };
      } catch (error) {
        primaryError = error instanceof Error ? error.message : String(error);
        if (attempt < attempts && isTransientAiError(primaryError)) {
          await sleep(baseDelayMs * attempt);
          continue;
        }
        break;
      }
    }
  }

  if (fallbackConfigError) {
    throw new Error(primaryError || fallbackConfigError);
  }
  if (sameAiTarget(primaryConfig, fallbackConfig)) {
    throw new Error(primaryError || "primary and fallback AI targets are identical");
  }

  try {
    const content = await callBlogAi({ prompt, ...fallbackConfig, timeoutMs, maxTokens, jsonMode });
    return { content, config: fallbackConfig, usedFallback: true, primaryError: primaryError || primaryConfigError };
  } catch (error) {
    if (error instanceof Error) throw withPriorFailureContext(error, primaryError || primaryConfigError);
    throw new Error(`${String(error)} | primary failure: ${clipText(primaryError || primaryConfigError, 400)}`);
  }
}
