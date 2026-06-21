from __future__ import annotations

import importlib.util
from pathlib import Path


def load_module(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


REPO = Path(__file__).resolve().parents[1]
archive = load_module(
    "astro_paper_archive",
    str(REPO / "scripts" / "astro_paper_archive.py"),
)


def test_foreign_podcast_filters_seen_episode_by_url(tmp_path):
    posts_dir = tmp_path / "src/content/posts/zh-cn"
    posts_dir.mkdir(parents=True, exist_ok=True)
    (posts_dir / "海外科技播客-2026-06-20.md").write_text(
        """---
title: \"海外科技访谈播客笔记｜2026-06-20\"
---

## Old Episode

### 基本信息
- **节目**：Latent Space
- **链接**：https://example.com/ep1
""",
        encoding="utf-8",
    )

    raw = """《今日国外热门科技访谈播客》

## 今日总览
测试

## 今日播客清单
- Old Episode
- New Episode

---

## Old Episode
### 基本信息
- 节目：Latent Space
- 嘉宾：A
- 日期：2026-06-21
- 来源：Example
- 链接：https://example.com/ep1

### 一句话总结
旧的

### Highlights
- a

### 长文笔记
旧的

---

## New Episode
### 基本信息
- 节目：Latent Space
- 嘉宾：B
- 日期：2026-06-21
- 来源：Example
- 链接：https://example.com/ep2

### 一句话总结
新的

### Highlights
- b

### 长文笔记
新的
"""

    formatted = archive.format_foreign_podcast(raw, "海外科技访谈播客笔记｜2026-06-21", repo=tmp_path)

    assert "https://example.com/ep1" not in formatted
    assert "## Old Episode" not in formatted
    assert "https://example.com/ep2" in formatted
    assert "## New Episode" in formatted
    assert "- **《今日国外热门科技访谈播客》**" not in formatted


def test_foreign_podcast_filters_seen_episode_by_show_and_title_when_url_differs(tmp_path):
    posts_dir = tmp_path / "src/content/posts/zh-cn"
    posts_dir.mkdir(parents=True, exist_ok=True)
    (posts_dir / "海外科技播客-2026-06-20.md").write_text(
        """---
title: \"海外科技访谈播客笔记｜2026-06-20\"
---

## GitHub's plan for Agents — Kyle Daigle, GitHub

### 基本信息
- **节目**：Latent Space: The AI Engineer Podcast
- **链接**：https://apple.example.com/ep-github
""",
        encoding="utf-8",
    )

    raw = """《今日国外热门科技访谈播客》

## 今日总览
测试

## 今日播客清单
- GitHub's plan for Agents — Kyle Daigle, GitHub
- Another Episode

---

## GitHub's plan for Agents — Kyle Daigle, GitHub
### 基本信息
- 节目：Latent Space: The AI Engineer Podcast
- 嘉宾：Kyle Daigle
- 日期：2026-06-21
- 来源：Example
- 链接：https://site.example.com/github-agents

### 一句话总结
重复但换链接

### Highlights
- a

### 长文笔记
重复但换链接

---

## Another Episode
### 基本信息
- 节目：The Pragmatic Engineer
- 嘉宾：Robert Erez
- 日期：2026-06-21
- 来源：Example
- 链接：https://example.com/ep2

### 一句话总结
新的

### Highlights
- b

### 长文笔记
新的
"""

    formatted = archive.format_foreign_podcast(raw, "海外科技访谈播客笔记｜2026-06-21", repo=tmp_path)

    assert "https://site.example.com/github-agents" not in formatted
    assert "## GitHub's plan for Agents — Kyle Daigle, GitHub" not in formatted
    assert "https://example.com/ep2" in formatted
    assert "## Another Episode" in formatted
    assert "- **《今日国外热门科技访谈播客》**" not in formatted
