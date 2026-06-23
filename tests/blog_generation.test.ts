import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { archivePost } from "../scripts/astro_paper_archive.ts";
import { chatCompletionsUrl, renderPrompt, validateMarkdown } from "../scripts/ai_blog_writer.ts";
import { buildPayload, classify } from "../scripts/hn_top10_source.ts";
import { FEEDS, buildForeignTechPodcastSource } from "../scripts/foreign_tech_podcast_source.ts";
import { bjtArchiveInstant } from "../scripts/blog_common.ts";
import { verifyResultJson } from "../scripts/verify_blog_generation.ts";

test("BJT archive dates use UTC instants for Beijing midnight", () => {
  assert.equal(bjtArchiveInstant("2026-06-22"), "2026-06-21T16:00:00Z");
  assert.equal(bjtArchiveInstant("2099-01-02"), "2099-01-01T16:00:00Z");
});

test("AI writer renders prompts and normalizes chat completions URLs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-"));
  fs.writeFileSync(path.join(dir, "hn-top10.md"), "task={task}\ndate={date}\nsource={source_text}");
  const prompt = renderPrompt({ task: "hn-top10", date: "2099-01-02", sourceText: "hello", promptDir: dir });
  assert.equal(prompt, "task=hn-top10\ndate=2099-01-02\nsource=hello");
  assert.equal(chatCompletionsUrl("https://api.example.com/v1"), "https://api.example.com/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://api.example.com/v1/chat/completions"), "https://api.example.com/v1/chat/completions");
});

