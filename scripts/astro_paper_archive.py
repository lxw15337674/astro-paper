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
HN_DEFAULT_OG_IMAGE = "../../../../public/images/hn-cover.svg"

TASKS: dict[str, dict[str, object]] = {
    "morning-market": {
        "title_prefix": "全球市场日报",
        "task_tag": "全球市场日报",
        "summary": "每日全球市场日报，按北京时间自然日汇总全球主要市场动态。",
        "formatter": "market-daily",
    },
    "global-market-daily": {
        "title_prefix": "全球市场日报",
        "task_tag": "全球市场日报",
        "summary": "每日全球市场日报，按北京时间自然日汇总全球主要市场动态。",
        "formatter": "market-daily",
    },
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
        "title_prefix": "每周影视推荐",
        "task_tag": "每周影视推荐",
        "summary": "每周影视推荐专栏，汇总本周值得关注的电影与剧集，并补充口碑观察。",
        "formatter": "mdblist-weekly",
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

HN_ITEM_SPLIT_RE = re.compile(r"(?m)^\d+\.\s*🔥?\s+")
HN_HEADER_RE = re.compile(r"^1\.\s*🔥?\s*今日 HackerNews 热门文章 Top 10\s*$", re.M)
ARCHIVE_PAYLOAD_MARKER = "===ARCHIVE_PAYLOAD==="


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
        response_match = re.search(r"^##\s+Response\s*$", text, flags=re.MULTILINE)
        if response_match:
            return text[response_match.end():].strip()
        return text
    env_text = os.environ.get("HERMES_CRON_CONTEXT") or os.environ.get("SCRIPT_OUTPUT") or ""
    env_text = env_text.strip()
    if env_text:
        response_match = re.search(r"^##\s+Response\s*$", env_text, flags=re.MULTILINE)
        if response_match:
            return env_text[response_match.end():].strip()
    return env_text


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


def build_frontmatter(*, title: str, pub_dt: datetime, mod_dt: datetime, tags: list[str], description: str, og_image: str = "") -> str:
    tags_yaml = "\n".join(f"  - {tag}" for tag in tags)
    og_image_line = f"ogImage: {yaml_quote(og_image)}\n" if og_image else ""
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
        f"{og_image_line}"
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


def fetch_og_image(url: str) -> str:
    if not url:
        return ""
    try:
        html = run(["curl", "-L", "-A", "Mozilla/5.0", "--max-time", "20", "-s", url])
    except Exception:
        return ""
    for pattern in [
        r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']',
        r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)["\']',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']twitter:image["\']',
    ]:
        m = re.search(pattern, html, flags=re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return ""


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
    raw = raw.strip()
    heading = extract_line(r"^##\s+(.+)$", raw) or extract_line(r"^\d+\.\s*(.+)$", raw)
    heading = re.sub(r"^#+\s*", "", heading).strip()
    show = extract_line(r"^-\s*\*\*节目\*\*：\s*(.+)$", raw) or extract_line(r"^-\s*节目：\s*(.+)$", raw)
    guest = extract_line(r"^-\s*\*\*嘉宾\*\*：\s*(.+)$", raw) or extract_line(r"^-\s*嘉宾：\s*(.+)$", raw)
    date = extract_line(r"^-\s*\*\*日期\*\*：\s*(.+)$", raw) or extract_line(r"^-\s*日期：\s*(.+)$", raw)
    source = extract_line(r"^-\s*\*\*来源\*\*：\s*(.+)$", raw) or extract_line(r"^-\s*来源：\s*(.+)$", raw)
    url = extract_line(r"^-\s*\*\*链接\*\*：\s*(.+)$", raw) or extract_line(r"^-\s*链接：\s*(.+)$", raw) or extract_url(raw)
    cover = infer_cover(url)

    summary_match = re.search(r"###\s*一句话总结\s*(.+?)(?=\n###\s|\Z)", raw, flags=re.S)
    summary = summary_match.group(1).strip() if summary_match else ""
    highlights_match = re.search(r"###\s*Highlights\s*(.+?)(?=\n###\s|\Z)", raw, flags=re.S)
    highlights_block = highlights_match.group(1).strip() if highlights_match else ""
    note_match = re.search(r"###\s*长文笔记\s*(.+)$", raw, flags=re.S)
    note = note_match.group(1).strip() if note_match else raw
    if not summary:
        summary = first_paragraph_summary(note, heading or show or "")
    cn_topic = summarize_heading(heading or show or "", note)

    highlights = []
    if highlights_block:
        for line in highlights_block.splitlines():
            stripped = line.strip()
            if stripped.startswith("-"):
                highlights.append(stripped)
    if not highlights:
        highlight_candidates = [p.strip() for p in re.split(r"\n\s*\n", note) if p.strip()]
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
    checklist_line = f"- {heading or show or '未命名播客'}"
    return "\n".join(parts), checklist_line


def classify_hn_topic(title: str, summary: str) -> str:
    hay = f"{title} {summary}".lower()
    for pattern, topic in HN_TOPIC_RULES:
        if re.search(pattern, hay):
            return topic
    return "技术 / 观察"


def extract_hn_bullets(raw: str) -> list[str]:
    bullets: list[str] = []
    for line in raw.splitlines():
        stripped = line.strip()
        for pattern in (r"^•\s*(.+)$", r"^-\s*(.+)$"):
            m = re.match(pattern, stripped)
            if m:
                bullets.append(m.group(1).strip())
                break
    return bullets


def split_hn_summary_and_comment(summary: str) -> tuple[str, str]:
    text = summary.strip()
    if not text:
        return "", ""
    parts = [p.strip(" ；;。.!？?，,") for p in re.split(r"[；;]\s*", text) if p.strip()]
    if len(parts) >= 2:
        return parts[0], "；".join(parts[1:])
    sentences = [p.strip(" 。！？!?，,") for p in re.split(r"(?<=[。！？!?])\s*", text) if p.strip()]
    if len(sentences) >= 2:
        return sentences[0], " ".join(sentences[1:])
    return text, ""


def normalize_hn_paragraph(text: str) -> str:
    text = text.strip()
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"([。！？!?])([^\n])", r"\1\n\n\2", text)
    return text.strip()


def build_hn_description(text: str, fallback: str) -> str:
    title_match = re.search(r"^\d+\.\s*🔥?\s*(.+)$", text, flags=re.MULTILINE)
    if title_match:
        title = compact_text(title_match.group(1))
        if title:
            return f"Hacker News Top 10：{title}"[:140]
    return fallback[:140]


def build_market_daily_description(text: str) -> str:
    return "每日全球市场日报，按北京时间自然日汇总全球主要市场动态。"


def build_morning_market_description(text: str) -> str:
    return build_market_daily_description(text)

def build_hn_item_block(index: int, raw: str, payload_item: dict[str, object] | None = None) -> tuple[str, str, str, str, int]:
    title = extract_line(rf"^{index}\.\s*🔥?\s*(.+)$", raw) or extract_line(r"^\d+\.\s*🔥?\s*(.+)$", raw)
    bullets = extract_hn_bullets(raw)
    points = next((b.removeprefix("⭐").strip() for b in bullets if b.startswith("⭐")), "")
    topic_from_source = next((b.split("：", 1)[1].strip() for b in bullets if b.startswith("主题：")), "")
    link = next((b.split("：", 1)[1].strip() for b in bullets if b.startswith("原文：") or b.startswith("蚊帐连接：") or b.startswith("蚊帐链接：")), "")
    hn_link = next((b.split("：", 1)[1].strip() for b in bullets if b.startswith("HN 讨论：")), "")
    content_summary = next((b.split("：", 1)[1].strip() for b in bullets if b.startswith("内容总结：")), "")
    comment_summary = next((b.split("：", 1)[1].strip() for b in bullets if b.startswith("评论总结：")), "")
    summary_candidates = [b for b in bullets if not re.match(r"^(⭐|主题：|原文：|HN 讨论：|内容总结：|评论总结：|蚊帐连接：|蚊帐链接：)", b)]
    fallback_summary = summary_candidates[0] if summary_candidates else ""
    if not content_summary or not comment_summary:
        parsed_content, parsed_comment = split_hn_summary_and_comment(fallback_summary)
        content_summary = content_summary or parsed_content
        comment_summary = comment_summary or parsed_comment

    if payload_item and isinstance(payload_item, dict):
        _topic_override = str(payload_item.get("topic") or "")
        _content_override = str(payload_item.get("content_summary") or "")
        _comment_override = str(payload_item.get("comment_summary") or "")
        if _content_override and _content_override != content_summary:
            content_summary = _content_override
        if _comment_override and _comment_override != comment_summary:
            comment_summary = _comment_override

    topic = topic_from_source or classify_hn_topic(title, content_summary or fallback_summary)
    source_image = fetch_og_image(link)
    points_num_match = re.search(r"(\d+)", points)
    points_num = int(points_num_match.group(1)) if points_num_match else 0

    if not hn_link:
        item_id = extract_line(r"news\.ycombinator\.com/item\?id=(\d+)", raw)
        if item_id:
            hn_link = f"https://news.ycombinator.com/item?id={item_id}"

    block = [f"### {index}. {title}", ""]
    if points:
        block.append(f"- **热度**：{points}")
    block.append(f"- **主题**：{topic}")
    if content_summary:
        block.extend(["", "#### 内容总结", "", normalize_hn_paragraph(content_summary), ""])
    if comment_summary:
        block.extend(["#### 评论总结", "", normalize_hn_paragraph(comment_summary), ""])
    if link:
        block.append(f"- **原文**：{link}")
    if hn_link:
        block.append(f"- **HN 讨论**：{hn_link}")
    block.append("")
    return "\n".join(block), topic, title, source_image, points_num


def format_hn_top10(text: str) -> tuple[str, str]:
    cleaned = text.strip()
    title_line = "1. 🔥 今日 HackerNews 热门文章 Top 10"
    cleaned = HN_HEADER_RE.sub("", cleaned, count=1).strip()

    payload_items_by_rank: dict[int, dict[str, object]] = {}
    marker_pos = cleaned.find(ARCHIVE_PAYLOAD_MARKER)
    if marker_pos != -1:
        body_part = cleaned[:marker_pos].strip()
        payload_part = cleaned[marker_pos + len(ARCHIVE_PAYLOAD_MARKER):].strip()
        cleaned = body_part
        try:
            payload = json.loads(payload_part)
            for p_item in payload.get("items") or payload.get("payload_items") or []:
                rank = int(p_item.get("rank") or 0)
                if rank:
                    payload_items_by_rank[rank] = dict(p_item)
        except (json.JSONDecodeError, ValueError, TypeError):
            pass

    matches = list(HN_ITEM_SPLIT_RE.finditer(cleaned))
    item_chunks: list[str] = []
    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(cleaned)
        chunk = cleaned[start:end].strip()
        if chunk:
            item_chunks.append(chunk)
    if not item_chunks:
        return text, ""

    item_blocks = []
    topics = []
    cover_image = ""
    best_points = -1
    for idx, chunk in enumerate(item_chunks, start=1):
        payload_item = payload_items_by_rank.get(idx)
        block, topic, _title, source_image, points_num = build_hn_item_block(idx, chunk, payload_item)
        item_blocks.append(block)
        topics.append(topic)
        if source_image and points_num > best_points:
            best_points = points_num
            cover_image = source_image

    topic_counts: dict[str, int] = {}
    for topic in topics:
        topic_counts[topic] = topic_counts.get(topic, 0) + 1
    topic_lines = [f"- {topic}：{count} 条" for topic, count in sorted(topic_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:5]]

    lines = [
        title_line,
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
    return "\n".join(lines).rstrip() + "\n", cover_image


def normalize_podcast_key(text: str) -> str:
    normalized = compact_text(text).lower()
    normalized = normalized.replace("—", "-").replace("–", "-")
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized


def load_seen_podcast_keys(repo: Path, exclude_paths: set[Path] | None = None) -> tuple[set[str], set[tuple[str, str]]]:
    posts_dir = repo / "src/content/posts/zh-cn"
    seen_urls: set[str] = set()
    seen_show_title_pairs: set[tuple[str, str]] = set()
    exclude_resolved = {p.resolve() for p in (exclude_paths or set())}
    if not posts_dir.exists():
        return seen_urls, seen_show_title_pairs

    for post_path in sorted(posts_dir.glob("海外科技播客-*.md")):
        if post_path.resolve() in exclude_resolved:
            continue
        text = post_path.read_text(encoding="utf-8")
        file_urls, file_pairs = load_seen_podcast_keys_from_text(text)
        seen_urls.update(file_urls)
        seen_show_title_pairs.update(file_pairs)
    return seen_urls, seen_show_title_pairs


def load_seen_podcast_keys_from_text(text: str) -> tuple[set[str], set[tuple[str, str]]]:
    seen_urls: set[str] = set()
    seen_show_title_pairs: set[tuple[str, str]] = set()
    for chunk in re.split(r"(?m)^##\s+", text):
        chunk = chunk.strip()
        if not chunk or chunk.startswith("今日总览") or chunk.startswith("今日播客清单"):
            continue
        chunk = "## " + chunk
        heading = extract_line(r"^##\s+(.+)$", chunk)
        show = extract_line(r"^-\s*\*\*节目\*\*：\s*(.+)$", chunk) or extract_line(r"^-\s*节目：\s*(.+)$", chunk)
        url = extract_line(r"^-\s*\*\*链接\*\*：\s*(.+)$", chunk) or extract_line(r"^-\s*链接：\s*(.+)$", chunk)
        if url:
            seen_urls.add(url.strip())
        if heading and show:
            seen_show_title_pairs.add((normalize_podcast_key(show), normalize_podcast_key(heading)))
    return seen_urls, seen_show_title_pairs


def format_foreign_podcast(text: str, title: str, repo: Path = DEFAULT_REPO) -> str:
    current_path: Path | None = None
    current_date_match = re.search(r"(\d{4}-\d{2}-\d{2})", title)
    if current_date_match:
        current_path = repo / "src/content/posts/zh-cn" / f"海外科技播客-{current_date_match.group(1)}.md"

    seen_urls, seen_show_title_pairs = load_seen_podcast_keys(
        repo,
        exclude_paths={current_path} if current_path else None,
    )

    response_match = re.search(r"^##\s+Response\s*$", text, flags=re.MULTILINE)
    if response_match:
        text = text[response_match.end():].strip()
    title_line_match = re.search(r"^《今日国外热门科技访谈播客》\s*$", text, flags=re.MULTILINE)
    if title_line_match:
        text = text[title_line_match.end():].strip()

    overview_match = re.search(r"##\s*今日总览\s*(.+?)(?=\n##\s*今日播客清单|\Z)", text, flags=re.S)
    summary_line = first_paragraph_summary(
        overview_match.group(1).strip() if overview_match else "",
        "今天的内容主要集中在两条主线：一是 AI 正从工具走向组织级基础设施，二是讨论边界正从软件扩展到数据中心、工业系统与工程设计。",
    )

    body_start = text.find("---")
    episode_text = text[body_start + 3 :].strip() if body_start != -1 else text.strip()

    sections = [
        match.group(1).strip()
        for match in re.finditer(r"(?sm)(##\s+.+?)(?=\n##\s+.+|\Z)", episode_text)
        if match.group(1).strip()
    ]
    episode_sections = []
    checklist = []
    for chunk in sections:
        if not chunk.startswith("## "):
            continue
        heading = extract_line(r"^##\s+(.+)$", chunk)
        show = extract_line(r"^-\s*\*\*节目\*\*：\s*(.+)$", chunk) or extract_line(r"^-\s*节目：\s*(.+)$", chunk)
        url = extract_line(r"^-\s*\*\*链接\*\*：\s*(.+)$", chunk) or extract_line(r"^-\s*链接：\s*(.+)$", chunk) or extract_url(chunk)
        if url and url.strip() in seen_urls:
            continue
        if heading and show and (normalize_podcast_key(show), normalize_podcast_key(heading)) in seen_show_title_pairs:
            continue
        normalized_chunk = chunk
        if not re.search(r"^\d+\.\s+", chunk, flags=re.M):
            normalized_chunk = f"1. {chunk}"
        section_md, checklist_line = build_podcast_section(normalized_chunk)
        episode_sections.append(section_md)
        checklist.append(checklist_line)
    if not episode_sections:
        return text

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


def compact_mdblist_summary(text: str) -> str:
    cleaned = compact_text(text)
    if len(cleaned) > 120:
        return cleaned[:120].rstrip("，,。 ") + "。"
    return cleaned


def build_mdblist_reason(item: dict[str, object]) -> str:
    raw_genres = item.get("genres")
    genres = [str(g) for g in raw_genres if g] if isinstance(raw_genres, list) else []
    genre_text = "、".join(genres[:3]) if genres else "题材"
    release_date = str(item.get("release_date") or "待补充")
    rating_bits: list[str] = []
    mdblist_rating = item.get("mdblist_rating")
    douban_rating = str(item.get("douban_rating") or "").strip()
    media_type = str(item.get("media_type") or "")
    title = str(item.get("title") or "这部作品")
    if mdblist_rating not in (None, ""):
        rating_bits.append(f"MDBList {mdblist_rating}")
    if douban_rating:
        rating_bits.append(f"豆瓣 {douban_rating}")
    rating_text = "，".join(rating_bits) if rating_bits else "现有榜单评分表现稳定"
    if media_type == "tv":
        return f"《{title}》适合放进本周待追清单：它的{genre_text}元素比较鲜明，开场阶段就容易把人带进情境里；再加上目前{rating_text}，整体属于这一轮榜单里更值得优先试看的剧集。"
    return f"《{title}》适合放进本周待看片单：它的{genre_text}气质比较明确，不太容易踩空；再加上 {release_date} 刚上线、目前{rating_text}，属于这周更值得优先补看的一部电影。"


def translate_mdblist_summary(text: str) -> str:
    raw = text.strip()
    if not raw:
        return "待补充。"
    mapping = {
        "Hoppers": "科学家发明了把人类意识转移进仿生动物体内的技术，热爱动物的女孩借此深入动物世界，也逐步触碰到远超想象的秘密。",
        "Remarkably Bright Creatures": "一位年迈寡妇在水族馆值夜班时，与意想不到的伙伴建立联系，并因此迎来可能改变后半生的重要发现。",
        "Sinners": "一对双胞胎兄弟回到故乡，想把过去抛在身后重新开始，却发现等待他们的是更危险也更邪恶的东西。",
        "Weapons": "同一班级的孩子在同一晚、同一时刻几乎全部离奇失踪，整个社区因此陷入恐慌，并不断追问真相到底是什么。",
        "Marty Supreme": "一个梦想始终不被看好的年轻人，为了追求所谓的伟大一路跌撞挣扎，几乎把自己逼到极限。",
        "Bugonia": "两名痴迷阴谋论的年轻人绑架了一位强势企业女总裁，因为他们坚信她其实是想毁灭地球的外星人。",
        "Teach You a Lesson": "一名来自教育权益保护局的督察，以带有强制性的非常规手段矫正问题学生，并试图直接整顿失序的教育体系。",
        "The WONDERfools": "一群有些不靠谱的小镇青年误打误撞获得超能力，在末日恐慌蔓延之际被迫站出来对抗不断升级的邪恶势力。",
        "Widow's Bay": "一位新英格兰小镇镇长想把当地打造成热门旅游地，但必须先面对这里一直流传的诅咒传闻。",
        "A Knight of the Seven Kingdoms": "故事发生在《权力的游戏》前约一百年，一位年轻骑士与他的侍从游历维斯特洛，途中不断卷入命运、强敌与危险冒险。",
        "Perfect Crown": "在21世纪君主立宪制下的韩国，一位财阀继承人与孤独王子因契约婚姻被绑在一起，并在相处中逐渐发展出跨越阶层的感情。",
        "When Life Gives You Tangerines": "在济州岛，一个倔强女孩与一个始终坚定的男孩，从青春走到成年，把一段跨越岁月的爱情活成了漫长的人生故事。",
    }
    for key, value in mapping.items():
        if raw.startswith(key + "||"):
            return value
    cleaned = compact_text(raw)
    if cleaned and not cleaned.endswith("。"):
        cleaned += "。"
    return cleaned or "待补充。"


def normalize_watchlist_title_keys(title: str) -> tuple[str, str]:
    raw = title.strip()
    m = re.match(r"^(.*?)（(.*?)）$", raw)
    if m:
        zh = compact_text(m.group(1))
        en = normalize_podcast_key(m.group(2))
        return en, zh
    normalized = compact_text(raw)
    return "", normalize_podcast_key(normalized)


def load_seen_watchlist_titles_from_text(text: str) -> tuple[set[str], set[str]]:
    seen_english: set[str] = set()
    seen_chinese: set[str] = set()
    for heading in re.findall(r"(?m)^##\s+(.+)$", text):
        en_key, zh_key = normalize_watchlist_title_keys(heading)
        if en_key:
            seen_english.add(en_key)
        if zh_key:
            seen_chinese.add(zh_key)

    if not seen_english and not seen_chinese:
        for match in re.finditer(r"(?m)^\s*\d+\.\s+\*\*(.+?)\*\*\s*$", text):
            heading = match.group(1).strip()
            en_key, zh_key = normalize_watchlist_title_keys(heading)
            if en_key:
                seen_english.add(en_key)
            if zh_key:
                seen_chinese.add(zh_key)

    return seen_english, seen_chinese


def load_seen_watchlist_titles(repo: Path) -> tuple[set[str], set[str]]:
    posts_dir = repo / "src/content/posts/zh-cn"
    seen_english: set[str] = set()
    seen_chinese: set[str] = set()
    if not posts_dir.exists():
        return seen_english, seen_chinese

    for post_path in sorted(posts_dir.glob("每周影视推荐-*.md")):
        text = post_path.read_text(encoding="utf-8")
        file_english, file_chinese = load_seen_watchlist_titles_from_text(text)
        seen_english.update(file_english)
        seen_chinese.update(file_chinese)
    return seen_english, seen_chinese


def format_mdblist_weekly(text: str, repo: Path = DEFAULT_REPO) -> str:
    cleaned = text.strip()
    if ARCHIVE_PAYLOAD_MARKER in cleaned:
        cleaned = cleaned.split(ARCHIVE_PAYLOAD_MARKER, 1)[0].strip()
    cleaned = re.sub(r"^```(?:markdown)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```\s*$", "", cleaned).strip()
    cleaned = re.sub(r"^#\s+.*$", "", cleaned, count=1, flags=re.MULTILINE).strip()
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)

    seen_english, seen_chinese = load_seen_watchlist_titles(repo)
    if re.search(r"(?m)^##\s+(电影推荐|剧集推荐)\s*$", cleaned) and re.search(r"(?m)^###\s+.+$", cleaned):
        return format_mdblist_weekly_structured(cleaned, seen_english, seen_chinese)

    sections = [chunk.strip() for chunk in re.split(r"\n(?=##\s+)", cleaned) if chunk.strip()]
    kept_sections: list[str] = []
    for section in sections:
        if not section.startswith("## "):
            kept_sections.append(section)
            continue
        heading = extract_line(r"^##\s+(.+)$", section)
        en_key, zh_key = normalize_watchlist_title_keys(heading)
        if en_key and en_key in seen_english:
            continue
        if (not en_key) and zh_key and zh_key in seen_chinese:
            continue
        kept_sections.append(section)

    return "\n\n".join(kept_sections).rstrip() + "\n"


def format_mdblist_weekly_structured(cleaned: str, seen_english: set[str], seen_chinese: set[str]) -> str:
    output_sections: list[str] = []
    current_block: list[str] = []
    current_heading: str | None = None
    current_items: list[str] = []

    def flush_heading() -> None:
        nonlocal current_heading, current_items
        if current_heading is None:
            return
        section_lines = [f"## {current_heading}"]
        if current_items:
            section_lines.append("")
            for item in current_items:
                section_lines.append(item.strip())
                section_lines.append("")
        output_sections.append("\n".join(section_lines).strip())
        current_heading = None
        current_items = []

    def maybe_add_block(block_lines: list[str]) -> None:
        nonlocal current_items
        block = "\n".join(block_lines).strip()
        if not block:
            return
        title = extract_line(r"^###\s+(.+)$", block)
        en_key, zh_key = normalize_watchlist_title_keys(title)
        if en_key and (en_key in seen_english or en_key in seen_chinese):
            return
        if zh_key and (zh_key in seen_chinese or zh_key in seen_english):
            return
        current_items.append(block)

    for line in cleaned.splitlines():
        if line.startswith("## "):
            if current_block:
                maybe_add_block(current_block)
                current_block = []
            flush_heading()
            current_heading = line[3:].strip()
            continue
        if line.startswith("### "):
            if current_block:
                maybe_add_block(current_block)
            current_block = [line]
            continue
        if current_block:
            current_block.append(line)

    if current_block:
        maybe_add_block(current_block)
    flush_heading()

    return "\n\n".join(section for section in output_sections if section.strip()).rstrip() + "\n"


def format_task_body(task_name: str, title: str, body: str) -> tuple[str, str]:
    task = TASKS[task_name]
    formatter = task.get("formatter")
    if formatter == "podcast":
        return format_foreign_podcast(body, title, DEFAULT_REPO), ""
    if formatter == "hn":
        return format_hn_top10(body)
    if formatter == "mdblist-weekly":
        return format_mdblist_weekly(body, DEFAULT_REPO), ""
    if formatter in {"morning-market", "market-daily"}:
        return body, ""
    return body, ""


def main() -> int:
    parser = argparse.ArgumentParser(description="Archive upstream cron output into Astro Paper posts")
    parser.add_argument("--task", required=True, choices=sorted(TASKS.keys()))
    parser.add_argument("--period", default="daily", choices=["daily", "weekly"])
    parser.add_argument("--repo", default=str(DEFAULT_REPO))
    parser.add_argument("--extra-tag", action="append", default=[])
    parser.add_argument("--date", help="Override cycle date (YYYY-MM-DD) in Asia/Shanghai")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-git-pull", action="store_true", help="Skip git pull before writing (useful when local formatter code is dirty)")
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
    sep = "｜"
    if args.task == "mdblist-weekly" and args.period == "weekly":
        period_key = period_key.replace("-W", " W")
    title = f"{task['title_prefix']}{sep}{period_key.upper() if args.period == 'weekly' else period_key}"

    raw_text = load_context_text()
    body = normalize_markdown(raw_text)
    body, cover_image = format_task_body(args.task, title, body)
    description = first_paragraph_summary(body, str(task["summary"]))
    if args.task == "hn-top10":
        description = build_hn_description(body, str(task["summary"]))
    if args.task in {"morning-market", "global-market-daily"}:
        description = build_market_daily_description(body)
    tags = [TOTAL_TAG, str(task["task_tag"]), *args.extra_tag]
    if args.task == "mdblist-weekly":
        cover_image = ""

    created = not post_path.exists()
    pub_dt = dt if created else dt
    mod_dt = now

    frontmatter = build_frontmatter(
        title=title,
        pub_dt=pub_dt,
        mod_dt=mod_dt,
        tags=tags,
        description=description,
        og_image=cover_image,
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

    if not args.skip_git_pull:
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
