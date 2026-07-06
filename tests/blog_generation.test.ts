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
import { type MarketTableData, renderMarketTable } from "../scripts/market_table_source.ts";
import { FEEDS, PodcastSourceInsufficientEpisodesError, buildForeignTechPodcastSource } from "../scripts/foreign_tech_podcast_source.ts";
import { bjtArchiveInstant, fetchText } from "../scripts/blog_common.ts";
import { normalizePodcastUrl } from "../scripts/foreign_tech_podcast_dedupe.ts";
import { appendSummarizedEpisode, isEpisodeSummarized, loadSummarizedFingerprints } from "../scripts/podcast_ledger.ts";
import { dedupeItems, eventFamilyKey } from "../scripts/daily_digest_source.ts";
import { articleConflictsWithIndexSnapshot, buildUsSection, extractYahooFinanceArticleText, quoteRowFromYahooChartPayload } from "../scripts/market_daily_source.ts";
import { buildGitHubTrendingDailySource, parseGitHubTrendingHtml, sanitizeReadmeText } from "../scripts/github_trending_daily_source.ts";
import { buildXyzRankTopEpisodesSource } from "../scripts/xyzrank_top_episodes_source.ts";
import { verifyResultJson } from "../scripts/verify_blog_generation.ts";
import { type ResultItem, settleDailyPodcastArticleResults, usesJsonComposer } from "../scripts/generate_scheduled_post.ts";
import { DAILY_DIGEST_TASKS, SCHEDULED_TASK_INPUTS, TASKS, scheduledTaskInput, taskInfo, taskPostRelPath, tasksForInput } from "../scripts/blog_tasks.ts";

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
  return dailyDigestMarkdownFromModelJson(raw, source, task);
}

