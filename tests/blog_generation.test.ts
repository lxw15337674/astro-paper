import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";

import { archivePost } from "../scripts/astro_paper_archive.ts";
import { chatCompletionsUrl, renderPrompt, resolvePromptFile } from "../scripts/ai_blog_writer.ts";
import { DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, callBlogAi, callBlogAiWithFailover, isTransientAiError, parseResponsesSse, responsesUrl } from "../scripts/blog_ai_client.ts";
import { buildPayload, classify } from "../scripts/hn_top10_source.ts";
import { composeHnBody, hnMarkdownFromModelJson, parseHnModelJson, parseSourceFacts } from "../scripts/hn_compose.ts";
import { githubTrendingMarkdownFromModelJson, parseGitHubTrendingFacts } from "../scripts/github_trending_compose.ts";
import { mdblistMarkdownFromModelJson } from "../scripts/mdblist_compose.ts";
import { appendMdblistRecommendations, loadMdblistRecommendationKeys, parseMdblistRecommendationsFromSource } from "../scripts/mdblist_weekly_ledger.ts";
import { buildMdblistWeeklySource, latestStartedSeasonNumber, selectUnrecommendedMdblistCandidates } from "../scripts/mdblist_weekly_source.ts";
import { dailyDigestMarkdownFromModelJson } from "../scripts/daily_digest_compose.ts";
import { FEEDS, buildForeignTechPodcastSource } from "../scripts/foreign_tech_podcast_source.ts";
import { bjtArchiveInstant, fetchText } from "../scripts/blog_common.ts";
import { normalizePodcastUrl } from "../scripts/foreign_tech_podcast_dedupe.ts";
import { appendSummarizedEpisode, isEpisodeSummarized, loadSummarizedFingerprints } from "../scripts/podcast_ledger.ts";
import { dedupeItems, eventFamilyKey } from "../scripts/daily_digest_source.ts";
import { CAPITAL_MARKET_SOURCE_SEP, articleConflictsWithIndexSnapshot, buildUsSection } from "../scripts/market_daily_source.ts";
import { composeFullCapitalMarket } from "../scripts/market_compose.ts";
import { economistWeeklyMarkdown, parseEconomistArticleSummaries } from "../scripts/economist_weekly_compose.ts";
import { parseEconomistEpub } from "../scripts/economist_weekly_source.ts";
import { magazineConfig, parseMagazineEpub } from "../scripts/magazine.ts";
import { buildGitHubTrendingDailySource, parseGitHubTrendingHtml, sanitizeReadmeText } from "../scripts/github_trending_daily_source.ts";
import { buildXyzRankTopEpisodesSource } from "../scripts/xyzrank_top_episodes_source.ts";
import { verifyResultJson } from "../scripts/verify_blog_generation.ts";
import {
  type ResultItem,
  contentDateForTask,
  parseMagazineItemSummary,
  settleDailyPodcastArticleResults,
  usesJsonComposer,
} from "../scripts/generate_scheduled_post.ts";

// prompts 已按 daily/weekly/market/podcast 分类到子目录，用解析器按名查找（根目录 + 一层子目录）。
const PROMPTS_DIR = path.join(process.cwd(), "prompts/blog");
const promptPath = (name: string): string => resolvePromptFile(PROMPTS_DIR, name);

const GITHUB_TRENDING_HTML_FIXTURE = `<!doctype html><html><body>
  <article class="Box-row">
    <h2><a href="/acme/agent-lab"> acme / agent-lab </a></h2>
    <p>Local AI agent workbench for developers</p>
    <span itemprop="programmingLanguage">TypeScript</span>
    <a href="/acme/agent-lab/stargazers">12,345</a>
    <a href="/acme/agent-lab/forks">678</a>
    <span class="d-inline-block float-sm-right">321 stars today</span>
  </article>
</body></html>`;

function economistEpubFixture(articleCount: number): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    "META-INF/container.xml",
    Buffer.from(`<?xml version="1.0"?><container><rootfiles><rootfile full-path="EPUB/content.opf"/></rootfiles></container>`),
  );
  const manifest = Array.from({ length: articleCount }, (_, index) => `<item id="article-${index + 1}" href="article-${index + 1}.xhtml" media-type="application/xhtml+xml"/>`).join("");
  const spine = Array.from({ length: articleCount }, (_, index) => `<itemref idref="article-${index + 1}"/>`).join("");
  zip.addFile(
    "EPUB/content.opf",
    Buffer.from(`<?xml version="1.0"?><package><metadata><title>The Economist fixture</title></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`),
  );
  for (let index = 1; index <= articleCount; index += 1) {
    const longBody = `${`Article ${index} presents complete evidence without an artificial per-article length limit. `.repeat(180)}ARTICLE_${index}_TAIL_SENTINEL`;
    zip.addFile(
      `EPUB/article-${index}.xhtml`,
      Buffer.from(`<html><body><div class="te_section_title">Leaders</div><h1>Repeated title</h1><a class="origin_link" href="https://www.economist.com/fixture/${index}">Original</a><p>${longBody}</p></body></html>`),
    );
  }
  return zip.toBuffer();
}

// Synthetic New Yorker EPUB: `.article` bodies + a non-article page + a too-short piece to exercise filtering.
function newYorkerEpubFixture(articleCount: number): Buffer {
  const zip = new AdmZip();
  zip.addFile("META-INF/container.xml", Buffer.from(`<?xml version="1.0"?><container><rootfiles><rootfile full-path="EPUB/content.opf"/></rootfiles></container>`));
  const ids = [
    ...Array.from({ length: articleCount }, (_, index) => `article-${index + 1}`),
    "toc-page", // no .article -> dropped
    "short-poem", // has .article but below minArticleChars -> dropped
  ];
  const manifest = ids.map(id => `<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`).join("");
  const spine = ids.map(id => `<itemref idref="${id}"/>`).join("");
  zip.addFile("EPUB/content.opf", Buffer.from(`<?xml version="1.0"?><package><metadata><title>The New Yorker fixture</title></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`));
  for (let index = 1; index <= articleCount; index += 1) {
    const body = `${`New Yorker article ${index} carries a full reported narrative with plenty of substance. `.repeat(60)}NY_${index}_TAIL`;
    zip.addFile(
      `EPUB/article-${index}.xhtml`,
      Buffer.from(
        `<html><body><span class="ny_article_category">A Reporter at Large</span><h1 class="ny_article_h1_title">Story ${index}</h1><span class="ny_article_author">By Someone</span><div class="article"><p><a href="https://www.newyorker.com/news/story-${index}">source</a></p><p>${body}</p></div></body></html>`,
      ),
    );
  }
  zip.addFile("EPUB/toc-page.xhtml", Buffer.from(`<html><body><ul class="sec_toc_item"><li>Contents</li></ul></body></html>`));
  zip.addFile("EPUB/short-poem.xhtml", Buffer.from(`<html><body><span class="ny_article_category">Poems</span><div class="article"><p>A brief verse, too short to summarize.</p></div></body></html>`));
  return zip.toBuffer();
}

// Synthetic calibre EPUB (The Atlantic / Wired shape): one body per file with hashed classes,
// a navbar to strip, plus a feed/TOC page that falls below minArticleChars.
function calibreEpubFixture(articleCount: number): Buffer {
  const zip = new AdmZip();
  zip.addFile("META-INF/container.xml", Buffer.from(`<?xml version="1.0"?><container><rootfiles><rootfile full-path="EPUB/content.opf"/></rootfiles></container>`));
  const ids = [...Array.from({ length: articleCount }, (_, index) => `body-${index + 1}`), "feed-index"];
  const manifest = ids.map(id => `<item id="${id}" href="${id}.html" media-type="application/xhtml+xml"/>`).join("");
  const spine = ids.map(id => `<itemref idref="${id}"/>`).join("");
  zip.addFile("EPUB/content.opf", Buffer.from(`<?xml version="1.0"?><package><metadata><title>The Atlantic fixture</title></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`));
  for (let index = 1; index <= articleCount; index += 1) {
    const body = `${`Calibre body ${index} carries a complete reported feature with ample substance to summarize. `.repeat(50)}CAL_${index}_TAIL`;
    zip.addFile(
      `EPUB/body-${index}.html`,
      Buffer.from(`<html><body><div class="calibre_navbar"><a href="#">| Next |</a></div><h2 class="calibre6">Feature ${index}</h2><p class="article_date">June 2026</p><p class="calibre3">${body}</p></body></html>`),
    );
  }
  // Feed/TOC page: empty .article markers, no prose -> dropped by minArticleChars.
  zip.addFile("EPUB/feed-index.html", Buffer.from(`<html><body><h2 class="calibre_feed_title">Features</h2><div class="article"></div><div class="article"></div></body></html>`));
  return zip.toBuffer();
}

// 从 JSON 模型输出 fixture + source fixture 经 composer 组装出 archive 中间契约 Markdown。
function composeFixtureBody(task: string): string {
  const source = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-sources", `${task}.md`), "utf8");
  const raw = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses", `${task}.json`), "utf8");
  if (task === "github-trending-daily") return githubTrendingMarkdownFromModelJson(raw, source);
  if (task === "mdblist-weekly") return mdblistMarkdownFromModelJson(raw, source);
  if (task === "economist-weekly") return economistWeeklyMarkdown(source).markdown;
  return dailyDigestMarkdownFromModelJson(raw, source);
}

test("BJT archive dates use UTC instants for Beijing midnight", () => {
  assert.equal(bjtArchiveInstant("2026-06-22"), "2026-06-21T16:00:00Z");
  assert.equal(bjtArchiveInstant("2099-01-02"), "2099-01-01T16:00:00Z");
});

