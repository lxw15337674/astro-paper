---
name: astro-paper-weekly-entertainment-cron
description: Use when maintaining this repo's weekly entertainment recommendation cron pipeline, including the MDBList-based upstream source, article upgrade rules, Astro archive flow, editorial structure, and end-to-end verification.
version: 1.1.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [astro-paper, cron, entertainment, mdblist, weekly, publishing, blog]
    related_skills: [hermes-agent, hermes-cronjob-operations, github-pr-workflow]
---

# Astro Paper Weekly Entertainment Cron

## Overview

This pipeline publishes the weekly Chinese entertainment recommendation article into Astro Paper. It is not just a transport job: the chain takes an MDBList-oriented upstream result, upgrades it into a more editorial Chinese recommendation article, then archives the result into the Astro content tree.

The important maintenance principle is that this pipeline owns both:

1. **execution flow** — source job → upgrade step → Astro archive;
2. **article contract** — naming, section layout, language, and what should or should not appear in the final post.

If the final article regresses into a raw database dump, the pipeline is considered broken even if the cron technically still runs.

## When to Use

Use this skill when you are:
- repairing the weekly entertainment cron chain;
- changing the upstream/downstream cron relationship;
- editing the upgrade prompt or upgrade script;
- changing title, naming, summary, poster, rating, or section rules;
- verifying the final article structure after regeneration;
- deciding whether a formatting problem belongs in the source, the upgrade layer, or the Astro archive layer.

Do not use this skill for:
- HN Top 10 publishing;
- foreign-tech podcast publishing;
- morning market publishing.

## Pipeline Purpose

The target artifact is a weekly Chinese-language blog post under the Astro Paper content tree. The final article should read like a curated editorial recommendation column, not like a scraped MDBList record export.

Typical target path:
- `src/content/posts/zh-cn/每周影视推荐-YYYY-wNN.md`

Publishing cadence:
- weekly

Primary audience expectation:
- Chinese-reading blog readers who want concise but readable entertainment recommendations with poster art and structured summaries.

## Current Pipeline

### Upstream source job
- Job ID: `404c8660ee38`
- Name: `mdblist-weekly-hot-highscore`
- Role: generate the raw weekly recommendation source that the upgrade/archive flow consumes

### Downstream archive job
- Job ID: `e226a7117f05`
- Name: `mdblist-weekly-astro-archive`
- Deliver: `local`
- Role: consume the upstream output, run the article-upgrade/archive flow, and write the Astro post

## Data Sources and Upstream Dependencies

This skill should explicitly track the origin of the article's content, because formatting fixes often belong in the wrong layer if the source chain is unclear.

### Source-of-truth inputs
1. **Upstream cron output** from `mdblist-weekly-hot-highscore`
   - this is the current pipeline input source;
   - it is the authoritative weekly candidate list for titles/items.

2. **Upgrade layer rules**
   - these rules reshape the source into the desired Chinese editorial article;
   - they should define naming, section presence/absence, and prose style expectations.

3. **Astro archive layer**
   - this layer is responsible for writing the final article into the repo content tree;
   - it should not invent unrelated editorial policy if that policy belongs in the upgrade prompt/script.

### Important principle about source ownership
- **item selection** comes from the upstream job;
- **article shaping** comes from the upgrade prompt/script;
- **Astro persistence** comes from the archive script.

When debugging, decide first which layer owns the defect:
- wrong works selected -> upstream problem;
- correct works but wrong naming/sections/prose -> upgrade-layer problem;
- correct text but wrong file/frontmatter/archive behavior -> Astro archive problem.

## Important Repo Files

Key files currently involved in this pipeline:
- `scripts/upgrade_mdblist_weekly_article.py`
- `scripts/mdblist_weekly_upgrade_prompt.md`
- `scripts/astro_paper_archive.py`

These files have different responsibilities:
- `upgrade_mdblist_weekly_article.py` -> transforms raw weekly source into the upgraded article body;
- `mdblist_weekly_upgrade_prompt.md` -> carries the editorial and structural instructions for the upgraded article;
- `astro_paper_archive.py` -> archives the final body into Astro content.

## Article Contract

This section is the most important part of the skill. It defines the final article shape, not just how to run the cron.

### Title rules
- Post title should use: `每周影视推荐｜YYYY WNN` or the repo's equivalent weekly style.
- Prefer the full-width separator `｜`, not a plain ASCII hyphen for the visible article title.

### Work title rules
- Each work title should prefer the format: `中文名（英文名）`.
- If a stable Chinese title exists, still keep the English title in parentheses under the current agreed convention.
- Do not regress to English-only item titles.

