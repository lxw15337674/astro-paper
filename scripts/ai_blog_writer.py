#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_AI_BASE_URL = "https://api.openai.com/v1"
DEFAULT_AI_MODEL = "gpt-4o-mini"
DEFAULT_MAX_TOKENS = 4096


def repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[1]


def prompt_path_for(task: str, prompt_dir: Path) -> Path:
    return prompt_dir / f"{task}.md"


def render_prompt(*, task: str, date: str, source_text: str, prompt_dir: Path) -> str:
    path = prompt_path_for(task, prompt_dir)
    if not path.exists():
        raise FileNotFoundError(f"prompt template not found for task {task}: {path}")
    template = path.read_text(encoding="utf-8")
    return template.format(task=task, date=date, source_text=source_text.strip())


def strip_markdown_fence(text: str) -> str:
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:markdown|md)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```\s*$", "", cleaned)
    return cleaned.strip() + "\n"


def validate_markdown(text: str) -> str:
    cleaned = strip_markdown_fence(text)
    if len(cleaned.strip()) < 200:
        raise ValueError("AI markdown output is too short to publish")
    forbidden = [
        r"Traceback \\(most recent call last\\)",
        r"Script not found:",
        r"归档失败",
        r"\\{\\{[^}]+\\}\\}",
        r"TODO",
    ]
    for pattern in forbidden:
        if re.search(pattern, cleaned, flags=re.IGNORECASE | re.S):
            raise ValueError(f"AI markdown output contains forbidden pattern: {pattern}")
    return cleaned


def chat_completions_url(base_url: str) -> str:
    cleaned = base_url.rstrip("/")
    if cleaned.endswith("/chat/completions"):
        return cleaned
    return cleaned + "/chat/completions"


def request_json(url: str, *, headers: dict[str, str], payload: dict[str, object], timeout: int) -> dict[str, object]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"AI provider HTTP {exc.code}: {body[:1200]}") from exc
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise RuntimeError("AI provider returned non-object JSON")
    return parsed


def call_ai(*, prompt: str, api_key: str, base_url: str, model: str, timeout: int, max_tokens: int) -> str:
    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "你是严格的中文博客编辑。只输出可归档的 Markdown 正文，不输出解释、前后缀或代码围栏。",
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.4,
        "max_tokens": max_tokens,
    }
    data = request_json(
        chat_completions_url(base_url),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        payload=payload,
        timeout=timeout,
    )
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        raise RuntimeError(f"AI response missing choices: {data}")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError(f"AI response missing message content: {data}")
    return content


def mock_response_path(mock_dir: Path, task: str) -> Path:
    return mock_dir / f"{task}.md"


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate blog Markdown from source evidence with an AI provider")
    parser.add_argument("--task", required=True)
    parser.add_argument("--date", required=True)
    parser.add_argument("--api-key", default=os.environ.get("AI_API_KEY", ""))
    parser.add_argument("--base-url", default=os.environ.get("AI_BASE_URL", DEFAULT_AI_BASE_URL))
    parser.add_argument("--model", default=os.environ.get("AI_MODEL", DEFAULT_AI_MODEL))
    parser.add_argument("--prompt-dir", default=str(repo_root_from_script() / "prompts" / "blog"))
    parser.add_argument("--mock-response-file", help="Use a fixed Markdown response instead of calling a provider")
    parser.add_argument("--mock-response-dir", help="Use <dir>/<task>.md as fixed Markdown response")
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    parser.add_argument("--save-prompt", help="Optional path for saving the rendered prompt artifact")
    args = parser.parse_args()

    source_text = sys.stdin.read()
    if not source_text.strip():
        raise ValueError("source evidence is empty")

    prompt = render_prompt(
        task=args.task,
        date=args.date,
        source_text=source_text,
        prompt_dir=Path(args.prompt_dir).expanduser().resolve(),
    )
    if args.save_prompt:
        Path(args.save_prompt).expanduser().resolve().write_text(prompt, encoding="utf-8")

    mock_file = args.mock_response_file
    if args.mock_response_dir:
        mock_file = str(mock_response_path(Path(args.mock_response_dir).expanduser().resolve(), args.task))

    if mock_file:
        raw_markdown = Path(mock_file).expanduser().resolve().read_text(encoding="utf-8")
    else:
        if not args.api_key:
            raise RuntimeError("AI_API_KEY is required for live AI blog generation")
        if not args.base_url:
            raise RuntimeError("AI_BASE_URL is required for live AI blog generation")
        if not args.model:
            raise RuntimeError("AI_MODEL is required for live AI blog generation")
        raw_markdown = call_ai(
            prompt=prompt,
            api_key=args.api_key,
            base_url=args.base_url,
            model=args.model,
            timeout=args.timeout,
            max_tokens=args.max_tokens,
        )

    print(validate_markdown(raw_markdown), end="")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
