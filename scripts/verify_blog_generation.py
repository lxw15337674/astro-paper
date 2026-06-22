#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


@dataclass(frozen=True)
class FixtureCase:
    task: str
    period: str
    date: str
    body: str
    required: tuple[str, ...]


FIXTURE_CASES: tuple[FixtureCase, ...] = (
    FixtureCase(
        task="hn-top10",
        period="daily",
        date="2099-01-02",
        body="""1. 🔥 今日 HackerNews 热门文章 Top 10

1. 🔥 Developers finally test their automation contracts
- ⭐ 320 points · 64 评论
- 主题：开发工具 / 编程语言
- 原文：https://example.com/automation-contracts
- HN 讨论：https://news.ycombinator.com/item?id=2099010201
- 内容总结：文章讨论了为什么自动化系统不能只检查任务是否启动，而要检查最终产物、文件路径和可复现构建结果。作者把 CI、调度器和内容归档都当作同一个交付链路来分析，强调每一层都必须留下可以审计的边界。
- 评论总结：评论区主要补充了 fixture 测试、离线回放和失败路径观测的重要性。有人指出，真正可靠的生成系统应该在网络数据源不可用时仍然能验证归档层，而不是把所有问题都甩给外部接口。
""",
        required=("HackerNews Top 10", "今日总览", "automation contracts"),
    ),
    FixtureCase(
        task="global-market-daily",
        period="daily",
        date="2099-01-02",
        body="""## 美股

三大指数表现为：纳指上涨 1.20%，标普500 上涨 0.60%，道指上涨 0.30%。从指数层面看，整体呈现科技权重相对占优。

## A股

A股最近一个交易日，上证指数小幅震荡，成交额维持在可观察区间。自动化日报只保留可复核指数信息，不在行业数据不足时硬编板块结论。

## 港股

港股最近一个交易日，恒生指数和国企指数同步整理。这个口径足以判断大盘风险偏好，但不足以替代完整行业涨跌幅。

## BTC 市场动态

BTC 当前参考价约为 100000 美元，近 24 小时变动 +1.50%。该数据只作为风险资产情绪的辅助观察。

## 总结

本篇自动化日报覆盖美股、A股、港股和 BTC，并明确把数据边界写进正文。
""",
        required=("全球市场日报", "美股", "BTC 市场动态"),
    ),
    FixtureCase(
        task="foreign-tech-podcast",
        period="daily",
        date="2099-01-02",
        body="""《今日国外热门科技访谈播客》

## 今日总览

今天的播客笔记围绕 AI 基础设施、可信代理和工程组织的控制面展开，重点不是复述新闻标题，而是把访谈里的判断整理成可以长期回看的一组技术观察。

## 今日播客清单

- Trustworthy AI Systems

---

## Trustworthy AI Systems

- **节目**：Engineering the Future
- **嘉宾**：Ada Systems
- **日期**：2099-01-02
- **来源**：Podcast fixture
- **链接**：https://example.com/podcast/trustworthy-ai-systems

### 一句话总结

这期讨论把可信 AI 从口号落到工程系统：模型能力只是入口，真正决定可交付性的，是权限边界、审计日志、回滚策略和人类接管点能否稳定工作。

### Highlights

- 代理系统需要把工具调用、权限升级和人工确认拆成可审计事件。
- 生产环境的 AI 不是一个聊天窗口，而是和队列、数据库、监控、部署系统相互咬合的控制面。

### 长文笔记

嘉宾反复强调，组织引入 AI 代理时最容易犯的错误，是把演示效果当成生产能力。演示阶段只需要模型给出一个看起来聪明的回答，但生产系统需要知道谁授权了动作、动作影响了哪些资源、失败后应该回滚到哪里，以及什么时候必须让人类重新接管。

更有价值的一点是，他们把评估对象从“模型是否聪明”改成了“系统是否可治理”。如果工具权限、上下文注入、日志追踪和变更审批仍然散落在不同地方，那么模型越强，事故半径反而越难预测。这也是为什么可信代理最终会长得更像基础设施，而不是一个普通应用插件。
""",
        required=("海外科技访谈播客笔记", "Trustworthy AI Systems", "今日播客清单"),
    ),
    FixtureCase(
        task="mdblist-weekly",
        period="weekly",
        date="2099-01-05",
        body="""## 电影推荐

### Hoppers（Hoppers）

- 类型：动画、冒险、科幻
- 上线日期：2099-01-03
- 推荐理由：这部片适合放进本周待看片单，因为它把轻量冒险、技术想象和家庭观众都能理解的情感线放在一起。自动化推荐在这里只保留明确片名、类型和推荐理由，不把榜单导出伪装成影评。

## 剧集推荐

### Perfect Crown（Perfect Crown）

- 类型：剧情、爱情
- 上线日期：2099-01-04
- 推荐理由：这部剧适合放进本周待追清单，因为它有清晰的关系张力和连续剧钩子。推荐语需要说明为什么值得看，而不是只罗列数据库字段。
""",
        required=("每周影视推荐", "电影推荐", "Perfect Crown"),
    ),
)

