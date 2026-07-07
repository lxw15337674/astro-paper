import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { archivePost } from "../scripts/astro_paper_archive.ts";
import { chatCompletionsUrl, renderPrompt, resolvePromptFile } from "../scripts/ai_blog_writer.ts";
import { callBlogAi, callBlogAiWithFailover } from "../scripts/blog_ai_client.ts";
import { buildPayload, classify } from "../scripts/hn_top10_source.ts";
import { composeHnBody, hnMarkdownFromModelJson, parseHnModelJson, parseSourceFacts } from "../scripts/hn_compose.ts";
import { githubTrendingMarkdownFromModelJson, parseGitHubTrendingFacts } from "../scripts/github_trending_compose.ts";
import { mdblistMarkdownFromModelJson } from "../scripts/mdblist_compose.ts";
import { dailyDigestMarkdownFromModelJson } from "../scripts/daily_digest_compose.ts";
import { FEEDS, buildForeignTechPodcastSource } from "../scripts/foreign_tech_podcast_source.ts";
import { bjtArchiveInstant, fetchText } from "../scripts/blog_common.ts";
import { normalizePodcastUrl } from "../scripts/foreign_tech_podcast_dedupe.ts";
import { appendSummarizedEpisode, isEpisodeSummarized, loadSummarizedFingerprints } from "../scripts/podcast_ledger.ts";
import { dedupeItems, eventFamilyKey } from "../scripts/daily_digest_source.ts";
import { articleConflictsWithIndexSnapshot, buildUsSection } from "../scripts/market_daily_source.ts";
import { composeFullCapitalMarket } from "../scripts/market_compose.ts";
import { buildGitHubTrendingDailySource, parseGitHubTrendingHtml, sanitizeReadmeText } from "../scripts/github_trending_daily_source.ts";
import { buildXyzRankTopEpisodesSource } from "../scripts/xyzrank_top_episodes_source.ts";
import { verifyResultJson } from "../scripts/verify_blog_generation.ts";
import { type ResultItem, settleDailyPodcastArticleResults, usesJsonComposer } from "../scripts/generate_scheduled_post.ts";

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

// 从 JSON 模型输出 fixture + source fixture 经 composer 组装出 archive 中间契约 Markdown。
function composeFixtureBody(task: string): string {
  const source = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-sources", `${task}.md`), "utf8");
  const raw = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses", `${task}.json`), "utf8");
  if (task === "github-trending-daily") return githubTrendingMarkdownFromModelJson(raw, source);
  if (task === "mdblist-weekly") return mdblistMarkdownFromModelJson(raw, source);
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
  assert.equal(feeds.has("Dwarkesh Podcast"), false);
  assert.equal(feeds.has("The Cognitive Revolution"), false);
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
  const xyzRankTopEpisodeBody = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/xyzrank-top-episodes.md"), "utf8");
  const xyzRankTopEpisode = archivePost({ task: "xyzrank-top-episodes", date: "2099-01-06", repo, body: xyzRankTopEpisodeBody, force: true, fileNameSuffix: "01-jokes-aside" });
  const techDailyBody = composeFixtureBody("tech-daily");
  const techDaily = archivePost({ task: "tech-daily", date: "2099-01-06", repo, body: techDailyBody, force: true });
  const artifactsDir = path.join(repo, "blog-generation-artifacts", "xyzrank-top-episodes");
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), "tests/fixtures/blog-sources/xyzrank-top-episodes.md"), path.join(artifactsDir, "source.fixture.md"));
  const xyzRankTopEpisodeWithSource = { ...xyzRankTopEpisode, generation: { source_artifact: "blog-generation-artifacts/xyzrank-top-episodes/source.fixture.md" } };
  const resultJson = path.join(repo, "result.json");
  fs.writeFileSync(resultJson, JSON.stringify({ date: "2099-01-06", results: [hn, podcast, xyzRankTopEpisodeWithSource, techDaily] }));
  assert.equal(verifyResultJson(repo, resultJson), 4);
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

test("composeFullCapitalMarket rejects missing JSON fields", () => {
  const validJson = JSON.stringify({
    overview: "全球市场偏弱。",
    asia_summary: "A股小幅下跌。",
    asia_interpretation: "上证相对抗跌，创业板偏弱。",
    us_summary: "美股窄幅收涨。",
    us_interpretation: "科技板块领涨，行业分化明显。",
    crypto_conclusion: "BTC 偏弱，约 62521 美元。",
    crypto_price_move: "24h 跌约 2.2%，短线承压。",
  });
  const source = "## 市场速览\n\n| 品种 | 最新 |\n| :--- | ---: |\n| 比特币 | 62521 |";
  assert.doesNotThrow(() => composeFullCapitalMarket(validJson, source));

  const missingField = JSON.stringify({ overview: "ok", asia_summary: "ok", asia_interpretation: "ok", us_summary: "ok", us_interpretation: "ok", crypto_conclusion: "ok" });
  assert.throws(() => composeFullCapitalMarket(missingField, source), /crypto_price_move is empty/);
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
