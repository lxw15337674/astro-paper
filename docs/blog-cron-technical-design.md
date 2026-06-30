# Blog Cron Technical Design

This document is the project-level technical design for the blog-oriented cron system in this repo.

It explains **how the blog cron system is implemented**, how responsibilities are split across jobs/scripts/archive logic, what each pipeline is expected to produce, and how to safely pause, repair, or extend the system.

For content-style rules of a specific pipeline, continue to use the pipeline-specific skill/docs as the source of truth. This file is the shared implementation map.

## Goals

The blog cron system exists to publish recurring Chinese-language content into the Astro Paper repo with stable automation and verifiable output.

The system is designed to guarantee:
- reproducible scheduled generation;
- stable file naming and overwrite behavior;
- separation between content generation and Astro persistence;
- local verification before considering the pipeline healthy;
- the ability to pause or repair blog automation without affecting unrelated cron jobs.

## System boundaries

### In scope
The blog cron system includes jobs that directly:
- generate blog-ready markdown;
- transform or upgrade upstream markdown into final article form;
- archive/persist final content into the Astro Paper repo;
- repair or supervise blog generation failures.

### Out of scope
The system does **not** automatically include every periodic content job in Hermes.

Examples of out-of-scope jobs unless explicitly requested:
- weather briefs;
- non-blog utility notifications;
- upstream digest jobs whose output is useful standalone but not part of the active Astro publishing leg the user intends to control.

This distinction matters operationally because “blog cron” in this repo means **Astro publishing automation**, not “all scheduled content of any kind”.

## High-level architecture

The implementation uses a layered pipeline model rather than one giant all-in-one cron job.

### Shared layers

1. **Source / generation layer**
   - collects source data or drafts markdown;
   - may be script-driven, agent-driven, or hybrid;
   - owns content selection and most article-shaping logic.

2. **Upgrade / normalization layer**
   - optional layer used when upstream content must be reshaped before publishing;
   - converts raw digest-like output into the article contract expected by the blog.

3. **Archive / persistence layer**
   - writes the final Markdown into the Astro Paper repo;
   - owns output path, frontmatter, overwrite semantics, and final content-file persistence.

4. **Supervisor / repair layer**
   - checks whether expected blog outputs were produced;
   - may trigger repair logic when pipeline steps fail.

This split is intentional: content defects should be fixed in the generation/upgrade layer, while file-layout defects should be fixed in the archive layer.

## Repository ownership model

### Repo-owned implementation
Core publishing logic belongs in the project repo so the system remains inspectable and maintainable as part of the delivery artifact.

Known repo-owned implementation files include:
- `scripts/hn_top10_source.ts`
- `scripts/generate_scheduled_post.ts`
- `scripts/astro_paper_archive.ts`
- `scripts/run_morning_market_ai_pipeline.py`
- `scripts/generate_morning_market_digest.py`
- `scripts/upgrade_mdblist_weekly_article.py`
- `scripts/mdblist_weekly_upgrade_prompt.md`

### Hermes cron integration
Hermes cron jobs orchestrate these repo-owned flows.

Design rules:
- cron jobs should point to real scripts or explicit agent prompts;
- if Hermes cron `script` is used, the script should be a real file, not an inline shell blob;
- the repo should contain the durable implementation logic for publishing behavior;
- the final deliverable is the repo post/build result, not just a successful scheduler tick.

## Active pipeline inventory

### 1. Hacker News Top 10
Purpose:
- publish a daily Chinese HN roundup into Astro.

Primary pipeline:
- GitHub Actions workflow: `.github/workflows/scheduled-posts.yml`
- scheduled task: `hn-top10` at `30 9 * * *` UTC (17:30 Asia/Shanghai)
- manual dispatch input: `task=hn-top10`

Implementation split:
- source collection and source-markdown emission: `scripts/hn_top10_source.ts`
- orchestration/result JSON/artifacts: `scripts/generate_scheduled_post.ts`
- Astro archive write: `scripts/astro_paper_archive.ts`