FORBIDDEN_PATTERNS: tuple[str, ...] = (
    r"Traceback \\(most recent call last\\)",
    r"Script not found:",
    r"归档失败",
    r"上游 .* 未提供可归档的最终正文",
    r"BLOCKED:",
    r"\\{\\{[^}]+\\}\\}",
    r"待补充",
    r"示例(?:标题|正文|内容|链接|数据|文章|输出)",
    r"这是一[个篇段].{0,20}示例",
)


def run(cmd: list[str], *, cwd: Path, input_text: str | None = None) -> str:
    result = subprocess.run(cmd, cwd=cwd, input=input_text, text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"command failed: {' '.join(cmd)}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result.stdout.strip()


def repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_json_output(text: str) -> dict[str, object]:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"expected JSON output, got: {text[:400]}") from exc
    if not isinstance(parsed, dict):
        raise ValueError("expected JSON object output")
    return parsed


def post_body(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        raise ValueError(f"{path} is missing frontmatter")
    parts = text.split("\n---\n", 1)
    if len(parts) != 2:
        raise ValueError(f"{path} has malformed frontmatter")
    return parts[1].strip()


def verify_frontmatter(path: Path, *, expected_task: str | None = None) -> str:
    text = path.read_text(encoding="utf-8")
    frontmatter = text.split("\n---\n", 1)[0]
    required_fields = [
        "author:",
        "pubDatetime:",
        "title:",
        "featured:",
        "draft: false",
        "tags:",
        "description:",
        "timezone: Asia/Shanghai",
    ]
    for field in required_fields:
        if field not in frontmatter:
            raise ValueError(f"{path} frontmatter missing {field}")
    if expected_task == "hn-top10" and "HackerNews" not in frontmatter:
        raise ValueError(f"{path} frontmatter missing HackerNews tag/title")
    if expected_task in {"global-market-daily", "morning-market"} and "全球市场日报" not in frontmatter:
        raise ValueError(f"{path} frontmatter missing market tag/title")
    if expected_task == "foreign-tech-podcast" and "海外科技播客" not in frontmatter:
        raise ValueError(f"{path} frontmatter missing podcast tag/title")
    if expected_task == "mdblist-weekly" and "每周影视推荐" not in frontmatter:
        raise ValueError(f"{path} frontmatter missing weekly recommendation tag/title")
    return text


def verify_post_contract(
    repo: Path,
    rel_path: str,
    *,
    task: str | None = None,
    required: tuple[str, ...] = (),
) -> None:
    if not rel_path:
        raise ValueError("post result is missing path")
    post_path = repo / rel_path
    if not post_path.exists():
        raise FileNotFoundError(f"generated post does not exist: {rel_path}")
    text = verify_frontmatter(post_path, expected_task=task)
    body = post_body(post_path)
    if len(body) < 240:
        raise ValueError(f"{rel_path} body is too short to be a publishable blog post")
    if not re.search(r"(?m)^##\s+", body):
        raise ValueError(f"{rel_path} body has no section headings")
    for needle in required:
        if needle not in text:
            raise ValueError(f"{rel_path} missing required text: {needle}")
    for pattern in FORBIDDEN_PATTERNS:
        if re.search(pattern, text, flags=re.IGNORECASE | re.S):
            raise ValueError(f"{rel_path} contains forbidden pattern: {pattern}")


def verify_result_json(repo: Path, result_json: Path) -> None:
    payload = parse_json_output(result_json.read_text(encoding="utf-8"))
    results = payload.get("results")
    if not isinstance(results, list) or not results:
        raise ValueError(f"{result_json} has no results array")

    verified = 0
    for item in results:
        if not isinstance(item, dict):
            raise ValueError(f"invalid result item: {item!r}")
        task = str(item.get("task") or "")
        rel_path = str(item.get("path") or "")
        verify_post_contract(repo, rel_path, task=task)
        verified += 1

    print(json.dumps({"mode": "result-json", "verified": verified}, ensure_ascii=False))


def run_fixture_case(repo: Path, case: FixtureCase) -> dict[str, object]:
    output = run(
        [
            "python3",
            "scripts/astro_paper_archive.py",
            "--task",
            case.task,
            "--period",
            case.period,
            "--date",
            case.date,
            "--repo",
            str(repo),
            "--skip-git-pull",
            "--write-only",
        ],
        cwd=repo,
        input_text=case.body,
    )
    result = parse_json_output(output)
    rel_path = str(result.get("path") or "")
    verify_post_contract(repo, rel_path, task=case.task, required=case.required)
    return result


def run_fixture_suite(repo: Path) -> None:
    generated: list[dict[str, object]] = []
    for case in FIXTURE_CASES:
        generated.append(run_fixture_case(repo, case))
    print(json.dumps({"mode": "fixtures", "generated": generated}, ensure_ascii=False, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify Astro Paper blog generation contracts")
    parser.add_argument("--repo", default=str(repo_root_from_script()))
    parser.add_argument("--result-json", help="Verify JSON output produced by scripts/generate_scheduled_post.py")
    args = parser.parse_args()

    repo = Path(args.repo).expanduser().resolve()
    if not (repo / "scripts" / "astro_paper_archive.py").exists():
        raise FileNotFoundError(f"repo does not look like astro-paper: {repo}")

    if args.result_json:
        verify_result_json(repo, Path(args.result_json).expanduser().resolve())
    else:
        run_fixture_suite(repo)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
