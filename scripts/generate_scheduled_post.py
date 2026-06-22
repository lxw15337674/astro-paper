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
TARGET_FILES = {
    "hn-top10": "hackernews-{date}.md",
    "global-market-daily": "全球市场日报-{date}.md",
}


def run(cmd: list[str], *, cwd: Path, input_text: str | None = None) -> str:
    result = subprocess.run(cmd, cwd=cwd, input=input_text, text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"command failed: {' '.join(cmd)}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result.stdout.strip()


def repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[1]


def target_post_path(task: str, repo: Path, date: str) -> Path:
    template = TARGET_FILES.get(task)
    if not template:
        raise ValueError(f"unsupported task: {task}")
    return repo / "src/content/posts/zh-cn" / template.format(date=date)


def skipped_existing_result(task: str, repo: Path, date: str) -> dict[str, object] | None:
    post_path = target_post_path(task, repo, date)
    if not post_path.exists():
        return None
    return {
        "task": task,
        "path": str(post_path.relative_to(repo)),
        "created": False,
        "skipped": True,
        "reason": "target post already exists",
    }


def fixture_source_for_task(task: str, source_fixture_dir: Path) -> str:
    path = source_fixture_dir / f"{task}.md"
    if not path.exists():
        raise FileNotFoundError(f"source fixture not found for task {task}: {path}")
    return path.read_text(encoding="utf-8")


def source_for_task(task: str, repo: Path, date: str, *, source_fixture_dir: Path | None = None) -> str:
    if source_fixture_dir is not None:
        return fixture_source_for_task(task, source_fixture_dir)
    if task == "hn-top10":
        return run(["python3", "scripts/hn_top10_source.py"], cwd=repo)
    if task == "global-market-daily":
        return run(["python3", "scripts/market_daily_source.py", "--date", date], cwd=repo)
    raise ValueError(f"unsupported task: {task}")


def write_artifact(artifacts_dir: Path | None, task: str, name: str, content: str) -> str:
    if artifacts_dir is None:
        return ""
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    path = artifacts_dir / f"{task}-{name}"
    path.write_text(content.rstrip() + "\n", encoding="utf-8")
    return str(path)


def render_with_ai(
    task: str,
    repo: Path,
    date: str,
    source: str,
    *,
    model: str,
    prompt_dir: Path | None,
    mock_response_dir: Path | None,
    artifacts_dir: Path | None,
) -> tuple[str, dict[str, object]]:
    prompt_artifact = write_artifact(artifacts_dir, task, "source.md", source)
    rendered_prompt_path = artifacts_dir / f"{task}-prompt.md" if artifacts_dir is not None else None
    response_artifact = artifacts_dir / f"{task}-ai-response.md" if artifacts_dir is not None else None

    cmd = [
        "python3",
        "scripts/ai_blog_writer.py",
        "--task",
        task,
        "--date",
        date,
    ]
    if model:
        cmd.extend(["--model", model])
    if prompt_dir is not None:
        cmd.extend(["--prompt-dir", str(prompt_dir)])
    if mock_response_dir is not None:
        cmd.extend(["--mock-response-dir", str(mock_response_dir)])
    if rendered_prompt_path is not None:
        cmd.extend(["--save-prompt", str(rendered_prompt_path)])

    markdown = run(cmd, cwd=repo, input_text=source)
    if response_artifact is not None:
        response_artifact.write_text(markdown.rstrip() + "\n", encoding="utf-8")

    return markdown, {
        "ai_model": model,
        "source_artifact": prompt_artifact,
        "prompt_artifact": str(rendered_prompt_path) if rendered_prompt_path else "",
        "ai_response_artifact": str(response_artifact) if response_artifact else "",
        "mocked_ai": mock_response_dir is not None,
    }


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


def generate(
    task: str,
    repo: Path,
    date: str,
    *,
    dry_run: bool,
    force: bool,
    use_ai: bool,
    model: str,
    prompt_dir: Path | None,
    source_fixture_dir: Path | None,
    mock_response_dir: Path | None,
    artifacts_dir: Path | None,
) -> dict[str, object]:
    if not force:
        skipped = skipped_existing_result(task, repo, date)
        if skipped:
            return skipped

    source = source_for_task(task, repo, date, source_fixture_dir=source_fixture_dir)
    ai_metadata: dict[str, object] = {}
    article_body = source
    if use_ai:
        article_body, ai_metadata = render_with_ai(
            task,
            repo,
            date,
            source,
            model=model,
            prompt_dir=prompt_dir,
            mock_response_dir=mock_response_dir,
            artifacts_dir=artifacts_dir,
        )

    result = archive_task(task, repo, date, article_body, dry_run=dry_run, force=force)
    result.setdefault("task", task)
    if use_ai:
        result["generation"] = ai_metadata
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate scheduled Astro Paper posts")
    parser.add_argument("--task", choices=[*TASKS, "all"], default="all")
    parser.add_argument("--date", help="Archive date YYYY-MM-DD in Asia/Shanghai")
    parser.add_argument("--repo", default=str(repo_root_from_script()))
    parser.add_argument("--force", action="store_true", help="Overwrite an existing post for the same date")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--ai", action="store_true", help="Generate the article body through scripts/ai_blog_writer.py")
    parser.add_argument("--model", default="", help="Optional AI_MODEL override for live AI generation")
    parser.add_argument("--prompt-dir", help="Prompt template directory. Defaults to prompts/blog")
    parser.add_argument("--source-fixture-dir", help="Read <task>.md source fixtures instead of fetching live data")
    parser.add_argument("--mock-response-dir", help="Read <task>.md AI responses instead of calling a provider")
    parser.add_argument("--artifacts-dir", help="Directory for source/prompt/AI response artifacts")
    args = parser.parse_args()

    repo = Path(args.repo).expanduser().resolve()
    date = args.date or datetime.now(BJT).strftime("%Y-%m-%d")
    tasks = list(TASKS) if args.task == "all" else [args.task]
    prompt_dir = Path(args.prompt_dir).expanduser().resolve() if args.prompt_dir else None
    source_fixture_dir = Path(args.source_fixture_dir).expanduser().resolve() if args.source_fixture_dir else None
    mock_response_dir = Path(args.mock_response_dir).expanduser().resolve() if args.mock_response_dir else None
    artifacts_dir = Path(args.artifacts_dir).expanduser().resolve() if args.artifacts_dir else None

    results = []
    for task in tasks:
        results.append(
            generate(
                task,
                repo,
                date,
                dry_run=args.dry_run,
                force=args.force,
                use_ai=args.ai,
                model=args.model,
                prompt_dir=prompt_dir,
                source_fixture_dir=source_fixture_dir,
                mock_response_dir=mock_response_dir,
                artifacts_dir=artifacts_dir,
            )
        )

    print(json.dumps({"date": date, "results": results}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
