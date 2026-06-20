---
name: astro-paper-foreign-tech-podcast-cron
description: Use when maintaining this repo's foreign-tech podcast blog cron pipeline, including the upstream markdown job, downstream Astro archive step, and verification flow.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [astro-paper, cron, podcast, foreign-tech, publishing, blog]
    related_skills: [hermes-agent, hermes-cronjob-operations, github-pr-workflow]
---

# Astro Paper Foreign Tech Podcast Cron

## Overview

This pipeline publishes a daily long-form Chinese note covering foreign tech interview podcasts into Astro Paper. It uses an upstream markdown-producing job and a downstream archive job.

## When to Use

Use this skill when you are:
- repairing the foreign-tech podcast cron chain;
- adjusting the upstream markdown shape for podcast articles;
- verifying the downstream Astro archive behavior;
- checking that the generated post still matches the intended long-form note style.

Do not use this skill for HN, morning market, or weekly entertainment cron work.

## Current Pipeline

### Upstream job
- Job ID: `c771b111d8e8`
- Name: `daily-global-tech-podcast-markdown`
- Deliver: `local`

### Downstream job
- Job ID: `9f9bc5f373fc`
- Name: `foreign-tech-podcast-astro-archive`
- Script: `run_archive_from_stdin.py --task foreign-tech-podcast`
- Deliver: `local`

## Intended Output Style

The user preference for this pipeline is long-form note style rather than very short summaries. The generated markdown should feel like a structured Chinese podcast note, not a chat digest.

## Verification Workflow

1. Run the upstream job or source generation path.
2. Inspect the latest upstream markdown artifact.
3. Feed that markdown through the downstream archive step.
4. Read the generated post file under `src/content/posts/zh-cn/`.
5. Run:
   ```bash
   pnpm run build
   ```

## Common Pitfalls

1. Letting the upstream content collapse into short chat-style bullets.
2. Treating the archive job as the place to invent structure that should be present upstream.
3. Forgetting to verify the generated Astro post rather than only the cron artifact.

## Verification Checklist

- [ ] Upstream markdown is long-form note style
- [ ] Downstream archive consumes the correct body
- [ ] Generated post file structure looks like a podcast note
- [ ] `pnpm run build` passes
- [ ] Manual cron verification succeeds after changes