### Language rules
- Reader-facing prose should be Chinese.
- Genre/type labels should be translated into Chinese.
- The article should feel like a Chinese editorial recommendation column, not a direct English metadata dump.

### Rating rules
- **Do not display Douban score** in the final article under the current agreed rule.
- IMDb score may be retained.
- If future rating policy changes, update this skill and the upgrade prompt/script together.

### Required structure rules
The final post should preserve:
- article title;
- article cover image if the pipeline provides one;
- per-item poster images;
- per-item structured sections.

Each item should remain a structured recommendation entry rather than a loose paragraph blob.

### Current required per-item sections
Each entertainment entry should include the equivalent of:
- title;
- poster;
- basic info;
- plot summary / story overview;
- recommendation reason;
- comment or reception summary.

Exact headings may vary slightly, but the structure should remain consistent and clearly segmented.

### Explicitly removed sections / patterns
The final article should **not** reintroduce these removed patterns:
- opening keyword-style lead-in such as “本周片单的关键词是 …”; 
- `本周推荐看点`;
- `本周口碑观察`;
- raw database-source branding or obvious MDBList exposure.

## Editing Strategy

When changing this pipeline, prefer the narrowest layer that owns the behavior.

### Change the upstream job when
- the wrong items are selected;
- required source fields are missing before the upgrade step;
- the candidate list itself is incorrect.

### Change the upgrade prompt/script when
- titles are not using `中文名（英文名）`;
- genre labels are not Chinese;
- banned sections reappear;
- the prose sounds like metadata instead of an editorial recommendation article;
- per-item section layout is wrong.

### Change the Astro archive layer when
- the output file path is wrong;
- frontmatter/content file writing is wrong;
- the final article body is correct before archive, but the saved Astro post is malformed.

## Verification Workflow

Run verification in this order after changing the weekly entertainment pipeline:

1. Re-run the upgrade flow directly:
   ```bash
   python3 /home/bhwa233/code/astro-paper/scripts/upgrade_mdblist_weekly_article.py
   ```
2. Read the generated markdown file under `src/content/posts/zh-cn/`.
3. Confirm the article still follows the editorial contract:
   - title uses the weekly Chinese recommendation pattern;
   - work titles use `中文名（英文名）`;
   - genre labels are Chinese;
   - Douban score is absent;
   - unwanted intro/overview sections remain absent;
   - posters and per-item sections are intact.
4. Run:
   ```bash
   pnpm run build
   ```
5. If cron behavior changed, manually trigger the relevant jobs and inspect the newest artifacts.

## Manual Cron Verification

When the cron behavior changes, verify both layers rather than trusting only local script output.

### Upstream verification
- run job `404c8660ee38` (`mdblist-weekly-hot-highscore`);
- inspect the latest artifact under `~/.hermes/cron/output/404c8660ee38/`;
- confirm the upstream source contains the expected weekly candidate content.

### Downstream verification
- run job `e226a7117f05` (`mdblist-weekly-astro-archive`);
- inspect the latest artifact under `~/.hermes/cron/output/e226a7117f05/`;
- confirm the repo content file was updated as expected.

Because the user prefers manual verification after cron modifications, do not stop at “job updated”; trigger and inspect the chain.

## Common Pitfalls

1. **Treating a structural problem as an archive problem**
   - If the article shape is wrong but the final file writes correctly, the issue is often in the upgrade prompt/script rather than Astro archive code.

2. **Reintroducing English-only or metadata-first titles**
   - The agreed convention is `中文名（英文名）`, not bare English titles.

3. **Accidentally restoring Douban score display**
   - This was explicitly removed and should stay removed unless the user changes the policy again.

4. **Letting deleted sections come back**
   - `本周推荐看点`, `本周口碑观察`, and keyword-style intro text should not reappear.

5. **Calling success too early**
   - The real success target is the generated Astro post + successful local build + manual cron verification when the pipeline changed.

6. **Leaving source/ownership unclear**
   - If the skill does not state where item selection comes from and where editorial shaping happens, future fixes drift into the wrong layer.

## Verification Checklist

- [ ] Upstream weekly source job identified and still correct
- [ ] Upgrade script and prompt still encode the editorial contract
- [ ] Generated titles use `中文名（英文名）`
- [ ] Chinese genre/type labels are present
- [ ] Douban score is not displayed
- [ ] Banned intro/overview sections are absent
- [ ] Posters and per-item structure are intact
- [ ] `pnpm run build` passes
- [ ] Manual upstream/downstream cron verification succeeds after pipeline changes
