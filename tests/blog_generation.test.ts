import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { archivePost } from "../scripts/astro_paper_archive.ts";
import { chatCompletionsUrl, renderPrompt, validateMarkdown } from "../scripts/ai_blog_writer.ts";
import { callBlogAi, callBlogAiWithFailover } from "../scripts/blog_ai_client.ts";
import { buildPayload, classify } from "../scripts/hn_top10_source.ts";
import { FEEDS, PodcastSourceInsufficientEpisodesError, buildForeignTechPodcastSource } from "../scripts/foreign_tech_podcast_source.ts";
import { bjtArchiveInstant, fetchText } from "../scripts/blog_common.ts";
import { normalizePodcastUrl } from "../scripts/foreign_tech_podcast_dedupe.ts";
import { appendSummarizedEpisode, isEpisodeSummarized, loadSummarizedFingerprints } from "../scripts/podcast_ledger.ts";
import { dedupeItems, eventFamilyKey } from "../scripts/daily_digest_source.ts";
import { articleConflictsWithIndexSnapshot, buildUsSection, extractYahooFinanceArticleText, quoteRowFromYahooChartPayload } from "../scripts/market_daily_source.ts";
import { buildGitHubTrendingDailySource, parseGitHubTrendingHtml, sanitizeReadmeText } from "../scripts/github_trending_daily_source.ts";
import { verifyResultJson } from "../scripts/verify_blog_generation.ts";
import { type ResultItem, settleDailyPodcastArticleResults, validateGeneratedMarkdownForTask } from "../scripts/generate_scheduled_post.ts";
import { DAILY_DIGEST_TASKS, SCHEDULED_TASK_INPUTS, TASKS, scheduledTaskInput, taskInfo, taskPostRelPath, tasksForInput } from "../scripts/blog_tasks.ts";

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