Architecture note:
- GitHub Actions `Scheduled posts` is the current source-of-truth publishing path for HN.
- Older Hermes jobs `0373c42e95ea` / `8640cfe88f41` are legacy context and should not be treated as the active HN publishing source unless explicitly re-enabled.

### 2. Foreign Tech Podcast
Purpose:
- publish a daily Chinese long-form tech podcast note into Astro.

Primary pipeline:
- GitHub Actions workflow: `.github/workflows/scheduled-posts.yml`
- scheduled task: `daily-podcasts` at `30 1 * * *` UTC (09:30 Asia/Shanghai); merges the foreign tech RSS/curated pool with Apple Podcasts Top Shows and emits one multimodal article per episode
- manual dispatch input: `task=daily-podcasts`

Implementation split:
- source collection: `scripts/foreign_tech_podcast_source.ts` (`fetchMergedPodcastEpisodes` unions the foreign and Apple Top Shows pools)
- curated external entries: `data/foreign-tech-podcast/curated-episodes.json`
- prompt contract: `prompts/blog/daily-podcasts.md`
- archive write: `scripts/astro_paper_archive.ts`
- contract verification: `scripts/verify_blog_generation.ts`

Architecture note:
- GitHub Actions is the source-of-truth publishing path for this repo.
- The source builder first reads repository-curated YouTube / Apple Podcasts / external selected entries, then fills from RSS feeds and local Whisper transcripts when audio enclosures are available.
- Curated entries without audio are allowed, but must carry useful metadata/show notes and are explicitly marked as non-transcribed evidence so the AI cannot pretend to have heard the full episode.
- Older Hermes two-step notes (`daily-global-tech-podcast-markdown` → `foreign-tech-podcast-astro-archive`) are historical context, not the current repo-owned main path.

### 3. Morning Market
Purpose:
- publish the daily Chinese global market brief into Astro.

Job:
- main: `bc96c9bab5e7` — `daily-morning-market-blog`

Implementation split:
- generation / synthesis: `scripts/run_morning_market_ai_pipeline.py`
- market digest support logic: `scripts/generate_morning_market_digest.py`
- cron entrypoint orchestrates generation and archive completion.

Architecture note:
- although this currently appears as a single main job, the implementation still follows the same conceptual split between article generation and final repo persistence.

### 4. Weekly Entertainment Recommendation
Purpose:
- publish a weekly Chinese entertainment recommendation column into Astro.

Jobs:
- upstream: `404c8660ee38` — `mdblist-weekly-hot-highscore`
- downstream: `e226a7117f05` — `mdblist-weekly-astro-archive`

Implementation split:
- upstream source candidate list: `404c8660ee38`
- editorial upgrade/reshape: `scripts/upgrade_mdblist_weekly_article.py`
- editorial prompt contract: `scripts/mdblist_weekly_upgrade_prompt.md`
- Astro archive write: `scripts/astro_paper_archive.py`

Architecture note:
- this pipeline explicitly separates source-item selection from article-shaping so the final post can read like a recommendation column rather than a database export.

### 5. Blog generation check-and-repair
Purpose:
- supervise whether expected blog outputs were produced and repair failures.

Job:
- main: `9d09cf6e77f5` — `daily-blog-generation-check-and-repair`

Architecture note:
- this is not a content pipeline by itself;
- it is a supervisor job for the blog system;
- operationally it belongs to the blog cron system because it can re-trigger or repair blog pipelines.

## Data-flow patterns

### Pattern A: upstream markdown -> downstream archive
Used by:
- HN Top 10
- Foreign Tech Podcast
- Weekly Entertainment Recommendation

Flow:
1. upstream cron run produces markdown or source artifact;
2. downstream cron reads latest completed upstream output;
3. normalization/upgrade logic extracts the clean response body when needed;
4. archive logic writes the Astro post.

Advantages:
- isolates source generation from archival logic;
- allows independent debugging of source vs archive;
- makes cron artifacts inspectable.

### Pattern B: single cron orchestrator with internal substeps
Used by:
- Morning Market

