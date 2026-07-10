# Blog Cron Pipelines Index

This document is a lightweight navigation index for the blog-oriented cron pipelines in this repo.

Use it to discover which pipeline exists and which skill/doc/script to open next.

For the shared implementation architecture, operational boundaries, and verification model, see:
- `docs/blog-cron-technical-design.md`

Do **not** treat this file as the single source of truth for each pipeline's detailed formatting rules — those belong in the pipeline-specific skills.

## Current blog pipelines

### 1. HN Top 10
- Skill: `skills/software-development/astro-paper-hn-cron-publishing/SKILL.md`
- Extra doc: `docs/hn-cron-pipeline.md`
- Key scripts:
  - `scripts/hn_top10_source.ts`
  - `scripts/generate_scheduled_post.ts`
  - `scripts/astro_paper_archive.ts`
- Primary entrypoint:
  - `.github/workflows/scheduled-posts.yml` with `task=hn-top10`
- Schedule:
  - `30 9 * * *` UTC / 17:30 Asia/Shanghai
- Legacy context:
  - older Hermes jobs `0373c42e95ea` / `8640cfe88f41` are historical two-step publishing context, not the current source-of-truth path.

### 2. Daily Podcasts (foreign tech + Apple Top Shows)
- Skill: `skills/software-development/astro-paper-foreign-tech-podcast-cron/SKILL.md`
- Primary entrypoint:
  - `.github/workflows/scheduled-posts.yml` with `task=daily-podcasts`
- Key scripts/data:
  - `scripts/foreign_tech_podcast_source.ts` (merged foreign RSS + Apple Top Shows pool, one multimodal article per episode)
  - `scripts/podcast_ledger.ts` + `data/daily-podcasts/summarized.json` (fingerprint dedup of already-summarized episodes)
  - `prompts/blog/daily-podcasts.md`
  - `scripts/astro_paper_archive.ts`
  - `scripts/verify_blog_generation.ts`
- Schedule:
  - `30 1 * * *` UTC / 09:30 Asia/Shanghai

### 3. Morning Market
- Skill: `skills/software-development/astro-paper-morning-market-cron/SKILL.md`
- Known related scripts:
  - `scripts/run_morning_market_ai_pipeline.py`
  - `scripts/generate_morning_market_digest.py`
- Cron job:
  - main: `bc96c9bab5e7` — `daily-morning-market-blog`

### 4. Weekly Entertainment Recommendation
- Key scripts:
  - `scripts/mdblist_weekly_source.ts`
  - `scripts/mdblist_weekly_ledger.ts`
  - `scripts/mdblist_compose.ts`
  - `prompts/blog/weekly/mdblist-weekly.md`
  - `scripts/astro_paper_archive.ts`
- State:
  - `data/mdblist-weekly/recommended.json` (permanent TMDB movie / TMDB show-season deduplication)
- Workflow:
  - `.github/workflows/publish-mdblist-weekly.yml`

## Global blog maintenance cron

### 5. Blog generation check-and-repair
- Purpose: verifies whether the day’s Astro blog generation completed successfully and attempts repair when failures are detected.
- Cron job:
  - main: `9d09cf6e77f5` — `daily-blog-generation-check-and-repair`
- Scope note:
  - this is a maintenance/supervisor job for the blog pipelines rather than a content-generation pipeline itself
  - when pausing all blog-related automation, pause this job together with the content jobs so it does not continue re-triggering or repairing disabled pipelines

## Pause-all-blog-crons runbook

Use this procedure when the goal is to stop all blog-oriented scheduled publishing and its automatic repair loop, while leaving unrelated automations untouched.

### Included in the pause set
- GitHub Actions scheduled publishing workflows — current repo-owned publishing path for HN, podcasts, markets, GitHub Trending, daily digests, and weekly entertainment recommendations
- `bc96c9bab5e7` — `daily-morning-market-blog`
- `9d09cf6e77f5` — `daily-blog-generation-check-and-repair`
- legacy HN Hermes jobs `0373c42e95ea` / `8640cfe88f41` if they are found enabled in the scheduler

### Intentionally excluded from the pause set
- `95d01fa1f5c7` — weather brief; not a blog pipeline

### Operational rule
- Default interpretation of “暂停现在的所有博客定时任务” in this repo is:
  - pause every cron that directly generates, archives, publishes, or repairs Astro blog posts
  - do not pause unrelated utility/news jobs unless they are explicitly included by the user

### Verification checklist
1. List cron jobs and identify every blog generation, archive, and repair job by purpose, not only by name.
2. Pause the selected jobs.
3. Re-check job state and confirm each target job is in `paused` state.
4. Record the inclusion/exclusion rationale in repo docs when the pause set changes or the boundary becomes ambiguous.

## Maintenance rule

Each pipeline has its own skill on purpose. Keep formatting rules, data-source notes, verification steps, and known pitfalls inside the pipeline-specific skill rather than merging them into one large shared skill.
