#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

BJT = ZoneInfo("Asia/Shanghai")
DEFAULT_REPO = Path("/home/bhwa233/code/astro-paper")
DEFAULT_AUTHOR = "bhwa233"
TOTAL_TAG = "定时文章"

TASKS: dict[str, dict[str, object]] = {
    "hn-top10": {
        "title_prefix": "HackerNews Top 10",
        "task_tag": "HackerNews",
        "summary": "每日 Hacker News 热门文章 Top 10 中文整理，按当天归档并覆盖更新。",
        "formatter": "hn",
    },
    "foreign-tech-podcast": {
        "title_prefix": "海外科技访谈播客笔记",
        "task_tag": "海外科技播客",
        "summary": "每日海外热门科技访谈播客中文长文笔记，按当天归档并覆盖更新。",
        "formatter": "podcast",
    },
    "developer-platform-weekly": {
        "title_prefix": "开发者平台更新周报",
        "task_tag": "开发者平台周报",
        "summary": "Cloudflare、Vercel、Hermes Agent、OpenClaw 等开发者平台近 7 天更新周报。",
    },
    "weekly-watchlist": {
        "title_prefix": "高分新剧电影推荐",
        "task_tag": "高分影视推荐",
        "summary": "高分新剧电影推荐周报，包含剧情概要、类型与具体上线日期。",
    },
    "mdblist-weekly": {
        "title_prefix": "MDBList 高分热播推荐",
        "task_tag": "MDBList热播推荐",
        "summary": "基于 MDBList 的高分热播影视推荐归档，按当天覆盖更新。",
    },
}

FAIL_PATTERNS = [
    r"Script not found:",
    r"归档失败",
    r"Traceback \(most recent call last\)",
    r"command failed:",
    r"上游 .* 未提供可归档的最终正文",
    r"BLOCKED:",
]

HN_TOPIC_RULES = [
    (r"ai|openai|llm|model|anthropic|gemini|copilot", "AI / 模型"),
    (r"school|education|teacher|children|policy|government|id|internet traffic", "政策 / 社会议题"),
    (r"javascript|typescript|rust|biome|tooling|compiler|developer", "开发工具 / 编程语言"),
    (r"spacex|gpu|datacenter|load-balanced|systems|atproto|boston dynamics|robot", "基础设施 / 系统"),
    (r"espresso|coffee|economics|game|doom|wolfenstein|duke nukem", "文化 / 杂项"),
]


