#!/usr/bin/env python3
from __future__ import annotations

import shlex
import subprocess
from pathlib import Path

REPO = Path("/home/bhwa233/code/astro-paper")
PROMPT_PATH = REPO / "scripts" / "morning_market_prompt.md"
OUTPUT_PATH = Path("/tmp/morning_market_ai_output.md")
ARCHIVE_SCRIPT = REPO / "scripts" / "astro_paper_archive.py"


def run(command: list[str]) -> str:
    result = subprocess.run(command, text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"command failed: {' '.join(shlex.quote(p) for p in command)}\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )
    return result.stdout


def main() -> int:
    prompt = PROMPT_PATH.read_text(encoding="utf-8")
    if OUTPUT_PATH.exists():
        OUTPUT_PATH.unlink()

    run(["hermes", "chat", "-q", prompt])

    if not OUTPUT_PATH.exists():
        raise FileNotFoundError(f"AI output not found: {OUTPUT_PATH}")

    body = OUTPUT_PATH.read_text(encoding="utf-8").strip()
    if not body:
        raise ValueError("AI output markdown is empty")

    proc = subprocess.run(
        [
            "python3",
            str(ARCHIVE_SCRIPT),
            "--task",
            "morning-market",
            "--period",
            "daily",
            "--skip-git-pull",
        ],
        input=body,
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"archive failed\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
        )
    print(proc.stdout.strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
