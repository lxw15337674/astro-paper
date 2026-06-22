import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { archivePost } from "../scripts/astro_paper_archive.ts";
import { chatCompletionsUrl, renderPrompt, validateMarkdown } from "../scripts/ai_blog_writer.ts";
import { buildPayload, classify } from "../scripts/hn_top10_source.ts";
import { verifyResultJson } from "../scripts/verify_blog_generation.ts";

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

test("archive and verifier accept generated HN and market posts", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astro-paper-archive-"));
  const hnBody = `1. 🔥 Developers don't understand CORS
- ⭐ 185 points · 88 评论
- 主题：开发工具 / 编程语言
- 原文：https://example.com/cors
- HN 讨论：https://news.ycombinator.com/item?id=123
- 内容总结：文章解释了浏览器同源策略与 CORS 预检机制之间的关系，并指出很多后端开发者把跨域报错误解成服务端权限问题。作者用请求头、凭证模式和常见配置误区串起了 CORS 的真实执行路径。
- 评论总结：评论区主要补充了反向代理、CDN 和本地开发场景下最容易踩坑的缓存与凭证问题，也有人强调把通配配置当万能解法会埋下安全隐患。
`;
  const marketBody = `## 美股

三大指数表现为：纳指上涨 1.20%，标普500 上涨 0.60%，道指上涨 0.30%。从指数层面看，整体呈现科技权重相对占优。

## A股

A股最近一个交易日，上证指数小幅震荡，成交额维持在可观察区间。自动化日报只保留可复核指数信息，不在行业数据不足时硬编板块结论。

## 港股

港股最近一个交易日，恒生指数和国企指数同步整理。这个口径足以判断大盘风险偏好，但不足以替代完整行业涨跌幅。

## BTC 市场动态

BTC 当前参考价约为 100000 美元，近 24 小时变动 +1.50%。该数据只作为风险资产情绪的辅助观察。

## 总结

本篇自动化日报覆盖美股、A股、港股和 BTC，并明确把数据边界写进正文。
`;
  const hn = archivePost({ task: "hn-top10", date: "2099-01-02", repo, body: hnBody, force: true });
  const hnMarkdown = fs.readFileSync(path.join(repo, hn.path), "utf8");
  assert.doesNotMatch(hnMarkdown, /今日 HackerNews 热门文章 Top 10|今日总览/);
  assert.match(hnMarkdown, /^## 1\. Developers don't understand CORS/m);
  const market = archivePost({ task: "global-market-daily", date: "2099-01-02", repo, body: marketBody, force: true });
  const resultJson = path.join(repo, "result.json");
  fs.writeFileSync(resultJson, JSON.stringify({ date: "2099-01-02", results: [hn, market] }));
  assert.equal(verifyResultJson(repo, resultJson), 2);
});