def run(cmd: list[str], cwd: Path | None = None) -> str:
    result = subprocess.run(cmd, cwd=cwd, text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"command failed: {' '.join(cmd)}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result.stdout.strip()


def load_context_text() -> str:
    text = sys.stdin.read().strip()
    if text:
        return text
    env_text = os.environ.get("HERMES_CRON_CONTEXT") or os.environ.get("SCRIPT_OUTPUT") or ""
    return env_text.strip()


def strip_headers(text: str) -> str:
    text = text.replace("\r\n", "\n")
    text = re.sub(r"^#+\s*Final response\s*\n", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^\*\*Final response\*\*\s*\n", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^Here(?:'|’)s the archived post content:?\s*\n", "", text, flags=re.IGNORECASE)
    return text.strip()


def reject_failure_text(text: str) -> None:
    stripped = text.strip()
    if not stripped:
        raise ValueError("upstream content is empty")
    for pattern in FAIL_PATTERNS:
        if re.search(pattern, stripped, flags=re.IGNORECASE):
            raise ValueError(f"upstream content appears to be an error message: {pattern}")


def normalize_markdown(text: str) -> str:
    text = strip_headers(text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    reject_failure_text(text)
    return text + "\n"


def compact_text(text: str) -> str:
    cleaned = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", text)
    cleaned = re.sub(r"[`*_>#-]", "", cleaned)
    cleaned = re.sub(r"https?://\S+", "", cleaned)
    cleaned = re.sub(r"[^\w\s\u4e00-\u9fff·：:，,。！？!?（）()/+-]", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def first_paragraph_summary(text: str, fallback: str, limit: int = 140) -> str:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    for para in paragraphs:
        if para.startswith("#"):
            continue
        cleaned = compact_text(para)
        if len(cleaned) >= 20:
            return cleaned[:limit]
    return fallback[:limit]


def yaml_quote(text: str) -> str:
    return json.dumps(text, ensure_ascii=False)


def build_frontmatter(*, title: str, pub_dt: datetime, mod_dt: datetime, tags: list[str], description: str) -> str:
    tags_yaml = "\n".join(f"  - {tag}" for tag in tags)
    return (
        "---\n"
        f"author: {DEFAULT_AUTHOR}\n"
        f"pubDatetime: {pub_dt.astimezone(ZoneInfo('UTC')).strftime('%Y-%m-%dT%H:%M:%SZ')}\n"
        f"modDatetime: {mod_dt.astimezone(ZoneInfo('UTC')).strftime('%Y-%m-%dT%H:%M:%SZ')}\n"
        f"title: {yaml_quote(title)}\n"
        "featured: false\n"
        "draft: false\n"
        "tags:\n"
        f"{tags_yaml}\n"
        f"description: {yaml_quote(description)}\n"
        "timezone: Asia/Shanghai\n"
        "---\n\n"
    )


def slug_date(now: datetime, period: str) -> str:
    if period == "daily":
        return now.strftime("%Y-%m-%d")
    if period == "weekly":
        iso_year, iso_week, _ = now.isocalendar()
        return f"{iso_year}-w{iso_week:02d}"
    raise ValueError(f"unsupported period: {period}")


def safe_slug_component(text: str) -> str:
    slug = text.lower()
    slug = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", slug)
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug


def target_path(repo: Path, task_name: str, task_tag: str, period_key: str) -> Path:
    if task_name == "foreign-tech-podcast":
        legacy = repo / "src/content/posts/zh-cn" / f"foreign-tech-podcast-{period_key}.md"
        if legacy.exists():
            return legacy
    return repo / "src/content/posts/zh-cn" / f"{safe_slug_component(task_tag)}-{period_key}.md"


def git_pull(repo: Path) -> None:
    run(["git", "pull", "--rebase", "origin", "main"], cwd=repo)


def git_commit_push(repo: Path, rel_path: str, message: str) -> tuple[str, str]:
    run(["git", "add", rel_path], cwd=repo)
    status = run(["git", "status", "--short", rel_path], cwd=repo)
    if not status:
        return "", ""
    run(["git", "commit", "-m", message], cwd=repo)
    commit = run(["git", "rev-parse", "HEAD"], cwd=repo)
    push_output = run(["git", "push", "origin", "main"], cwd=repo)
    return commit, push_output


def split_sections(text: str) -> list[str]:
    return [chunk.strip() for chunk in re.split(r"\n\s*---\s*\n", text.strip()) if chunk.strip()]


def extract_line(pattern: str, text: str) -> str:
    m = re.search(pattern, text, flags=re.MULTILINE)
    return m.group(1).strip() if m else ""


def extract_url(text: str) -> str:
    m = re.search(r"https?://\S+", text)
    return m.group(0).rstrip(')。]') if m else ""


def infer_cover(url: str) -> str | None:
    if not url:
        return None
    if "youtube.com/watch?v=" in url:
        vid = re.search(r"v=([^&]+)", url)
        if vid:
            return f"https://i.ytimg.com/vi/{vid.group(1)}/hqdefault.jpg"
    if "youtu.be/" in url:
        vid = url.rstrip('/').split('/')[-1]
        if vid:
            return f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
    if "possible.fm" in url:
        return "https://images.transistor.fm/file/transistor/images/show/48046/full_dh6kPuRK.png"
    return None


def shorten_sentence(text: str, limit: int = 70) -> str:
    sentence = compact_text(text)
    if len(sentence) > limit:
        sentence = sentence[:limit].rstrip("，,。 ") + "。"
    return sentence


def summarize_heading(heading: str, note: str) -> str:
    h = heading.lower()
    if "trust ai" in h or "kanjun" in h:
        return "可信代理为什么仍然难以被放心托付。"
    if "github" in h or "kyle daigle" in h:
        return "GitHub 如何重新定义 AI 时代的开发者平台。"
    if "spacex" in h or "gavin baker" in h:
        return "AI 基础设施为什么开始被资本市场重新定价。"
    if "hardware engineering" in h or "paul eremenko" in h:
        return "AI 如何真正进入物理工程与工业设计。"
    return shorten_sentence(note, limit=28)


def build_podcast_section(raw: str) -> tuple[str, str]:
    heading = extract_line(r"^\d+\.\s*(.+)$", raw)
    show = extract_line(r"^-\s*节目：\s*(.+)$", raw)
    guest = extract_line(r"^-\s*嘉宾：\s*(.+)$", raw)
    date = extract_line(r"^-\s*日期：\s*(.+)$", raw)
    source = extract_line(r"^-\s*来源：\s*(.+)$", raw)
    url = extract_line(r"^-\s*链接：\s*(.+)$", raw) or extract_url(raw)
    cover = infer_cover(url)

    note_match = re.search(r"-\s*长文笔记：\s*\n(.+)$", raw, flags=re.S)
    note = note_match.group(1).strip() if note_match else raw.strip()

    summary = first_paragraph_summary(note, heading or show or "")
    cn_topic = summarize_heading(heading or show or "", note)

    highlight_candidates = [p.strip() for p in re.split(r"\n\s*\n", note) if p.strip()]
    highlights = []
    for para in highlight_candidates[:4]:
        highlights.append(f"- {shorten_sentence(para, limit=60)}")

    parts = [f"## {heading or show or '未命名播客'}", "", "### 中文主题", "", cn_topic, "", "### 基本信息", ""]
    if show:
        parts.append(f"- **节目**：{show}")
    if guest:
        parts.append(f"- **嘉宾**：{guest}")
    if date:
        parts.append(f"- **日期**：{date}")
    if source:
        parts.append(f"- **来源**：{source}")
    if url:
        parts.append(f"- **链接**：{url}")
    parts.append("")
    if cover:
        parts.append(f"![{heading or show}]({cover})")
        parts.append("")
    parts.extend([
        "### 一句话总结",
        "",
        summary,
        "",
        "### Highlights",
        "",
        *highlights,
        "",
        "### 长文笔记",
        "",
        note,
        "",
        "---",
        "",
    ])
    checklist_line = f"- **{heading or show or '未命名播客'}** — {summary}"
    return "\n".join(parts), checklist_line


def classify_hn_topic(title: str, summary: str) -> str:
    hay = f"{title} {summary}".lower()
    for pattern, topic in HN_TOPIC_RULES:
        if re.search(pattern, hay):
            return topic
    return "技术 / 观察"


def build_hn_item_block(index: int, raw: str) -> tuple[str, str, str]:
    title = extract_line(rf"^{index}\.\s*🔥?\s*(.+)$", raw) or extract_line(r"^\d+\.\s*🔥?\s*(.+)$", raw)
    points = extract_line(r"^•\s*⭐\s*(.+)$", raw)
    summary = extract_line(r"^•\s*(?!⭐|原文|HN 讨论)(.+)$", raw)
    link = extract_line(r"^•\s*蚊帐连?接?：\s*(.+)$", raw) or extract_line(r"^•\s*原文：\s*(.+)$", raw)
    hn_link = extract_line(r"^•\s*HN 讨论：\s*(.+)$", raw)
    topic = classify_hn_topic(title, summary)

    if not hn_link:
        item_id = extract_line(r"news\.ycombinator\.com/item\?id=(\d+)", raw)
        if item_id:
            hn_link = f"https://news.ycombinator.com/item?id={item_id}"

    block = [f"### {index}. {title}", ""]
    if points:
        block.append(f"- **热度**：{points}")
    block.append(f"- **主题**：{topic}")
    if summary:
        block.append(f"- **摘要**：{summary}")
    if link:
        block.append(f"- **原文**：{link}")
    if hn_link:
        block.append(f"- **HN 讨论**：{hn_link}")
    block.append("")
    return "\n".join(block), topic, title


def format_hn_top10(text: str) -> str:
    title_line = text.splitlines()[0].strip() if text.splitlines() else "今日 HackerNews 热门文章 Top 10"
    chunks = [chunk.strip() for chunk in re.split(r"\n\s*\n", text) if chunk.strip()]
    item_chunks = [c for c in chunks if re.match(r"^\d+\.\s*🔥?", c)]
    if not item_chunks:
        return text

    item_blocks = []
    topics = []
    top_titles = []
    for idx, chunk in enumerate(item_chunks, start=1):
        block, topic, title = build_hn_item_block(idx, chunk)
        item_blocks.append(block)
        topics.append(topic)
        if idx <= 3:
            top_titles.append(title)

    topic_counts: dict[str, int] = {}
    for topic in topics:
        topic_counts[topic] = topic_counts.get(topic, 0) + 1
    topic_lines = [f"- {topic}：{count} 条" for topic, count in sorted(topic_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:5]]

    lead = "今天的 Hacker News 热门内容同时覆盖了教育政策、工程文化、分布式系统与基础设施议题，说明社区关注点并不只停留在单一技术热点，而是明显横跨工具、社会影响与系统设计。"
    close = "从今天的榜单看，Hacker News 讨论重心仍然偏向‘技术如何影响现实系统’，而不是单纯追逐新产品发布。"

    lines = [
        title_line,
        "",
        "## 今日总览",
        "",
        lead,
        "",
        f"如果时间有限，优先看：{'; '.join(top_titles[:3])}。",
        "",
        "## 今日看点",
        "",
        *topic_lines,
        "",
        "## 今日 Hacker News Top 10",
        "",
    ]
    for block in item_blocks:
        lines.extend([block, ""])
    lines.extend([
        "## 结尾观察",
        "",
        close,
        "",
    ])
    return "\n".join(lines).rstrip() + "\n"


def format_foreign_podcast(text: str, title: str) -> str:
    sections = split_sections(text)
    episode_sections = []
    checklist = []
    for chunk in sections:
        if re.search(r"^\d+\.\s+", chunk, flags=re.M):
            section_md, checklist_line = build_podcast_section(chunk)
            episode_sections.append(section_md)
            checklist.append(checklist_line)
    if not episode_sections:
        return text

    summary_line = "今天的内容主要集中在两条主线：一是 AI 正从工具走向组织级基础设施，二是讨论边界正从软件扩展到数据中心、工业系统与工程设计。"
    lines = [
        "《今日国外热门科技访谈播客》",
        "",
        "## 今日总览",
        "",
        summary_line,
        "",
        "## 今日播客清单",
        "",
        *checklist,
        "",
        "---",
        "",
    ]
    for sec in episode_sections:
        lines.append(sec.rstrip())
    if lines[-1] == "---":
        lines = lines[:-1]
    return "\n".join(lines).rstrip() + "\n"


def format_task_body(task_name: str, title: str, body: str) -> str:
    task = TASKS[task_name]
    formatter = task.get("formatter")
    if formatter == "podcast":
        return format_foreign_podcast(body, title)
    if formatter == "hn":
        return format_hn_top10(body)
    return body


def main() -> int:
    parser = argparse.ArgumentParser(description="Archive upstream cron output into Astro Paper posts")
    parser.add_argument("--task", required=True, choices=sorted(TASKS.keys()))
    parser.add_argument("--period", default="daily", choices=["daily", "weekly"])
    parser.add_argument("--repo", default=str(DEFAULT_REPO))
    parser.add_argument("--extra-tag", action="append", default=[])
    parser.add_argument("--date", help="Override date in YYYY-MM-DD (Asia/Shanghai)")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    repo = Path(args.repo).expanduser().resolve()
    if not repo.exists():
        raise FileNotFoundError(f"repo not found: {repo}")

    now = datetime.now(BJT)
    if args.date:
        dt = datetime.strptime(args.date, "%Y-%m-%d").replace(tzinfo=BJT)
    else:
        dt = now

    task = TASKS[args.task]
    period_key = slug_date(dt, args.period)
    post_path = target_path(repo, args.task, str(task["task_tag"]), period_key)
    title = f"{task['title_prefix']} - {period_key.upper() if args.period == 'weekly' else period_key}"

    raw_text = load_context_text()
    body = normalize_markdown(raw_text)
    body = format_task_body(args.task, title, body)
    description = first_paragraph_summary(body, str(task["summary"]))
    tags = [TOTAL_TAG, str(task["task_tag"]), *args.extra_tag]

    created = not post_path.exists()
    pub_dt = dt if created else dt
    mod_dt = now

    frontmatter = build_frontmatter(
        title=title,
        pub_dt=pub_dt,
        mod_dt=mod_dt,
        tags=tags,
        description=description,
    )
    content = frontmatter + body
    rel_path = str(post_path.relative_to(repo))

    if args.dry_run:
        print(json.dumps({
            "task": args.task,
            "path": rel_path,
            "title": title,
            "created": created,
            "description": description,
            "tags": tags,
        }, ensure_ascii=False, indent=2))
        return 0

    git_pull(repo)
    post_path.write_text(content, encoding="utf-8")
    commit_message = f"feat: archive {safe_slug_component(str(task['task_tag']))} {period_key}"
    commit, push_output = git_commit_push(repo, rel_path, commit_message)

    result = {
        "task": args.task,
        "path": rel_path,
        "title": title,
        "created": created,
        "updated_at_bjt": mod_dt.strftime('%Y-%m-%d %H:%M:%S %Z'),
        "commit": commit,
        "push": push_output.splitlines()[-1] if push_output else "",
        "tags": tags,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