Flow:
1. one cron entrypoint triggers the market article generation path;
2. helper scripts collect/shape data;
3. final article is archived into Astro.

Advantages:
- simpler scheduler surface for a tightly coupled pipeline;
- fewer scheduler edges when the generation/archive chain is strongly bound.

## Archive contract

Across pipelines, the archive layer is responsible for:
- writing to `src/content/posts/...`;
- preserving valid frontmatter;
- applying stable file naming for recurring periods;
- overwriting same-period content instead of creating duplicates when the contract requires stable identity;
- producing buildable Astro content.

The archive layer is **not** the right place to hide weak upstream content quality. If the article substance is wrong, fix generation/upgrade first.

## Operational rules

### Success criteria
A cron job is not “healthy” merely because it ran successfully.

A blog pipeline is healthy only if:
- the expected content file exists in the repo;
- the file content matches the pipeline contract;
- the local Astro build succeeds;
- when cron behavior changed, the modified job has been manually triggered and inspected.

### Repair policy
When a pipeline fails:
1. classify the failure by layer:
   - source/generation;
   - upgrade/normalization;
   - archive/persistence;
   - supervisor logic.
2. fix the owning layer rather than compensating in the wrong place;
3. manually rerun the changed cron path for verification.

### Pause policy
When the user asks to pause “all blog cron jobs”, default behavior in this repo is:
- pause jobs that directly generate, archive, publish, or repair Astro blog posts;
- keep unrelated non-blog jobs running unless explicitly included.

This means the default pause set currently includes:
- GitHub Actions `Scheduled posts` schedules — current repo-owned daily publishing path for HN, podcast, market, GitHub Trending, and daily digests
- `bc96c9bab5e7` — `daily-morning-market-blog`
- `e226a7117f05` — `mdblist-weekly-astro-archive`
- `9d09cf6e77f5` — `daily-blog-generation-check-and-repair`
- legacy HN Hermes jobs `0373c42e95ea` / `8640cfe88f41` if they are found enabled in the scheduler

By default it excludes:
- `95d01fa1f5c7` — weather brief
- `404c8660ee38` — weekly recommendation upstream source unless the user wants the source-digest leg stopped in addition to the Astro publishing leg

## Verification workflow

Use this shared verification model for any blog cron implementation change.

1. Identify which pipeline and which layer changed.
2. Run the owning script or direct local generation path first when practical.
3. Inspect the generated file under `src/content/posts/`.
4. Confirm the article still satisfies the pipeline-specific content contract.
5. Run:
   ```bash
   pnpm run build
   ```
6. If the cron behavior or orchestration changed, manually trigger the affected cron job(s).
7. Inspect the newest cron artifact(s) under `~/.hermes/cron/output/<job_id>/`.
8. Confirm that the saved Astro file, not just the cron wrapper output, is correct.

## Known design principles

### 1. Blog-first, not chat-first
These automations exist to produce Astro posts. Cron chat/status output is secondary.

### 2. Stable ownership boundaries
- selection/content sourcing belongs upstream;
- editorial reshaping belongs in generation or upgrade logic;
- persistence belongs in archive logic;
- repair belongs in supervisor logic.

### 3. Repo-local durability
Publishing logic should live in the repo wherever possible so future maintainers can inspect and evolve it in one place.

### 4. Manual verification after cron changes
Changing a cron definition is not enough. Modified behavior should be manually triggered and verified against the actual repo output.

### 5. Pause/repair semantics are part of the design
Operational controls are not ad hoc. The system explicitly distinguishes content jobs, archive jobs, and supervisor jobs so bulk pause/repair actions can be done safely.

## Related documents

- `docs/blog-cron-pipelines-index.md`
- `docs/hn-cron-pipeline.md`
- `skills/software-development/astro-paper-hn-cron-publishing/SKILL.md`
- `skills/software-development/astro-paper-foreign-tech-podcast-cron/SKILL.md`
- `skills/software-development/astro-paper-morning-market-cron/SKILL.md`
- `skills/software-development/astro-paper-weekly-entertainment-cron/SKILL.md`
