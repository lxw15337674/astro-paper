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
archive_latest = load_module(
    "archive_latest_cron_response",
    str(REPO / "scripts" / "archive_latest_cron_response.py"),
)


def test_extract_response_body_returns_only_top_level_response():
    text = """# Cron Job: example

## Prompt

ignored

## Response

《今日国外热门科技访谈播客》

## 今日总览
正文
"""

    body = archive_latest.extract_response_body(text)

    assert body.startswith("《今日国外热门科技访谈播客》")
    assert "## Prompt" not in body


def test_latest_artifact_path_picks_newest_markdown(tmp_path):
    output_dir = tmp_path / "cron" / "output" / "job123"
    output_dir.mkdir(parents=True)
    old = output_dir / "2026-06-21_01-02-11.md"
    new = output_dir / "2026-06-22_01-02-11.md"
    old.write_text("old", encoding="utf-8")
    new.write_text("new", encoding="utf-8")

    latest = archive_latest.latest_artifact_path(hermes_home=tmp_path, job_id="job123")

    assert latest == new
