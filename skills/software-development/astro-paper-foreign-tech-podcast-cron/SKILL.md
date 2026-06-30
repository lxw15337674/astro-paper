---
name: astro-paper-foreign-tech-podcast-cron
description: Use when maintaining this repo's foreign-tech podcast blog cron pipeline, including the upstream markdown source, downstream Astro archive step, long-form note style contract, and end-to-end verification.
version: 1.1.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [astro-paper, cron, podcast, foreign-tech, publishing, blog]
    related_skills: [hermes-agent, hermes-cronjob-operations, github-pr-workflow]
---

# Astro Paper Foreign Tech Podcast Cron

## Overview

This pipeline publishes a daily Chinese note covering foreign tech interview podcasts into Astro Paper. It uses an upstream markdown-producing job and a downstream archive job, but the main maintenance target is broader than mere execution.

This skill should preserve both:

1. **the chain** — upstream markdown generation → archive into Astro;
2. **the article style contract** — long-form Chinese note style rather than short chat-like summaries.

If the job still runs but the output collapses into a shallow digest, the pipeline quality has regressed.

## When to Use

Use this skill when you are:
- repairing the foreign-tech podcast cron chain;
- adjusting the upstream markdown shape for podcast articles;
- changing article structure, note style, or section layout;
- verifying the downstream Astro archive behavior;
- checking that the generated post still matches the intended long-form note style.

Do not use this skill for:
- HN Top 10 work;
- morning market work;
- weekly entertainment / MDBList work.

## Pipeline Purpose

The target artifact is a daily Chinese-language long-form note summarizing selected foreign tech interview podcast content for the blog.

Typical target path:
- `src/content/posts/zh-cn/` under the podcast-related post naming convention

Publishing cadence:
- daily

Reader expectation:
- a readable Chinese note with structure, takeaways, and narrative flow, not a terse bullet digest.

## Current Pipeline

### Primary job
- Workflow: `.github/workflows/scheduled-posts.yml`
- Task: `foreign-tech-podcast`
- Schedule: `30 1 * * *` UTC / 09:30 Asia/Shanghai
- Manual dispatch: `gh workflow run scheduled-posts.yml --repo lxw15337674/astro-paper -f task=foreign-tech-podcast ...`
- Role: collect source evidence, call AI, archive the Markdown post, verify, build, and commit via GitHub Actions.

### Source builder
- Script: `scripts/foreign_tech_podcast_source.ts`
- RSS feeds: hard-coded interview/deep-discussion podcast feeds with audio enclosures.
  - Current base pool includes AI/product sources such as a16z, Decoder, Practical AI, Big Technology, The Cognitive Revolution, and Training Data.
  - Engineering/interview expansion includes Software Engineering Daily, Software Engineering Radio, Oxide and Friends, The InfoQ Podcast, Changelog Interviews, The Data Engineering Show, Dwarkesh Podcast, and Gradient Dissent.
  - Do not mix in generic news brief / daily AI roundup / marketing podcasts unless the user explicitly changes the content direction.
- Apple Podcasts Top Shows: `fetchAppleTopShows` pulls the storefront chart and resolves each show's RSS feed.
- Transcription: local Whisper for entries with audio URLs.
- Episodes without a usable transcript are skipped (no metadata-only fallback).
- Dedup ledger: `scripts/podcast_ledger.ts` + `data/daily-podcasts/summarized.json` records already-summarized episodes by source fingerprint; the fetch skips any episode whose fingerprint is in the ledger.

## Data Sources and Upstream Dependencies

### Primary content source
The source-of-truth input now lives in the repository-owned GitHub Actions pipeline:
- RSS metadata and local Whisper transcripts from `scripts/foreign_tech_podcast_source.ts` (foreign tech feeds + Apple Podcasts Top Shows).

Historical Hermes cron jobs (`daily-global-tech-podcast-markdown` and `foreign-tech-podcast-astro-archive`) are no longer the main repo-owned path. Treat references to them as historical context unless the user explicitly asks to restore the external upstream chain.

### Ownership split
- **content selection** belongs to `foreign_tech_podcast_source.ts` (RSS + Apple Top Shows pools);
- **dedup** belongs to `scripts/podcast_ledger.ts` and `data/daily-podcasts/summarized.json`;
- **note drafting** belongs to the AI call using `prompts/blog/foreign-tech-podcast.md`;
- **Astro persistence** belongs to `scripts/astro_paper_archive.ts`;
- **quality gate** belongs to `scripts/verify_blog_generation.ts` and the site build.

### Debugging principle
When the final article is weak, first determine which problem class it belongs to:
- wrong episode/topic selection -> source builder (RSS / Apple Top Shows) issue;
- correct topic but shallow note style -> prompt / AI response quality issue;
- correct markdown but broken saved article -> archive issue;
- the same episode re-archived across runs -> dedup ledger (`podcast_ledger.ts`) issue.

## Content Contract

This pipeline has a strong style requirement based on user preference.

