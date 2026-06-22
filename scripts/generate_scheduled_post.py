#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

BJT = ZoneInfo("Asia/Shanghai")
TASKS = ("hn-top10", "global-market-daily")


def run(cmd: list[str], *, cwd: Path, input_text: str | None = None) -> str:
    result = subprocess.run(cmd, cwd=cwd, input=input_text, text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"command failed: {' '.join(cmd)}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result.stdout.strip()


def repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[1]


def source_for_task(task: str, repo: Path, date: str) -> str:
    if task == "hn-top10":
        return run(["python3", "scripts/hn_top10_source.py"], cwd=repo)
    if task == "global-market-daily":
        return run(["python3", "scripts/market_daily_source.py", "--date", date], cwd=repo)
    raise ValueError(f"unsupported task: {task}")


def archive_task(task: str, repo: Path, date: str, source: str, *, dry_run: bool, force: bool) -> dict[str, object]:
    cmd = [
        "python3",
        "scripts/astro_paper_archive.py",
        "--task",
        task,
        "--period",
        "daily",
        "--date",
        date,
        "--repo",
        str(repo),
        "--skip-git-pull",
    ]
    if dry_run:
        cmd.append("--dry-run")
    else:
        cmd.append("--write-only")
    if not force:
        cmd.append("--no-overwrite")

    output = run(cmd, cwd=repo, input_text=source)
    try:
        return json.loads(output)
    except json.JSONDecodeError:
        return {"task": task, "raw_output": output}


def generate(task: str, repo: Path, date: str, *, dry_run: bool, force: bool) -> dict[str, object]:
    source = source_for_task(task, repo, date)
    result = archive_task(task, repo, date, source, dry_run=dry_run, force=force)
    result.setdefault("task", task)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate scheduled Astro Paper posts without Hermes")
    parser.add_argument("--task", choices=[*TASKS, "all"], default="all")
    parser.add_argument("--date", help="Archive date YYYY-MM-DD in Asia/Shanghai")
    parser.add_argument("--repo", default=str(repo_root_from_script()))
    parser.add_argument("--force", action="store_true", help="Overwrite an existing post for the same date")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    repo = Path(args.repo).expanduser().resolve()
    date = args.date or datetime.now(BJT).strftime("%Y-%m-%d")
    tasks = list(TASKS) if args.task == "all" else [args.task]

    results = []
    for task in tasks:
        results.append(generate(task, repo, date, dry_run=args.dry_run, force=args.force))

    print(json.dumps({"date": date, "results": results}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