test("AI writer rejects placeholder markdown", () => {
  assert.match(validateMarkdown("```markdown\n## 标题\n\n" + "这是一段完整中文正文。".repeat(30) + "\n```"), /^## 标题/);
  assert.throws(() => validateMarkdown("## TODO\n\n" + "内容".repeat(120)), /forbidden pattern/);
});

test("foreign tech podcast source includes technical interview feeds", () => {
  const feeds = new Map(FEEDS.map(feed => [feed.show, feed.url]));
  assert.equal(feeds.get("Software Engineering Daily"), "https://softwareengineeringdaily.com/feed/podcast/");
  assert.equal(feeds.get("Software Engineering Radio"), "https://rss.libsyn.com/shows/21070/destinations/23379.xml");
  assert.equal(feeds.get("Oxide and Friends"), "https://feeds.transistor.fm/oxide-and-friends");
  assert.equal(feeds.get("The InfoQ Podcast"), "https://feeds.soundcloud.com/users/soundcloud:users:215740450/sounds.rss");
  assert.equal(feeds.get("Changelog Interviews"), "https://changelog.com/podcast/feed");
  assert.equal(feeds.get("The Data Engineering Show"), "https://feeds.fame.so/the-data-engineering-show");
  assert.equal(feeds.get("Dwarkesh Podcast"), "https://apple.dwarkesh-podcast.workers.dev/feed.rss");
  assert.equal(feeds.get("Gradient Dissent"), "https://feeds.captivate.fm/gradient-dissent/");
});

test("foreign tech podcast source supports curated external episodes", async () => {
  const previousDisableRss = process.env.PODCAST_DISABLE_RSS;
  const previousMinEpisodes = process.env.PODCAST_MIN_EPISODES;
  const previousMaxEpisodes = process.env.PODCAST_MAX_EPISODES;
  const previousAudioTranscribe = process.env.PODCAST_AUDIO_TRANSCRIBE;
  process.env.PODCAST_DISABLE_RSS = "true";
  process.env.PODCAST_MIN_EPISODES = "4";
  process.env.PODCAST_MAX_EPISODES = "4";
  process.env.PODCAST_AUDIO_TRANSCRIBE = "false";
  try {
    const source = await buildForeignTechPodcastSource("2026-06-23");
    assert.match(source, /The Oprah Podcast/);
    assert.match(source, /Apple Podcasts/);
    assert.match(source, /Megaphone/);
    assert.match(source, /Dario Amodei、Daniela Amodei/);
    assert.match(source, /时长：1:10:23/);
    assert.match(source, /音频：https:\/\/pdrl\.fm/);
    assert.match(source, /Claude and underage users/);
    assert.match(source, /未提供 transcript/);
    assert.doesNotMatch(source, /a16z\.simplecast\.com/);
  } finally {
    if (previousDisableRss === undefined) delete process.env.PODCAST_DISABLE_RSS;
    else process.env.PODCAST_DISABLE_RSS = previousDisableRss;
    if (previousMinEpisodes === undefined) delete process.env.PODCAST_MIN_EPISODES;
    else process.env.PODCAST_MIN_EPISODES = previousMinEpisodes;
    if (previousMaxEpisodes === undefined) delete process.env.PODCAST_MAX_EPISODES;
    else process.env.PODCAST_MAX_EPISODES = previousMaxEpisodes;
    if (previousAudioTranscribe === undefined) delete process.env.PODCAST_AUDIO_TRANSCRIBE;
    else process.env.PODCAST_AUDIO_TRANSCRIBE = previousAudioTranscribe;
  }
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

test("archive and verifier accept generated HN, split market posts, and podcast notes", () => {
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
  const cryptoBody = `## 总结

数字货币总市值约 2.61万亿美元，24小时成交量约 0.12万亿美元；BTC 市值占比 +52.40%，ETH 市值占比 +17.80%。以上内容只描述已获取数据对应的市场状态与数据边界，不生成交易动作或资产配置结论。

## 全市场概览

数字货币总市值约 2.61万亿美元，24小时成交量约 0.12万亿美元。全市场总市值 24小时变化率 +1.20%。BTC 市值占比 +52.40%，ETH 市值占比 +17.80%。

## 主流资产表现

- Bitcoin（BTC）：65,090 美元，24小时 +1.51%，市值约 1.28万亿美元
- Ethereum（ETH）：3,420 美元，24小时 +0.84%，市值约 0.41万亿美元
- Solana（SOL）：142 美元，24小时 -2.10%，市值约 0.07万亿美元

BTC/ETH 7日涨跌幅：BTC +3.20%、ETH -1.10%。

## 市场强弱结构

分类板块涨幅靠前：Layer 1 +1.20%、DeFi +0.70%、AI +0.50%。分类板块跌幅靠前：Meme -2.80%、Gaming -1.60%、RWA -0.40%。

## 衍生品与情绪辅助

BTC/ETH 衍生品辅助指标：BTC（CoinGecko Binance Futures）资金费率 +0.0100%，未平仓合约名义价值约 200.00亿美元；ETH（CoinGecko Binance Futures）资金费率 +0.0090%，未平仓合约名义价值约 100.00亿美元。
市场情绪辅助指标：Fear & Greed Index 为 42（Fear），更新时间 2099-01-02T00:00:00Z。上述衍生品与情绪指标仅作辅助记录，分类板块和涨跌排行会受到接口覆盖范围、流动性过滤和稳定币权重影响，不生成交易动作或资产配置结论。
`;
  const usBody = `## 总结

本篇美股市场日报覆盖完整常规收盘后的主要指数与行业 ETF 结构。美股三大指数分别为道指 +0.14%、纳指 +1.91%、标普500 +1.08%。

## 美股

美股最近一个完整常规收盘交易日，道指 +0.14%，纳指 +1.91%，标普500 +1.08%。

## 美股行业板块

表现靠前行业 ETF：科技 +1.85%、通信服务 +1.42%、可选消费 +0.92%、金融 +0.50%、工业 +0.31%。表现靠后行业 ETF：能源 -1.20%、公用事业 -0.60%、房地产 -0.44%、必需消费 -0.18%、材料 -0.10%。行业板块采用 S&P 500 行业 ETF 作为近似口径，用于观察风格结构，不等同于完整成分股贡献。
`;
  const hn = archivePost({ task: "hn-top10", date: "2099-01-02", repo, body: hnBody, force: true });
  const hnMarkdown = fs.readFileSync(path.join(repo, hn.path), "utf8");
  assert.match(hnMarkdown, /pubDatetime: 2099-01-01T16:00:00Z/);
  assert.doesNotMatch(hnMarkdown, /今日 HackerNews 热门文章 Top 10|今日总览/);
  assert.match(hnMarkdown, /^## 1\. Developers don't understand CORS/m);
  const asia = archivePost({ task: "asia-market-daily", date: "2099-01-02", repo, body: asiaBody, force: true });
  const crypto = archivePost({ task: "crypto-market-daily", date: "2099-01-02", repo, body: cryptoBody, force: true });
  const podcastBody = `${fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/foreign-tech-podcast.md"), "utf8")}

这期还谈到产品布局和值得关注的设计工作流，这些是产品访谈里的正常语义，不应被市场日报的投顾口吻过滤误伤。
`;
  const us = archivePost({ task: "us-market-daily", date: "2099-01-02", repo, body: usBody, force: true });
  const podcast = archivePost({ task: "foreign-tech-podcast", date: "2099-01-02", repo, body: podcastBody, force: true });
  const asiaMarkdown = fs.readFileSync(path.join(repo, asia.path), "utf8");
  const cryptoMarkdown = fs.readFileSync(path.join(repo, crypto.path), "utf8");
  const usMarkdown = fs.readFileSync(path.join(repo, us.path), "utf8");
  const podcastMarkdown = fs.readFileSync(path.join(repo, podcast.path), "utf8");
  assert.match(asiaMarkdown, /title: "亚洲市场日报｜2099-01-02"/);
  assert.match(asiaMarkdown, /A股行业板块/);
  assert.match(cryptoMarkdown, /title: "数字货币日报｜2099-01-02"/);
  assert.match(cryptoMarkdown, /全市场市值|总市值/);
  assert.match(cryptoMarkdown, /衍生品与情绪辅助/);
  assert.match(cryptoMarkdown, /BTC\/ETH 7日涨跌幅/);
  assert.doesNotMatch(cryptoMarkdown, /^##\s*数据边界(?:说明)?\s*$/m);
  assert.match(usMarkdown, /title: "美股市场日报｜2099-01-02"/);
  assert.match(usMarkdown, /美股行业板块/);
  assert.match(podcastMarkdown, /title: "海外科技访谈播客笔记｜2099-01-02"/);
  assert.doesNotMatch(podcastMarkdown, /^##\s*今日总览\s*$/m);
  assert.doesNotMatch(podcastMarkdown, /^##\s*今日播客清单\s*$/m);
  assert.match(podcastMarkdown, /### 长文笔记/);
  for (const markdown of [asiaMarkdown, cryptoMarkdown, usMarkdown]) {
    assert.match(markdown, /pubDatetime: 2099-01-01T16:00:00Z/);
    assert.match(markdown.split("---\n\n").at(-1) || "", /^## 总结/m);
    assert.doesNotMatch(markdown, /建议关注|值得关注|继续关注|最看好|赚钱点子|操作|布局/);
  }
  const resultJson = path.join(repo, "result.json");
  fs.writeFileSync(resultJson, JSON.stringify({ date: "2099-01-02", results: [hn, asia, crypto, us, podcast] }));
  assert.equal(verifyResultJson(repo, resultJson), 5);
});

test("foreign tech podcast rejects repeated summaries", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-podcast-repeat-"));
  const fixture = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/blog-ai-responses/foreign-tech-podcast.md"), "utf8");
  const repeatedParagraph = "这期节目最值得记录的地方，是它把 AI 编程工具从个人效率叙事里拽了出来。过去讨论 coding assistant，经常停留在“写得快不快”“补全准不准”；但一旦 agent 能持续提交变更，真正麻烦的问题就变成：这些变更如何进入代码库，谁来审核，出了问题如何回滚，以及平台怎样判断一批机器生成代码是否超过组织承载能力。";
  assert.throws(() => archivePost({ task: "foreign-tech-podcast", date: "2099-01-02", repo, body: `${fixture}\n\n${repeatedParagraph}\n`, force: true }), /repeated summary content/);
  assert.throws(
    () => archivePost({ task: "foreign-tech-podcast", date: "2099-01-02", repo, body: fixture.replace("## Data Centers, Energy, and the AI Infrastructure Stack", "## Building Reliable AI Developer Platforms"), force: true }),
    /duplicate episode heading/,
  );
});

test("market verifier rejects semantic drift in generated posts", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-market-semantic-"));
  const badPositiveDeclineBody = `## 总结

A股与港股市场可复核状态：A股可用宽基指数为上证指数 +1.78%、深证成指 +2.13%、创业板指 +2.52%；港股主要指数分别为恒生指数 -0.65%、国企指数 -0.77%、恒生科技指数 -1.19%。以上内容只描述已获取数据对应的市场状态与数据边界，不生成交易动作或资产配置结论。

## A股

A股最近一个交易日，上证指数收报 4163.10 点，+1.78%；深证成指收报 16372.50 点，+2.13%；创业板指收报 4359.39 点，+2.52%。成交额口径未获取到完整可比数据。

## A股行业板块

涨幅靠前行业：钨 +9.80%、磷肥及磷化工 +8.97%、钛白粉 +8.82%、铅锌 +8.03%、钼 +7.89%。
跌幅靠前行业：白银 +6.11%、钴 +6.18%、期货 +6.18%、磨具磨料 +6.22%、其他小金属 +6.43%。

## 港股

港股最近一个交易日，恒生指数收报 23768.52 点，-0.65%；国企指数收报 7914.74 点，-0.77%；恒生科技指数收报 4549.41 点，-1.19%。成交额口径未获取到完整可比数据。
`;
  const badMissingCoreBody = badPositiveDeclineBody
    .replace(
      "A股可用宽基指数为上证指数 +1.78%、深证成指 +2.13%、创业板指 +2.52%；港股主要指数分别为恒生指数 -0.65%、国企指数 -0.77%、恒生科技指数 -1.19%",
      "A股可用宽基指数为上证指数 +1.78%、深证成指 +2.13%；港股主要指数分别为恒生指数 -0.65%、国企指数 -0.77%。未获取到完整数据的指数：创业板指、恒生科技指数",
    )
    .replace("跌幅靠前行业：白银 +6.11%", "涨幅相对靠后行业：白银 +6.11%");
  const positiveDecline = archivePost({ task: "asia-market-daily", date: "2099-01-02", repo, body: badPositiveDeclineBody, force: true });
  const resultJson = path.join(repo, "result.json");
  fs.writeFileSync(resultJson, JSON.stringify({ date: "2099-01-02", results: [positiveDecline] }));
  assert.throws(() => verifyResultJson(repo, resultJson), /labels non-negative percentage list as decline/);

  const missingCore = archivePost({ task: "asia-market-daily", date: "2099-01-03", repo, body: badMissingCoreBody, force: true });
  fs.writeFileSync(resultJson, JSON.stringify({ date: "2099-01-03", results: [missingCore] }));
  assert.throws(() => verifyResultJson(repo, resultJson), /core Asia index missing-data language/);
});
