---
name: astro-paper-hn-cron-publishing
description: Use when maintaining this repo's Hacker News Top 10 cron-to-Astro pipeline, including the upstream source script, downstream archive step, formatting contract, and end-to-end verification.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [astro-paper, cron, hn, hackernews, publishing, blog]
    related_skills: [hermes-agent, hermes-cronjob-operations, github-pr-workflow]
---

# Astro Paper HN Cron Publishing

## Overview

This repo publishes a daily Chinese Hacker News Top 10 post through a two-step cron pipeline:

1. an upstream source job builds clean markdown source data;
2. a downstream archive job converts that source into an Astro Paper post.

The stable target is a blog article shaped like the published HN post, but with stronger `内容总结` and `评论总结` when the user asks for better editorial quality.

## When to Use

Use this skill when you are:
- repairing the HN Top 10 cron chain;
- modifying `scripts/hn_top10_source.py`;
- changing how HN source markdown is parsed into Astro posts;
- comparing the local generated HN article against the live HN article structure;
- verifying upstream and downstream HN cron jobs manually.

Do not use this skill for:
- foreign-tech podcast cron work;
- morning market cron work;
- weekly entertainment / MDBList cron work.

## Current Pipeline

### Upstream job
- Job ID: `0373c42e95ea`
- Name: `hn-top10-local-markdown`
- Workdir: `/home/bhwa233/code/astro-paper`
- Script: `scripts/hn_top10_source.py`

### Downstream job
- Job ID: `8640cfe88f41`
- Name: `hn-top10-astro-archive`
- Workdir: `/home/bhwa233/code/astro-paper`
- Script: `python3 /home/bhwa233/code/astro-paper/scripts/run_archive_from_stdin.py --task hn-top10 --period daily`

### Repo files
- `scripts/hn_top10_source.py` — upstream source generator
- `scripts/run_archive_from_stdin.py` — strips wrapper noise when present
- `scripts/astro_paper_archive.py` — parses HN source markdown and writes the Astro post
- `docs/hn-cron-pipeline.md` — extra focused reference

## Source Markdown Contract

The upstream script should emit exactly one clean markdown body, shaped like:

```md
1. 🔥 今日 HackerNews 热门文章 Top 10

1. 🔥 标题
- ⭐ 123 points · 45 评论
- 主题：...
- 原文：https://...
- HN 讨论：https://news.ycombinator.com/item?id=...
- 内容总结：...
- 评论总结：...
```

Important invariants:
- the first line is a document header, not item 1 content;
- each item uses dash bullets (`- ...`);
- `内容总结` and `评论总结` are single-line source fields, but may contain long prose;
- the source should contain no frontmatter and no chat-style preamble.

## Editorial Standard

Current target quality for the HN article is **方案 B / 中增强**:

### 内容总结
- 2~3 句
- explain what the article is about;
- surface the real core point or method;
- say why it is worth attention on today's HN list.

### 评论总结
- 2~3 句
- summarize the main HN discussion direction;
- identify the real disagreement or constraint;
- avoid empty filler like “大家主要讨论工程边界”.

Allow uneven length:
- stronger / higher-discussion items can run longer;
- weaker items may stay shorter, but should still feel editorial rather than placeholder.

## Archive Parser Expectations

`scripts/astro_paper_archive.py` currently needs to correctly handle:
- stripping the HN document header before item parsing;
- reading dash bullets and bullet dots;
- extracting:
  - 热度
  - 主题
  - 原文
  - HN 讨论
  - 内容总结
  - 评论总结
- preserving final article structure:
  - `## 今日看点`
  - `## 今日 Hacker News Top 10`
  - `### N. 标题`
  - `#### 内容总结`
  - `#### 评论总结`

## Verification Workflow

Run in this order:

1. Direct upstream check:
   ```bash
   python3 scripts/hn_top10_source.py | sed -n '1,140p'
   ```
2. Direct archive check:
   ```bash
   python3 scripts/hn_top10_source.py > /tmp/hn_top10_source_latest.md
   python3 scripts/astro_paper_archive.py --task hn-top10 --period daily --skip-git-pull < /tmp/hn_top10_source_latest.md
   ```
3. Read generated file:
   ```bash
   sed -n '1,220p' src/content/posts/zh-cn/hackernews-2026-06-20.md
   ```
4. Validate site build:
   ```bash
   pnpm run build
   ```
5. If verifying cron end-to-end:
   - run upstream job `0373c42e95ea`
   - wait for newest artifact in `~/.hermes/cron/output/0373c42e95ea/`
   - inspect `## Response`
   - run downstream job `8640cfe88f41`
   - inspect newest artifact in `~/.hermes/cron/output/8640cfe88f41/`

## Comparing with the Live Post

Reference live page:
- `https://blog.bhwa233.com/posts/hackernews-2026-06-20/`

Use it as a **structure reference**:
- keep the same article skeleton and section ordering;
- it is acceptable for the local regenerated copy to have better summaries than the live page if the user explicitly requested stronger writing.

## Common Pitfalls

1. **Treating the HN header line as item 1**
   - `1. 🔥 今日 HackerNews 热门文章 Top 10` is a document header.

2. **Forgetting dash-bullet compatibility**
   - the source now uses `- ...`, so the parser must not expect only `• ...`.

3. **Letting cron wrapper text leak into archive input**
   - `run_archive_from_stdin.py` must prefer the `## Response` section when present.

4. **Judging success only from cron artifact wrappers**
   - the real success target is the generated post file + successful local build.

5. **Making every summary the same shape**
   - strong items should sound more editorial; weaker items can stay concise.

## Verification Checklist

- [ ] `scripts/hn_top10_source.py` emits clean HN source markdown
- [ ] `scripts/run_archive_from_stdin.py` strips wrapper noise correctly
- [ ] `scripts/astro_paper_archive.py` parses current HN bullet format correctly
- [ ] generated HN post matches the intended Astro structure
- [ ] `pnpm run build` passes
- [ ] upstream and downstream cron jobs both manually verified when the pipeline changes
