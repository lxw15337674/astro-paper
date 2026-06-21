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


def test_watchlist_filters_seen_entry_by_english_title(tmp_path):
    posts_dir = tmp_path / "src/content/posts/zh-cn"
    posts_dir.mkdir(parents=True, exist_ok=True)
    (posts_dir / "每周影视推荐-2026-w25.md").write_text(
        """---
title: \"每周影视推荐｜2026 W25\"
---

## 罪人（Sinners）
### 基本信息
- 类型：剧情
- 上线日期：2026年6月1日
""",
        encoding="utf-8",
    )

    raw = """# 每周影视推荐

## 罪人（Sinners）
### 基本信息
- 类型：剧情
- 上线日期：2026年6月21日
### 剧情概要
略
### 推荐理由
略

## 新片（New Movie）
### 基本信息
- 类型：剧情
- 上线日期：2026年6月21日
### 剧情概要
略
### 推荐理由
略
"""

    formatted = archive.format_mdblist_weekly(raw, repo=tmp_path)

    assert "## 罪人（Sinners）" not in formatted
    assert "## 新片（New Movie）" in formatted


def test_watchlist_filters_seen_entry_by_chinese_title_fallback(tmp_path):
    posts_dir = tmp_path / "src/content/posts/zh-cn"
    posts_dir.mkdir(parents=True, exist_ok=True)
    (posts_dir / "每周影视推荐-2026-w25.md").write_text(
        """---
title: \"每周影视推荐｜2026 W25\"
---

## 雾港谜案
### 基本信息
- 类型：悬疑
- 上线日期：2026年6月1日
""",
        encoding="utf-8",
    )

    raw = """# 每周影视推荐

## 雾港谜案
### 基本信息
- 类型：悬疑
- 上线日期：2026年6月21日
### 剧情概要
略
### 推荐理由
略

## 另一部（Another One）
### 基本信息
- 类型：剧情
- 上线日期：2026年6月21日
### 剧情概要
略
### 推荐理由
略
"""

    formatted = archive.format_mdblist_weekly(raw, repo=tmp_path)

    assert "## 雾港谜案" not in formatted
    assert "## 另一部（Another One）" in formatted


def test_watchlist_history_loader_supports_legacy_numbered_list_format():
    text = """---
title: \"每周影视推荐｜2026-W25\"
---

### 电影推荐
1. **Sinners**
   - 类型：动作
2. **Perfect Crown**
   - 类型：爱情
"""

    seen_english, seen_chinese = archive.load_seen_watchlist_titles_from_text(text)

    assert "sinners" in seen_chinese
    assert "perfect crown" in seen_chinese
