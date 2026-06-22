#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import subprocess
from pathlib import Path


RESPONSE_RE = re.compile(r"^##\s+Response\s*$", flags=re.MULTILINE)


def latest_artifact_path(*, hermes_home: Path, job_id: str) -> Path:
    output_dir = hermes_home / "cron" / "output" / job_id
    artifacts = sorted(output_dir.glob("*.md"))
    if not artifacts:
        raise FileNotFoundError(f"no cron artifacts found for job {job_id} in {output_dir}")
    return artifacts[-1]


def extract_response_body(text: str) -> str:
    match = RESPONSE_RE.search(text)
    if not match:
        raise ValueError("cron artifact is missing a top-level ## Response section")
    body = text[match.end():].strip()
    if not body:
        raise ValueError("cron artifact response body is empty")
    return body + "\n"


def run_archive(
    *,
    repo: Path,
    task: str,
    period: str | None,
    date: str | None,
    skip_git_pull: bool,
    dry_run: bool,
    body: str,
) -> str:
    archive_script = repo / "scripts" / "astro_paper_archive.py"
    cmd = ["python3", str(archive_script), "--task", task]
    if period:
        cmd.extend(["--period", period])
    if date:
        cmd.extend(["--date", date])
    if skip_git_pull:
        cmd.append("--skip-git-pull")
    if dry_run:
        cmd.append("--dry-run")

    result = subprocess.run(cmd, input=body, text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"command failed: {' '.join(cmd)}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result.stdout


def main() -> int:
    parser = argparse.ArgumentParser(description="Archive the latest upstream cron response body into Astro Paper")
    parser.add_argument("--source-job-id", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--period", choices=["daily", "weekly"], default=None)
    parser.add_argument("--date", help="Override cycle date (YYYY-MM-DD)")
    parser.add_argument("--repo", default="/home/bhwa233/code/astro-paper")
    parser.add_argument("--hermes-home", default=os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes"))
    parser.add_argument("--skip-git-pull", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    repo = Path(args.repo).expanduser().resolve()
    hermes_home = Path(args.hermes_home).expanduser().resolve()
    artifact_path = latest_artifact_path(hermes_home=hermes_home, job_id=args.source_job_id)
    body = extract_response_body(artifact_path.read_text(encoding="utf-8"))
    print(
        run_archive(
            repo=repo,
            task=args.task,
            period=args.period,
            date=args.date,
            skip_git_pull=args.skip_git_pull,
            dry_run=args.dry_run,
            body=body,
        ).strip()
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
