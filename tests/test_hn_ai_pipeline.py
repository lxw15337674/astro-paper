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
hn = load_module(
    "hn_top10_source",
    str(REPO / "scripts" / "hn_top10_source.py"),
)
archive = load_module(
    "astro_paper_archive",
    str(REPO / "scripts" / "astro_paper_archive.py"),
)


def test_hn_source_emits_structured_json_payload():
    item = {
        "id": 123,
        "title": "Developers don't understand CORS",
        "url": "https://example.com/cors",
        "descendants": 88,
        "score": 185,
        "text": "An explainer about why CORS exists and what browsers actually enforce.",
    }

    payload = hn.build_item_payload(item, rank=1)

    assert payload["rank"] == 1
    assert payload["id"] == 123
    assert payload["title"] == "Developers don't understand CORS"
    assert payload["url"] == "https://example.com/cors"
    assert payload["hn_link"] == "https://news.ycombinator.com/item?id=123"
    assert payload["topic"] == "开发工具 / 编程语言"
    assert payload["score"] == 185
    assert payload["comments"] == 88
    assert "CORS exists" in payload["source_text"]


def test_archive_prefers_ai_summary_fields_from_payload():
    payload = {
        "items": [
            {
                "rank": 1,
                "id": 123,
                "title": "Developers don't understand CORS",
                "topic": "开发工具 / 编程语言",
                "url": "https://example.com/cors",
                "hn_link": "https://news.ycombinator.com/item?id=123",
                "score": 185,
                "comments": 88,
                "content_summary": "文章解释了浏览器同源策略与 CORS 预检机制之间的关系，并指出很多后端开发者把跨域报错误解成服务端权限问题。作者用请求头、凭证模式和常见配置误区串起了 CORS 的真实执行路径。",
                "comment_summary": "评论区主要补充了反向代理、CDN 和本地开发场景下最容易踩坑的缓存与凭证问题，也有人强调把 `Access-Control-Allow-Origin: *` 当万能解法会埋下安全隐患。争议点集中在“开发体验糟糕”究竟是规范设计问题，还是浏览器安全模型不可避免的代价。",
            }
        ]
    }
    text = """1. 🔥 今日 HackerNews 热门文章 Top 10

1. 🔥 Developers don't understand CORS
- ⭐ 185 points · 88 评论
- 主题：开发工具 / 编程语言
- 原文：https://example.com/cors
- HN 讨论：https://news.ycombinator.com/item?id=123
- 内容总结：旧的模板摘要。
- 评论总结：旧的模板评论。

===ARCHIVE_PAYLOAD===
""" + __import__("json").dumps(payload, ensure_ascii=False)

    formatted, _cover = archive.format_hn_top10(text)

    assert "文章解释了浏览器同源策略与 CORS 预检机制之间的关系" in formatted
    assert "评论区主要补充了反向代理、CDN 和本地开发场景下最容易踩坑的缓存与凭证问题" in formatted
    assert "旧的模板摘要" not in formatted
    assert "旧的模板评论" not in formatted
