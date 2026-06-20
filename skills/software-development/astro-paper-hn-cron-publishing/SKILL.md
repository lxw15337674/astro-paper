---
name: astro-paper-hn-cron-publishing
description: Use when maintaining this repo's Hacker News Top 10 cron-to-Astro pipeline, including the upstream source script, downstream archive step, data contract, article structure, and end-to-end verification.
version: 1.1.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [astro-paper, cron, hn, hackernews, publishing, blog]
    related_skills: [hermes-agent, hermes-cronjob-operations, github-pr-workflow]
---

# Astro Paper HN Cron Publishing

## Overview

This repo publishes a Chinese Hacker News Top 10 article through a two-step cron pipeline:

1. an upstream source job fetches and formats HN source material;
2. a downstream archive job converts that source into an Astro Paper post.

This skill is not just about running the cron. It also captures the **content contract** for the intermediate markdown and the final article structure, because many HN failures are format-contract failures rather than execution failures.

## When to Use

Use this skill when you are:
- repairing the HN Top 10 cron chain;
- modifying `scripts/hn_top10_source.py`;
- changing how HN source markdown is parsed into Astro posts;
- improving `内容总结` / `评论总结` quality;
- comparing the local generated HN article against the intended live article structure;
- verifying upstream and downstream HN cron jobs manually.

Do not use this skill for:
- foreign-tech podcast cron work;
- morning market cron work;
- weekly entertainment / MDBList cron work.

## Pipeline Purpose

The target artifact is a daily Chinese blog post summarizing the current HN Top 10 in a readable editorial format.

Typical target path:
- `src/content/posts/zh-cn/hackernews-YYYY-MM-DD.md`

Publishing cadence:
- daily

Reader expectation:
- a structured Chinese-language HN digest with useful summaries and meaningful comment synthesis, not a mechanically copied leaderboard.

## Current Pipeline

### Upstream job
- Job ID: `0373c42e95ea`
- Name: `hn-top10-local-markdown`
- Workdir: `/home/bhwa233/code/astro-paper`
- Script: `scripts/hn_top10_source.py`
- Role: fetch HN items and emit one clean markdown source document in the expected intermediate format

### Downstream job
- Job ID: `8640cfe88f41`
- Name: `hn-top10-astro-archive`
- Workdir: `/home/bhwa233/code/astro-paper`
- Script: `python3 /home/bhwa233/code/astro-paper/scripts/run_archive_from_stdin.py --task hn-top10 --period daily`
- Role: strip wrapper noise when present and archive the clean HN markdown into Astro content

## Data Sources and Upstream Dependencies

### Primary data source
The upstream HN job is the source-of-truth collector for the daily list. It is responsible for:
- obtaining the current top items;
- preserving title/link/discussion metadata;
- emitting the expected intermediate markdown format.

### Intermediate transport format
The source job does not write the final Astro article directly. Instead, it emits a **clean markdown source document** that downstream tooling parses.

This markdown contract matters because the archive layer depends on it exactly enough that format drift can break the whole chain.

### Archive dependency chain
- source collection and summarization -> `scripts/hn_top10_source.py`
- wrapper stripping / stdin normalization -> `scripts/run_archive_from_stdin.py`
- Astro article generation -> `scripts/astro_paper_archive.py`

## Repo Files and Responsibilities

### Key repo files
- `scripts/hn_top10_source.py` — upstream source generator
- `scripts/run_archive_from_stdin.py` — prefers the clean response body when cron wrapper text is present
- `scripts/astro_paper_archive.py` — parses HN source markdown and writes the Astro post
- `docs/hn-cron-pipeline.md` — focused reference document for this chain

### Responsibility boundaries
- `hn_top10_source.py` owns **what source markdown is emitted**;
- `run_archive_from_stdin.py` owns **normalizing wrapped stdin**;
- `astro_paper_archive.py` owns **parsing the source and saving the final Astro article**.

## Source Markdown Contract

The upstream script should emit exactly one clean markdown body shaped like:

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

### Invariants
- the first line is a **document header**, not item 1 content;
- each item uses dash bullets (`- ...`);
- `内容总结` and `评论总结` are source fields expected by downstream parsing;
- the source should contain no frontmatter;
- the source should contain no chat-style preamble or explanatory wrapper text.

