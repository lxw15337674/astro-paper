---
name: astro-paper-morning-market-cron
description: Use when maintaining this repo's morning market blog cron pipeline, including the data-generation layer, archive behavior, article structure, and verification flow.
version: 1.1.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [astro-paper, cron, market, morning-brief, publishing, blog]
    related_skills: [hermes-agent, hermes-cronjob-operations, github-pr-workflow]
---

# Astro Paper Morning Market Cron

## Overview

This pipeline generates the daily morning market blog article for Astro Paper. It is a blog-first publishing chain rather than a chat push workflow, so the main maintenance target is the saved article in the repo — not merely whether a scheduler invocation completes.

This skill should preserve both:

1. **execution flow** — market data/article generation → archive into Astro;
2. **article contract** — the post should read like a structured morning market brief rather than a raw monitoring dump.

## When to Use

Use this skill when you are:
- repairing the morning market cron job;
- modifying the daily market article generation logic;
- adjusting article structure, title, or section behavior;
- validating that the generated market article builds correctly in Astro;
- tracing whether a failure belongs in the generator layer or the archive layer.

Do not use this skill for:
- HN Top 10 work;
- foreign-tech podcast work;
- weekly entertainment work.

## Pipeline Purpose

The target artifact is a daily Chinese market morning brief published as an Astro Paper post.

Typical target path:
- `src/content/posts/zh-cn/` under the morning-market naming convention

Publishing cadence:
- daily

Reader expectation:
- a structured market morning brief with clear takeaways, not a mechanical script-output log.

## Current Pipeline

### Main job
- Job ID: `bc96c9bab5e7`
- Name: `daily-morning-market-blog`
- Deliver: `local`
- Workdir: `/home/bhwa233/code/astro-paper`
- Script: `run_morning_market_archive.sh`
- Role: generate and archive the daily market article

## Data Sources and Upstream Dependencies

This skill should explicitly capture where the morning article comes from, because these posts are time-sensitive and easy to mischaracterize.

### Generation layer
Known related repo scripts include:
- `scripts/run_morning_market_ai_pipeline.py`
- `scripts/generate_morning_market_digest.py`

These represent the data-generation / article-generation layer for the market brief.

### Ownership split
- **market data collection / article drafting** belong to the generation layer;
- **Astro persistence** belongs to the archive layer;
- article voice/structure should usually be fixed in generation, not papered over only at save time.

### Debugging principle
When the article is wrong, classify the defect first:
- wrong or missing market content -> generation-layer problem;
- correct inputs but weak brief structure -> generation/article-shaping problem;
- correct article body but broken saved post -> archive problem.

## Article Contract

### Title rule
- visible title should use: `晨间市场观察｜YYYY-MM-DD`

### Structural expectations
The article should feel like a proper morning market brief.

That means:
- the post is daily and blog-oriented;
- `今日要点` should not be empty;
- sections should be organized and readable;
- the article should not read like a raw watcher log or diagnostic dump.

### Optional section rule
- the Hong Kong IPO section is optional and should appear only when relevant content exists.

### Tone rule
The article should be informative and structured. It should not feel like a chat notification pasted into a markdown file.

## Repo Files and Responsibilities

Known related files:
- `scripts/run_morning_market_ai_pipeline.py`
- `scripts/generate_morning_market_digest.py`

These should be treated as part of the morning-market content generation layer even if the top-level cron entrypoint script orchestrates them indirectly.

## Editing Strategy

### Change the generation layer when
- the article misses important market content;
- the summary sections are weak or empty;
- `今日要点` becomes empty;
- the prose sounds like raw system output rather than a morning brief.

### Change the archive layer when
- the article body is already correct before save, but the Astro post is malformed;
- the final path/frontmatter/content persistence is wrong.

### Important maintenance bias
Do not treat the morning brief as a chat alert. If the saved article reads like a monitoring log, that is a content-generation regression.

## Verification Workflow

1. Run the market generation path directly.
2. Read the generated markdown file under `src/content/posts/zh-cn/`.
3. Check that title, summary, and article sections match the intended morning-market format.
4. Confirm `今日要点` is not empty.
5. Confirm optional sections (such as Hong Kong IPO coverage) appear only when justified.
6. Run:
   ```bash
   pnpm run build
   ```

## Manual Cron Verification

When cron behavior changes:
- run job `bc96c9bab5e7` (`daily-morning-market-blog`);
- inspect the latest artifact under `~/.hermes/cron/output/bc96c9bab5e7/`;
- confirm the artifact corresponds to a correctly generated and archived market post;
- verify the saved Astro content file, not just the cron output wrapper.

Because the user prefers manual verification after cron edits, do not stop at updating the schedule or script.

## Common Pitfalls

1. **Reintroducing dependencies on deleted legacy cron artifact directories**
   - this chain should rely on the current pipeline, not stale historical paths.

2. **Letting the article regress into stiff script-output prose**
   - a successful job that produces an unreadable article is still a failure.

3. **Treating the piece as a chat alert instead of a blog post**
   - the morning market artifact is blog-first.

4. **Ignoring empty or weak `今日要点`**
   - this section is a key quality signal and should not be empty.

5. **Leaving source/generation ownership vague**
   - future fixes need to know the difference between generation problems and archive problems.

## Verification Checklist

- [ ] Source generation runs successfully
- [ ] Generated market article file is structurally correct
- [ ] Title follows `晨间市场观察｜YYYY-MM-DD`
- [ ] `今日要点` is present and non-empty
- [ ] Optional IPO appendix behaves correctly
- [ ] Article reads like a morning brief rather than a raw log
- [ ] `pnpm run build` passes
- [ ] Manual cron verification succeeds after changes
