---
name: astro-paper-weekly-entertainment-cron
description: Use when maintaining this repo's weekly entertainment recommendation cron pipeline, including the MDBList-based upstream, article upgrade rules, Chinese naming conventions, and Astro archive verification.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [astro-paper, cron, entertainment, mdblist, weekly, publishing, blog]
    related_skills: [hermes-agent, hermes-cronjob-operations, github-pr-workflow]
---

# Astro Paper Weekly Entertainment Cron

## Overview

This pipeline publishes the weekly Chinese entertainment recommendation article into Astro Paper. It uses an MDBList-oriented upstream source plus an article-upgrade/archive layer to produce a richer blog-style post.

## When to Use

Use this skill when you are:
- repairing the weekly entertainment cron chain;
- changing title, naming, summary, rating, or poster rules;
- editing the upgrade prompt or archive logic for the weekly recommendation post;
- verifying the final article structure after regeneration.

Do not use this skill for HN, podcasts, or morning market tasks.

## Current Pipeline

### Upstream source job
- Job ID: `404c8660ee38`
- Name: `mdblist-weekly-hot-highscore`

### Downstream archive job
- Job ID: `e226a7117f05`
- Name: `mdblist-weekly-astro-archive`
- Deliver: `local`

### Important repo files
- `scripts/upgrade_mdblist_weekly_article.py`
- `scripts/mdblist_weekly_upgrade_prompt.md`
- `scripts/astro_paper_archive.py`

## Important Current Editorial Rules

Current final article rules include:
- title uses `每周影视推荐｜YYYY-Www` style;
- work titles use `中文名（英文名）`;
- types are translated into Chinese;
- do **not** show Douban score in the final article;
- keep IMDb score;
- remove intro boilerplate such as:
  - `本周推荐看点`
  - `本周口碑观察`
  - keyword-style opening lead-in
- each item should keep poster + structured sections.

## Verification Workflow

1. Run the weekly source or upgrade flow directly.
2. Regenerate the article with the upgrade script.
3. Read the generated markdown file under `src/content/posts/zh-cn/`.
4. Run:
   ```bash
   pnpm run build
   ```
5. If cron behavior changed, manually trigger upstream and downstream jobs and inspect artifacts.

## Common Pitfalls

1. Reintroducing English-only titles.
2. Accidentally restoring Douban score display after it was explicitly removed.
3. Letting the article regress into database-dump phrasing instead of a Chinese editorial recommendation style.
4. Mixing old prompt rules with new structural requirements.

## Verification Checklist

- [ ] Generated titles use `中文名（英文名）`
- [ ] Chinese type labels are present
- [ ] Douban score is not displayed
- [ ] Article sections and posters are intact
- [ ] `pnpm run build` passes
- [ ] Manual cron verification succeeds after changes