test("AI writer rejects placeholder markdown", () => {
  assert.match(validateMarkdown("```markdown\n## 标题\n\n" + "这是一段完整中文正文。".repeat(30) + "\n```"), /^## 标题/);
  assert.match(validateMarkdown("## 标题\n\n### [@ai-sdk/workflow-harness@1.0.0-beta.0](https://example.com)\n\n" + "这是一段完整中文正文。".repeat(30)), /@ai-sdk\/workflow-harness v1\.0\.0-beta\.0/);
  assert.throws(() => validateMarkdown("## TODO\n\n" + "内容".repeat(120)), /forbidden pattern/);
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

test("common article rules require knowledge and viewpoint extraction", () => {
  const commonRules = fs.readFileSync(path.join(process.cwd(), "prompts/blog", "_common-article-rules.md"), "utf8");
  assert.match(commonRules, /提炼优先于描述/);
  assert.match(commonRules, /可迁移的知识/);
  assert.match(commonRules, /只回答“发生了什么”的段落不合格/);

  const podcastPrompt = fs.readFileSync(path.join(process.cwd(), "prompts/blog", "daily-podcasts.md"), "utf8");
  assert.match(podcastPrompt, /把音频内容提炼成知识和观点/);
  assert.match(podcastPrompt, /不能只描述“聊了什么”/);
  assert.match(podcastPrompt, /### 核心观点/);
});

test("blog task registry covers prompts, fixtures, archive paths and schedules", () => {
  for (const task of TASKS) {
    const info = taskInfo(task);
    assert.ok(info.titlePrefix);
    assert.ok(info.tag);
    assert.ok(info.description);
    assert.match(taskPostRelPath(task, "2099-01-02"), /^src\/content\/posts\/zh-cn\/.+2099-01-02\.md$/);
    assert.equal(fs.existsSync(path.join(process.cwd(), "prompts/blog", `${task}.md`)), true, `${task} prompt missing`);
    assert.equal(fs.existsSync(path.join(process.cwd(), "prompts/blog", "_common-article-rules.md")), true, "common article rules prompt missing");
    assert.equal(fs.existsSync(path.join(process.cwd(), "tests/fixtures/blog-sources", `${task}.md`)), true, `${task} source fixture missing`);
    assert.equal(fs.existsSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses", `${task}.md`)), true, `${task} AI fixture missing`);
  }
  assert.deepEqual(tasksForInput("daily-digests"), [...DAILY_DIGEST_TASKS]);
  assert.deepEqual(tasksForInput("all"), [...TASKS]);
  assert.equal(scheduledTaskInput("0 17 * * *").task, "crypto-market-daily");
  assert.equal(scheduledTaskInput("0 17 * * *").dateOffset, -1);
  assert.equal(scheduledTaskInput("30 22 * * *").task, "us-market-daily");
  assert.equal(scheduledTaskInput("30 22 * * *").dateTimeZone, "America/New_York");
  assert.equal(scheduledTaskInput("30 0 * * *").task, "daily-digests");
  assert.equal(scheduledTaskInput("30 0 * * *").dateTimeZone, "America/Los_Angeles");
  assert.equal(scheduledTaskInput("0 6 * * *").task, "hn-top10");
  assert.equal(scheduledTaskInput("0 6 * * *").dateTimeZone, "America/Los_Angeles");
  assert.equal(scheduledTaskInput("30 1 * * *").task, "daily-podcasts");
  assert.equal(scheduledTaskInput("0 23 * * *").task, "github-trending-daily");
  assert.equal(scheduledTaskInput("0 23 * * *").dateTimeZone, "America/Los_Angeles");
  assert.equal(scheduledTaskInput("unknown schedule").task, "all");
  for (const schedule of Object.keys(SCHEDULED_TASK_INPUTS)) {
    assert.match(schedule, /^\d+ \d+ \* \* (?:\*|\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/);
  }
  const workflow = fs.readFileSync(path.join(process.cwd(), ".github/workflows/scheduled-posts.yml"), "utf8");
  const podcastSource = fs.readFileSync(path.join(process.cwd(), "scripts/foreign_tech_podcast_source.ts"), "utf8");
  for (const schedule of Object.keys(SCHEDULED_TASK_INPUTS)) {
    assert.match(workflow, new RegExp(`cron: "${schedule.replaceAll("*", "\\*")}"`));
  }
  assert.match(workflow, /group: scheduled-posts-\$\{\{ github\.ref \}\}/);
  assert.match(workflow, /github\.event\.inputs\.task == 'daily-podcasts'/);
  assert.match(workflow, /AI_TIMEOUT_MS: 600000/);
  assert.match(workflow, /PODCAST_PROMPT_TRANSCRIPT_CHARS: 8000/);
  assert.match(workflow, /PODCAST_AUDIO_DOWNLOAD_TIMEOUT_MS: 120000/);
  assert.match(workflow, /Install ffmpeg for podcast transcription/);
  assert.match(workflow, /GEMINI_API_KEY: \$\{\{ secrets\.GEMINI_API_KEY \}\}/);
  assert.match(workflow, /PODCAST_TRANSCRIBE_PROVIDER: gemini/);
  assert.match(workflow, /PODCAST_GEMINI_MODEL: gemini-flash-latest/);
  assert.match(workflow, /PODCAST_GEMINI_SEGMENT_SECONDS: 1200/);
  assert.match(workflow, /PODCAST_GEMINI_MAX_INLINE_CHUNK_MB: 14/);
  assert.match(podcastSource, /function runGeminiTranscription/);
  assert.match(podcastSource, /inline_data/);
  assert.match(workflow, /PODCAST_GEMINI_ARTICLE_BASE_URL: https:\/\/right\.codes\/gemini/);
  assert.match(workflow, /PODCAST_GEMINI_ARTICLE_MODEL: gemini-3\.5-flash/);
  assert.match(podcastSource, /export async function buildDailyPodcastEpisodeArticle/);
  assert.match(podcastSource, /function prepareGeminiArticleAudioChunks/);
  assert.match(podcastSource, /atempo=\$\{speed\}/);
  assert.match(podcastSource, /libopus/);
  assert.match(workflow, /PODCAST_GEMINI_ARTICLE_AUDIO_SPEED: "1\.5"/);
  assert.match(workflow, /PODCAST_GEMINI_ARTICLE_AUDIO_CODEC: libopus/);
  assert.match(podcastSource, /PODCAST_DAILY_MAX_EPISODE_MINUTES/);
  assert.match(podcastSource, /skipping overlong daily podcast episode/);
  assert.match(podcastSource, /audio fetch returned 403; retrying with curl/);
  assert.match(podcastSource, /\"whisper-cpp,local\"/);
  assert.match(podcastSource, /function runWhisperCpp/);
  assert.match(podcastSource, /prepareWhisperCppAudioChunks/);
  assert.doesNotMatch(workflow, /uses: actions\/cache@v4/);
  assert.doesNotMatch(workflow, /WHISPER_CPP_VERSION/);
  assert.doesNotMatch(workflow, /whisper-bin-ubuntu-x64\.tar\.gz/);
  assert.doesNotMatch(workflow, /ggml-\$WHISPER_CPP_MODEL\.bin/);
  assert.doesNotMatch(workflow, /PODCAST_WHISPER_CPP_/);
  assert.doesNotMatch(workflow, /GROQ_API_KEY/);
  assert.doesNotMatch(workflow, /PODCAST_GROQ_/);
  assert.doesNotMatch(workflow, /openai-whisper/);
  assert.doesNotMatch(workflow, /uses: actions\/setup-python@v6/);
  assert.doesNotMatch(workflow, /podcast_whisper_model/);
  assert.match(workflow, /AI_FALLBACK_API_KEY:/);
  assert.match(workflow, /AI_FALLBACK_BASE_URL: \$\{\{ secrets\.AI_FALLBACK_BASE_URL \|\| 'https:\/\/api\.deepseek\.com' \}\}/);
  assert.match(workflow, /AI_FALLBACK_MODEL: \$\{\{ secrets\.AI_FALLBACK_MODEL \|\| 'deepseek-v4-flash' \}\}/);
  assert.match(workflow, /APPLE_TOP_PODCASTS_COUNT: 10/);
  assert.match(workflow, /PODCAST_MAX_EPISODES: \$\{\{ github\.event\.inputs\.podcast_max_episodes \|\| '8' \}\}/);
  assert.match(workflow, /PODCAST_MIN_EPISODES: 1/);
  assert.match(workflow, /PODCAST_CANDIDATE_EPISODES: 8/);
  assert.match(workflow, /APPLE_TOP_PODCASTS_MAX_EPISODES: \$\{\{ github\.event\.inputs\.podcast_max_episodes \|\| '10' \}\}/);
  assert.match(workflow, /APPLE_TOP_PODCASTS_MIN_EPISODES: 1/);
  assert.match(workflow, /APPLE_TOP_PODCASTS_CANDIDATE_EPISODES: 10/);
  assert.match(workflow, /APPLE_TOP_PODCASTS_SKIP_ON_INSUFFICIENT: true/);
  assert.match(workflow, /APPLE_TOP_PODCASTS_TRANSCRIBE_DELAY_MS: 15000/);
  assert.match(workflow, /PODCAST_FFMPEG_TIMEOUT_MS: 300000/);
  assert.match(workflow, /PODCAST_DAILY_MAX_EPISODE_MINUTES: 90/);
  assert.match(workflow, /git checkout -B "\$\{GITHUB_REF_NAME\}" "origin\/\$\{GITHUB_REF_NAME\}"/);
  assert.match(workflow, /git pull --rebase -X theirs origin "\$\{GITHUB_REF_NAME\}"/);
  assert.match(workflow, /push attempt \$\{attempt\}\/3 failed; retrying after remote refresh/);
  assert.match(workflow, /Report task-level generation failures/);
  assert.match(workflow, /Summarize scheduled publishing result/);
  assert.doesNotMatch(workflow, /Using Groq-only transcription for apple-top-podcasts/);
  assert.match(workflow, /default:\s*hn-top10/);
  assert.doesNotMatch(workflow, /default:\s*all/);
  assert.doesNotMatch(workflow, /type:\s*choice\n\s+required:\s*true\n\s+default:\s*all\n\s+options:/);
  for (const task of ["ai-daily", "ai-weekly"]) {
    const prompt = fs.readFileSync(path.join(process.cwd(), "prompts/blog", `${task}.md`), "utf8");
    assert.match(prompt, /从零|入门教程|一文[读懂搞懂]/, `${task} prompt should mirror low-signal validator terms`);
  }
  const itemSummaryPrompt = fs.readFileSync(path.join(process.cwd(), "prompts/blog", "daily-digest-item-summary.md"), "utf8");
  const sectionPlannerPrompt = fs.readFileSync(path.join(process.cwd(), "prompts/blog", "daily-digest-section-planner.md"), "utf8");
  const techDailyPrompt = fs.readFileSync(path.join(process.cwd(), "prompts/blog", "tech-daily.md"), "utf8");
  assert.match(itemSummaryPrompt, /一次只处理一条候选/);
  assert.match(sectionPlannerPrompt, /动态规划《技术日报》的栏目/);
  assert.match(techDailyPrompt, /不要固定套用 AI\/工程\/商业三段式/);
  const generator = fs.readFileSync(path.join(process.cwd(), "scripts/generate_scheduled_post.ts"), "utf8");
  assert.match(generator, /retrying with validation feedback/);
  assert.match(generator, /上一轮 \$\{task\} 输出被发布质量检查拒绝/);
  assert.match(generator, /generateDailyPodcastArticles/);
  assert.match(generator, /buildDailyPodcastEpisodeArticle/);
  assert.match(generator, /buildCombinedTechDailySource/);
  assert.match(generator, /daily-digest-item-summary\.md/);
  assert.match(generator, /daily-digest-section-planner\.md/);
});

test("RSS source builders do not truncate summary evidence with clipText", () => {
  for (const file of ["tech_weekly_source.ts", "ai_weekly_source.ts", "tech_business_weekly_source.ts", "daily_digest_source.ts"]) {
    const source = fs.readFileSync(path.join(process.cwd(), "scripts", file), "utf8");
    assert.doesNotMatch(source, /clipText\(item\.summary \|\| item\.title/);
    assert.match(source, /摘要证据：\$\{compact\(item\.summary \|\| item\.title\)\}/);
  }
});

test("Yahoo Finance article extraction prefers public articleBody text", () => {
  const html = `<!doctype html><html><head><script type="application/ld+json">{"@type":"NewsArticle","articleBody":"Stocks closed mixed as technology shares lagged while industrial and consumer discretionary groups advanced. Analysts cited positioning around major index weights, but the article also noted that volume evidence was mixed across broad ETFs and did not by itself prove fund flows."}</script></head><body><article>fallback text</article></body></html>`;
  const text = extractYahooFinanceArticleText(html, "https://finance.yahoo.com/example");
  assert.match(text, /Stocks closed mixed/);
  assert.match(text, /did not by itself prove fund flows/);
});

test("market source uses the live EastMoney secid for Hang Seng Tech", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "scripts/market_daily_source.ts"), "utf8");
  assert.match(source, /hstech: "124\.HSTECH"/);
  assert.doesNotMatch(source, /hstech: "100\.HSTECH"/);
});

test("market source parses Hang Seng Tech Yahoo chart payload when currency is null", () => {
  const parsed = quoteRowFromYahooChartPayload({
    code: "HSTECH",
    name: "恒生科技指数",
    date: "2026-07-01",
    payload: {
      chart: {
        result: [
          {
            meta: {
              regularMarketPrice: 4472.23,
              chartPreviousClose: 4393.01,
              regularMarketTime: 1782806908,
              regularMarketVolume: 0,
            },
            timestamp: [1782806908],
            indicators: { quote: [{ close: [4472.22998046875], volume: [0] }] },
          },
        ],
      },
    },
  });
  assert.equal(parsed?.[0], "HSTECH");
  assert.equal(parsed?.[1].f2, 4472.22998046875);
  assert.match(String(parsed?.[1].f3), /^1\.80/);
});

test("asia market daily does not hard-fail when only Hang Seng Tech is missing", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "scripts/market_daily_source.ts"), "utf8");
  assert.match(source, /const REQUIRED_ASIA_CORE_QUOTES = \[\.\.\.YAHOO_SYMBOLS\.aShare, YAHOO_SYMBOLS\.hk\[0\], YAHOO_SYMBOLS\.hk\[1\]\]/);
  assert.match(source, /assertRequiredQuotes\(rows, REQUIRED_ASIA_CORE_QUOTES, "亚洲市场日报"\)/);
  assert.match(source, /if \(code === "HSTECH"\) return yahooChartQuote\(symbolConfig, date\)\.catch\(\(\) => null\)/);
  assert.match(source, /恒生科技指数未获取到完整数据/);
});

test("Yahoo Finance article evidence is rejected when index moves conflict with closing data", () => {
  const conflicting = "The S&P 500 Index today is down -1.26%, the Dow Jones Industrial Average is down -0.30%, and the Nasdaq 100 Index is down -2.69%.";
  assert.equal(articleConflictsWithIndexSnapshot(conflicting, { dji: 0.35, nasdaq: -0.43, spx: -0.1 }), true);

  const compatible = "The S&P 500 Index closed down -0.10%, the Dow Jones Industrial Average gained +0.35%, and the Nasdaq 100 Index slipped -0.43%.";
  assert.equal(articleConflictsWithIndexSnapshot(compatible, { dji: 0.35, nasdaq: -0.43, spx: -0.1 }), false);
});

test("US market section includes stock and volume evidence without treating volume as fund flow", () => {
  const section = buildUsSection(
    {
      DJIA: { f2: 46000, f3: 0.35 },
      NDX: { f2: 25000, f3: -0.43 },
      SPX: { f2: 6600, f3: -0.1 },
    },
    "2099-01-06",
    [
      { symbol: "XLI", name: "工业", close: 100, pct: 1.16, volume: 130_000_000, avgVolume20: 100_000_000, volumeRatio: 1.3 },
      { symbol: "XLE", name: "能源", close: 80, pct: -1.63, volume: 90_000_000, avgVolume20: 100_000_000, volumeRatio: 0.9 },
    ],
    [
      { symbol: "NVDA", name: "英伟达(NVDA)", close: 180, pct: 2.4, volume: 240_000_000, avgVolume20: 200_000_000, volumeRatio: 1.2 },
      { symbol: "AAPL", name: "苹果(AAPL)", close: 220, pct: 1.1, volume: 70_000_000, avgVolume20: 80_000_000, volumeRatio: 0.88 },
      { symbol: "MSFT", name: "微软(MSFT)", close: 510, pct: 0.6, volume: 30_000_000, avgVolume20: 28_000_000, volumeRatio: 1.07 },
      { symbol: "AMZN", name: "亚马逊(AMZN)", close: 230, pct: 0.2, volume: 45_000_000, avgVolume20: 44_000_000, volumeRatio: 1.02 },
      { symbol: "META", name: "Meta(META)", close: 700, pct: -1.0, volume: 20_000_000, avgVolume20: 21_000_000, volumeRatio: 0.95 },
      { symbol: "TSLA", name: "特斯拉(TSLA)", close: 300, pct: -2.1, volume: 100_000_000, avgVolume20: 140_000_000, volumeRatio: 0.71 },
    ],
    [{ symbol: "QQQ", name: "QQQ", close: 560, pct: -0.4, volume: 65_000_000, avgVolume20: 50_000_000, volumeRatio: 1.3 }],
    [
      {
        title: "Stock market today: Nasdaq slips as industrials rise",
        url: "https://finance.yahoo.com/news/stock-market-today-example.html",
        publishedAt: "2099-01-06T21:30:00.000Z",
        bodyText: `Yahoo Finance article text says stocks closed mixed as industrial shares rose while technology shares lagged, and it frames the move as a market narrative rather than a complete causal explanation. ${"market ".repeat(160)} MARKET_BODY_TAIL_SENTINEL`,
      },
    ],
  );

  assert.match(section.markdown, /按已获取的完整常规收盘口径/);
  assert.match(section.markdown, /## 宽基指数/);
  assert.match(section.markdown, /## 行业指数/);
  assert.match(section.markdown, /## 个股样本/);
  assert.match(section.markdown, /核心个股涨幅靠前：英伟达\(NVDA\) \+2\.40%/);
  assert.match(section.markdown, /核心个股跌幅靠前：特斯拉\(TSLA\) -2\.10%/);
  assert.match(section.markdown, /主要宽基 ETF 成交活跃度：QQQ 当日成交量约 6500万股，约为近 20 个交易日均量的 1\.30 倍，成交活跃度偏高/);
  assert.match(section.markdown, /成交量只能描述活跃度，不等同于真实资金流/);
  assert.match(section.markdown, /外部财经文章正文线索/);
  assert.match(section.markdown, /https:\/\/finance\.yahoo\.com\/news\/stock-market-today-example\.html/);
  assert.match(section.markdown, /只作为市场叙事辅助证据/);
  assert.match(section.markdown, /MARKET_BODY_TAIL_SENTINEL/);
  assert.doesNotMatch(section.markdown, /资金流入|资金流出|机构买入|机构卖出/);
});

test("US market section degrades when 20-day average volume is unavailable", () => {
  const section = buildUsSection(
    {
      DJIA: { f2: 46000, f3: 0.35 },
      NDX: { f2: 25000, f3: -0.43 },
      SPX: { f2: 6600, f3: -0.1 },
    },
    "2099-01-06",
    [{ symbol: "XLK", name: "科技", close: 100, pct: -0.62, volume: 50_000_000 }],
    [],
    [{ symbol: "SPY", name: "SPY", close: 660, pct: -0.1, volume: 80_000_000 }],
  );

  assert.match(section.markdown, /核心个股样本未获取到稳定数据/);
  assert.match(section.markdown, /已获取当日成交量，但近 20 个交易日均量不足，暂不判断放量或缩量/);
});

test("US market verifier accepts explicit no-complete-regular-close source boundary", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-us-market-boundary-"));
  const sourcePath = path.join(repo, "us-source.md");
  fs.writeFileSync(
    sourcePath,
    `## 美股

美股当日未产生完整常规收盘数据，本节不做涨跌与板块强弱判断。

数据边界：本篇不生成道指、纳指、标普500或行业 ETF 强弱结论。
`,
  );
  const body = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/us-market-daily.md"), "utf8");
  const result = archivePost({ task: "us-market-daily", date: "2099-01-02", repo, body, force: true });
  const resultJson = path.join(repo, "result.json");
  fs.writeFileSync(resultJson, JSON.stringify({ date: "2099-01-02", results: [{ ...result, generation: { source_artifact: sourcePath } }] }));
  assert.equal(verifyResultJson(repo, resultJson), 1);
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

test("archive and verifier accept generated HN, market posts, podcast notes, weekly and daily digests", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-archive-"));
  const hnBody = `1. 🔥 Developers don't understand CORS
- ⭐ 185 points · 88 评论
- 主题：开发工具 / 编程语言
- 原文：https://example.com/cors
- HN 讨论：https://news.ycombinator.com/item?id=123
- 内容总结：文章解释了浏览器同源策略与 CORS 预检机制之间的关系，并指出很多后端开发者把跨域报错误解成服务端权限问题。作者用请求头、凭证模式和常见配置误区串起了 CORS 的真实执行路径。
- 评论总结：评论区主要补充了反向代理、CDN 和本地开发场景下最容易踩坑的缓存与凭证问题，也有人强调把通配配置当万能解法会埋下安全隐患。
`;
  const asiaBody = `## 总结

本篇亚洲市场日报覆盖 A股与港股。A股三大宽基同步上涨，上证指数 +1.78%、深证成指 +2.13%、创业板指 +2.52%；港股主要指数走弱，恒生指数 -0.65%、国企指数 -0.77%、恒生科技指数 -1.10%。

## A股

A股最近一个交易日，上证指数收报 3560.00 点，+1.78%；深证成指收报 10980.00 点，+2.13%；创业板指收报 2280.00 点，+2.52%。

## A股行业板块

涨幅靠前行业：半导体 +4.12%、软件开发 +3.80%、消费电子 +3.10%、证券 +2.75%、电池 +2.20%。跌幅靠前行业：煤炭 -1.10%、银行 -0.88%、公用事业 -0.55%、贵金属 -0.30%、石油行业 -0.12%。

## 港股

港股最近一个交易日，恒生指数收报 18400.00 点，-0.65%；国企指数收报 6600.00 点，-0.77%；恒生科技指数收报 3820.00 点，-1.10%。
`;
  const cryptoBody = `## 一句话结论

BTC 今天偏弱。价格约 62,521 美元，24 小时下跌 2.19%，7 日下跌 5.09%，说明压力不只是单日波动，而是一周内持续回落后的延续。

## 今天价格怎么走

价格已经回到 6.3 万美元下方，短线和一周维度都是负收益。对普通读者来说，最直接的读法是：BTC 现在还没摆脱弱势，市场正在测试下方承接。

## 市场情绪冷不冷

Fear & Greed 为 17，属于 Extreme Fear，市场情绪明显偏冷。这个读数和价格回落方向一致，说明当前不是热情追涨的环境，而是更多人在转向防御。

## 短线风险在哪里

短线风险主要来自“有人在为下跌买保险”。期权数据显示，近端 5% OTM Put IV 高于 5% OTM Call IV，可以翻译成一句人话：短期下跌保险更贵，市场对下方波动更敏感。

但杠杆端没有显示明显踩踏。Deribit 永续资金费率接近中性，全期限 Put/Call OI 也没有显示全面押注下跌，所以今天更像“弱势中的短线防守”，不是全市场一致看崩。
`;
  const usBody = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/us-market-daily.md"), "utf8");
  const hn = archivePost({ task: "hn-top10", date: "2099-01-02", repo, body: hnBody, force: true });
  const hnMarkdown = fs.readFileSync(path.join(repo, hn.path), "utf8");
  assert.match(hnMarkdown, /pubDatetime: 2099-01-01T16:00:00Z/);
  assert.doesNotMatch(hnMarkdown, /今日 HackerNews 热门文章 Top 10|今日总览/);
  assert.match(hnMarkdown, /^## 1\. Developers don't understand CORS/m);
  const asia = archivePost({ task: "asia-market-daily", date: "2099-01-02", repo, body: asiaBody, force: true });
  const crypto = archivePost({ task: "crypto-market-daily", date: "2099-01-02", repo, body: cryptoBody, force: true });
  const podcastBody = `${fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/daily-podcasts.md"), "utf8")}

这期还谈到产品布局和值得关注的设计工作流，这些是产品访谈里的正常语义，不应被市场日报的投顾口吻过滤误伤。
`;
  const us = archivePost({ task: "us-market-daily", date: "2099-01-02", repo, body: usBody, force: true });
  const podcast = archivePost({ task: "daily-podcasts", date: "2099-01-02", repo, body: podcastBody, force: true });
  const techWeeklyBody = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/tech-weekly.md"), "utf8");
  const techWeekly = archivePost({ task: "tech-weekly", date: "2099-01-03", repo, body: techWeeklyBody, force: true });
  const aiWeeklyBody = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/ai-weekly.md"), "utf8");
  const aiWeekly = archivePost({ task: "ai-weekly", date: "2099-01-04", repo, body: aiWeeklyBody, force: true });
  const techBusinessWeeklyBody = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/tech-business-weekly.md"), "utf8");
  const techBusinessWeekly = archivePost({ task: "tech-business-weekly", date: "2099-01-05", repo, body: techBusinessWeeklyBody, force: true });
  const techDailyBody = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/tech-daily.md"), "utf8");
  const techDaily = archivePost({ task: "tech-daily", date: "2099-01-06", repo, body: techDailyBody, force: true });
  const aiDailyBody = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/ai-daily.md"), "utf8");
  const aiDaily = archivePost({ task: "ai-daily", date: "2099-01-06", repo, body: aiDailyBody, force: true });
  const techBusinessDailyBody = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/tech-business-daily.md"), "utf8");
  const techBusinessDaily = archivePost({ task: "tech-business-daily", date: "2099-01-06", repo, body: techBusinessDailyBody, force: true });
  const asiaMarkdown = fs.readFileSync(path.join(repo, asia.path), "utf8");
  const cryptoMarkdown = fs.readFileSync(path.join(repo, crypto.path), "utf8");
  const usMarkdown = fs.readFileSync(path.join(repo, us.path), "utf8");
  const podcastMarkdown = fs.readFileSync(path.join(repo, podcast.path), "utf8");
  const techWeeklyMarkdown = fs.readFileSync(path.join(repo, techWeekly.path), "utf8");
  const aiWeeklyMarkdown = fs.readFileSync(path.join(repo, aiWeekly.path), "utf8");
  const techBusinessWeeklyMarkdown = fs.readFileSync(path.join(repo, techBusinessWeekly.path), "utf8");
  const techDailyMarkdown = fs.readFileSync(path.join(repo, techDaily.path), "utf8");
  const aiDailyMarkdown = fs.readFileSync(path.join(repo, aiDaily.path), "utf8");
  const techBusinessDailyMarkdown = fs.readFileSync(path.join(repo, techBusinessDaily.path), "utf8");
  assert.match(asiaMarkdown, /title: "亚洲市场日报｜2099-01-02"/);
  assert.match(asiaMarkdown, /A股行业板块/);
  assert.match(cryptoMarkdown, /title: "比特币日报｜2099-01-02"/);
  assert.match(cryptoMarkdown, /一句话结论/);
  assert.match(cryptoMarkdown, /今天价格怎么走/);
  assert.match(cryptoMarkdown, /市场情绪冷不冷/);
  assert.match(cryptoMarkdown, /短线风险在哪里/);
  assert.doesNotMatch(cryptoMarkdown, /数据边界/);
  assert.doesNotMatch(cryptoMarkdown, /BTC 现货状态|永续与杠杆结构|期权与保护需求|情绪与风险边界/);
  assert.doesNotMatch(cryptoMarkdown, /ETH|Solana|SOL|BNB|主流资产|分类板块|全市场概览/);
  assert.match(usMarkdown, /title: "美股市场日报｜2099-01-02"/);
  assert.match(usMarkdown, /## 宽基指数/);
  assert.match(usMarkdown, /## 行业指数/);
  assert.match(usMarkdown, /## 个股样本/);
  assert.match(podcastMarkdown, /title: "Latent Space：Building Reliable AI Developer Platforms"/);
  assert.doesNotMatch(podcastMarkdown, /^##\s*今日总览\s*$/m);
  assert.doesNotMatch(podcastMarkdown, /^##\s*今日播客清单\s*$/m);
  assert.match(podcastMarkdown, /### 长文笔记/);
  assert.match(techWeeklyMarkdown, /title: "技术趋势与工程观察｜2099-01-03"/);
  assert.match(techWeeklyMarkdown, /技术周刊/);
  assert.match(techWeeklyMarkdown, /^## 工程观察/m);
  assert.match(techWeeklyMarkdown, /工程价值|工程含义|工程实践|迁移风险|采用成本|变更管理/);
  assert.doesNotMatch(techWeeklyMarkdown, /一文[读看搞]懂|从零|入门教程|基础教程|面试题/);
  assert.match(aiWeeklyMarkdown, /title: "AI 周刊｜2099-01-04"/);
  assert.match(aiWeeklyMarkdown, /AI周刊/);
  assert.match(aiWeeklyMarkdown, /^## Agent 与工程化/m);
  assert.match(aiWeeklyMarkdown, /能力|边界|成本|风险|治理|评测|安全|上下文|推理|Agent|模型|企业|生产/);
  assert.doesNotMatch(aiWeeklyMarkdown.split("---\n\n").at(-1) || "", /融资|工具榜单|提示词技巧|论文导读|赋能|颠覆|革命性|不容错过|值得关注/);
  assert.match(techBusinessWeeklyMarkdown, /title: "科技商业观察周刊｜2099-01-05"/);
  assert.match(techBusinessWeeklyMarkdown, /科技商业观察/);
  assert.match(techBusinessWeeklyMarkdown, /^## 政策、监管与安全/m);
  assert.match(techBusinessWeeklyMarkdown, /影响|风险|监管|政策|安全|平台|公司|商业|市场|企业|不确定|观察/);
  assert.doesNotMatch(techBusinessWeeklyMarkdown.split("---\n\n").at(-1) || "", /娱乐八卦|购物推荐|工具榜单|融资快讯|投资建议|买卖建议|股价预测|赋能|颠覆|革命性|不容错过|值得关注/);
  assert.match(techDailyMarkdown, /title: "技术日报｜2099-01-06"/);
  assert.match(techDailyMarkdown, /技术日报/);
  assert.match(techDailyMarkdown, /今日总览/);
  assert.match(techDailyMarkdown, /工程影响|工程风险|架构|版本|安全|迁移/);
  assert.match(aiDailyMarkdown, /title: "AI 工程日报｜2099-01-06"/);
  assert.match(aiDailyMarkdown, /AI工程日报/);
  assert.match(aiDailyMarkdown, /Agent|模型|成本|风险|评测|治理|工程/);
  assert.doesNotMatch(aiDailyMarkdown.split("---\n\n").at(-1) || "", /^#\s+/m);
  assert.match(techBusinessDailyMarkdown, /title: "科技商业观察日报｜2099-01-06"/);
  assert.match(techBusinessDailyMarkdown, /科技商业观察日报/);
  assert.doesNotMatch(techBusinessDailyMarkdown.split("---\n\n").at(-1) || "", /^#\s+/m);
  assert.match(techBusinessDailyMarkdown, /监管|政策|商业|企业|供应链|不确定|风险/);
  for (const markdown of [asiaMarkdown, cryptoMarkdown, usMarkdown]) {
    assert.match(markdown, /pubDatetime: 2099-01-01T16:00:00Z/);
    assert.doesNotMatch(markdown, /建议关注|值得关注|继续关注|最看好|赚钱点子|操作|布局/);
  }
  assert.match(asiaMarkdown.split("---\n\n").at(-1) || "", /^## 总结/m);
  assert.match(usMarkdown.split("---\n\n").at(-1) || "", /^## 总结/m);
  assert.match(cryptoMarkdown.split("---\n\n").at(-1) || "", /^## 一句话结论/m);
  const resultJson = path.join(repo, "result.json");
  fs.writeFileSync(resultJson, JSON.stringify({ date: "2099-01-06", results: [hn, asia, crypto, us, podcast, techWeekly, aiWeekly, techBusinessWeekly, techDaily, aiDaily, techBusinessDaily] }));
  assert.equal(verifyResultJson(repo, resultJson), 11);
});

test("tech weekly rejects pure tutorial language", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-tech-weekly-bad-"));
  const body = `## 本周快讯

### [一文搞懂 Redis 基础教程](https://example.com/redis)

这是一篇没有工程事件的 API 详解，只是在讲基础知识。https://example.com/redis https://example.com/a https://example.com/b https://example.com/c https://example.com/d https://example.com/e`;
  assert.throws(() => archivePost({ task: "tech-weekly", date: "2099-01-03", repo, body, force: true }), /pure tutorial language|at least three expected sections/);
});

test("archive and verifier accept generated GitHub trending daily", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-github-trending-"));
  const body = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/github-trending-daily.md"), "utf8");
  const result = archivePost({ task: "github-trending-daily", date: "2099-01-06", repo, body, force: true });
  const markdown = fs.readFileSync(path.join(repo, result.path), "utf8");
  assert.match(markdown, /title: "GitHub 项目日报｜2099-01-06"/);
  assert.match(markdown, /GitHub项目日报/);
  assert.doesNotMatch(markdown, /^## 总结/m);
  assert.doesNotMatch(markdown, /^## 趋势观察/m);
  assert.doesNotMatch(markdown, /^## 数据边界/m);
  assert.match(markdown, /^## 1\. \[acme\/agent-lab\]\(https:\/\/github\.com\/acme\/agent-lab\)/m);
  assert.match(markdown, /^- Stars：12.4k/m);
  assert.match(markdown, /^- Forks：620/m);
  assert.match(markdown, /^- 今日新增 Stars：820/m);
  assert.match(markdown, /^- 项目总结：/m);
  assert.match(markdown, /^- 技术栈：/m);
  assert.match(markdown, /^- 使用场景：/m);
  assert.doesNotMatch(markdown, /^- README 摘要：/m);
  const resultJson = path.join(repo, "result.json");
  fs.writeFileSync(resultJson, JSON.stringify({ date: "2099-01-06", results: [result] }));
  assert.equal(verifyResultJson(repo, resultJson), 1);
});

test("task validation catches GitHub trending archive failures before publishing", () => {
  const body = fs
    .readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/github-trending-daily.md"), "utf8")
    .replace("开发者或工程团队。", "开发者或工程团队参考示例。");
  assert.throws(() => validateGeneratedMarkdownForTask(body, "github-trending-daily", "2099-01-06"), /forbidden language: 示例/);
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

test("AI weekly rejects low-signal AI content", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-ai-weekly-bad-"));
  const body = `## 本周模型与产品

### [10 个 AI 工具推荐](https://example.com/ai-tools)

这是一篇工具榜单和提示词技巧文章，没有模型能力边界、工程成本、治理风险或生产采用条件。https://example.com/a https://example.com/b https://example.com/c https://example.com/d https://example.com/e https://example.com/f`;
  assert.throws(() => archivePost({ task: "ai-weekly", date: "2099-01-04", repo, body, force: true }), /ai weekly contains low-signal language|at least three expected sections/);
});

test("AI daily low-signal rejection names the actual task", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-ai-daily-bad-"));
  const body = `## 今日模型与产品

### [10 个 AI 工具推荐](https://example.com/ai-tools)

这是一篇工具榜单和提示词技巧文章，没有模型能力边界、工程成本、治理风险或生产采用条件。https://example.com/ai-tools`;
  assert.throws(() => archivePost({ task: "ai-daily", date: "2099-01-06", repo, body, force: true }), /ai daily contains low-signal language/);
});

test("tech business weekly rejects low-signal news content", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-tech-business-weekly-bad-"));
  const body = `## 本周大事件

### [本周科技购物推荐与融资快讯](https://example.com/deals)

这是一篇购物推荐、工具榜单和融资快讯合集，还包含投资建议和股价预测，没有政策、监管、安全、平台、公司或商业影响判断。https://example.com/a https://example.com/b https://example.com/c https://example.com/d https://example.com/e https://example.com/f https://example.com/g https://example.com/h`;
  assert.throws(() => archivePost({ task: "tech-business-weekly", date: "2099-01-05", repo, body, force: true }), /low-signal language|at least three expected sections/);
});


test("daily digest verifier accepts one high-quality item", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-daily-one-item-"));
  const resultJson = path.join(repo, "result.json");
  const techDaily = archivePost({
    task: "tech-daily",
    date: "2099-01-06",
    repo,
    body: `# 技术日报｜2099-01-06

## 今日总览

今天的技术日报只保留一条高质量工程事件，避免为了数量塞入低相关内容。

## 平台工程

### [PostgreSQL release improves planner behavior](https://example.com/postgresql-planner)

PostgreSQL 的新版本改进 planner 行为，工程影响集中在复杂查询、索引选择和升级回归验证。适合数据库平台团队和依赖复杂 SQL 的业务系统关注；风险在于版本迁移可能改变执行计划，需要用真实查询集做延迟、错误率和回滚路径验证。`,
    force: true,
  });
  const aiDaily = archivePost({
    task: "ai-daily",
    date: "2099-01-06",
    repo,
    body: `# AI 工程日报｜2099-01-06

## 今日模型与产品

### [OpenAI adds enterprise routing controls](https://example.com/openai-routing)

OpenAI 增加企业模型路由控制，AI 工程影响在于模型选择、成本、审计和权限边界进入统一治理平面。适合多团队共用模型平台的企业；风险是策略配置错误会影响质量和合规，需要配套评测、回滚和日志审计。`,
    force: true,
  });
  const businessDaily = archivePost({
    task: "tech-business-daily",
    date: "2099-01-06",
    repo,
    body: `# 科技商业观察日报｜2099-01-06

## 今日大事件

### [EU opens platform policy probe](https://example.com/eu-platform-probe)

欧盟启动平台政策调查，商业影响集中在应用分发、支付规则和平台抽佣边界。受影响的是平台公司、开发者和订阅业务；风险在于监管周期长、地区规则可能分裂，后续需要观察处罚范围、整改要求和企业合规成本。`,
    force: true,
  });
  fs.writeFileSync(resultJson, JSON.stringify({ date: "2099-01-06", results: [techDaily, aiDaily, businessDaily] }));
  for (const result of [techDaily, aiDaily, businessDaily]) {
    const markdown = fs.readFileSync(path.join(repo, result.path), "utf8");
    assert.doesNotMatch(markdown.split("---\n\n").at(-1) || "", /^#\s+/m);
  }
  assert.equal(verifyResultJson(repo, resultJson), 3);
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
  fs.writeFileSync(resultJson, JSON.stringify({ date: "2099-01-06", results: [{ task: "ai-daily", path: "", failed: true, error: "validator rejected low-signal language" }] }));
  assert.equal(verifyResultJson(repo, resultJson), 0);
});


test("daily podcasts archive rejects repeated summaries and duplicate headings", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-podcast-repeat-"));
  const fixture = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/daily-podcasts.md"), "utf8");
  const repeatedParagraph = "这期节目最值得记录的地方，是它把 AI 编程工具从个人效率叙事里拽了出来。过去讨论 coding assistant，经常停留在“写得快不快”“补全准不准”；但一旦 agent 能持续提交变更，真正麻烦的问题就变成：这些变更如何进入代码库，谁来审核，出了问题如何回滚，以及平台怎样判断一批机器生成代码是否超过组织承载能力。";
  assert.throws(() => archivePost({ task: "daily-podcasts", date: "2099-01-02", repo, body: `${fixture}\n\n${repeatedParagraph}\n`, force: true }), /repeated summary content/);
  assert.throws(
    () => archivePost({ task: "daily-podcasts", date: "2099-01-02", repo, body: `${fixture}\n\n${fixture}`, force: true }),
    /duplicate episode heading/,
  );
});

test("result verifier checks source artifacts instead of generated prose style", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-source-contract-"));
  const sourcePath = path.join(repo, "crypto-source.md");
  fs.writeFileSync(
    sourcePath,
    `BTC source evidence.

CoinGecko BTC 现货：62,521 美元；24h -2.19%；7d -5.09%。
Deribit BTC-PERPETUAL 8h funding：-0.0010%；OI：6,159,000,000。
Deribit BTC option book Put/Call：0.61；近端 ATM IV：65.20%；5% OTM Put IV：76.06%；5% OTM Call IV：56.08%。
Alternative.me Fear & Greed：17（Extreme Fear）。
`,
  );
  const body = `## 一句话结论

BTC 偏弱，价格约 62,521 美元，24 小时和 7 日都在下跌。

## 今天价格怎么走

BTC 跌回 6.3 万美元下方，短线压力比较直接。

## 市场情绪冷不冷

Fear & Greed 处在 Extreme Fear，说明市场情绪明显偏冷。

## 短线风险在哪里

Deribit funding 接近中性，说明杠杆端没有明显踩踏；期权侧的下跌保险更贵，说明短线防守需求更高。
`;
  const result = archivePost({ task: "crypto-market-daily", date: "2099-01-02", repo, body, force: true });
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

  const badSourcePath = path.join(repo, "bad-crypto-source.md");
  fs.writeFileSync(
    badSourcePath,
    `BTC source evidence.

CoinGecko BTC 现货：62,521 美元。
Deribit BTC-PERPETUAL 8h funding：-0.0010%。
Alternative.me Fear & Greed：17（Extreme Fear）。
`,
  );
  fs.writeFileSync(
    resultJson,
    JSON.stringify({
      date: "2099-01-02",
      results: [
        {
          ...result,
          generation: {
            ai_model: "mock",
            source_artifact: badSourcePath,
            prompt_artifact: "",
            ai_response_artifact: "",
            mocked_ai: true,
          },
        },
      ],
    }),
  );

  assert.throws(() => verifyResultJson(repo, resultJson), /missing required source terms: Put\/Call, ATM IV, 5% OTM Put IV, 5% OTM Call IV/);
});
