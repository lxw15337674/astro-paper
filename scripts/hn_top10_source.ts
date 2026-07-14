#!/usr/bin/env tsx
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { compact, fetchJson, fetchText, stripHtml, writeStderr, writeStdout } from "./blog_common.ts";

const HN_TOP_STORIES_URL = "https://hacker-news.firebaseio.com/v0/topstories.json";
const hnApiItem = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

type HnItem = {
  id?: number;
  title?: string;
  url?: string;
  descendants?: number;
  score?: number;
  text?: string;
  kids?: number[];
  deleted?: boolean;
  dead?: boolean;
};

export type HnPayloadItem = {
  rank: number;
  id: number;
  title: string;
  url: string;
  hn_link: string;
  topic: string;
  score: number;
  comments: number;
  source_text: string;
  original_excerpt: string;
  hn_comment_excerpt: string;
};

const TOPIC_RULES: [RegExp, string][] = [
  [/ai|openai|llm|model|anthropic|gemini|copilot|opus|glm/i, "AI / 模型"],
  [/javascript|typescript|rust|biome|tooling|compiler|developer|code|deno|codex|inline assembly|lisp/i, "开发工具 / 编程语言"],
  [/bond|market|investor|fca|trading/i, "金融 / 市场"],
  [/photo|camera|image|wigglegram|stereo|gif/i, "图像 / 创意技术"],
  [/school|education|teacher|children|policy|government|id|internet traffic|fraud/i, "政策 / 社会议题"],
  [/spacex|gpu|datacenter|load-balanced|systems|atproto|boston dynamics|robot|compression|printing/i, "基础设施 / 系统"],
];

export function classify(title = ""): string {
  for (const [pattern, label] of TOPIC_RULES) {
    if (pattern.test(title)) return label;
  }
  return "技术 / 观察";
}

export async function fetchTopIds(n = 30): Promise<number[]> {
  const ids = await fetchJson<number[]>(HN_TOP_STORIES_URL, { timeoutMs: 20_000 });
  return ids.slice(0, n);
}

function readableFromHtml(html: string, url: string): string {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document, { keepClasses: false });
  const article = reader.parse();
  const text = article?.textContent ? compact(article.textContent) : "";
  return text.length >= 160 ? text : "";
}

async function githubExcerpt(url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.hostname !== "github.com") return "";
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return "";
  const [owner, repo] = parts;
  if (parts.length >= 4 && ["issues", "pull"].includes(parts[2]) && /^\d+$/.test(parts[3])) {
    try {
      const issue = await fetchJson<{ title?: string; body?: string }>(`https://api.github.com/repos/${owner}/${repo}/issues/${parts[3]}`, {
        timeoutMs: 12_000,
      });
      return compact(`${issue.title || ""}. ${stripHtml(issue.body || "")}`);
    } catch {
      return "";
    }
  }
  for (const branch of ["main", "master"]) {
    try {
      const readme = await fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`, {
        timeoutMs: 10_000,
        maxChars: 500_000,
        throwOnMaxChars: true,
      });
      if (compact(readme).length >= 160) return compact(readme);
    } catch {
      // try next branch
    }
  }
  return "";
}

export async function fetchOriginalExcerpt(url: string): Promise<string> {
  if (!url || !/^https?:\/\//i.test(url) || url.includes("news.ycombinator.com")) return "";
  try {
    const github = await githubExcerpt(url);
    if (github) return github;
  } catch {
    // fall through to generic readability
  }
  try {
    const html = await fetchText(url, { timeoutMs: 14_000, maxChars: 1_200_000, throwOnMaxChars: true });
    return readableFromHtml(html, url);
  } catch {
    return "";
  }
}

async function commentText(id: number): Promise<string> {
  try {
    const item = await fetchJson<HnItem>(hnApiItem(id), { timeoutMs: 10_000 });
    if (!item || item.deleted || item.dead) return "";
    return stripHtml(item.text || "");
  } catch {
    return "";
  }
}

export async function fetchCommentExcerpt(item: HnItem, { topLimit = 8, repliesPerComment = 1 } = {}): Promise<string> {
  const snippets: string[] = [];
  for (const childId of (item.kids || []).slice(0, topLimit)) {
    const top = await commentText(childId);
    if (top.length >= 40) snippets.push(top);
    let child: HnItem | null = null;
    try {
      child = await fetchJson<HnItem>(hnApiItem(childId), { timeoutMs: 10_000 });
    } catch {
      child = null;
    }
    for (const replyId of (child?.kids || []).slice(0, repliesPerComment)) {
      const reply = await commentText(replyId);
      if (reply.length >= 40) snippets.push(reply);
    }
  }
  return compact(snippets.join(" / "));
}

export function buildPayload(item: HnItem, rank: number, { originalExcerpt = "", commentExcerpt = "" } = {}): HnPayloadItem {
  const id = Number(item.id || 0);
  const title = compact(item.title || `Item ${id || rank}`);
  const url = item.url || `https://news.ycombinator.com/item?id=${id}`;
  return {
    rank,
    id,
    title,
    url,
    hn_link: `https://news.ycombinator.com/item?id=${id}`,
    topic: classify(title),
    score: Number(item.score || 0),
    comments: Number(item.descendants || 0),
    source_text: stripHtml(item.text || ""),
    original_excerpt: compact(originalExcerpt),
    hn_comment_excerpt: compact(commentExcerpt),
  };
}

function evidenceCounts(text: string): { original: number; comments: number } {
  let original = 0;
  let comments = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("- 原文正文：") && line.split("：").slice(1).join("：").trim().length >= 120) original += 1;
    if (line.startsWith("- HN 评论样本：") && line.split("：").slice(1).join("：").trim().length >= 60) comments += 1;
  }
  return { original, comments };
}

