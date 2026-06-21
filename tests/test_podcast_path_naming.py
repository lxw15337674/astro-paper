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


def test_foreign_tech_podcast_target_path_uses_chinese_slug_even_if_legacy_file_exists(tmp_path):
    legacy = tmp_path / "src/content/posts/zh-cn/foreign-tech-podcast-2026-06-21.md"
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text("legacy", encoding="utf-8")

    path = archive.target_path(
        tmp_path,
        "foreign-tech-podcast",
        "海外科技播客",
        "2026-06-21",
    )

    assert path == tmp_path / "src/content/posts/zh-cn/海外科技播客-2026-06-21.md"
    assert path != legacy
