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


def test_structured_watchlist_sections_dedup_against_history(tmp_path):
    posts_dir = tmp_path / "src/content/posts/zh-cn"
    posts_dir.mkdir(parents=True, exist_ok=True)
    (posts_dir / "每周影视推荐-2026-w25.md").write_text(
        """---
title: \"每周影视推荐｜2026-W25\"
---

### 电影推荐
1. **Sinners**
   - 类型：动作
""",
        encoding="utf-8",
    )

    raw = """## 电影推荐

### 罪人（Sinners）
![罪人（Sinners）](https://example.com/sinners.jpg)
#### 基本信息
- 类型：动作 / 惊悚
- 上线日期：2025年4月16日
- IMDb 评分：7.5
#### 剧情概要
一对双胞胎兄弟回到故乡后发现更可怕的邪恶在等着他们。
#### 推荐理由
气质凌厉，恐怖与动作结合得很稳。
#### 评论总结
IMDb 评价普遍认可其氛围和执行力，但也有人觉得暴力表达过猛。

### 新片（New Movie）
![新片（New Movie）](https://example.com/new-movie.jpg)
#### 基本信息
- 类型：剧情
- 上线日期：2026年6月21日
- IMDb 评分：7.1
#### 剧情概要
一个家庭在意外之后重新理解彼此。
#### 推荐理由
情绪表达直接，适合周末补片。
#### 评论总结
评论多提到表演自然、节奏平稳，少数人觉得故事收束偏保守。

## 剧集推荐

### 另一部剧（Another Show）
![另一部剧（Another Show）](https://example.com/show.jpg)
#### 基本信息
- 类型：剧情
- 上线日期：2026年6月18日
- IMDb 评分：7.8
#### 剧情概要
一座海港城市里，几个人的命运逐渐纠缠在一起。
#### 推荐理由
群像写法扎实，进入状态很快。
#### 评论总结
观众普遍喜欢它的氛围和表演，但也有人觉得前两集节奏偏慢。
"""

    formatted = archive.format_mdblist_weekly(raw, repo=tmp_path)

    assert "### 罪人（Sinners）" not in formatted
    assert "### 新片（New Movie）" in formatted
    assert "### 另一部剧（Another Show）" in formatted
    assert formatted.count("## 电影推荐") == 1
    assert formatted.count("## 剧集推荐") == 1