If this contract drifts, fix the producer and/or parser explicitly rather than hand-waving around the mismatch.

## Final Article Contract

### Article structure
The final HN article should preserve the current Astro-style structure:
- `## 今日看点`
- `## 今日 Hacker News Top 10`
- `### N. 标题`
- `#### 内容总结`
- `#### 评论总结`

### Editorial quality target
The current expected writing quality is **方案 B / 中增强**.

#### 内容总结
- 2~3 句;
- explain what the linked article is about;
- surface the core idea, method, or observation;
- say why the item matters on today's HN list.

#### 评论总结
- 2~3 句;
- summarize the real HN discussion direction;
- identify the main disagreement, tradeoff, or constraint;
- avoid empty filler phrasing.

### Allowed unevenness
Not every item needs identical length:
- strong / highly discussed items may run longer;
- weaker items may stay shorter;
- the output should still sound editorial rather than placeholder-like.

## Comparing with the Live Post

Reference live page example:
- `https://blog.bhwa233.com/posts/hackernews-2026-06-20/`

Use it as a **structure reference**, not as a cap on quality.

That means:
- keep the same overall skeleton and section ordering;
- it is acceptable for regenerated local output to have stronger summaries if the user explicitly asked for better writing.

## Editing Strategy

### Change the source generator when
- the wrong HN items are selected;
- source fields are missing;
- the markdown transport format is malformed at emission time;
- summaries are too weak before they ever reach the archive layer.

### Change the stdin wrapper stripper when
- cron artifacts include wrapper noise and the wrong body is being archived;
- the `## Response` extraction logic is incorrect.

### Change the archive parser when
- the source markdown is correct but the saved Astro article is misparsed;
- bullets/headers/field extraction drift from the current source format;
- the final section ordering or Astro content generation is wrong.

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
3. Read generated file under `src/content/posts/zh-cn/`.
4. Confirm the saved article still preserves:
   - current HN article structure;
   - meaningful `内容总结`;
   - meaningful `评论总结`;
   - correct field extraction for links and metadata.
5. Validate site build:
   ```bash
   pnpm run build
   ```

## Manual Cron Verification

When the pipeline changes, verify both jobs explicitly.

### Upstream
- run upstream job `0373c42e95ea`;
- inspect the newest artifact in `~/.hermes/cron/output/0373c42e95ea/`;
- confirm the `## Response` section contains clean HN source markdown.

### Downstream
- run downstream job `8640cfe88f41`;
- inspect the newest artifact in `~/.hermes/cron/output/8640cfe88f41/`;
- confirm the generated Astro post matches the intended structure.

The true success criterion is not “cron printed something”; it is “generated Astro post is correct and build passes.”

## Common Pitfalls

1. **Treating the HN header line as item 1**
   - `1. 🔥 今日 HackerNews 热门文章 Top 10` is a document header, not an entry.

2. **Forgetting dash-bullet compatibility**
   - the source now uses `- ...`, so the parser must support that format.

3. **Letting cron wrapper text leak into archive input**
   - `run_archive_from_stdin.py` must prefer the actual response body when wrapper sections are present.

4. **Judging success only from cron artifact wrappers**
   - the real target is the saved Astro article plus successful local build.

5. **Making every summary identical in rhythm**
   - stronger HN items should read stronger; weak placeholder uniformity is a regression.

6. **Leaving the data contract undocumented**
   - this pipeline breaks easily if source-format ownership is unclear.

## Verification Checklist

- [ ] `scripts/hn_top10_source.py` emits clean HN source markdown
- [ ] source markdown still matches the current intermediate contract
- [ ] `scripts/run_archive_from_stdin.py` strips wrapper noise correctly
- [ ] `scripts/astro_paper_archive.py` parses current HN format correctly
- [ ] generated HN post matches the intended Astro structure
- [ ] `内容总结` quality remains useful
- [ ] `评论总结` quality remains useful
- [ ] `pnpm run build` passes
- [ ] upstream and downstream cron jobs both manually verified when the pipeline changes
