# Blog Cron Pipelines Index

This document is a lightweight navigation index for the blog-oriented cron pipelines in this repo.

Use it to discover which pipeline exists and which skill/doc/script to open next. Do **not** treat this file as the single source of truth for each pipeline's detailed formatting rules — those belong in the pipeline-specific skills.

## Current blog pipelines

### 1. HN Top 10
- Skill: `skills/software-development/astro-paper-hn-cron-publishing/SKILL.md`
- Extra doc: `docs/hn-cron-pipeline.md`
- Key scripts:
  - `scripts/hn_top10_source.py`
  - `scripts/run_archive_from_stdin.py`
  - `scripts/astro_paper_archive.py`
- Cron jobs:
  - upstream: `0373c42e95ea` — `hn-top10-local-markdown`
  - downstream: `8640cfe88f41` — `hn-top10-astro-archive`

### 2. Foreign Tech Podcast
- Skill: `skills/software-development/astro-paper-foreign-tech-podcast-cron/SKILL.md`
- Key downstream entrypoint:
  - `scripts/run_archive_from_stdin.py --task foreign-tech-podcast`
- Cron jobs:
  - upstream: `c771b111d8e8` — `daily-global-tech-podcast-markdown`
  - downstream: `9f9bc5f373fc` — `foreign-tech-podcast-astro-archive`

### 3. Morning Market
- Skill: `skills/software-development/astro-paper-morning-market-cron/SKILL.md`
- Known related scripts:
  - `scripts/run_morning_market_ai_pipeline.py`
  - `scripts/generate_morning_market_digest.py`
- Cron job:
  - main: `bc96c9bab5e7` — `daily-morning-market-blog`

### 4. Weekly Entertainment Recommendation
- Skill: `skills/software-development/astro-paper-weekly-entertainment-cron/SKILL.md`
- Key scripts:
  - `scripts/upgrade_mdblist_weekly_article.py`
  - `scripts/mdblist_weekly_upgrade_prompt.md`
  - `scripts/astro_paper_archive.py`
- Cron jobs:
  - upstream: `404c8660ee38` — `mdblist-weekly-hot-highscore`
  - downstream: `e226a7117f05` — `mdblist-weekly-astro-archive`

## Maintenance rule

Each pipeline has its own skill on purpose. Keep formatting rules, data-source notes, verification steps, and known pitfalls inside the pipeline-specific skill rather than merging them into one large shared skill.
