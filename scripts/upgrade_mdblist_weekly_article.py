#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

REPO = Path("/home/bhwa233/code/astro-paper")
SOURCE_SCRIPT = Path("/home/bhwa233/.hermes/scripts/mdblist_weekly_hot_highscore.py")
PROMPT_PATH = REPO / "scripts" / "mdblist_weekly_upgrade_prompt.md"
TEMP_OUTPUT = Path("/tmp/mdblist_weekly_ai_output.md")
ARCHIVE_SCRIPT = REPO / "scripts" / "astro_paper_archive.py"
ARCHIVE_PAYLOAD_MARKER = "===ARCHIVE_PAYLOAD==="


def run(cmd: list[str], *, input_text: str | None = None) -> str:
    proc = subprocess.run(cmd, text=True, input=input_text, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"command failed: {' '.join(cmd)}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
        )
    return proc.stdout


def load_source_payload() -> tuple[str, dict]:
    raw = run(["python3", str(SOURCE_SCRIPT)])
    if ARCHIVE_PAYLOAD_MARKER not in raw:
        raise ValueError("source report missing archive payload marker")
    body, payload_text = raw.split(ARCHIVE_PAYLOAD_MARKER, 1)
    payload = json.loads(payload_text.strip())
    return body.strip(), payload


def build_context_markdown(payload: dict) -> str:
    items = payload.get("items") or []
    lines = ["# MDBLIST WEEKLY SOURCE CONTEXT", ""]
    for idx, item in enumerate(items, start=1):
        lines.extend(
            [
                f"## ITEM {idx}: {item.get('title', '')}",
                f"- media_type: {item.get('media_type', '')}",
                f"- genres: {', '.join(item.get('genres', [])) if item.get('genres') else ''}",
                f"- release_date: {item.get('release_date', '')}",
                f"- mdblist_rating: {item.get('mdblist_rating', '')}",
                f"- imdb_rating: {item.get('imdb_rating', '')}",
                f"- douban_rating: {item.get('douban_rating', '')}",
                f"- poster: {item.get('poster', '')}",
                f"- mdblist_url: {item.get('url', '')}",
                f"- douban_url: {item.get('douban_url', '')}",
                f"- summary: {item.get('summary', '')}",
                "",
            ]
        )
    return "\n".join(lines).strip() + "\n"


def main() -> int:
    _, payload = load_source_payload()
    context = build_context_markdown(payload)
    prompt = PROMPT_PATH.read_text(encoding="utf-8")
    combined_prompt = prompt + "\n\n" + context

    if TEMP_OUTPUT.exists():
        TEMP_OUTPUT.unlink()
    run(["hermes", "chat", "-q", combined_prompt])
    if not TEMP_OUTPUT.exists():
        raise FileNotFoundError(f"AI output not found: {TEMP_OUTPUT}")
    body = TEMP_OUTPUT.read_text(encoding="utf-8").strip()
    if not body:
        raise ValueError("AI output markdown is empty")

    body = re.sub(r"^```(?:markdown)?\s*", "", body)
    body = re.sub(r"\s*```\s*$", "", body).strip() + "\n"

    archive_result = run(
        [
            "python3",
            str(ARCHIVE_SCRIPT),
            "--task",
            "mdblist-weekly",
            "--period",
            "weekly",
            "--skip-git-pull",
        ],
        input_text=body,
    )
    print(archive_result.strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