test("AI writer renders prompts and normalizes chat completions URLs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-"));
  fs.writeFileSync(path.join(dir, "hn-top10.md"), "task={task}\ndate={date}\nsource={source_text}");
  const prompt = renderPrompt({ task: "hn-top10", date: "2099-01-02", sourceText: "hello", promptDir: dir });
  assert.equal(prompt, "task=hn-top10\ndate=2099-01-02\nsource=hello");
  fs.writeFileSync(path.join(dir, "_common-article-rules.md"), "common rules");
  const promptWithCommon = renderPrompt({ task: "hn-top10", date: "2099-01-02", sourceText: "hello", promptDir: dir });
  assert.equal(promptWithCommon, "common rules\n\ntask=hn-top10\ndate=2099-01-02\nsource=hello");
  assert.equal(chatCompletionsUrl("https://api.example.com/v1"), "https://api.example.com/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://api.example.com/v1/chat/completions"), "https://api.example.com/v1/chat/completions");
  assert.equal(DEFAULT_AI_BASE_URL, "https://www.right.codes/codex/v1");
  assert.equal(DEFAULT_AI_MODEL, "gpt-5.6-luna");
});

test("blog source evidence keeps long text sentinels instead of truncating", () => {
  const originalTail = `Original evidence ${"x".repeat(2300)} ORIGINAL_TAIL_SENTINEL`;
  const commentTail = `Comment evidence ${"y".repeat(1900)} COMMENT_TAIL_SENTINEL`;
  const payload = buildPayload(
    {
      id: 123,
      title: "Developers don't understand CORS",
      url: "https://example.com/cors",
      descendants: 88,
      score: 185,
      text: "fallback self text",
    },
    1,
    { originalExcerpt: originalTail, commentExcerpt: commentTail },
  );
  assert.match(payload.original_excerpt, /ORIGINAL_TAIL_SENTINEL/);
  assert.match(payload.hn_comment_excerpt, /COMMENT_TAIL_SENTINEL/);

  const readme = sanitizeReadmeText(`# Heading\n\n${"readme ".repeat(400)} README_TAIL_SENTINEL`);
  assert.match(readme, /README TAIL SENTINEL/);
});

test("GitHub Trending README sanitizer removes template delimiters from evidence", () => {
  const readme = sanitizeReadmeText("Run docker inspect trek --format '{{json .Mounts}}' before updating.");
  assert.match(readme, /json \.Mounts/);
  assert.doesNotMatch(readme, /\{\{[^}]+\}\}/);
});

