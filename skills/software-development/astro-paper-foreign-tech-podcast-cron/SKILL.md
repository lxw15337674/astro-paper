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

### Upstream job
- Job ID: `c771b111d8e8`
- Name: `daily-global-tech-podcast-markdown`
- Deliver: `local`
- Role: produce the upstream markdown body for the podcast article

### Downstream job
- Job ID: `9f9bc5f373fc`
- Name: `foreign-tech-podcast-astro-archive`
- Script: `run_archive_from_stdin.py --task foreign-tech-podcast`
- Deliver: `local`
- Role: archive the upstream markdown body into the Astro content tree

## Data Sources and Upstream Dependencies

### Primary content source
The current source-of-truth input is the upstream job `daily-global-tech-podcast-markdown`. That job is responsible for producing the markdown body that downstream archive tooling consumes.

### Ownership split
- **content selection and note drafting** belong upstream;
- **Astro persistence** belongs downstream;
- the archive layer should not become the main place where note depth is invented if the upstream markdown is already too thin.

### Debugging principle
When the final article is weak, first determine which problem class it belongs to:
- wrong episode/topic selection -> upstream issue;
- correct topic but shallow note style -> upstream markdown quality issue;
- correct markdown but broken saved article -> archive issue.

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

The archive layer should preserve that structure, not flatten it.

## Repo Files and Responsibilities

This skill should document the known chain even when the implementation is simple.

### Known downstream entrypoint
- `scripts/run_archive_from_stdin.py --task foreign-tech-podcast`

### Responsibility split
- upstream job -> produce the real article markdown body;
- downstream archive runner -> extract the clean body when needed and hand it to the archive layer;
- Astro archive layer -> save it as a valid post in the content tree.

## Editing Strategy

### Change the upstream markdown job when
- the article is too short or too chat-like;
- the structure is too weak before archival;
- the note fails to capture meaningful takeaways;
- the selected content is wrong.

### Change the archive layer when
- the incoming markdown is good, but the saved Astro article is malformed;
- body extraction is broken;
- final file structure or frontmatter is incorrect.

### Important bias
Because the user explicitly prefers long-form note style, do not “fix” a shallow upstream article by only prettifying the downstream save step. The substance should exist in the upstream markdown.

## Verification Workflow

1. Run the upstream job or source generation path.
2. Inspect the latest upstream markdown artifact.
3. Confirm the markdown is actually long-form note style rather than a short digest.
4. Feed that markdown through the downstream archive step.
5. Read the generated post file under `src/content/posts/zh-cn/`.
6. Run:
   ```bash
   pnpm run build
   ```

## Manual Cron Verification

When the pipeline changes, verify both layers.

### Upstream
- run job `c771b111d8e8` (`daily-global-tech-podcast-markdown`);
- inspect the latest artifact under `~/.hermes/cron/output/c771b111d8e8/`;
- confirm the article body already has long-form note structure.

### Downstream
- run job `9f9bc5f373fc` (`foreign-tech-podcast-astro-archive`);
- inspect the latest artifact under `~/.hermes/cron/output/9f9bc5f373fc/`;
- confirm the final Astro post was written correctly.

Because cron updates should be manually verified, do not stop after editing configuration.

## Common Pitfalls

1. **Letting the article collapse into short chat-style bullets**
   - this violates the user's explicit long-note preference.

2. **Expecting the archive job to invent depth that the upstream markdown lacks**
   - if the note is shallow upstream, fix the source.

3. **Verifying only the cron artifact and not the saved post**
   - success means the Astro article is correct and buildable.

4. **Leaving data provenance unclear**
   - future maintainers need to know that the upstream markdown job is the source-of-truth content producer.

## Verification Checklist

- [ ] Upstream markdown is long-form note style
- [ ] Upstream artifact already contains meaningful structured content
- [ ] Downstream archive consumes the correct body
- [ ] Generated post file structure still reads like a podcast note
- [ ] `pnpm run build` passes
- [ ] Manual upstream/downstream cron verification succeeds after changes
