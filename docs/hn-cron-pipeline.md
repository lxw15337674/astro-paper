# HN Cron Pipeline

## Current stable structure

This repo's Hacker News publishing flow is split into two layers:

1. **Upstream source job**
   - Cron job: `0373c42e95ea` (`hn-top10-local-markdown`)
   - Script: `~/.hermes/scripts/hn_top10_source.py`
   - Responsibility: fetch HN top items and emit clean markdown source in the expected intermediate format.

2. **Downstream archive step**
   - Cron job: `8640cfe88f41` (`hn-top10-astro-archive`)
   - Script entrypoint: `scripts/run_archive_from_stdin.py --task hn-top10 --period daily`
   - Responsibility: strip wrapper noise when present, then pass the clean markdown body into `scripts/astro_paper_archive.py` for Astro post generation.

## Expected intermediate markdown format

The upstream script should emit exactly:

- first line: `1. 🔥 今日 HackerNews 热门文章 Top 10`
- then 10 numbered entries
- each entry contains dash bullets for:
  - 热度
  - 主题 (optional but preferred)
  - 原文
  - HN 讨论
  - 内容总结
  - 评论总结

Example:

```md
1. 🔥 今日 HackerNews 热门文章 Top 10

1. 🔥 Example title
- ⭐ 123 points · 45 评论
- 主题：技术 / 观察
- 原文：https://example.com
- HN 讨论：https://news.ycombinator.com/item?id=123
- 内容总结：...
- 评论总结：...
```

## Archive parser expectations

`scripts/astro_paper_archive.py` currently supports:

- dash bullets (`- ...`)
- bullet dots (`• ...`)
- title-header stripping for the first `1. 🔥 今日 HackerNews 热门文章 Top 10`
- extraction of:
  - 热度
  - 主题
  - 原文
  - HN 讨论
  - 内容总结
  - 评论总结

## Verification checklist

When changing this pipeline:

1. Run the upstream source script directly:
   ```bash
   python3 ~/.hermes/scripts/hn_top10_source.py | sed -n '1,120p'
   ```
2. Pipe it into the archive script locally:
   ```bash
   python3 ~/.hermes/scripts/hn_top10_source.py > /tmp/hn_top10_source_latest.md
   python3 scripts/astro_paper_archive.py --task hn-top10 --period daily --skip-git-pull < /tmp/hn_top10_source_latest.md
   ```
3. Inspect the generated file:
   ```bash
   sed -n '1,220p' src/content/posts/zh-cn/hackernews-2026-06-20.md
   ```
4. Build locally:
   ```bash
   pnpm run build
   ```
5. If validating cron behavior, manually trigger upstream first, then downstream, and inspect the newest artifact under:
   - `~/.hermes/cron/output/0373c42e95ea/`
   - `~/.hermes/cron/output/8640cfe88f41/`

## Important caveat

Cron artifacts themselves may still contain Hermes wrapper sections such as `## Prompt` and injected skill text. The durable correctness target is:

- upstream `## Response` is clean HN markdown
- the generated Astro post content is correct

If downstream cron artifacts need to be human-clean as well, that likely requires changing the scheduler artifact wrapper behavior rather than only the HN archive script.