test("AI client surfaces aborts as timeout errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const error = new Error("This operation was aborted");
    error.name = "AbortError";
    throw error;
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => callBlogAi({ prompt: "hello", apiKey: "test", baseUrl: "https://api.example.com/v1", model: "demo", timeoutMs: 25 }),
      /AI request timed out after 25ms/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchText surfaces aborts as source-specific timeout errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const error = new Error("This operation was aborted");
    error.name = "AbortError";
    throw error;
  }) as typeof fetch;
  try {
    await assert.rejects(() => fetchText("https://example.com/feed.xml", { timeoutMs: 25 }), /request timed out after 25ms for https:\/\/example\.com\/feed\.xml/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AI client fails over to deepseek when primary request fails", async () => {
  const originalFetch = globalThis.fetch;
  const previousAttempts = process.env.AI_PRIMARY_RETRY_ATTEMPTS;
  const previousFallback = process.env.AI_FALLBACK_ENABLED;
  process.env.AI_PRIMARY_RETRY_ATTEMPTS = "1"; // isolate failover from the transient-retry path
  process.env.AI_FALLBACK_ENABLED = "true";
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    calls.push(String(input));
    const body = JSON.parse(String(init?.body || "{}")) as { model?: string };
    if (body.model === "primary-model") {
      return new Response(JSON.stringify({ error: { message: "upstream overloaded" } }), { status: 503 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "## 标题\n\n" + "有效正文".repeat(80) } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await callBlogAiWithFailover({
      prompt: "hello",
      primaryConfig: { apiKey: "primary-key", baseUrl: "https://primary.example.com/v1", model: "primary-model" },
      fallbackConfig: { apiKey: "fallback-key", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" },
      timeoutMs: 25,
    });
    assert.equal(result.usedFallback, true);
    assert.equal(result.config.model, "deepseek-v4-flash");
    assert.equal(result.config.baseUrl, "https://api.deepseek.com");
    assert.match(result.content, /^## 标题/);
    assert.deepEqual(calls, [
      "https://primary.example.com/v1/chat/completions",
      "https://api.deepseek.com/chat/completions",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousAttempts === undefined) delete process.env.AI_PRIMARY_RETRY_ATTEMPTS;
    else process.env.AI_PRIMARY_RETRY_ATTEMPTS = previousAttempts;
    if (previousFallback === undefined) delete process.env.AI_FALLBACK_ENABLED;
    else process.env.AI_FALLBACK_ENABLED = previousFallback;
  }
});

test("AI client throws (no fallback) when fallback is disabled and primary fails", async () => {
  const originalFetch = globalThis.fetch;
  const previousAttempts = process.env.AI_PRIMARY_RETRY_ATTEMPTS;
  const previousFallback = process.env.AI_FALLBACK_ENABLED;
  process.env.AI_PRIMARY_RETRY_ATTEMPTS = "1";
  delete process.env.AI_FALLBACK_ENABLED; // default: disabled
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ error: { message: "upstream overloaded" } }), { status: 503 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        callBlogAiWithFailover({
          prompt: "hello",
          primaryConfig: { apiKey: "primary-key", baseUrl: "https://primary.example.com/v1", model: "primary-model", apiStyle: "chat" },
          fallbackConfig: { apiKey: "fallback-key", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", apiStyle: "chat" },
        }),
      /AI provider HTTP 503/,
    );
    assert.deepEqual(calls, ["https://primary.example.com/v1/chat/completions"]); // fallback never called
  } finally {
    globalThis.fetch = originalFetch;
    if (previousAttempts === undefined) delete process.env.AI_PRIMARY_RETRY_ATTEMPTS;
    else process.env.AI_PRIMARY_RETRY_ATTEMPTS = previousAttempts;
    if (previousFallback === undefined) delete process.env.AI_FALLBACK_ENABLED;
    else process.env.AI_FALLBACK_ENABLED = previousFallback;
  }
});

test("isTransientAiError classifies dropped connections, timeouts and 5xx/429 as retryable", () => {
  assert.equal(isTransientAiError("AI request failed: fetch failed"), true);
  assert.equal(isTransientAiError("AI request timed out after 600000ms"), true);
  assert.equal(isTransientAiError("AI provider HTTP 503: overloaded"), true);
  assert.equal(isTransientAiError("AI provider HTTP 429: slow down"), true);
  assert.equal(isTransientAiError("AI provider HTTP 400: bad request"), false);
  assert.equal(isTransientAiError("AI response missing message content: {}"), false);
});

test("AI client retries the primary on a transient drop before using fallback", async () => {
  const originalFetch = globalThis.fetch;
  const previousDelay = process.env.AI_PRIMARY_RETRY_DELAY_MS;
  process.env.AI_PRIMARY_RETRY_DELAY_MS = "1";
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    if (calls.length === 1) throw new TypeError("fetch failed"); // dropped connection
    return new Response(JSON.stringify({ choices: [{ message: { content: "## 标题\n\n" + "有效正文".repeat(80) } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await callBlogAiWithFailover({
      prompt: "hello",
      primaryConfig: { apiKey: "primary-key", baseUrl: "https://primary.example.com/v1", model: "primary-model", apiStyle: "chat" },
      fallbackConfig: { apiKey: "fallback-key", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", apiStyle: "chat" },
    });
    assert.equal(result.usedFallback, false);
    assert.equal(result.config.model, "primary-model");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls, ["https://primary.example.com/v1/chat/completions", "https://primary.example.com/v1/chat/completions"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousDelay === undefined) delete process.env.AI_PRIMARY_RETRY_DELAY_MS;
    else process.env.AI_PRIMARY_RETRY_DELAY_MS = previousDelay;
  }
});

test("responsesUrl appends the /responses path once", () => {
  assert.equal(responsesUrl("https://www.right.codes/codex/v1"), "https://www.right.codes/codex/v1/responses");
  assert.equal(responsesUrl("https://www.right.codes/codex/v1/responses"), "https://www.right.codes/codex/v1/responses");
  assert.equal(responsesUrl("https://www.right.codes/codex/v1/"), "https://www.right.codes/codex/v1/responses");
});

test("parseResponsesSse prefers the completed text and falls back to deltas", () => {
  const sse = [
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "他" })}`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "好" })}`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { output: [{ content: [{ type: "output_text", text: "他好世界" }] }] } })}`,
    "data: [DONE]",
  ].join("\n\n");
  assert.equal(parseResponsesSse(sse), "他好世界");

  const deltaOnly = [
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "A" })}`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "B" })}`,
  ].join("\n\n");
  assert.equal(parseResponsesSse(deltaOnly), "AB");
});

test("parseResponsesSse throws on a failed response event", () => {
  const sse = `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { error: { message: "quota exceeded" } } })}`;
  assert.throws(() => parseResponsesSse(sse), /AI responses API error: quota exceeded/);
});

test("callBlogAi posts to /responses and decodes the SSE stream when apiStyle is responses", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body || "{}")) });
    const sse = [
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "## 标题\n\n正文" })}`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { output: [{ content: [{ type: "output_text", text: "## 标题\n\n正文" }] }] } })}`,
    ].join("\n\n");
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const content = await callBlogAi({
      prompt: "hello",
      apiKey: "key",
      baseUrl: "https://www.right.codes/codex/v1",
      model: "gpt-5.6-luna",
      apiStyle: "responses",
      jsonMode: true,
    });
    assert.equal(content, "## 标题\n\n正文");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://www.right.codes/codex/v1/responses");
    assert.deepEqual(calls[0].body.input, [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]);
    assert.deepEqual(calls[0].body.text, { format: { type: "json_object" } });
    assert.equal("messages" in calls[0].body, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Yahoo Finance article evidence is rejected when index moves conflict with closing data", () => {
  const conflicting = "The S&P 500 Index today is down -1.26%, the Dow Jones Industrial Average is down -0.30%, and the Nasdaq 100 Index is down -2.69%.";
  assert.equal(articleConflictsWithIndexSnapshot(conflicting, { dji: 0.35, nasdaq: -0.43, spx: -0.1 }), true);

  const compatible = "The S&P 500 Index closed down -0.10%, the Dow Jones Industrial Average gained +0.35%, and the Nasdaq 100 Index slipped -0.43%.";
  assert.equal(articleConflictsWithIndexSnapshot(compatible, { dji: 0.35, nasdaq: -0.43, spx: -0.1 }), false);
});



test("daily digest source dedupes post-quantum executive order coverage", () => {
  const ars = {
    title: "White House drastically shortens deadline for dropping quantum-vulnerable crypto",
    url: "https://example.com/ars-post-quantum",
    source: "Ars Technica",
    category: "business" as const,
    publishedAt: "2099-01-06T00:00:00Z",
    summary: "Executive order bumps up deadline to move off quantum-vulnerable cryptography.",
  };
  const cloudflare = {
    title: "The post-quantum EO is an important milestone. Now it’s time to get to work",
    url: "https://example.com/cloudflare-post-quantum",
    source: "Cloudflare Blog",
    category: "infra" as const,
    publishedAt: "2099-01-06T00:10:00Z",
    summary: "Cloudflare responds to the post-quantum executive order and migration deadline.",
  };

  assert.equal(eventFamilyKey(ars), "post-quantum-executive-order");
  assert.equal(eventFamilyKey(cloudflare), "post-quantum-executive-order");
  assert.equal(dedupeItems([ars, cloudflare]).length, 1);
});


test("foreign tech podcast source includes technical interview feeds", () => {
  const feeds = new Map(FEEDS.map(feed => [feed.show, feed.url]));
  assert.equal(feeds.get("Software Engineering Daily"), "https://softwareengineeringdaily.com/feed/podcast/");
  assert.equal(feeds.get("Software Engineering Radio"), "https://rss.libsyn.com/shows/21070/destinations/23379.xml");
  assert.equal(feeds.get("Oxide and Friends"), "https://feeds.transistor.fm/oxide-and-friends");
  assert.equal(feeds.get("The InfoQ Podcast"), "https://feeds.soundcloud.com/users/soundcloud:users:215740450/sounds.rss");
  assert.equal(feeds.get("Changelog Interviews"), "https://changelog.com/podcast/feed");
  assert.equal(feeds.get("The Data Engineering Show"), "https://feeds.fame.so/the-data-engineering-show");
  assert.equal(feeds.get("The Cognitive Revolution"), "https://feeds.megaphone.fm/RINTP3108857801");
  assert.equal(feeds.has("Dwarkesh Podcast"), false);
  assert.equal(feeds.has("Training Data"), false);
  assert.equal(feeds.has("Gradient Dissent"), false);
});

function writeTestPodcastEpisodesFile(file: string, episodes: unknown[]): void {
  fs.writeFileSync(file, JSON.stringify({ episodes }, null, 2));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function podcastResult(overrides: Partial<ResultItem>): ResultItem {
  return {
    task: "daily-podcasts",
    path: "",
    title: "每日播客笔记｜2099-01-02",
    created: false,
    skipped: false,
    updated_at_bjt: "",
    commit: "",
    push: "",
    tags: ["播客", "定时文章"],
    ...overrides,
  };
}

test("daily podcasts skip single episode failures when enough articles succeed", () => {
  const results = settleDailyPodcastArticleResults(
    [
      podcastResult({ path: "src/content/posts/zh-cn/每日播客-2099-01-02-01-good.md", created: true }),
      podcastResult({
        path: "src/content/posts/zh-cn/每日播客-2099-01-02-02-blocked.md",
        failed: true,
        error: "audio download HTTP 403",
      }),
    ],
    "2099-01-02",
    1,
  );

  assert.equal(results.some(result => result.failed), false);
  assert.equal(results[1].skipped, true);
  assert.equal(results[1].path, "");
  assert.match(results[1].skip_reason || "", /audio download HTTP 403/);
  assert.match(results[1].skip_reason || "", /每日播客-2099-01-02-02-blocked\.md/);
});

test("daily podcasts fail only when successful articles fall below the minimum", () => {
  const results = settleDailyPodcastArticleResults(
    [
      podcastResult({
        path: "src/content/posts/zh-cn/每日播客-2099-01-02-01-blocked.md",
        failed: true,
        error: "audio download HTTP 403",
      }),
    ],
    "2099-01-02",
    1,
  );

  assert.equal(results[0].skipped, true);
  const failures = results.filter(result => result.failed);
  assert.equal(failures.length, 1);
  assert.match(failures[0].error || "", /found only 0 usable episodes; need 1/);
});

test("foreign tech podcast source trims oversized transcripts for prompt stability", async () => {
  const curatedFile = path.join(os.tmpdir(), `astro-paper-curated-trim-${Date.now()}-${Math.random()}.json`);
  const previousDisableRss = process.env.PODCAST_DISABLE_RSS;
  const previousMinEpisodes = process.env.PODCAST_MIN_EPISODES;
  const previousMaxEpisodes = process.env.PODCAST_MAX_EPISODES;
  const previousAudioTranscribe = process.env.PODCAST_AUDIO_TRANSCRIBE;
  const previousCuratedFile = process.env.PODCAST_TEST_EPISODES_FILE;
  const previousMinTranscriptChars = process.env.PODCAST_MIN_TRANSCRIPT_CHARS;
  const previousPromptTranscriptChars = process.env.PODCAST_PROMPT_TRANSCRIPT_CHARS;
  const transcript = `HEAD_SENTINEL ${"engineering signal ".repeat(2200)} TAIL_SENTINEL`;
  writeTestPodcastEpisodesFile(curatedFile, [
    {
      archiveDate: "2026-06-23",
      title: "Operating AI Platforms Under Load",
      show: "Latent Space",
      source: "Curated Transcript",
      guest: "Platform Lead",
      date: "2026-06-23",
      link: "https://example.com/podcast/platform-load",
      description: "Curated episode with a very long transcript.",
      transcript,
    },
  ]);
  process.env.PODCAST_DISABLE_RSS = "true";
  process.env.PODCAST_MIN_EPISODES = "1";
  process.env.PODCAST_MAX_EPISODES = "1";
  process.env.PODCAST_AUDIO_TRANSCRIBE = "false";
  process.env.PODCAST_TEST_EPISODES_FILE = curatedFile;
  process.env.PODCAST_MIN_TRANSCRIPT_CHARS = "120";
  process.env.PODCAST_PROMPT_TRANSCRIPT_CHARS = "4000";
  try {
    const source = await buildForeignTechPodcastSource("2026-06-23");
    assert.match(source, /HEAD_SENTINEL/);
    assert.match(source, /TAIL_SENTINEL/);
    assert.match(source, /\[transcript clipped for prompt\]/);
    assert.ok(source.length < transcript.length);
  } finally {
    restoreEnv("PODCAST_DISABLE_RSS", previousDisableRss);
    restoreEnv("PODCAST_MIN_EPISODES", previousMinEpisodes);
    restoreEnv("PODCAST_MAX_EPISODES", previousMaxEpisodes);
    restoreEnv("PODCAST_AUDIO_TRANSCRIBE", previousAudioTranscribe);
    restoreEnv("PODCAST_TEST_EPISODES_FILE", previousCuratedFile);
    restoreEnv("PODCAST_MIN_TRANSCRIPT_CHARS", previousMinTranscriptChars);
    restoreEnv("PODCAST_PROMPT_TRANSCRIPT_CHARS", previousPromptTranscriptChars);
    fs.rmSync(curatedFile, { force: true });
  }
});

test("foreign tech podcast skips a failed episode when enough transcript evidence remains", async () => {
  const curatedFile = path.join(os.tmpdir(), `astro-paper-curated-audio-fail-${Date.now()}-${Math.random()}.json`);
  const previousDisableRss = process.env.PODCAST_DISABLE_RSS;
  const previousMinEpisodes = process.env.PODCAST_MIN_EPISODES;
  const previousMaxEpisodes = process.env.PODCAST_MAX_EPISODES;
  const previousAudioTranscribe = process.env.PODCAST_AUDIO_TRANSCRIBE;
  const previousCuratedFile = process.env.PODCAST_TEST_EPISODES_FILE;
  const previousMinTranscriptChars = process.env.PODCAST_MIN_TRANSCRIPT_CHARS;
  const originalFetch = globalThis.fetch;
  writeTestPodcastEpisodesFile(curatedFile, [
    {
      archiveDate: "2026-06-23",
      title: "Reliable Agent Review Loops",
      show: "Curated Show",
      source: "Curated Transcript",
      date: "2026-06-23",
      link: "https://example.com/podcast/review-loops",
      description: "Curated episode with transcript.",
      transcript: "This transcript discusses AI engineering review gates, rollback paths, observability, release safety, ownership queues, security boundaries, and production incident response in enough detail to support a useful technical podcast note.",
    },
    {
      archiveDate: "2026-06-23",
      title: "Blocked Audio Episode",
      show: "Blocked Show",
      source: "Blocked Feed",
      date: "2026-06-23",
      link: "https://example.com/podcast/blocked",
      audioUrl: "https://example.com/audio/blocked.mp3",
      description: "Episode with inaccessible audio.",
    },
  ]);
  process.env.PODCAST_DISABLE_RSS = "true";
  process.env.PODCAST_MIN_EPISODES = "1";
  process.env.PODCAST_MAX_EPISODES = "2";
  process.env.PODCAST_AUDIO_TRANSCRIBE = "true";
  process.env.PODCAST_TEST_EPISODES_FILE = curatedFile;
  process.env.PODCAST_MIN_TRANSCRIPT_CHARS = "120";
  globalThis.fetch = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
  try {
    const source = await buildForeignTechPodcastSource("2026-06-23");
    assert.match(source, /Reliable Agent Review Loops/);
    assert.doesNotMatch(source, /Blocked Audio Episode/);
  } finally {
    restoreEnv("PODCAST_DISABLE_RSS", previousDisableRss);
    restoreEnv("PODCAST_MIN_EPISODES", previousMinEpisodes);
    restoreEnv("PODCAST_MAX_EPISODES", previousMaxEpisodes);
    restoreEnv("PODCAST_AUDIO_TRANSCRIBE", previousAudioTranscribe);
    restoreEnv("PODCAST_TEST_EPISODES_FILE", previousCuratedFile);
    restoreEnv("PODCAST_MIN_TRANSCRIPT_CHARS", previousMinTranscriptChars);
    globalThis.fetch = originalFetch;
    fs.rmSync(curatedFile, { force: true });
  }
});

test("foreign tech podcast skips audio downloads that exceed the per-episode timeout", async () => {
  const curatedFile = path.join(os.tmpdir(), `astro-paper-curated-audio-timeout-${Date.now()}-${Math.random()}.json`);
  const previousDisableRss = process.env.PODCAST_DISABLE_RSS;
  const previousMinEpisodes = process.env.PODCAST_MIN_EPISODES;
  const previousMaxEpisodes = process.env.PODCAST_MAX_EPISODES;
  const previousAudioTranscribe = process.env.PODCAST_AUDIO_TRANSCRIBE;
  const previousCuratedFile = process.env.PODCAST_TEST_EPISODES_FILE;
  const previousMinTranscriptChars = process.env.PODCAST_MIN_TRANSCRIPT_CHARS;
  const previousDownloadTimeout = process.env.PODCAST_AUDIO_DOWNLOAD_TIMEOUT_MS;
  const originalFetch = globalThis.fetch;
  writeTestPodcastEpisodesFile(curatedFile, [
    {
      archiveDate: "2026-06-23",
      title: "Reliable Agent Review Loops",
      show: "Curated Show",
      source: "Curated Transcript",
      date: "2026-06-23",
      link: "https://example.com/podcast/review-loops",
      description: "Curated episode with transcript.",
      transcript: "This transcript discusses AI engineering review gates, rollback paths, observability, release safety, ownership queues, security boundaries, and production incident response in enough detail to support a useful technical podcast note.",
    },
    {
      archiveDate: "2026-06-23",
      title: "Never Ending Audio Episode",
      show: "Slow Show",
      source: "Slow Feed",
      date: "2026-06-23",
      link: "https://example.com/podcast/slow",
      audioUrl: "https://example.com/audio/slow.mp3",
      description: "Episode with a hanging audio download.",
    },
  ]);
  process.env.PODCAST_DISABLE_RSS = "true";
  process.env.PODCAST_MIN_EPISODES = "1";
  process.env.PODCAST_MAX_EPISODES = "2";
  process.env.PODCAST_AUDIO_TRANSCRIBE = "true";
  process.env.PODCAST_TEST_EPISODES_FILE = curatedFile;
  process.env.PODCAST_MIN_TRANSCRIPT_CHARS = "120";
  process.env.PODCAST_AUDIO_DOWNLOAD_TIMEOUT_MS = "10";
  globalThis.fetch = (async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("audio download missing abort signal"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true },
      );
    })) as typeof fetch;
  try {
    const source = await buildForeignTechPodcastSource("2026-06-23");
    assert.match(source, /Reliable Agent Review Loops/);
    assert.doesNotMatch(source, /Never Ending Audio Episode/);
  } finally {
    restoreEnv("PODCAST_DISABLE_RSS", previousDisableRss);
    restoreEnv("PODCAST_MIN_EPISODES", previousMinEpisodes);
    restoreEnv("PODCAST_MAX_EPISODES", previousMaxEpisodes);
    restoreEnv("PODCAST_AUDIO_TRANSCRIBE", previousAudioTranscribe);
    restoreEnv("PODCAST_TEST_EPISODES_FILE", previousCuratedFile);
    restoreEnv("PODCAST_MIN_TRANSCRIPT_CHARS", previousMinTranscriptChars);
    restoreEnv("PODCAST_AUDIO_DOWNLOAD_TIMEOUT_MS", previousDownloadTimeout);
    globalThis.fetch = originalFetch;
    fs.rmSync(curatedFile, { force: true });
  }
});

test("foreign tech podcast source rejects metadata-only episodes without transcripts", async () => {
  const curatedFile = path.join(os.tmpdir(), `astro-paper-podcast-metadata-${Date.now()}-${Math.random()}.json`);
  const previousDisableRss = process.env.PODCAST_DISABLE_RSS;
  const previousMinEpisodes = process.env.PODCAST_MIN_EPISODES;
  const previousMaxEpisodes = process.env.PODCAST_MAX_EPISODES;
  const previousAudioTranscribe = process.env.PODCAST_AUDIO_TRANSCRIBE;
  const previousCuratedFile = process.env.PODCAST_TEST_EPISODES_FILE;
  writeTestPodcastEpisodesFile(curatedFile, [
    {
      archiveDate: "2026-06-23",
      title: "Building the Infrastructure for ASI | Ganesh Krishnan | Ep. 219",
      show: "Localization Fireside Chat",
      source: "YouTube",
      guest: "Ganesh Krishnan",
      date: "2026-06-23",
      link: "https://www.youtube.com/watch?v=H8M47RYi024",
      description: "Only title, guest, link, thumbnail, and a short curated boundary note are available. No transcript or original show notes are stored.",
    },
  ]);
  process.env.PODCAST_DISABLE_RSS = "true";
  process.env.PODCAST_MIN_EPISODES = "1";
  process.env.PODCAST_MAX_EPISODES = "1";
  process.env.PODCAST_AUDIO_TRANSCRIBE = "false";
  process.env.PODCAST_TEST_EPISODES_FILE = curatedFile;
  try {
    await assert.rejects(() => buildForeignTechPodcastSource("2026-06-23"), /found only 0 usable episodes/);
  } finally {
    restoreEnv("PODCAST_DISABLE_RSS", previousDisableRss);
    restoreEnv("PODCAST_MIN_EPISODES", previousMinEpisodes);
    restoreEnv("PODCAST_MAX_EPISODES", previousMaxEpisodes);
    restoreEnv("PODCAST_AUDIO_TRANSCRIBE", previousAudioTranscribe);
    restoreEnv("PODCAST_TEST_EPISODES_FILE", previousCuratedFile);
    fs.rmSync(curatedFile, { force: true });
  }
});

test("daily podcasts fetch skips episodes already in the summarized ledger", async () => {
  const ledgerFile = path.join(os.tmpdir(), `astro-paper-ledger-${Date.now()}-${Math.random()}.json`);
  const curatedFile = path.join(os.tmpdir(), `astro-paper-curated-history-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(
    ledgerFile,
    `${JSON.stringify({
      version: 1,
      episodes: [
        {
          title: "The Co-Founders of Claude AI Tell Oprah About the Impact Artificial Intelligence Has on Your Life",
          show: "The Oprah Podcast",
          link: "https://podcasts.apple.com/us/podcast/the-co-founders-of-claude-ai-tell-oprah-about/id1782960381?i=1000768533274&utm_source=copy&uo=4",
          date: "2026-05-19",
          archivedAt: "2026-06-22",
        },
      ],
    })}\n`,
  );
  const transcript = "This transcript discusses AI engineering, product workflows, verification, release safety, architecture, developer platforms, operational risk, review gates, auditability, and infrastructure changes in enough detail to be usable evidence.";
  writeTestPodcastEpisodesFile(curatedFile, [
    {
      archiveDate: "2026-06-23",
      title: "The Co-Founders of Claude AI Tell Oprah About the Impact Artificial Intelligence Has on Your Life",
      show: "The Oprah Podcast",
      source: "Apple Podcasts",
      date: "2026-05-19",
      link: "https://podcasts.apple.com/us/podcast/the-co-founders-of-claude-ai-tell-oprah-about/id1782960381?i=1000768533274&uo=4",
      description: "Duplicate episode with transcript.",
      transcript,
    },
    ...["How Anthropic Uses Claude Fable 5 With Mike Krieger", "Most of the Web Will Never Get APIs for AI Agents | Dhruv Batra", "Building Reliable AI Developer Platforms"].map((title, index) => ({
      archiveDate: "2026-06-23",
      title,
      show: "Curated Show",
      source: "Curated Transcript",
      date: "2026-06-23",
      link: `https://example.com/podcast/${index}`,
      description: "Curated episode with transcript.",
      transcript,
    })),
  ]);
  const previousDisableRss = process.env.PODCAST_DISABLE_RSS;
  const previousMinEpisodes = process.env.PODCAST_MIN_EPISODES;
  const previousMaxEpisodes = process.env.PODCAST_MAX_EPISODES;
  const previousAudioTranscribe = process.env.PODCAST_AUDIO_TRANSCRIBE;
  const previousLedgerFile = process.env.PODCAST_SUMMARIZED_LEDGER_FILE;
  const previousCuratedFile = process.env.PODCAST_TEST_EPISODES_FILE;
  const previousMinTranscriptChars = process.env.PODCAST_MIN_TRANSCRIPT_CHARS;
  process.env.PODCAST_DISABLE_RSS = "true";
  process.env.PODCAST_MIN_EPISODES = "3";
  process.env.PODCAST_MAX_EPISODES = "3";
  process.env.PODCAST_AUDIO_TRANSCRIBE = "false";
  process.env.PODCAST_SUMMARIZED_LEDGER_FILE = ledgerFile;
  process.env.PODCAST_TEST_EPISODES_FILE = curatedFile;
  process.env.PODCAST_MIN_TRANSCRIPT_CHARS = "120";
  try {
    const source = await buildForeignTechPodcastSource("2026-06-23");
    assert.doesNotMatch(source, /The Oprah Podcast/);
    assert.doesNotMatch(source, /The Co-Founders of Claude AI Tell Oprah/);
    assert.match(source, /How Anthropic Uses Claude Fable 5 With Mike Krieger/);
    assert.equal((source.match(/^### \d+\./gm) || []).length, 3);
  } finally {
    restoreEnv("PODCAST_DISABLE_RSS", previousDisableRss);
    restoreEnv("PODCAST_MIN_EPISODES", previousMinEpisodes);
    restoreEnv("PODCAST_MAX_EPISODES", previousMaxEpisodes);
    restoreEnv("PODCAST_AUDIO_TRANSCRIBE", previousAudioTranscribe);
    restoreEnv("PODCAST_SUMMARIZED_LEDGER_FILE", previousLedgerFile);
    restoreEnv("PODCAST_TEST_EPISODES_FILE", previousCuratedFile);
    restoreEnv("PODCAST_MIN_TRANSCRIPT_CHARS", previousMinTranscriptChars);
    fs.rmSync(curatedFile, { force: true });
    fs.rmSync(ledgerFile, { force: true });
  }
});

test("XYZ Rank top episodes source extracts Xiaoyuzhou audio links", async () => {
  const originalFetch = globalThis.fetch;
  const items = Array.from({ length: 5 }, (_, index) => ({
    rank: index + 1,
    title: `热门单集 ${index + 1}`,
    podcastName: `中文播客 ${index + 1}`,
    link: `https://www.xiaoyuzhoufm.com/episode/test-${index + 1}`,
    duration: 60 + index,
    playCount: 1000 + index,
    commentCount: 100 + index,
    primaryGenreName: "社会与文化",
    postTime: "2099-01-05T00:00:00.000Z",
    logoURL: "https://image.xyzcdn.net/demo.png",
  }));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("xyzrank.com/api/episodes")) return Response.json({ items });
    const match = url.match(/test-(\d+)/);
    if (match) {
      return new Response(`<html><head><meta property="og:audio" content="https://media.xyzcdn.net/test/audio-${match[1]}.m4a"/><script name="schema:podcast-show" type="application/ld+json">{"description":"这一期节目讨论沟通边界和关系协商。"}</script></head></html>`);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const source = await buildXyzRankTopEpisodesSource("2099-01-06", 5);
    assert.match(source, /XYZ Rank 热门播客单集候选源/);
    assert.equal((source.match(/^##\s+\d+\.\s+/gm) || []).length, 5);
    assert.match(source, /- 音频：https:\/\/media\.xyzcdn\.net\/test\/audio-1\.m4a/);
    assert.match(source, /- 节目：中文播客 5/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("XYZ Rank top episodes source falls back to reader links when API is blocked", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("xyzrank.com/api/episodes")) return new Response("blocked", { status: 403 });
    if (url.includes("r.jina.ai")) {
      return new Response(
        [
          "Title: 中文播客榜",
          "",
          "Markdown Content:",
          "1[![Image 1](https://image.example.com/one.jpg)](https://www.xiaoyuzhoufm.com/episode/fallback-1)123 4 0.1%5.0%42′1天前 科技",
          "2[![Image 2](https://image.example.com/two.jpg)](https://www.xiaoyuzhoufm.com/episode/fallback-2)99 3 0.1%4.0%38′2天前 商务",
        ].join("\n"),
      );
    }
    const match = url.match(/fallback-(\d+)/);
    if (match) {
      return new Response(
        `<html><head><meta property="og:audio" content="https://media.xyzcdn.net/fallback/audio-${match[1]}.m4a"/><script name="schema:podcast-show" type="application/ld+json">{"name":"兜底单集 ${match[1]}","datePublished":"2099-01-05T00:00:00.000Z","timeRequired":"PT42M","description":"兜底详情页描述","associatedMedia":{"contentUrl":"https://media.xyzcdn.net/fallback/jsonld-${match[1]}.m4a"},"partOfSeries":{"name":"兜底节目 ${match[1]}"}}</script></head></html>`,
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const source = await buildXyzRankTopEpisodesSource("2099-01-06", 2);
    assert.equal((source.match(/^##\s+\d+\.\s+/gm) || []).length, 2);
    assert.match(source, /## 1\. 兜底单集 1/);
    assert.match(source, /- 节目：兜底节目 2/);
    assert.match(source, /- 音频：https:\/\/media\.xyzcdn\.net\/fallback\/jsonld-1\.m4a/);
    assert.match(source, /- 日期：2099-01-05/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("summarized ledger upserts by fingerprint and matches tracking-param variants", () => {
  const ledgerFile = path.join(os.tmpdir(), `astro-paper-ledger-unit-${Date.now()}-${Math.random()}.json`);
  const episode = {
    title: "Building Reliable AI Developer Platforms",
    show: "Latent Space",
    link: "https://example.com/podcast/dev-platforms?utm_medium=social",
    date: "2099-01-02",
  };
  try {
    appendSummarizedEpisode(episode, { archivedAt: "2099-01-02", postPath: "src/content/posts/zh-cn/每日播客-2099-01-02-01-latent-space.md" }, ledgerFile);
    // 同一集再次写入（force 重生场景）→ upsert，不新增条目，刷新 archivedAt/postPath
    appendSummarizedEpisode(episode, { archivedAt: "2099-01-03", postPath: "src/content/posts/zh-cn/每日播客-2099-01-03-01-latent-space.md" }, ledgerFile);
    const parsed = JSON.parse(fs.readFileSync(ledgerFile, "utf8")) as { episodes: { postPath?: string; archivedAt?: string }[] };
    assert.equal(parsed.episodes.length, 1);
    assert.equal(parsed.episodes[0].archivedAt, "2099-01-03");
    assert.match(parsed.episodes[0].postPath || "", /2099-01-03-01-latent-space/);
    // 追踪参数变体仍命中已存指纹
    const variant = { title: "Building Reliable AI Developer Platforms", show: "Latent Space", link: "https://example.com/podcast/dev-platforms?uo=4" };
    assert.equal(isEpisodeSummarized(loadSummarizedFingerprints(ledgerFile), variant), true);
  } finally {
    fs.rmSync(ledgerFile, { force: true });
  }
});

test("foreign tech podcast URL fingerprints ignore common tracking parameters", () => {
  assert.equal(normalizePodcastUrl("https://example.com/podcast/dev-platforms?utm_medium=social&uo=4&b=2&a=1#section"), "https://example.com/podcast/dev-platforms?a=1&b=2");
});

test("HN source payload carries original and comment evidence", () => {
  const payload = buildPayload(
    {
      id: 123,
      title: "Developers don't understand CORS",
      url: "https://example.com/cors",
      descendants: 88,
      score: 185,
      text: "An explainer about why CORS exists and what browsers actually enforce.",
    },
    1,
    {
      originalExcerpt: "The original article explains how browsers enforce CORS through preflight requests, credentials, and origin checks.",
      commentExcerpt: "Commenters discuss reverse proxies, CDN caches, and local development pitfalls.",
    },
  );
  assert.equal(payload.topic, "开发工具 / 编程语言");
  assert.equal(classify("A new open model benchmark"), "AI / 模型");
  assert.match(payload.original_excerpt, /browsers enforce CORS/);
  assert.match(payload.hn_comment_excerpt, /reverse proxies/);
});

test("GitHub Trending parser extracts repository metadata", () => {
  const repos = parseGitHubTrendingHtml(GITHUB_TRENDING_HTML_FIXTURE, 10);
  assert.equal(repos.length, 1);
  assert.equal(repos[0].fullName, "acme/agent-lab");
  assert.equal(repos[0].language, "TypeScript");
  assert.equal(repos[0].stars, 12_345);
  assert.equal(repos[0].forks, 678);
  assert.equal(repos[0].todayStars, 321);
  assert.equal(repos[0].url, "https://github.com/acme/agent-lab");
});

test("archive and verifier accept generated HN, podcast notes, and retained digests", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-archive-"));
  const hnBody = `1. 🔥 开发者并不真正理解 CORS
- ⭐ 185 points · 88 评论
- 主题：开发工具 / 编程语言
- 原文：https://example.com/cors
- HN 讨论：https://news.ycombinator.com/item?id=123
- 内容总结：文章解释了浏览器同源策略与 CORS 预检机制之间的关系，并指出很多后端开发者把跨域报错误解成服务端权限问题。作者用请求头、凭证模式和常见配置误区串起了 CORS 的真实执行路径。
- 评论总结：评论区主要补充了反向代理、CDN 和本地开发场景下最容易踩坑的缓存与凭证问题，也有人强调把通配配置当万能解法会埋下安全隐患。
  `;
  const hn = archivePost({ task: "hn-top10", date: "2099-01-02", repo, body: hnBody, force: true });
  const podcastBody = `${fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/daily-podcasts.md"), "utf8")}

这期还谈到产品布局和值得关注的设计工作流，这些是产品访谈里的正常语义，不应被市场日报的投顾口吻过滤误伤。
`;
  const podcast = archivePost({ task: "daily-podcasts", date: "2099-01-02", repo, body: podcastBody, force: true });
  const applePodcast = archivePost({ task: "apple-top-podcasts", date: "2099-01-02", repo, body: podcastBody, force: true, fileNameSuffix: "01-latent-space" });
  const xyzRankTopEpisodeBody = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/xyzrank-top-episodes.md"), "utf8");
  const xyzRankTopEpisode = archivePost({ task: "xyzrank-top-episodes", date: "2099-01-06", repo, body: xyzRankTopEpisodeBody, force: true, fileNameSuffix: "01-jokes-aside" });
  const techDailyBody = composeFixtureBody("tech-daily");
  const techDaily = archivePost({ task: "tech-daily", date: "2099-01-06", repo, body: techDailyBody, force: true });
  const artifactsDir = path.join(repo, "blog-generation-artifacts", "xyzrank-top-episodes");
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), "tests/fixtures/blog-sources/xyzrank-top-episodes.md"), path.join(artifactsDir, "source.fixture.md"));
  const xyzRankTopEpisodeWithSource = { ...xyzRankTopEpisode, generation: { source_artifact: "blog-generation-artifacts/xyzrank-top-episodes/source.fixture.md" } };
  const resultJson = path.join(repo, "result.json");
  fs.writeFileSync(resultJson, JSON.stringify({ date: "2099-01-06", results: [hn, podcast, applePodcast, xyzRankTopEpisodeWithSource, techDaily] }));
  assert.equal(verifyResultJson(repo, resultJson), 5);
});

test("podcast archive promotes h3-only model output into accepted section headings", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-podcast-h3-"));
  const body = `DESCRIPTION: 模型把顶层标题写成三级标题

### 中文标题：一次格式下沉的播客输出

### 基本信息

- 节目：Format Drift Podcast
- 日期：2099-01-02
- 来源：Format Drift
- 链接：https://example.com/podcast/format-drift

### 长文笔记

#### 第一部分

${"这是一段用于覆盖模型把播客顶层标题写成三级标题时的归档兼容逻辑。它保留内容质量校验，只把标题层级提升一级，避免可用文章因为 Markdown 层级偏差被跳过。".repeat(24)}
`;
  const result = archivePost({ task: "apple-top-podcasts", date: "2099-01-02", repo, body, force: true, fileNameSuffix: "01-format-drift" });
  const article = fs.readFileSync(path.join(repo, result.path), "utf8");
  assert.equal(result.title, "Format Drift Podcast：中文标题：一次格式下沉的播客输出");
  assert.match(article, /^## 中文标题：一次格式下沉的播客输出$/m);
  assert.match(article, /^### 第一部分$/m);
});

test("Economist EPUB keeps every valid article without title dedupe or body truncation", () => {
  const issue = parseEconomistEpub(economistEpubFixture(12));
  assert.equal(issue.articles.length, 12);
  assert.deepEqual(
    issue.articles.map(article => article.rank),
    Array.from({ length: 12 }, (_, index) => index + 1),
  );
  assert.match(issue.articles[0].text, /ARTICLE_1_TAIL_SENTINEL/);
  assert.ok(issue.articles[0].text.length > 12_000);
  assert.deepEqual(Object.keys(issue.articles[0]).sort(), ["originUrl", "rank", "text"]);
});

test("New Yorker EPUB parses .article bodies and drops non-article and short pages", () => {
  const issue = parseMagazineEpub(newYorkerEpubFixture(5), magazineConfig("new-yorker-weekly"));
  // 5 real articles; the toc page and the short poem are filtered out.
  assert.equal(issue.articles.length, 5);
  assert.deepEqual(
    issue.articles.map(article => article.rank),
    [1, 2, 3, 4, 5],
  );
  assert.match(issue.articles[0].text, /NY_1_TAIL/);
  assert.equal(issue.articles[0].originUrl, "https://www.newyorker.com/news/story-1");
});

test("Calibre EPUB (Atlantic/Wired) parses bodies, strips navbar, drops the feed index", () => {
  for (const task of ["atlantic-monthly", "wired-monthly"]) {
    const issue = parseMagazineEpub(calibreEpubFixture(4), magazineConfig(task));
    assert.equal(issue.articles.length, 4);
    assert.match(issue.articles[0].text, /CAL_1_TAIL/);
    assert.doesNotMatch(issue.articles[0].text, /Next/); // navbar stripped
    assert.equal(issue.articles[0].originUrl, ""); // no reliable canonical link
  }
});

test("Economist item summary keeps Markdown structure and rejects headings", () => {
  const item = parseMagazineItemSummary(
    JSON.stringify({
      rank: 1,
      title_zh: "制度压力",
      one_sentence_summary: "短摘要。",
      core_point: "核心观点。",
      content_summary: "第一段总结。\n\n- **要点一**：细节。\n- 要点二：细节。",
    }),
    1,
  );
  assert.equal(item.titleZh, "制度压力");
  assert.match(item.contentSummary, /\n\n- \*\*要点一\*\*/);

  assert.throws(
    () =>
      parseMagazineItemSummary(
        JSON.stringify({ rank: 1, title_zh: "制度压力", one_sentence_summary: "短摘要。", core_point: "核心观点。", content_summary: "## 小标题\n\n正文。" }),
        1,
      ),
    /must not use Markdown headings/,
  );
});

test("Economist compose aggregates per-article summaries with no issue-level sections", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-sources/economist-weekly.md"), "utf8");
  const summaries = parseEconomistArticleSummaries(source);
  const { markdown, description } = economistWeeklyMarkdown(source);
  assert.equal(summaries.length, 3);
  // No issue-level overview/reading-route/wrapper sections; articles are top-level.
  assert.doesNotMatch(markdown, /本期主题脉络|阅读路线|全部文章/);
  assert.match(markdown, /^## 脆弱和平的压力测试$/m);
  assert.match(markdown, /^### 内容总结$/m);
  // content_summary Markdown structure survives the carrier round-trip.
  assert.match(markdown, /- \*\*国内政治\*\*：/);
  assert.match(markdown, /- 原文：\[The Economist\]\(https:\/\/www\.economist\.com\/leaders\/2099\/01\/01\/a-fragile-peace\)/);
  assert.doesNotMatch(markdown, /原题：|栏目：|作者：|A fragile peace faces a hard test/);
  assert.equal(description, summaries[0].oneSentenceSummary.slice(0, 30));
  assert.ok(description.length > 0 && description.length <= 30);
});

test("Economist archive accepts more than ten complete articles", () => {
  const fixtureSource = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-sources/economist-weekly.md"), "utf8");
  const header = fixtureSource.slice(0, fixtureSource.search(/^##\s+\d+\./m)).trimEnd();
  const source = [
    header,
    "",
    ...Array.from({ length: 12 }, (_, index) => {
      const rank = index + 1;
      return [
        `## ${rank}. 文章`,
        "",
        `- 原文链接：https://www.economist.com/fixture/${rank}`,
        `- 中文标题：第${rank}篇中文标题`,
        `- 一句话摘要：第${rank}篇文章的一句话中文摘要。`,
        `- 核心观点：第${rank}篇文章的核心中文观点。`,
        `- 内容总结：${JSON.stringify(`第${rank}篇文章的完整中文内容总结：\n\n- **要点**：合理说明文章采用的示例。`)}`,
        "",
      ].join("\n");
    }),
  ].join("\n");
  const body = economistWeeklyMarkdown(source).markdown;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-economist-all-"));
  const issueDate = contentDateForTask("economist-weekly", "2099-01-09", source);
  assert.equal(issueDate, "2099-01-02");
  assert.equal(contentDateForTask("hn-top10", "2099-01-09", source), "2099-01-09");
  const result = archivePost({ task: "economist-weekly", date: issueDate, repo, body, force: true });
  const article = fs.readFileSync(path.join(repo, result.path), "utf8");
  assert.equal(result.path, "src/content/posts/zh-cn/经济学人-2099-01-02.md");
  assert.equal(result.title, "经济学人本期导读｜2099-01-02");
  assert.match(article, /pubDatetime: 2099-01-01T16:00:00Z/);
  assert.equal((article.match(/^##\s+第\d+篇中文标题$/gm) || []).length, 12);
  assert.match(article, /- \*\*要点\*\*：/);
  assert.doesNotMatch(article, /原题：|栏目：|作者：/);
});

test("HN compose parses source facts from markdown blocks", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-sources/hn-top10.md"), "utf8");
  const facts = parseSourceFacts(source);
  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0], {
    rank: 1,
    points: "320 points · 64 评论",
    topic: "开发工具 / 编程语言",
    url: "https://example.com/automation-contracts",
    hn_link: "https://news.ycombinator.com/item?id=2099010201",
  });
});

test("HN compose takes facts from source, not from the model", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-sources/hn-top10.md"), "utf8");
  // 模型 JSON 只带语义字段；即使模型试图塞链接也不该出现在成品里。
  const modelJson = JSON.stringify({
    items: [
      {
        rank: 1,
        title_zh: "开发者终于开始测试自动化契约",
        content_summary: "文章讨论了为什么自动化系统不能只检查任务是否启动，而要检查最终产物、文件路径和可复现构建结果，并强调每一层都要留下可复盘证据。",
        comment_summary: "评论区补充了 fixture 测试、离线回放和失败路径观测的重要性，强调外部接口不可用时仍应能验证归档层。",
        url: "https://evil.example.com/hallucinated",
      },
    ],
  });
  const markdown = hnMarkdownFromModelJson(modelJson, source);
  assert.match(markdown, /^1\. 🔥 开发者终于开始测试自动化契约$/m);
  assert.match(markdown, /- 原文：https:\/\/example\.com\/automation-contracts/);
  assert.match(markdown, /- ⭐ 320 points · 64 评论/);
  assert.doesNotMatch(markdown, /evil\.example\.com/);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-hn-json-"));
  const result = archivePost({ task: "hn-top10", date: "2099-01-02", repo, body: markdown, force: true });
  const article = fs.readFileSync(path.join(repo, result.path), "utf8");
  assert.match(article, /^## 1\. 开发者终于开始测试自动化契约/m);
  assert.match(article, /https:\/\/example\.com\/automation-contracts/);
  assert.doesNotMatch(article, /evil\.example\.com/);
});

test("HN model JSON parser rejects malformed output", () => {
  const facts = [{ rank: 1, points: "1 points · 0 评论", topic: "x", url: "https://e.com", hn_link: "https://h.com" }];
  assert.throws(() => parseHnModelJson("not json", 1), /not valid JSON/);
  assert.throws(() => parseHnModelJson(JSON.stringify({ items: [] }), 1), /non-empty items array/);
  assert.throws(() => parseHnModelJson(JSON.stringify({ items: [{ rank: 1, title_zh: "x", content_summary: "a", comment_summary: "b" }] }), 2), /does not match source count/);
  // 容错解析：即使模型裹了 ```json 围栏也能解析。
  const fenced = "```json\n" + JSON.stringify({ items: [{ rank: 1, title_zh: "中文标题", content_summary: "内容够长的中文总结用来通过校验规则", comment_summary: "评论够长的中文总结用来通过校验规则" }] }) + "\n```";
  const parsed = parseHnModelJson(fenced, 1);
  assert.equal(parsed[0].title_zh, "中文标题");
  assert.equal(composeHnBody(parsed, facts).includes("- 原文：https://e.com"), true);
});

test("GitHub trending compose takes stars and links from source, not the model", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-sources/github-trending-daily.md"), "utf8");
  const facts = parseGitHubTrendingFacts(source);
  assert.equal(facts.length, 5);
  assert.deepEqual(facts[0], { rank: 1, repo: "acme/agent-lab", url: "https://github.com/acme/agent-lab", stars: "12.4k", forks: "620", today_stars: "820" });
  const markdown = composeFixtureBody("github-trending-daily");
  assert.match(markdown, /^## 1\. \[acme\/agent-lab\]\(https:\/\/github\.com\/acme\/agent-lab\)/m);
  assert.match(markdown, /^- Stars：12\.4k/m);
});

test("GitHub trending JSON parser rejects malformed and incomplete output", async () => {
  const { parseGitHubTrendingModelJson } = await import("../scripts/github_trending_compose.ts");
  assert.throws(() => parseGitHubTrendingModelJson("not json", 5), /not valid JSON/);
  assert.throws(() => parseGitHubTrendingModelJson(JSON.stringify({ items: [{ rank: 1, project_summary: "a", tech_stack: "TS", use_case: "b" }] }), 5), /does not match source count/);
  assert.throws(
    () => parseGitHubTrendingModelJson(JSON.stringify({ items: [{ rank: 1, project_summary: "够长的中文项目总结用于通过校验", tech_stack: "未明确", use_case: "够长的中文使用场景用于通过校验" }] }), 1),
    /empty tech_stack/,
  );
});

test("mdblist compose takes poster and IMDb rating from source", () => {
  const markdown = composeFixtureBody("mdblist-weekly");
  assert.match(markdown, /^## 电影推荐$/m);
  assert.match(markdown, /^## 剧集推荐$/m);
  assert.match(markdown, /### 痴迷（Obsession）/);
  assert.match(markdown, /!\[痴迷\]\(https:\/\/image\.tmdb\.org\/t\/p\/w1920_and_h800_multi_faces\/r013C8Me2bZ0pUi0OWJRh0h7MzT\.jpg\)/);
  assert.match(markdown, /- IMDb 评分：8\.1/);
});

test("mdblist compose requires every selected candidate exactly once", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-sources/mdblist-weekly.md"), "utf8");
  const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/mdblist-weekly.json"), "utf8"));
  assert.throws(() => mdblistMarkdownFromModelJson(JSON.stringify({ ...raw, movies: raw.movies.slice(0, -1) }), source), /电影推荐 model count does not match source count/);
  assert.throws(
    () => mdblistMarkdownFromModelJson(JSON.stringify({ ...raw, series: raw.series.map((item: { rank: number }, index: number) => ({ ...item, rank: index ? 1 : item.rank })) }), source),
    /剧集推荐 model contains duplicate ranks/,
  );
});

test("mdblist season identity uses the latest season with started episodes", () => {
  assert.equal(
    latestStartedSeasonNumber([
      { season_number: 0, episodes: [{ votes: 100, rating: 8 }] },
      { season_number: 1, episodes: [{ votes: 50, rating: 7.5 }] },
      { season_number: 2, episodes: [{ votes: 10, rating: null }] },
      { season_number: 3, episodes: [{ votes: 0, rating: null }] },
    ]),
    2,
  );
  assert.equal(latestStartedSeasonNumber([{ season_number: 1, episodes: [{ votes: 0, rating: null }] }]), null);
});

test("mdblist candidate selection expands past recommended TMDB identities", () => {
  const startedSeason = (season: number, imdb: number | null = 6) => ({
    ratings: imdb === null ? [] : [{ source: "imdb", value: imdb }],
    seasons: [{ season_number: season, episodes: [{ votes: 1, rating: 8 }] }],
  });
  const candidates = [
    { item: { title: "Already recommended", ids: { tmdb: 101 } }, info: startedSeason(2) },
    { item: { title: "Low rated", ids: { tmdb: 102 } }, info: startedSeason(1, 5.9) },
    { item: { title: "Missing IMDb", ids: { tmdb: 103 } }, info: startedSeason(1, null) },
    {
      item: { title: "Future season only", ids: { tmdb: 104 } },
      info: { ratings: [{ source: "imdb", value: 8 }], seasons: [{ season_number: 1, episodes: [{ votes: 0, rating: null }] }] },
    },
    { item: { title: "Fresh first", ids: { tmdb: 105 } }, info: startedSeason(1, 6) },
    { item: { title: "Fresh second", ids: { tmdb: 106 } }, info: startedSeason(4, 6.1) },
  ];
  const selected = selectUnrecommendedMdblistCandidates(candidates, "show", new Set(["show:101:season:2"]), 2);
  assert.deepEqual(
    selected.map(entry => ({ title: entry.item.title, key: entry.recommendation.key })),
    [
      { title: "Fresh first", key: "show:105:season:1" },
      { title: "Fresh second", key: "show:106:season:4" },
    ],
  );
});

test("mdblist ledger persists successful selections and replaces same-post reruns", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdblist-ledger-"));
  const file = path.join(dir, "recommended.json");
  appendMdblistRecommendations(
    [
      { key: "movie:10", mediaType: "movie", tmdbId: 10, title: "Movie A" },
      { key: "show:20:season:2", mediaType: "show", tmdbId: 20, seasonNumber: 2, title: "Show A" },
    ],
    { archivedAt: "2099-01-09", postPath: "src/content/posts/zh-cn/每周影视推荐-2099-01-09.md" },
    file,
  );
  assert.deepEqual(loadMdblistRecommendationKeys(file), new Set(["movie:10", "show:20:season:2"]));

  appendMdblistRecommendations(
    [{ key: "show:21:season:1", mediaType: "show", tmdbId: 21, seasonNumber: 1, title: "Show B" }],
    { archivedAt: "2099-01-09", postPath: "src/content/posts/zh-cn/每周影视推荐-2099-01-09.md" },
    file,
  );
  assert.deepEqual(loadMdblistRecommendationKeys(file), new Set(["show:21:season:1"]));
});

test("mdblist source evidence exposes the TMDB identities selected for the ledger", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-sources/mdblist-weekly.md"), "utf8");
  const selections = parseMdblistRecommendationsFromSource(source);
  assert.equal(selections.length, 6);
  assert.deepEqual(selections[0], { key: "movie:1339713", mediaType: "movie", tmdbId: 1339713, title: "Obsession" });
  assert.deepEqual(selections[3], {
    key: "show:94997:season:3",
    mediaType: "show",
    tmdbId: 94997,
    seasonNumber: 3,
    title: "House of the Dragon",
  });
});

test("mdblist source builder scans deeper and returns as many unrecommended candidates as available", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdblist-source-"));
  const ledgerFile = path.join(dir, "recommended.json");
  appendMdblistRecommendations(
    [
      { key: "movie:1", mediaType: "movie", tmdbId: 1, title: "Seen Movie" },
      { key: "show:11:season:1", mediaType: "show", tmdbId: 11, seasonNumber: 1, title: "Seen Show" },
    ],
    { archivedAt: "2099-01-02", postPath: "previous.md" },
    ledgerFile,
  );
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.MDBLIST_API_KEY;
  process.env.MDBLIST_API_KEY = "test-key";
  globalThis.fetch = (async input => {
    const url = new URL(String(input));
    let payload: unknown;
    if (url.pathname.includes("/lists/87667/items")) {
      payload = { movies: [{ title: "Seen Movie", ids: { tmdb: 1 } }, { title: "Fresh Movie", ids: { tmdb: 2 } }] };
    } else if (url.pathname.includes("/lists/88434/items")) {
      payload = {
        shows: [
          { title: "Seen Show", ids: { tmdb: 11 } },
          { title: "Low Rated Show", ids: { tmdb: 12 } },
          { title: "Missing IMDb Show", ids: { tmdb: 13 } },
          { title: "Future Show", ids: { tmdb: 14 } },
          { title: "Fresh Show", ids: { tmdb: 15 } },
        ],
      };
    } else if (url.pathname.endsWith("/tmdb/show/11")) {
      payload = { ratings: [{ source: "imdb", value: 8 }], seasons: [{ season_number: 1, episodes: [{ votes: 5, rating: 8 }] }] };
    } else if (url.pathname.endsWith("/tmdb/show/12")) {
      payload = { ratings: [{ source: "imdb", value: 5.9 }], seasons: [{ season_number: 1, episodes: [{ votes: 5, rating: 8 }] }] };
    } else if (url.pathname.endsWith("/tmdb/show/13")) {
      payload = { ratings: [], seasons: [{ season_number: 1, episodes: [{ votes: 5, rating: 8 }] }] };
    } else if (url.pathname.endsWith("/tmdb/show/14")) {
      payload = { ratings: [{ source: "imdb", value: 8 }], seasons: [{ season_number: 1, episodes: [{ votes: 0, rating: null }] }] };
    } else if (url.pathname.endsWith("/tmdb/show/15")) {
      payload = { ratings: [{ source: "imdb", value: 6 }], seasons: [{ season_number: 2, episodes: [{ votes: 2, rating: 7 }] }] };
    } else {
      payload = { title: "Fresh Movie", description: "A fresh movie.", ratings: [], genres: [] };
    }
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  try {
    const source = await buildMdblistWeeklySource("2099-01-09", 2, { candidatesToFetch: 5, ledgerFile });
    assert.match(source, /过滤历史推荐后各最多选 2 部/);
    assert.match(source, /剧集评分门槛：IMDb 评分存在且不低于 6\.0/);
    assert.match(source, /## 1\. Fresh Movie/);
    assert.match(source, /- TMDB ID：2/);
    assert.match(source, /## 1\. Fresh Show/);
    assert.match(source, /- TMDB ID：15/);
    assert.match(source, /- 推荐季度：2/);
    assert.doesNotMatch(source, /## \d+\. (?:Seen Movie|Seen Show|Low Rated Show|Missing IMDb Show|Future Show)/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.MDBLIST_API_KEY;
    else process.env.MDBLIST_API_KEY = originalKey;
  }
});

test("daily digest compose rejects links outside the source pool and duplicates", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-sources/tech-daily.md"), "utf8");
  const good = { title_zh: "中文标题", source_url: "https://example.com/postgresql-19-beta", body_markdown: "这是一段足够长的中文正文用于通过低信号与长度校验，说明事件影响与风险。" };
  const overview = "今天的主线是工程平台与供应链在发布治理上收敛。";
  assert.doesNotThrow(() => dailyDigestMarkdownFromModelJson(JSON.stringify({ overview, sections: [{ title: "平台工程", items: [good] }] }), source));
  // 编造的链接不在 source 池 → 拒绝。
  assert.throws(
    () => dailyDigestMarkdownFromModelJson(JSON.stringify({ overview, sections: [{ title: "平台工程", items: [{ ...good, source_url: "https://evil.example.com/x" }] }] }), source),
    /outside the source pool/,
  );
  // 同一链接复用 → 拒绝。
  assert.throws(
    () => dailyDigestMarkdownFromModelJson(JSON.stringify({ overview, sections: [{ title: "平台工程", items: [good, { ...good, title_zh: "另一个标题" }] }] }), source),
    /reuses source link/,
  );
});

test("archive and verifier accept generated GitHub trending daily", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-github-trending-"));
  const body = composeFixtureBody("github-trending-daily");
  const result = archivePost({ task: "github-trending-daily", date: "2099-01-06", repo, body, force: true });
  const resultJson = path.join(repo, "result.json");
  fs.writeFileSync(resultJson, JSON.stringify({ date: "2099-01-06", results: [result] }));
  assert.equal(verifyResultJson(repo, resultJson), 1);
});

test("GitHub trending source overwrites an existing daily archive", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-github-trending-archive-"));
  const dataDir = path.join(repo, "data/github-trending");
  fs.mkdirSync(dataDir, { recursive: true });
  const archiveFile = path.join(dataDir, "2099-01-06.json");
  fs.writeFileSync(archiveFile, JSON.stringify({ stale: true, repos: [] }, null, 2));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("github.com/trending")) return new Response(GITHUB_TRENDING_HTML_FIXTURE, { status: 200 });
    if (url.includes("api.github.com/repos/")) {
      return Response.json({ content: Buffer.from("README content for generated archive").toString("base64"), encoding: "base64" });
    }
    return new Response("", { status: 404 });
  };
  try {
    const source = await buildGitHubTrendingDailySource("2099-01-06", { dataDir, limit: 1 });
    const payload = JSON.parse(fs.readFileSync(archiveFile, "utf8")) as { stale?: boolean; date?: string; repos?: unknown[] };
    assert.equal(payload.stale, undefined);
    assert.equal(payload.date, "2099-01-06");
    assert.equal(payload.repos?.length, 1);
    assert.match(source, /结构化数据归档/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("daily digest verifier skips zero-item rows", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-daily-skipped-"));
  const resultJson = path.join(repo, "result.json");
  fs.writeFileSync(resultJson, JSON.stringify({ date: "2099-01-06", results: [{ task: "tech-daily", path: "", skipped: true, skip_reason: "no high-quality daily items" }] }));
  assert.equal(verifyResultJson(repo, resultJson), 0);
});

test("result verifier skips task-level failures with explicit error", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-task-failed-"));
  const resultJson = path.join(repo, "result.json");
  fs.writeFileSync(resultJson, JSON.stringify({ date: "2099-01-06", results: [{ task: "tech-daily", path: "", failed: true, error: "validator rejected low-signal language" }] }));
  assert.equal(verifyResultJson(repo, resultJson), 0);
});

function capitalMarketSourceFixture(): string {
  const table = `## 市场速览（2099-01-06）

| 分类 | 品种 | 最新 | 当日 | 今年以来 |
| :-- | :-- | --: | --: | --: |
| 美股 | 标普500 | 7000.00 | +1.30% | +8.00% |`;
  const evidence = {
    schema_version: 1,
    date: "2099-01-06",
    market_overview: { rows: [{ name: "标普500", latest: 7000, daily_change: "+1.30%" }] },
    markets: {
      us: { status: "open", direction: "up", strongest_index: "纳指", weakest_index: "道指" },
      ashare: { status: "open", direction: "down", strongest_index: "上证指数", weakest_index: "创业板指数" },
      hk: { status: "open", direction: "mixed", strongest_index: "恒生科技指数", weakest_index: "国企指数" },
      crypto: { status: "open", direction: "up", spot: { change_24h_pct: 1.41 } },
    },
  };
  return `${table}${CAPITAL_MARKET_SOURCE_SEP}## 结构化市场证据\n\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\``;
}

test("composeFullCapitalMarket puts the deterministic table first and uses complete AI sections", () => {
  const validJson = JSON.stringify({
    description: "全球市场表现不一，成长风格相对活跃。",
    overview: "2099年1月6日，美股走强，A股回落，港股分化，比特币反弹。",
    us: "美股主要指数同涨，风险偏好有所改善。行业表现仍有差异，不能据此推断真实资金流。",
    ashare: "A股主要指数同跌，宽基整体承压。指数表现不能代表所有成分股。",
    hk: "港股主要指数涨跌分化，市场缺少一致方向。",
    crypto: "比特币现货反弹，但衍生品结构仍显示谨慎情绪。",
  });
  const markdown = composeFullCapitalMarket(validJson, capitalMarketSourceFixture());
  assert.ok(markdown.indexOf("## 市场速览") < markdown.indexOf("## 今日总览"));
  assert.equal((markdown.match(/^## A股$/gm) || []).length, 1);
  assert.doesNotMatch(markdown, /^### A股$/m);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-capital-market-"));
  assert.doesNotThrow(() => archivePost({ task: "capital-market-daily", date: "2099-01-06", repo, body: markdown, force: true }));

  const missingField = JSON.stringify({ description: "简述", overview: "总览", us: "美股", ashare: "A股", hk: "港股" });
  assert.throws(() => composeFullCapitalMarket(missingField, capitalMarketSourceFixture()), /crypto is empty/);
});

test("composeFullCapitalMarket allows prose numbers absent from evidence", () => {
  const raw = JSON.stringify({
    description: "市场方向分化。",
    overview: "各市场走势不一。",
    us: "美股主要指数同涨，其中一个指数上涨 9.99%。",
    ashare: "A股主要指数同跌。",
    hk: "港股主要指数涨跌分化。",
    crypto: "比特币现货反弹。",
  });
  assert.doesNotThrow(() => composeFullCapitalMarket(raw, capitalMarketSourceFixture()));
});

test("composeFullCapitalMarket rejects broad-market direction contradictions", () => {
  const raw = JSON.stringify({
    description: "市场方向分化。",
    overview: "各市场走势不一。",
    us: "美股三大指数走势分化，科技方向相对活跃。",
    ashare: "A股主要指数同跌。",
    hk: "港股主要指数涨跌分化。",
    crypto: "比特币现货反弹。",
  });
  assert.throws(() => composeFullCapitalMarket(raw, capitalMarketSourceFixture()), /us prose contradicts source direction up/);
});

test("composeFullCapitalMarket rejects inverted strongest and weakest indices", () => {
  const raw = JSON.stringify({
    description: "市场方向分化。",
    overview: "各市场走势不一。",
    us: "美股主要指数整体上涨，道指相对更强。",
    ashare: "A股主要指数同跌。",
    hk: "港股主要指数涨跌分化。",
    crypto: "比特币现货反弹。",
  });
  assert.throws(() => composeFullCapitalMarket(raw, capitalMarketSourceFixture()), /us prose describes the weakest index as strongest/);
});

test("HN source verifier accepts legitimate double-brace examples from source articles", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-hn-source-braces-"));
  const body = `1. 🔥 Pandoc Lua 过滤器
- ⭐ 57 points · 1 评论
- 主题：技术 / 观察
- 原文：https://pandoc.org/lua-filters.html
- HN 讨论：https://news.ycombinator.com/item?id=48773079
- 内容总结：Pandoc Lua 过滤器允许用户直接操作文档 AST，并用内置 Lua 解释器减少传统 JSON filter 的序列化开销。文章展示了如何匹配元素、替换节点以及编写宏替换逻辑。
- 评论总结：评论主要讨论 Pandoc 功能边界和过滤器文档兼容性，也有人提到 Lua 过滤器在复杂文档转换中的实用价值。
`;
  const result = archivePost({ task: "hn-top10", date: "2099-01-02", repo, body, force: true });
  const sourcePath = path.join(repo, "hn-source.md");
  fs.writeFileSync(
    sourcePath,
    `## 1. Pandoc Lua 过滤器

- 原文：https://pandoc.org/lua-filters.html
- HN 讨论：https://news.ycombinator.com/item?id=48773079
- 原文正文：The filter converts the string {{helloworld}} into emphasized text.
`,
  );
  const resultJson = path.join(repo, "result.json");
  fs.writeFileSync(
    resultJson,
    JSON.stringify({
      date: "2099-01-02",
      results: [
        {
          ...result,
          generation: {
            ai_model: "mock",
            source_artifact: sourcePath,
            prompt_artifact: "",
            ai_response_artifact: "",
            mocked_ai: true,
          },
        },
      ],
    }),
  );

  assert.equal(verifyResultJson(repo, resultJson), 1);
});
