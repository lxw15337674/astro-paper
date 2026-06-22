import fs from "node:fs";
import path from "node:path";

export const BJT_TIME_ZONE = "Asia/Shanghai";
export const TOTAL_TAG = "定时文章";
export const AUTHOR = "bhwa233";

export function repoRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
}

export function compact(text = ""): string {
  return String(text).replace(/\s+/g, " ").trim();
}

export function stripHtml(text = ""): string {
  return compact(String(text).replace(/<[^>]+>/g, " "));
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function readStdin(): string {
  return fs.readFileSync(0, "utf8");
}

export type CliArgs = Record<string, string | boolean>;

export function parseArgs(argv = process.argv.slice(2)): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

export function stringArg(args: CliArgs, key: string, fallback = ""): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

export function booleanArg(args: CliArgs, key: string): boolean {
  return args[key] === true;
}

export function bjtDateString(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BJT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function bjtArchiveInstant(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid archive date: ${date}`);
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1000);
  return utc.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function bjtTimestamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BJT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} CST`;
}

export function frontmatter({
  title,
  date,
  description,
  tags,
  ogImage = "",
}: {
  title: string;
  date: string;
  description: string;
  tags: string[];
  ogImage?: string;
}): string {
  const lines = [
    "---",
    `author: ${AUTHOR}`,
    `pubDatetime: ${bjtArchiveInstant(date)}`,
    `modDatetime: ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    `title: "${title.replaceAll('"', '\\"')}"`,
    "featured: false",
    "draft: false",
    "tags:",
    ...tags.map(tag => `  - ${tag}`),
  ];
  if (ogImage) lines.push(`ogImage: "${ogImage}"`);
  lines.push(`description: "${description.replaceAll('"', '\\"')}"`, "timezone: Asia/Shanghai", "---", "");
  return `${lines.join("\n")}\n`;
}

export async function fetchText(
  url: string,
  { timeoutMs = 20_000, headers = {}, maxChars = 1_000_000 }: { timeoutMs?: number; headers?: Record<string, string>; maxChars?: number } = {},
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        ...headers,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const text = await response.text();
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T = unknown>(url: string, options = {}): Promise<T> {
  return JSON.parse(await fetchText(url, options)) as T;
}

export function clipText(text = "", limit = 1600): string {
  const cleaned = compact(text);
  if (cleaned.length <= limit) return cleaned;
  const cut = cleaned.slice(0, limit).replace(/\s+\S*$/, "").trim();
  return cut || cleaned.slice(0, limit).trim();
}

export function writeStdout(text: string): void {
  process.stdout.write(text);
}

export function writeStderr(text: string): void {
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}
