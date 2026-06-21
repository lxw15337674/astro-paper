#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

REPO = Path("/home/bhwa233/code/astro-paper")
GENERATOR = REPO / "scripts" / "generate_morning_market_digest.py"
ARCHIVE_SCRIPT = REPO / "scripts" / "astro_paper_archive.py"
BJT = ZoneInfo("Asia/Shanghai")


def run(command: list[str], *, input_text: str | None = None) -> str:
    result = subprocess.run(command, input=input_text, text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"command failed: {' '.join(command)}\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )
    return result.stdout


def main() -> int:
    parser = argparse.ArgumentParser(description="Build and archive a natural-day Global Market Daily post")
    parser.add_argument("--date", help="Archive date YYYY-MM-DD in Asia/Shanghai")
    parser.add_argument("--skip-git-pull", action="store_true")
    args = parser.parse_args()

    date_str = args.date or datetime.now(BJT).strftime("%Y-%m-%d")

    run(["python3", str(GENERATOR), "--date", date_str, "--build-sections"])
    body = run(["python3", str(GENERATOR), "--date", date_str, "--assemble"]).strip()
    if not body:
        raise ValueError("assembled global market daily body is empty")

    archive_cmd = [
        "python3",
        str(ARCHIVE_SCRIPT),
        "--task",
        "global-market-daily",
        "--period",
        "daily",
        "--date",
        date_str,
    ]
    if args.skip_git_pull:
        archive_cmd.append("--skip-git-pull")
    print(run(archive_cmd, input_text=body).strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