test("market table renders category groups, pct/BP units and missing cells", () => {
  const data = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-sources/capital-market-daily-table.json"), "utf8")) as MarketTableData;
  const md = renderMarketTable(data);
  assert.match(md, /^## 市场速览$/m);
  assert.match(md, /\| 股票 \| 上证指数 \| 4043\.64 \| \+0\.37% \| \+1\.88% \|/);
  assert.match(md, /\| 债券 \| 1年国债到期收益率 \| 1\.1392 \| \+0\.25BP \| -19\.80BP \|/);
  assert.match(md, /\| 比特币 \| 比特币（美元） \| 68000 \| \+1\.20% \| -26\.88% \|/);
  // 同一分类只在首行显示分类名，其余留空。
  assert.match(md, /\|  \| 深证成指 \|/);
  // 缺失数据渲染为 —，不让整表失败。
  const missing = renderMarketTable({ date: "d", asof: "d", rows: [{ category: "外汇", name: "美元指数", unit: "pct", decimals: 4, latest: null, prev_close: null, year_open: null }] });
  assert.match(missing, /\| 外汇 \| 美元指数 \| — \| — \| — \|/);
});

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

test("blog task registry covers prompts, fixtures, archive paths and schedules", () => {
  for (const task of TASKS) {
    const info = taskInfo(task);
    assert.ok(info.titlePrefix);
    assert.ok(info.tag);
    assert.ok(info.description);
    assert.match(taskPostRelPath(task, "2099-01-02"), /^src\/content\/posts\/zh-cn\/.+2099-01-02\.md$/);
    assert.equal(fs.existsSync(promptPath("_common-article-rules")), true, "common article rules prompt missing");
    if (task === "capital-market-daily") {
      // 资本市场日报按段拆分：prompt / source / 模型 JSON fixture 都是 capital-market-{segment}。
      for (const segment of ["us", "asia", "crypto"]) {
        assert.equal(fs.existsSync(promptPath(`capital-market-${segment}`)), true, `capital-market-${segment} prompt missing`);
        assert.equal(fs.existsSync(path.join(process.cwd(), "tests/fixtures/blog-sources", `${task}-${segment}.md`)), true, `${task}-${segment} source fixture missing`);
        assert.equal(fs.existsSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses", `${task}-${segment}.json`)), true, `${task}-${segment} AI fixture missing`);
      }
      continue;
    }
    assert.equal(fs.existsSync(promptPath(task)), true, `${task} prompt missing`);
    assert.equal(fs.existsSync(path.join(process.cwd(), "tests/fixtures/blog-sources", `${task}.md`)), true, `${task} source fixture missing`);
    // JSON 组装家族的模型输出 fixture 是 .json；其余任务仍是 .md 正文。
    const aiFixtureExt = usesJsonComposer(task) ? "json" : "md";
    assert.equal(fs.existsSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses", `${task}.${aiFixtureExt}`)), true, `${task} AI fixture missing`);
  }
  assert.deepEqual(tasksForInput("daily-digests"), [...DAILY_DIGEST_TASKS]);
  assert.deepEqual(tasksForInput("all"), [...TASKS]);
  assert.equal(scheduledTaskInput("0 17 * * 1-5").task, "capital-market-daily");
  assert.equal(scheduledTaskInput("0 17 * * 1-5").marketSegment, "asia");
  assert.equal(scheduledTaskInput("5 17 * * *").marketSegment, "crypto");
  assert.equal(scheduledTaskInput("0 6 * * 2-6").marketSegment, "us");
  assert.equal(scheduledTaskInput("0 6 * * 2-6").dateOffset, -1);
  assert.equal(scheduledTaskInput("30 0 * * *").task, "daily-digests");
  assert.equal(scheduledTaskInput("30 0 * * *").dateTimeZone, "America/Los_Angeles");
  assert.equal(scheduledTaskInput("0 6 * * *").task, "hn-top10");
  assert.equal(scheduledTaskInput("0 6 * * *").dateTimeZone, "America/Los_Angeles");
  assert.equal(scheduledTaskInput("30 1 * * *").task, "daily-podcasts");
  assert.equal(scheduledTaskInput("0 2 * * 1").task, "xyzrank-top-episodes");
  assert.equal(scheduledTaskInput("0 2 * * 1").dateTimeZone, "Asia/Shanghai");
  assert.equal(scheduledTaskInput("0 23 * * *").task, "github-trending-daily");
  assert.equal(scheduledTaskInput("0 23 * * *").dateTimeZone, "America/Los_Angeles");
  assert.equal(scheduledTaskInput("unknown schedule").task, "all");
  for (const schedule of Object.keys(SCHEDULED_TASK_INPUTS)) {
    assert.match(schedule, /^\d+ \d+ \* \* (?:\*|\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/);
  }
  const workflowDir = path.join(process.cwd(), ".github/workflows");
  const manualWorkflow = fs.readFileSync(path.join(workflowDir, "scheduled-posts.yml"), "utf8");
  const publishWorkflow = fs.readFileSync(path.join(workflowDir, "blog-publish.yml"), "utf8");
  const scheduledWorkflowFiles = [
    "publish-daily-digests.yml",
    "publish-hn-top10.yml",
    "publish-podcasts.yml",
    "publish-capital-market-daily.yml",
    "publish-github-trending.yml",
    "publish-mdblist-weekly.yml",
  ];
  const scheduledWorkflows = scheduledWorkflowFiles.map(file => fs.readFileSync(path.join(workflowDir, file), "utf8")).join("\n");
  const workflow = `${manualWorkflow}\n${publishWorkflow}\n${scheduledWorkflows}`;
  const podcastSource = fs.readFileSync(path.join(process.cwd(), "scripts/foreign_tech_podcast_source.ts"), "utf8");
  for (const schedule of Object.keys(SCHEDULED_TASK_INPUTS)) {
    assert.match(scheduledWorkflows, new RegExp(`cron: "${schedule.replaceAll("*", "\\*")}"`));
  }
  for (const file of scheduledWorkflowFiles) {
    const wrapper = fs.readFileSync(path.join(workflowDir, file), "utf8");
    assert.match(wrapper, /uses: \.\/\.github\/workflows\/blog-publish\.yml/, `${file} should call the reusable publisher`);
    assert.match(wrapper, /secrets: inherit/, `${file} should pass repository secrets to the reusable publisher`);
  }
  assert.match(publishWorkflow, /workflow_call:/);
  assert.match(publishWorkflow, /group: scheduled-posts-\$\{\{ github\.ref \}\}/);
  assert.match(publishWorkflow, /inputs\.task == 'daily-podcasts'/);
  assert.match(publishWorkflow, /inputs\.task == 'xyzrank-top-episodes'/);
  assert.match(publishWorkflow, /AI_TIMEOUT_MS: 600000/);
  assert.match(publishWorkflow, /PODCAST_PROMPT_TRANSCRIPT_CHARS: 8000/);
  assert.match(publishWorkflow, /PODCAST_AUDIO_DOWNLOAD_TIMEOUT_MS: 120000/);
  assert.match(publishWorkflow, /Install ffmpeg for podcast transcription/);
  assert.match(publishWorkflow, /GEMINI_API_KEY: \$\{\{ secrets\.GEMINI_API_KEY \}\}/);
  assert.match(publishWorkflow, /PODCAST_TRANSCRIBE_PROVIDER: gemini/);
  assert.match(publishWorkflow, /PODCAST_GEMINI_MODEL: gemini-flash-latest/);
  assert.match(publishWorkflow, /PODCAST_GEMINI_SEGMENT_SECONDS: 1200/);
  assert.match(publishWorkflow, /PODCAST_GEMINI_MAX_INLINE_CHUNK_MB: 14/);
  assert.match(podcastSource, /function runGeminiTranscription/);
  assert.match(podcastSource, /inline_data/);
  assert.match(publishWorkflow, /PODCAST_GEMINI_ARTICLE_BASE_URL: https:\/\/right\.codes\/gemini/);
  assert.match(publishWorkflow, /PODCAST_GEMINI_ARTICLE_MODEL: gemini-3\.5-flash/);
  assert.match(podcastSource, /export async function buildDailyPodcastEpisodeArticle/);
  assert.match(podcastSource, /function prepareGeminiArticleAudioChunks/);
  assert.match(podcastSource, /atempo=\$\{speed\}/);
  assert.match(podcastSource, /libopus/);
  assert.match(publishWorkflow, /PODCAST_GEMINI_ARTICLE_AUDIO_SPEED: "1\.5"/);
  assert.match(publishWorkflow, /PODCAST_GEMINI_ARTICLE_AUDIO_CODEC: libopus/);
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
  // 播客转写不再用 Python，但资本市场日报的「市场速览」表格需要 Python + AkShare。
  assert.match(publishWorkflow, /pip install -r requirements\.txt/);
  assert.doesNotMatch(workflow, /podcast_whisper_model/);
  assert.match(publishWorkflow, /AI_FALLBACK_API_KEY:/);
  assert.match(publishWorkflow, /AI_FALLBACK_BASE_URL: \$\{\{ secrets\.AI_FALLBACK_BASE_URL \|\| 'https:\/\/api\.deepseek\.com' \}\}/);
  assert.match(publishWorkflow, /AI_FALLBACK_MODEL: \$\{\{ secrets\.AI_FALLBACK_MODEL \|\| 'deepseek-v4-flash' \}\}/);
  assert.match(publishWorkflow, /APPLE_TOP_PODCASTS_COUNT: 5/);
  assert.match(publishWorkflow, /PODCAST_MAX_EPISODES: \$\{\{ inputs\.podcast_max_episodes \|\| '10' \}\}/);
  assert.match(publishWorkflow, /PODCAST_MIN_EPISODES: 1/);
  assert.match(publishWorkflow, /PODCAST_CANDIDATE_EPISODES: 8/);
  assert.match(publishWorkflow, /FOREIGN_TECH_PODCAST_MAX_EPISODES: 5/);
  assert.match(publishWorkflow, /APPLE_TOP_PODCASTS_MAX_EPISODES: 5/);
  assert.match(publishWorkflow, /APPLE_TOP_PODCASTS_TRANSCRIBE_DELAY_MS: 15000/);
  assert.match(publishWorkflow, /PODCAST_FFMPEG_TIMEOUT_MS: 300000/);
  assert.match(publishWorkflow, /PODCAST_DAILY_MAX_EPISODE_MINUTES: 90/);
  assert.match(publishWorkflow, /XYZRANK_TOP_EPISODES_LIMIT: 5/);
  assert.match(publishWorkflow, /git checkout -B "\$\{GITHUB_REF_NAME\}" "origin\/\$\{GITHUB_REF_NAME\}"/);
  assert.match(publishWorkflow, /git pull --rebase -X theirs origin "\$\{GITHUB_REF_NAME\}"/);
  assert.match(publishWorkflow, /push attempt \$\{attempt\}\/3 failed; retrying after remote refresh/);
  assert.match(publishWorkflow, /Report task-level generation failures/);
  assert.match(publishWorkflow, /Summarize scheduled publishing result/);
  assert.doesNotMatch(workflow, /Using Groq-only transcription for apple-top-podcasts/);
  assert.match(manualWorkflow, /default:\s*hn-top10/);
  assert.doesNotMatch(manualWorkflow, /default:\s*all/);
  assert.doesNotMatch(manualWorkflow, /type:\s*choice\n\s+required:\s*true\n\s+default:\s*all\n\s+options:/);
  const generator = fs.readFileSync(path.join(process.cwd(), "scripts/generate_scheduled_post.ts"), "utf8");
  assert.match(generator, /generatePodcastArticles/);
  assert.match(generator, /buildDailyPodcastEpisodeArticle/);
  assert.match(generator, /buildCombinedTechDailySource/);
  assert.match(generator, /daily-digest-item-summary/);
  assert.match(generator, /daily-digest-section-planner/);
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
  const body = `## 美股\n\n美股当日未产生完整常规收盘数据，本节不做涨跌与板块强弱判断。`;
  const result = archivePost({ task: "capital-market-daily", date: "2099-01-02", repo, body, force: true, marketSegment: "us" });
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

test("archive and verifier accept generated HN, market posts, podcast notes, weekly and daily digests", () => {
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
  const techWeeklyBody = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/tech-weekly.md"), "utf8");
  const techWeekly = archivePost({ task: "tech-weekly", date: "2099-01-03", repo, body: techWeeklyBody, force: true });
  const aiWeeklyBody = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/ai-weekly.md"), "utf8");
  const aiWeekly = archivePost({ task: "ai-weekly", date: "2099-01-04", repo, body: aiWeeklyBody, force: true });
  const techBusinessWeeklyBody = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/tech-business-weekly.md"), "utf8");
  const techBusinessWeekly = archivePost({ task: "tech-business-weekly", date: "2099-01-05", repo, body: techBusinessWeeklyBody, force: true });
  const xyzRankTopEpisodeBody = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/xyzrank-top-episodes.md"), "utf8");
  const xyzRankTopEpisode = archivePost({ task: "xyzrank-top-episodes", date: "2099-01-06", repo, body: xyzRankTopEpisodeBody, force: true, fileNameSuffix: "01-jokes-aside" });
  const techDailyBody = composeFixtureBody("tech-daily");
  const techDaily = archivePost({ task: "tech-daily", date: "2099-01-06", repo, body: techDailyBody, force: true });
  const aiDailyBody = composeFixtureBody("ai-daily");
  const aiDaily = archivePost({ task: "ai-daily", date: "2099-01-06", repo, body: aiDailyBody, force: true });
  const techBusinessDailyBody = composeFixtureBody("tech-business-daily");
  const techBusinessDaily = archivePost({ task: "tech-business-daily", date: "2099-01-06", repo, body: techBusinessDailyBody, force: true });
  const artifactsDir = path.join(repo, "blog-generation-artifacts", "xyzrank-top-episodes");
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), "tests/fixtures/blog-sources/xyzrank-top-episodes.md"), path.join(artifactsDir, "source.fixture.md"));
  const xyzRankTopEpisodeWithSource = { ...xyzRankTopEpisode, generation: { source_artifact: "blog-generation-artifacts/xyzrank-top-episodes/source.fixture.md" } };
  const resultJson = path.join(repo, "result.json");
  fs.writeFileSync(resultJson, JSON.stringify({ date: "2099-01-06", results: [hn, podcast, techWeekly, aiWeekly, techBusinessWeekly, xyzRankTopEpisodeWithSource, techDaily, aiDaily, techBusinessDaily] }));
  assert.equal(verifyResultJson(repo, resultJson), 9);
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
  assert.doesNotThrow(() => dailyDigestMarkdownFromModelJson(JSON.stringify({ overview, sections: [{ title: "平台工程", items: [good] }] }), source, "tech-daily"));
  // 编造的链接不在 source 池 → 拒绝。
  assert.throws(
    () => dailyDigestMarkdownFromModelJson(JSON.stringify({ overview, sections: [{ title: "平台工程", items: [{ ...good, source_url: "https://evil.example.com/x" }] }] }), source, "tech-daily"),
    /outside the source pool/,
  );
  // 同一链接复用 → 拒绝。
  assert.throws(
    () => dailyDigestMarkdownFromModelJson(JSON.stringify({ overview, sections: [{ title: "平台工程", items: [good, { ...good, title_zh: "另一个标题" }] }] }), source, "tech-daily"),
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
  fs.writeFileSync(resultJson, JSON.stringify({ date: "2099-01-06", results: [{ task: "ai-daily", path: "", failed: true, error: "validator rejected low-signal language" }] }));
  assert.equal(verifyResultJson(repo, resultJson), 0);
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
  const body = `## 比特币

### 一句话结论

BTC 偏弱，价格约 62,521 美元，24 小时和 7 日都在下跌。

### 今天价格怎么走

BTC 跌回 6.3 万美元下方，短线压力比较直接。

### 市场情绪冷不冷

Fear & Greed 处在 Extreme Fear，说明市场情绪明显偏冷。

### 短线风险在哪里

Deribit funding 接近中性，说明杠杆端没有明显踩踏；期权侧的下跌保险更贵，说明短线防守需求更高。
`;
  const result = archivePost({ task: "capital-market-daily", date: "2099-01-02", repo, body, force: true, marketSegment: "crypto" });
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
    `这是一段与任何金融行情都完全无关的占位说明文本，它被刻意写得足够长，以便顺利通过来源最小长度检查（需要超过八十个字符），但是全文故意不包含任何股票指数名称或加密货币指标关键词，因此在来源契约校验阶段应当被判定为缺少市场证据而拒绝。
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

  assert.throws(() => verifyResultJson(repo, resultJson), /missing required source terms: market evidence/);
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
