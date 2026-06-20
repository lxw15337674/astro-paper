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


def extract_hn_bullets(raw: str) -> list[str]:
    bullets: list[str] = []
    for line in raw.splitlines():
        m = re.match(r"^•\s*(.+)$", line.strip())
        if m:
            bullets.append(m.group(1).strip())
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

def build_hn_item_block(index: int, raw: str) -> tuple[str, str, str, str, int]:
    title = extract_line(rf"^{index}\.\s*🔥?\s*(.+)$", raw) or extract_line(r"^\d+\.\s*🔥?\s*(.+)$", raw)
    bullets = extract_hn_bullets(raw)
    points = next((b.removeprefix("⭐").strip() for b in bullets if b.startswith("⭐")), "")
    link = next((b.split("：", 1)[1].strip() for b in bullets if b.startswith("原文：") or b.startswith("蚊帐连接：") or b.startswith("蚊帐链接：")), "")
    hn_link = next((b.split("：", 1)[1].strip() for b in bullets if b.startswith("HN 讨论：")), "")
    summary_candidates = [b for b in bullets if not re.match(r"^(⭐|原文：|HN 讨论：|蚊帐连接：|蚊帐链接：)", b)]
    summary = summary_candidates[0] if summary_candidates else ""
    content_summary, comment_summary = split_hn_summary_and_comment(summary)
    topic = classify_hn_topic(title, content_summary or summary)
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
        block.extend(["#### 内容总结", "", normalize_hn_paragraph(content_summary), ""])
    if comment_summary:
        block.extend(["#### 评论总结", "", normalize_hn_paragraph(comment_summary), ""])
    if link:
        block.append(f"- **原文**：{link}")
    if hn_link:
        block.append(f"- **HN 讨论**：{hn_link}")
    block.append("")
    return "\n".join(block), topic, title, source_image, points_num


def format_hn_top10(text: str) -> tuple[str, str]:
    title_line = text.splitlines()[0].strip() if text.splitlines() else "今日 HackerNews 热门文章 Top 10"
    matches = list(HN_ITEM_SPLIT_RE.finditer(text))
    item_chunks: list[str] = []
    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        chunk = text[start:end].strip()
        if chunk:
            item_chunks.append(chunk)
    if not item_chunks:
        return text, ""

    item_blocks = []
    topics = []
    cover_image = ""
    best_points = -1
    for idx, chunk in enumerate(item_chunks, start=1):
        block, topic, _title, source_image, points_num = build_hn_item_block(idx, chunk)
        item_blocks.append(block)
        topics.append(topic)
        if source_image and points_num > best_points:
            best_points = points_num
            cover_image = source_image

    topic_counts: dict[str, int] = {}
    for topic in topics:
        topic_counts[topic] = topic_counts.get(topic, 0) + 1
    topic_lines = [f"- {topic}：{count} 条" for topic, count in sorted(topic_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:5]]

    close = "从今天的榜单看，Hacker News 讨论重心仍然偏向‘技术如何影响现实系统’，而不是单纯追逐新产品发布。"

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
    lines.extend([
        "## 结尾观察",
        "",
        close,
        "",
    ])
    return "\n".join(lines).rstrip() + "\n", cover_image


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


def format_mdblist_weekly(text: str) -> str:
    if ARCHIVE_PAYLOAD_MARKER not in text:
        return text
    raw_body, raw_payload = text.split(ARCHIVE_PAYLOAD_MARKER, 1)
    payload = json.loads(raw_payload.strip())
    items = payload.get("items") or []
    if not isinstance(items, list) or not items:
        return raw_body.strip() + "\n"

    intro = "这份片单基于 MDBList 热门榜中近期评分与讨论度都比较突出的条目整理而成，不强行凑固定数量，重点挑出这周更值得立即加入待看列表的作品。"
    lines = [
        "《本周高分热播推荐》",
        "",
        "## 本周总览",
        "",
        intro,
        "",
    ]

    for idx, item in enumerate(items, start=1):
        title = str(item.get("title") or f"第{idx}部作品")
        poster = str(item.get("poster") or "").strip()
        genres = item.get("genres") or []
        genre_text = " / ".join(str(g) for g in genres if g) or "待补充"
        release_date = str(item.get("release_date") or "待补充")
        media_type = str(item.get("media_type") or "")
        mdblist_rating = item.get("mdblist_rating")
        douban_rating = str(item.get("douban_rating") or "").strip()
        imdb_rating = str(item.get("imdb_rating") or "").strip()
        summary = translate_mdblist_summary(f"{title}||{str(item.get('summary') or '')}")
        link = str(item.get("url") or "").strip()
        douban_url = str(item.get("douban_url") or "").strip()
        basic_info = []
        if media_type == "movie":
            basic_info.append("- **类型归属**：电影")
        elif media_type == "tv":
            basic_info.append("- **类型归属**：剧集")
        basic_info.extend([
            f"- **题材类型**：{genre_text}",
            f"- **上线日期**：{release_date}",
        ])
        ratings = []
        if mdblist_rating not in (None, ""):
            ratings.append(f"MDBList {mdblist_rating}")
        if douban_rating:
            ratings.append(f"豆瓣 {douban_rating}")
        if imdb_rating:
            ratings.append(f"IMDb {imdb_rating}")
        basic_info.append(f"- **评分**：{'｜'.join(ratings) if ratings else '待补充'}")
        if link:
            basic_info.append(f"- **MDBList**：{link}")
        if douban_url:
            basic_info.append(f"- **豆瓣**：{douban_url}")

        lines.extend([f"## {idx}. {title}", ""])
        if poster:
            lines.extend([f"![{title} 海报]({poster})", ""])
        lines.extend([
            "### 基本信息",
            "",
            *basic_info,
            "",
            "### 剧情概要",
            "",
            summary,
            "",
            "### 推荐理由",
            "",
            build_mdblist_reason(item),
            "",
        ])

    return "\n".join(lines).rstrip() + "\n"


def format_task_body(task_name: str, title: str, body: str) -> tuple[str, str]:
    task = TASKS[task_name]
    formatter = task.get("formatter")
    if formatter == "podcast":
        return format_foreign_podcast(body, title), ""
    if formatter == "hn":
        return format_hn_top10(body)
    if formatter == "mdblist-weekly":
        return format_mdblist_weekly(body), ""
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
    title = f"{task['title_prefix']} - {period_key.upper() if args.period == 'weekly' else period_key}"

    raw_text = load_context_text()
    body = normalize_markdown(raw_text)
    body, cover_image = format_task_body(args.task, title, body)
    description = first_paragraph_summary(body, str(task["summary"]))
    if args.task == "hn-top10":
        description = build_hn_description(body, str(task["summary"]))
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
