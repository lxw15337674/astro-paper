#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", required=True)
    parser.add_argument("--period", choices=["daily", "weekly"], default=None)
    args = parser.parse_args()

    data = sys.stdin.read()
    if "## Response" in data:
        data = data.split("## Response", 1)[1].strip() + "\n"
    repo = Path("/home/bhwa233/code/astro-paper")
    script = repo / "scripts" / "astro_paper_archive.py"
    cmd = ["python3", str(script), "--task", args.task]
    if args.period:
        cmd.extend(["--period", args.period])
    subprocess.run(cmd, input=data, text=True, check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