export async function buildHnSource(): Promise<string> {
  // Phase 1: fetch top 30 metadata in parallel, sort by comment count, keep top 10
  const topIds = await fetchTopIds(30);
  const rawItems = await Promise.all(
    topIds.map(id => fetchJson<HnItem>(hnApiItem(id), { timeoutMs: 12_000 }).catch(() => null))
  );
  const sorted = rawItems
    .filter((item): item is HnItem => item !== null && !item.deleted && !item.dead)
    .sort((a, b) => (b.descendants ?? 0) - (a.descendants ?? 0))
    .slice(0, 10);

  // Phase 2: fetch original excerpts + comments for top 10
  const lines = ["1. 🔥 今日 HackerNews 热门文章 Top 10", ""];
  const items: HnPayloadItem[] = [];
  for (const [index, item] of sorted.entries()) {
    const rank = index + 1;
    const id = Number(item.id || 0);
    const title = compact(item.title || `Item ${id}`);
    const url = item.url || `https://news.ycombinator.com/item?id=${id}`;
    const [originalExcerpt, commentExcerpt] = await Promise.all([fetchOriginalExcerpt(url), fetchCommentExcerpt(item)]);
    const payload = buildPayload(item, rank, { originalExcerpt, commentExcerpt });
    items.push(payload);
    lines.push(
      `${rank}. 🔥 ${title}`,
      `- ⭐ ${payload.score} points · ${payload.comments} 评论`,
      `- 主题：${payload.topic}`,
      `- 原文：${url}`,
      `- HN 讨论：${payload.hn_link}`,
      `- 原文正文：${originalExcerpt || payload.source_text || "未抓取到可读正文；只能依据标题、链接和 HN 讨论保守处理。"}`,
      `- HN 评论样本：${commentExcerpt || "暂无足够长的可读评论样本；评论总结必须保守。"}`,
      "",
    );
  }
  const body = lines.join("\n");
  const counts = evidenceCounts(body);
  if (counts.original < 6) throw new Error(`low-signal HN source output: original=${counts.original}, comments=${counts.comments}`);
  lines.push("===ARCHIVE_PAYLOAD===", JSON.stringify({ items }, null, 2));
  return `${lines.join("\n").trim()}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildHnSource()
    .then(text => writeStdout(text))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      writeStderr(`ERROR: ${message}`);
      process.exit(1);
    });
}
