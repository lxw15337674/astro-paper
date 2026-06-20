---
name: astro-paper-morning-market-cron
description: Use when maintaining this repo's morning market blog cron pipeline, including the daily market article generator, source dependencies, archive behavior, and verification flow.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [astro-paper, cron, market, morning-brief, publishing, blog]
    related_skills: [hermes-agent, hermes-cronjob-operations, github-pr-workflow]
---

# Astro Paper Morning Market Cron

## Overview

This pipeline generates the daily morning market blog article for Astro Paper. It is a blog-first pipeline, not a chat push pipeline.

## When to Use

Use this skill when you are:
- repairing the morning market cron job;
- modifying the daily market article generation logic;
- adjusting article structure, title, or description behavior;
- validating that the generated market article builds correctly in Astro.

Do not use this skill for HN, podcasts, or weekly entertainment tasks.

## Current Pipeline

### Main job
- Job ID: `bc96c9bab5e7`
- Name: `daily-morning-market-blog`
- Deliver: `local`
- Workdir: `/home/bhwa233/code/astro-paper`
- Script: `run_morning_market_archive.sh`

## Important Current Editorial Rules

- article is daily and blog-oriented;
- title style uses `晨间市场观察｜YYYY-MM-DD`;
- `今日要点` should not be empty;
- article structure should feel like a structured market morning brief, not a raw monitoring log;
- Hong Kong IPO section is optional and only appears when there is relevant content.

## Verification Workflow

1. Run the market generation script directly.
2. Read the generated markdown file under `src/content/posts/zh-cn/`.
3. Check that title, summary, and article sections match the intended market format.
4. Run:
   ```bash
   pnpm run build
   ```
5. If cron behavior changed, manually trigger the job and inspect the latest artifact under `~/.hermes/cron/output/<job_id>/`.

## Common Pitfalls

1. Reintroducing dependencies on deleted legacy cron artifact directories.
2. Letting the article regress into stiff script-output prose.
3. Treating the piece as a chat alert instead of a blog article.

## Verification Checklist

- [ ] Source generation runs successfully
- [ ] Generated market article file is structurally correct
- [ ] Optional IPO appendix behaves correctly
- [ ] `pnpm run build` passes
- [ ] Manual cron verification succeeds after changes
