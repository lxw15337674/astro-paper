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
writer = load_module("ai_blog_writer", str(REPO / "scripts" / "ai_blog_writer.py"))


def test_render_prompt_injects_source_and_date(tmp_path):
    prompt_dir = tmp_path / "prompts"
    prompt_dir.mkdir()
    (prompt_dir / "hn-top10.md").write_text(
        "task={task}\ndate={date}\nsource={source_text}\n",
        encoding="utf-8",
    )

    prompt = writer.render_prompt(
        task="hn-top10",
        date="2099-01-02",
        source_text="1. source item",
        prompt_dir=prompt_dir,
    )

    assert "task=hn-top10" in prompt
    assert "date=2099-01-02" in prompt
    assert "source=1. source item" in prompt


def test_chat_completions_url_accepts_base_or_full_endpoint():
    assert writer.chat_completions_url("https://api.example.com/v1") == "https://api.example.com/v1/chat/completions"
    assert writer.chat_completions_url("https://api.example.com/v1/chat/completions") == "https://api.example.com/v1/chat/completions"


def test_validate_markdown_strips_fence_and_rejects_placeholders():
    text = "```markdown\n" + "## 标题\n\n" + "这是一段足够长的中文正文。" * 20 + "\n```"

    cleaned = writer.validate_markdown(text)

    assert cleaned.startswith("## 标题")
    assert "```" not in cleaned

    try:
        writer.validate_markdown("## 标题\n\nTODO")
    except ValueError as exc:
        assert "too short" in str(exc) or "forbidden pattern" in str(exc)
    else:
        raise AssertionError("expected invalid markdown to be rejected")
