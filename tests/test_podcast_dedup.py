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
    assert "### 一句话总结" not in formatted
    assert "### Highlights" not in formatted
    assert "### 长文笔记" not in formatted


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


def test_foreign_podcast_does_not_self_dedup_existing_target_file(tmp_path):
    posts_dir = tmp_path / "src/content/posts/zh-cn"
    posts_dir.mkdir(parents=True, exist_ok=True)
    target = posts_dir / "海外科技播客-2026-06-21.md"
    target.write_text(
        """---
title: \"海外科技访谈播客笔记｜2026-06-21\"
---

## Existing Episode

### 基本信息
- 节目：Latent Space
- 链接：https://example.com/existing
""",
        encoding="utf-8",
    )

    raw = """《今日国外热门科技访谈播客》

## 今日总览
测试

## 今日播客清单
- Existing Episode
- Fresh Episode

---

## Existing Episode
### 基本信息
- 节目：Latent Space
- 嘉宾：A
- 日期：2026-06-21
- 来源：Example
- 链接：https://example.com/existing

### 一句话总结
当天重跑时不该被自己过滤

### Highlights
- a

### 长文笔记
旧稿重跑

---

## Fresh Episode
### 基本信息
- 节目：The Pragmatic Engineer
- 嘉宾：B
- 日期：2026-06-21
- 来源：Example
- 链接：https://example.com/fresh

### 一句话总结
新的

### Highlights
- b

### 长文笔记
新的
"""

    formatted = archive.format_foreign_podcast(raw, "海外科技访谈播客笔记｜2026-06-21", repo=tmp_path)

    assert "## Existing Episode" in formatted
    assert "https://example.com/existing" in formatted
    assert "## Fresh Episode" in formatted
    assert "https://example.com/fresh" in formatted


def test_foreign_podcast_skips_truncated_episode_paragraphs(tmp_path):
    posts_dir = tmp_path / "src/content/posts/zh-cn"
    posts_dir.mkdir(parents=True, exist_ok=True)

    raw = """《今日国外热门科技访谈播客》

## 今日总览
测试

## 今日播客清单
- Broken Episode
- Good Episode

---

## Broken Episode
### 基本信息
- 节目：Latent Space
- 嘉宾：A
- 日期：2026-06-21
- 来源：Example
- 链接：https://example.com/broken

### 一句话总结
这期内容最值得存档的地方，是它把当前 AI 产业最容易被。

### Highlights
- 因为它没。

### 长文笔记
这期内容最值得存档的地方，是它把当前 AI 产业最容易被。

---

## Good Episode
### 基本信息
- 节目：The Pragmatic Engineer
- 嘉宾：B
- 日期：2026-06-21
- 来源：Example
- 链接：https://example.com/good

### 一句话总结
这期对话把开发者平台、数据基础设施和 AI 代理之间的关系讲得很清楚，重点不在概念翻新，而在于平台边界正在被重新划分。

### Highlights
- 讨论了平台层为什么会重新抢占接口与工作流。

### 长文笔记
主持人与嘉宾把今天开发者平台的新压力讲得很直接：当 AI 工具开始替用户执行任务，平台不再只是托管代码或提供 API，而是在重新定义谁拥有入口、上下文和执行权。

这期最有价值的地方，是它没有把竞争只理解成模型能力竞赛，而是把数据接入、身份体系、执行环境和结算链路一起放回平台策略里看。
"""

    formatted = archive.format_foreign_podcast(raw, "海外科技访谈播客笔记｜2026-06-21", repo=tmp_path)

    assert "## Broken Episode" not in formatted
    assert "最容易被。" not in formatted
    assert "因为它没。" not in formatted
    assert "## Good Episode" in formatted
