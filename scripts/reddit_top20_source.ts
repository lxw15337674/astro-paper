#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import { JSDOM } from "jsdom";
import { bjtDateString, compact, ensureDir, parseArgs, repoRoot, stringArg, writeStderr, writeStdout } from "./blog_common.ts";

export const REDDIT_DATA_DIR = path.join(repoRoot(), "data/reddit-top20");

const OLD_REDDIT = "https://old.reddit.com";
const REDDIT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
const SUBREDDITS = ["AskReddit", "TIFU", "offmychest", "confessions", "explainlikeimfive", "changemyview"];
const POSTS_PER_SUB = 30;
const TOP_N = 20;
const COMMENTS_PER_POST = 5;
const COMMENT_CONCURRENCY = 4;

export type RedditPayloadItem = {
  rank: number;
  subreddit: string;
  title: string;
  score: number;
  numComments: number;
  permalink: string;
};

// Node fetch 自动附加 sec-fetch-* 头会被 Reddit 拦截，用 https.request 绕过。
function httpsGet(url: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          "User-Agent": REDDIT_UA,
          "Accept": "text/html,application/xhtml+xml,*/*",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      res => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpsGet(res.headers.location, timeoutMs).then(resolve, reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`timeout for ${url}`)); });
    req.on("error", reject);
    req.end();
  });
}

type RawPost = { id: string; subreddit: string; title: string; score: number; numComments: number; permalink: string };

function parseListingHtml(html: string): RawPost[] {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const posts: RawPost[] = [];

  for (const thing of doc.querySelectorAll("div.thing.link[data-fullname]")) {
    const fullname = thing.getAttribute("data-fullname") ?? "";
    const id = fullname.replace("t3_", "");
    if (!id) continue;
    if (![...thing.classList].includes("self")) continue; // self post only

    const titleEl = thing.querySelector("a.title");
    const title = titleEl?.textContent?.trim() ?? "";
    if (!title) continue;

    const score = parseInt(thing.getAttribute("data-score") ?? "0", 10);
    const subreddit = thing.getAttribute("data-subreddit") ?? "";
    const permalink = thing.getAttribute("data-permalink") ?? `/r/${subreddit}/comments/${id}/`;
    const commentsEl = thing.querySelector("a.comments");
    const numComments = parseInt((commentsEl?.textContent ?? "0").replace(/[^\d]/g, "") || "0", 10);

    posts.push({ id, subreddit, title, score, numComments, permalink });
  }
  return posts;
}

async function fetchSubreddit(sub: string): Promise<RawPost[]> {
  const html = await httpsGet(`${OLD_REDDIT}/r/${sub}/hot/?limit=${POSTS_PER_SUB}`);
  return parseListingHtml(html);
}

type PostDetail = { selfText: string; comments: string[] };

async function fetchPostDetail(permalink: string): Promise<PostDetail> {
  try {
    const html = await httpsGet(`${OLD_REDDIT}${permalink}?limit=${COMMENTS_PER_POST}&sort=top`, 15_000);
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const selfEl = doc.querySelector(".expando .usertext-body .md, .self .usertext-body .md");
    const selfText = compact(selfEl?.textContent ?? "").slice(0, 800);

    const comments: string[] = [];
    for (const el of doc.querySelectorAll("div.comment[data-fullname] div.usertext-body div.md")) {
      const text = compact(el.textContent ?? "");
      if (text.length >= 20) comments.push(text.slice(0, 400));
      if (comments.length >= COMMENTS_PER_POST) break;
    }
    return { selfText, comments };
  } catch {
    return { selfText: "", comments: [] };
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function evidenceCounts(text: string): { withComments: number; withText: number } {
  let withComments = 0;
  let withText = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("- 热门评论：") && line.length > 20) withComments++;
    if (line.startsWith("- 正文：") && line.length > 10) withText++;
  }
  return { withComments, withText };
}

export async function buildRedditTop20Source(): Promise<string> {
  writeStderr("Reddit top20: fetching listings from 6 subreddits...");
  const listResults = await Promise.all(SUBREDDITS.map(sub =>
    fetchSubreddit(sub).catch(e => { writeStderr(`WARN: r/${sub} fetch failed: ${e}`); return [] as RawPost[]; }),
  ));

  const all = listResults.flat().sort((a, b) => b.score - a.score).slice(0, TOP_N);
  if (all.length === 0) throw new Error("Reddit top20: no posts fetched from any subreddit");

  writeStderr(`Reddit top20: top ${all.length} posts selected, fetching details...`);
  const details = await mapWithConcurrency(all, COMMENT_CONCURRENCY, post => fetchPostDetail(post.permalink));

  const lines = ["1. 🔴 今日 Reddit 热门帖子 Top 20", ""];
  const payloadItems: RedditPayloadItem[] = [];

  for (const [i, post] of all.entries()) {
    const rank = i + 1;
    const detail = details[i];
    const url = `https://www.reddit.com${post.permalink}`;
    const commentSnippet = detail.comments.slice(0, 3).join(" / ");

    lines.push(
      `${rank}. [r/${post.subreddit}] ${post.title}`,
      `- ⭐ ${post.score} points · ${post.numComments} 评论`,
      `- 来源：r/${post.subreddit}`,
      `- 帖子链接：${url}`,
      `- 正文：${detail.selfText || "（无正文）"}`,
      `- 热门评论：${commentSnippet || "（暂无评论）"}`,
      "",
    );

    payloadItems.push({ rank, subreddit: post.subreddit, title: post.title, score: post.score, numComments: post.numComments, permalink: post.permalink });
  }

  const body = lines.join("\n");
  const counts = evidenceCounts(body);
  if (counts.withComments < 10) throw new Error(`Reddit top20 low-signal source: only ${counts.withComments} posts have comments`);

  return `${body.trim()}\n\n===ARCHIVE_PAYLOAD===\n${JSON.stringify({ items: payloadItems }, null, 2)}\n`;
}

// 读取预先抓取的 source 文件（CI 模式，不做 live fetch）
export function readRedditSource(date: string, dataDir = REDDIT_DATA_DIR): string {
  const file = path.join(dataDir, `${date}.md`);
  if (!fs.existsSync(file)) throw new Error(`Reddit top20 source file not found for ${date}: ${file}`);
  return fs.readFileSync(file, "utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  const date = stringArg(args, "date", bjtDateString());
  const save = args.save === true;
  const dataDir = stringArg(args, "data-dir", REDDIT_DATA_DIR);

  buildRedditTop20Source()
    .then(text => {
      if (save) {
        ensureDir(dataDir);
        const file = path.join(dataDir, `${date}.md`);
        fs.writeFileSync(file, text, "utf8");
        writeStderr(`Saved to ${file}`);
      } else {
        writeStdout(text);
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      writeStderr(`ERROR: ${message}`);
      process.exit(1);
    });
}