### Required output style
The article should feel like a **long-form Chinese note** about a foreign tech interview podcast episode or discussion.

That means it should not read like:
- a chat reply;
- a tiny headline digest;
- a flat sequence of one-line bullets with no narrative connection.

### What the post should do
The generated article should usually:
- explain who is speaking or what the discussion is about;
- summarize the main topics or themes;
- surface the interesting technical, career, product, or industry points;
- leave the reader with clear takeaways.

### Structure expectations
Exact headings may vary by article, but the generated post should still have a recognizably structured note-like form rather than a loose text dump.

The article must not include `## 今日总览` or `## 今日播客清单`; it should start with `《今日国外热门科技访谈播客》` and then go directly into episode sections.

The archive layer should preserve that structure, not flatten it. It should reject duplicate episode headings and repeated long summary blocks so the article does not contain copied podcast summaries.

## Repo Files and Responsibilities

This skill should document the repo-owned GitHub Actions chain.

### Known entrypoints
- `.github/workflows/scheduled-posts.yml`
- `scripts/generate_scheduled_post.ts --task foreign-tech-podcast`
- `scripts/foreign_tech_podcast_source.ts`
- `scripts/podcast_ledger.ts` + `data/daily-podcasts/summarized.json`
- `prompts/blog/foreign-tech-podcast.md`
- `scripts/astro_paper_archive.ts`
- `scripts/verify_blog_generation.ts`

### Responsibility split
- source builder -> select episodes (RSS + Apple Top Shows) and assemble evidence;
- dedup ledger -> skip episodes already summarized in prior runs;
- AI prompt -> turn evidence into long-form Chinese notes;
- Astro archive layer -> save it as a valid post in the content tree;
- verifier/build -> reject shallow, malformed, duplicated, or placeholder output.

## Editing Strategy

### Change the source builder when
- the selected content is wrong;
- Apple Podcasts Top Shows selection needs adjusting;
- RSS feeds are too narrow or stale;
- dedup is too aggressive or too loose (tune `scripts/podcast_ledger.ts` fingerprints).

### Change the prompt when
- the article is too short or too chat-like;
- the structure is too weak before archival;
- the note repeats the same summary across `一句话总结`, `Highlights`, and `长文笔记`;
- the note fails to capture meaningful takeaways.

### Change the archive layer when
- the incoming markdown is good, but the saved Astro article is malformed;
- body extraction is broken;
- final file structure or frontmatter is incorrect.

### Important bias
Because the user explicitly prefers long-form note style, do not “fix” a shallow article by only prettifying the downstream save step. The substance should exist in the source evidence and prompt output.

## Verification Workflow

1. Run source generation, preferably with a bounded smoke config when avoiding long Whisper work:
   ```bash
   PODCAST_DISABLE_RSS=true PODCAST_MIN_EPISODES=1 node --import tsx scripts/foreign_tech_podcast_source.ts --date 2026-06-23
   ```
2. Inspect the source artifact and confirm RSS / Apple Top Shows evidence is clearly labeled.
3. Run `pnpm run test:blog`.
4. Run `pnpm run typecheck`.
5. Run `pnpm run build`.
6. For end-to-end publishing changes, dispatch the GitHub workflow and inspect `scheduled-posts-generation-artifacts` plus the generated post.

## Manual Workflow Verification

When the pipeline changes, verify the GitHub Actions path.

### Source smoke test
- Use `PODCAST_DISABLE_RSS=true` to skip the RSS pool and exercise only the Apple Top Shows path when checking selection logic.
- Tests can inject fixed episodes without network via `PODCAST_TEST_EPISODES_FILE` (test-only seam; not used in production).
- Confirm source output contains RSS / Apple Top Shows entries and states when transcript is missing.

### End-to-end workflow
- Trigger `Scheduled posts` with `task=foreign-tech-podcast` and a small `podcast_max_episodes` for smoke tests when needed.
- Inspect `scheduled-posts-generation-artifacts`.
- Confirm the final Astro post was written correctly and passes build.

Because scheduled publishing changes should be manually verified, do not stop after editing configuration.

## Common Pitfalls

1. **Letting the article collapse into short chat-style bullets**
   - this violates the user's explicit long-note preference.

2. **Expecting the archive job to invent depth that the source/prompt lacks**
   - if the note is shallow, fix RSS / Apple Top Shows selection, transcript evidence, or the prompt.

3. **Verifying only the cron artifact and not the saved post**
   - success means the Astro article is correct and buildable.

4. **Leaving data provenance unclear**
   - future maintainers need to know that the upstream markdown job is the source-of-truth content producer.

## Verification Checklist

- [ ] Source artifact labels RSS, Apple Top Shows, and transcript evidence clearly
- [ ] AI response is long-form note style
- [ ] Archive writes the correct body
- [ ] Generated post file structure still reads like a podcast note
- [ ] `pnpm run test:blog` passes
- [ ] `pnpm run typecheck` passes
- [ ] `pnpm run build` passes
- [ ] GitHub Actions smoke/end-to-end verification succeeds after workflow changes
