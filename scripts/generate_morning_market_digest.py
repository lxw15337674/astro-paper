#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import subprocess
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

BJT = ZoneInfo("Asia/Shanghai")
ROOT = Path("/home/bhwa233")
HERMES_SCRIPTS = ROOT / ".hermes" / "scripts"
ASTRO_POSTS = ROOT / "code" / "astro-paper" / "src" / "content" / "posts" / "zh-cn"


def run_cmd(cmd: list[str]) -> str:
    result = subprocess.run(cmd, text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"command failed: {' '.join(cmd)}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result.stdout.strip()


def run_script(path: Path) -> str:
    return run_cmd(["python3", str(path)])


def read_latest_post(pattern: str) -> str:
    files = sorted(ASTRO_POSTS.glob(pattern))
    if not files:
        raise FileNotFoundError(f"no post files matched {pattern} in {ASTRO_POSTS}")
    return files[-1].read_text(encoding="utf-8")


def strip_frontmatter(text: str) -> str:
    if text.startswith("---\n"):
        parts = text.split("\n---\n", 1)
        if len(parts) == 2:
            return parts[1].strip()
    return text.strip()


def parse_us_market(text: str) -> dict[str, str]:
    data: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("- 时间："):
            data["time"] = line.removeprefix("- 时间：").strip()
        elif line.startswith("- 三大指数："):
            data["indexes"] = line.removeprefix("- 三大指数：").strip()
        elif line.startswith("- 情绪温度："):
            data["sentiment"] = line.removeprefix("- 情绪温度：").strip()
        elif line.startswith("- 主要科技股："):
            data["tech"] = line.removeprefix("- 主要科技股：").strip()
        elif line.startswith("- 宏观/市场事件："):
            data["macro"] = line.removeprefix("- 宏观/市场事件：").strip()
        elif line.startswith("- 盘后风险提示："):
            data["risk"] = line.removeprefix("- 盘后风险提示：").strip()
    return data


def parse_btc(text: str) -> dict[str, str]:
    data: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("- 时间："):
            data["time"] = line.removeprefix("- 时间：").strip()
        elif line.startswith("- 现价："):
            data["price"] = line.removeprefix("- 现价：").strip()
        elif line.startswith("- 24h涨跌幅："):
            data["change_24h"] = line.removeprefix("- 24h涨跌幅：").strip()
        elif line.startswith("- 12h涨跌幅："):
            data["change_12h"] = line.removeprefix("- 12h涨跌幅：").strip()
        elif line.startswith("- 本月涨跌幅："):
            data["mtd"] = line.removeprefix("- 本月涨跌幅：").strip()
        elif line.startswith("- 备注："):
            data["note"] = line.removeprefix("- 备注：").strip()
    return data


def parse_hk_ipo(text: str) -> dict[str, object]:
    text = strip_frontmatter(text)
    result: dict[str, object] = {"has_ipo": False, "body": text}
    if "今日非港股交易日" in text or "今日无可申购港股新股" in text:
        return result
    if "港股打新" in text or "打新" in text:
        result["has_ipo"] = True
        result["body"] = text
    return result


def extract_section(text: str, heading: str) -> str:
    pattern = rf"##\s+{re.escape(heading)}\n+(.*?)(?=\n##\s+|\Z)"
    match = re.search(pattern, text, flags=re.S)
    return match.group(1).strip() if match else ""


def normalize_paragraphs(text: str) -> list[str]:
    text = strip_frontmatter(text)
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    return [p for p in paras if not p.startswith("### ")]


def first_sentence(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return ""
    match = re.search(r".+?[。！？!?]", text)
    return match.group(0).strip() if match else text


def compact_join(parts: list[str]) -> str:
    return " ".join(part.strip() for part in parts if part and part.strip())


def clean_macro_for_summary(macro: str) -> str:
    macro = macro.rstrip("。")
    macro = re.sub(r"^消息面", "", macro)
    macro = re.sub(r"^主要围绕", "", macro)
    return macro.lstrip("，,：:；; ")


def build_key_points(
    us: dict[str, str],
    ah_paras: list[str],
    hk_paras: list[str],
    btc: dict[str, str],
    has_ipo: bool,
) -> list[str]:
    points = []
    if us.get("indexes"):
        points.append(
            f"隔夜美股方面，{us['indexes']}，整体呈现{us.get('sentiment', '分化整理')}。"
        )
    if ah_paras:
        points.append(first_sentence(ah_paras[0]))
    if hk_paras:
        points.append(first_sentence(hk_paras[0]))
    if btc.get("price") or btc.get("change_24h"):
        bits = []
        if btc.get("price"):
            bits.append(f"BTC 现报 {btc['price']}")
        if btc.get("change_24h"):
            bits.append(f"24 小时变动 {btc['change_24h']}")
        if btc.get("change_12h"):
            bits.append(f"12 小时变动 {btc['change_12h']}")
        points.append("；".join(bits) + "。")
    if has_ipo:
        points.append("今天有处于可申购期的港股新股，文末附录已整理相关打新信息。")
    return points[:4]


def build_us_sections(us: dict[str, str]) -> list[str]:
    lines: list[str] = ["## 隔夜美股", ""]
    if us.get("indexes") or us.get("sentiment"):
        lines.extend(["### 指数表现", ""])
        parts = []
        if us.get("indexes"):
            parts.append(f"隔夜美股收盘方面，{us['indexes']}。")
        if us.get("sentiment"):
            parts.append(f"从指数层面看，整体呈现{us['sentiment']}。")
        lines.extend([compact_join(parts), ""])
    if us.get("tech"):
        lines.extend([
            "### 科技股与结构",
            "",
            f"科技权重方面，{us['tech']}",
            "",
        ])
    if us.get("macro") or us.get("risk"):
        lines.extend(["### 消息面", ""])
        if us.get("macro"):
            macro = us["macro"]
            lines.append(macro if macro.startswith("消息面") else f"消息面上，{macro}")
        if us.get("risk"):
            lines.extend(["", f"后续仍可继续关注{us['risk']}"])
        lines.append("")
    return lines


def build_ah_sections(ah_paras: list[str], market_open: bool) -> list[str]:
    if market_open:
        lines: list[str] = ["## A股收盘回顾", ""]
        labels = ["### 指数与成交", "### 强弱板块", "### 当日主线"]
        for label, para in zip(labels, ah_paras[:3]):
            lines.extend([label, "", para, ""])
        return lines

    lines = [
        "## A股（今日未开盘）",
        "",
        "今日 A 股未开盘，无新增收盘数据。以下内容仅回顾最近一个交易日的盘面表现。",
        "",
    ]
    labels = ["### 最近一个交易日指数与成交", "### 最近一个交易日强弱板块", "### 最近一个交易日主线"]
    for label, para in zip(labels, ah_paras[:3]):
        lines.extend([label, "", para, ""])
    return lines


def build_hk_sections(hk_paras: list[str], market_open: bool) -> list[str]:
    if market_open:
        lines: list[str] = ["## 港股收盘回顾", ""]
        labels = ["### 指数与资金", "### 强弱板块", "### 当日主线"]
        for label, para in zip(labels, hk_paras[:3]):
            lines.extend([label, "", para, ""])
        return lines

    lines = [
        "## 港股（今日未开盘）",
        "",
        "今日港股未开盘，无新增收盘数据。以下内容仅回顾最近一个交易日的市场表现。",
        "",
    ]
    labels = ["### 最近一个交易日指数与资金", "### 最近一个交易日强弱板块", "### 最近一个交易日主线"]
    for label, para in zip(labels, hk_paras[:3]):
        lines.extend([label, "", para, ""])
    return lines


def build_btc_sections(btc: dict[str, str]) -> list[str]:
    lines: list[str] = ["## BTC 市场动态", "", "### 当前价格与短线变化", ""]
    current = []
    if btc.get("price"):
        current.append(f"截至发文时，BTC 报 {btc['price']}。")
    if btc.get("change_24h") and btc.get("change_12h"):
        current.append(
            f"过去 24 小时变动为 {btc['change_24h']}，过去 12 小时变动为 {btc['change_12h']}。"
        )
    elif btc.get("change_24h"):
        current.append(f"过去 24 小时变动为 {btc['change_24h']}。")
    lines.extend([compact_join(current), "", "### 市场观察", ""])
    observation = []
    if btc.get("mtd"):
        observation.append(
            f"从月内表现看，BTC 目前较月初仍变动 {btc['mtd']}，说明短线虽然有所修复，但月内趋势仍未完全扭转。"
        )
    if btc.get("note") and "获取失败" in btc["note"]:
        observation.append(f"备注：{btc['note']}")
    lines.extend([compact_join(observation), ""])
    return lines


def build_summary(us: dict[str, str], btc: dict[str, str], has_ipo: bool) -> str:
    lines = []
    if us.get("macro"):
        macro = clean_macro_for_summary(us["macro"])
        lines.append(f"今天早上把几类市场放在一起看，海外市场主线仍集中在{macro}上。")
    if btc.get("change_24h"):
        lines.append(
            f"A股与港股的科技方向仍是主要观察重点，而 BTC 的近 24 小时表现为 {btc['change_24h']}，更适合作为风险情绪的辅助指标。"
        )
    if has_ipo:
        lines.append("若需要关注一级市场机会，还可以结合文末的港股打新附录继续看。")
    return "\n\n".join(lines[:3])


def build_markdown(
    date_str: str,
    us_raw: str,
    ah_text: str,
    hk_text: str,
    btc_raw: str,
    ipo_text: str,
) -> str:
    us = parse_us_market(us_raw)
    btc = parse_btc(btc_raw)
    ah_paras = normalize_paragraphs(ah_text)
    hk_paras = normalize_paragraphs(hk_text)
    ipo = parse_hk_ipo(ipo_text)
    key_points = build_key_points(us, ah_paras, hk_paras, btc, bool(ipo.get("has_ipo")))

    target_dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=BJT)
    weekday = target_dt.weekday()
    cn_market_open = weekday < 5

    lines: list[str] = ["## 今日要点", ""]
    lines.extend([f"- {point}" for point in key_points])
    lines.extend([""])
    lines.extend(build_us_sections(us))
    lines.extend(build_ah_sections(ah_paras, cn_market_open))
    lines.extend(build_hk_sections(hk_paras, cn_market_open))
    lines.extend(build_btc_sections(btc))
    lines.extend(["## 总结", "", build_summary(us, btc, bool(ipo.get("has_ipo"))), ""])
    if ipo.get("has_ipo"):
        lines.extend(["## 附录：港股打新", "", str(ipo["body"]).strip(), ""])
    return "\n".join(lines).strip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", help="Override output date YYYY-MM-DD in Asia/Shanghai")
    args = parser.parse_args()
    now = datetime.now(BJT)
    target_date = args.date or now.strftime("%Y-%m-%d")

    us_raw = run_script(HERMES_SCRIPTS / "us_market_close_summary.py")
    btc_raw = run_script(HERMES_SCRIPTS / "daily_btc_change.py")

    market_post = read_latest_post("市场日报-*.md")
    ah_text = extract_section(market_post, "A股收盘回顾")
    hk_text = extract_section(market_post, "港股收盘回顾")
    ipo_text = extract_section(market_post, "附录：港股打新") or "今日无可申购港股新股。"

    print(build_markdown(target_date, us_raw, ah_text, hk_text, btc_raw, ipo_text))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
