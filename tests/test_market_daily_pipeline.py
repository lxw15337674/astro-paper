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
generate = load_module(
    "generate_morning_market_digest",
    str(REPO / "scripts" / "generate_morning_market_digest.py"),
)
archive = load_module(
    "astro_paper_archive",
    str(REPO / "scripts" / "astro_paper_archive.py"),
)


def test_market_daily_assembler_omits_missing_sections_and_has_no_key_points(tmp_path):
    section_dir = tmp_path / "data" / "market-daily" / "2026-06-21"
    section_dir.mkdir(parents=True)
    (section_dir / "us.md").write_text("## 美股\n\n美股内容。\n", encoding="utf-8")
    (section_dir / "btc.md").write_text("## BTC 市场动态\n\nBTC 内容。\n", encoding="utf-8")

    body = generate.assemble_market_daily_body(section_dir)

    assert "## 今日要点" not in body
    assert "隔夜美股" not in generate.sanitize_market_daily_text("隔夜美股科技板块回暖")
    assert "## 美股" in body
    assert "美股内容。" in body
    assert "## BTC 市场动态" in body
    assert "BTC 内容。" in body
    assert "## A股" not in body
    assert "## 港股" not in body
    assert "暂未" not in body
    assert "稍后补充" not in body


def test_market_daily_uses_daily_title_tag_slug_and_description():
    task = archive.TASKS["global-market-daily"]
    path = archive.target_path(
        Path("/repo"),
        "global-market-daily",
        str(task["task_tag"]),
        "2026-06-21",
    )

    assert task["title_prefix"] == "全球市场日报"
    assert task["task_tag"] == "全球市场日报"
    assert path == Path("/repo/src/content/posts/zh-cn/全球市场日报-2026-06-21.md")
    assert archive.build_market_daily_description("## 美股\n\n美股内容。") == (
        "每日全球市场日报，按北京时间自然日汇总全球主要市场动态。"
    )
