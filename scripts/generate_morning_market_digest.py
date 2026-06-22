#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

BJT = ZoneInfo("Asia/Shanghai")
ROOT = Path("/home/bhwa233")
HERMES_SCRIPTS = ROOT / ".hermes" / "scripts"
REPO = ROOT / "code" / "astro-paper"
ASTRO_POSTS = REPO / "src" / "content" / "posts" / "zh-cn"
MARKET_DAILY_ROOT = REPO / "data" / "market-daily"
SECTION_ORDER = ["us", "a-share", "hk", "btc"]
QUALITY_BLOCK_PATTERNS = [
    r"\{\{[^}]+\}\}",
    r"待补充",
    r"暂无数据",
    r"稍后补充",
    r"示例",
    r"关注关注",
    r"市场关注.+上",
]


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
    return [sanitize_market_daily_text(p) for p in paras if not p.startswith("### ")]


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


def sanitize_market_daily_text(text: str) -> str:
    text = text.replace("隔夜美股", "美股")
    text = text.replace("隔夜", "")
    text = text.replace("A股当天", "A股最近一个交易日")
    text = text.replace("港股当天", "港股最近一个交易日")
    text = re.sub(r"最近一个交易日的港股收盘数据未能从单一稳定来源完整抓取到全部指数点位，因此这里不机械堆数字。可以确认的是，", "最近一个交易日，", text)
    text = re.sub(r"关注{2,}", "关注", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


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
    return points


def build_us_sections(us: dict[str, str], market_open: bool = True) -> list[str]:
    if not market_open:
        return ["## 美股", "", "本自然日美股未开盘，无新增市场数据。", ""]

    lines: list[str] = ["## 美股", ""]
    if us.get("indexes") or us.get("sentiment"):
        lines.extend(["### 指数表现", ""])
        sentence = "三大指数表现为："
        if us.get("indexes"):
            sentence += f"{us['indexes']}。"
        else:
            sentence = "本自然日美股有交易，但指数数据暂未完整落地。"
        if us.get("sentiment"):
            sentence += f"从指数层面看，整体呈现{us['sentiment']}。"
        lines.extend([sentence, ""])
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
            macro = sanitize_market_daily_text(us["macro"])
            lines.append(macro if macro.startswith("消息面") else f"消息面上，{macro}")
        if us.get("risk"):
            risk = re.sub(r"^关注", "", sanitize_market_daily_text(us["risk"]))
            lines.extend(["", f"后续仍可继续关注{risk}"])
        lines.append("")
    return lines


def build_ah_sections(ah_paras: list[str], market_open: bool) -> list[str]:
    if market_open:
        lines: list[str] = ["## A股", ""]
        labels = ["### 指数与成交", "### 强弱板块", "### 当日主线"]
        for label, para in zip(labels, ah_paras[:3]):
            lines.extend([label, "", para, ""])
        return lines

    return [
        "## A股",
        "",
        "本自然日 A 股未开盘，无新增收盘数据。",
        "",
    ]


def build_hk_sections(hk_paras: list[str], market_open: bool) -> list[str]:
    if market_open:
        lines: list[str] = ["## 港股", ""]
        labels = ["### 指数与资金", "### 强弱板块", "### 当日主线"]
        for label, para in zip(labels, hk_paras[:3]):
            lines.extend([label, "", para, ""])
        return lines

    return [
        "## 港股",
        "",
        "本自然日港股未开盘，无新增收盘数据。",
        "",
    ]


def is_btc_natural_day_complete(date_str: str | None = None, now: datetime | None = None) -> bool:
    if not date_str:
        return True
    target_dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=BJT)
    now_dt = now or datetime.now(BJT)
    return now_dt >= target_dt + timedelta(days=1)


def build_btc_sections(btc: dict[str, str]) -> list[str]:
    lines: list[str] = ["## BTC 市场动态", "", "### 自然日价格与涨跌", ""]
    current = []
    if btc.get("price"):
        current.append(f"北京时间自然日收口后，BTC 报 {btc['price']}。")
    if btc.get("change_24h"):
        current.append(f"本自然日价格变动为 {btc['change_24h']}。")
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
        macro = sanitize_market_daily_text(clean_macro_for_summary(us["macro"]))
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
    target_dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=BJT)
    weekday = target_dt.weekday()
    cn_market_open = weekday < 5
    us_market_open = weekday < 5

    lines: list[str] = []
    lines.extend(build_us_sections(us, us_market_open))
    lines.extend(build_ah_sections(ah_paras, cn_market_open))
    lines.extend(build_hk_sections(hk_paras, cn_market_open))
    lines.extend(build_btc_sections(btc))
    summary = build_summary(us, btc, bool(ipo.get("has_ipo")))
    if summary:
        lines.extend(["## 总结", "", summary, ""])
    if ipo.get("has_ipo"):
        lines.extend(["## 附录：港股打新", "", str(ipo["body"]).strip(), ""])
    return "\n".join(lines).strip() + "\n"



def section_dir_for(date_str: str, root: Path = MARKET_DAILY_ROOT) -> Path:
    return root / date_str


def is_publishable_section(text: str) -> bool:
    stripped = text.strip()
    if not stripped or not stripped.startswith("## "):
        return False
    return not any(re.search(pattern, stripped, flags=re.I | re.S) for pattern in QUALITY_BLOCK_PATTERNS)


def write_meta(section_dir: Path, section: str, status: str, reason: str = "") -> None:
    meta_path = section_dir / "meta.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            meta = {}
    else:
        meta = {}
    meta.setdefault("date", section_dir.name)
    meta.setdefault("timezone", "Asia/Shanghai")
    meta[section] = {
        "generated_at": datetime.now(BJT).isoformat(),
        "status": status,
        "reason": reason,
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_section(section_dir: Path, section: str, lines: list[str]) -> Path | None:
    section_dir.mkdir(parents=True, exist_ok=True)
    text = "\n".join(lines).strip() + "\n"
    if not is_publishable_section(text):
        write_meta(section_dir, section, "skipped", "section failed publishability check")
        return None
    path = section_dir / f"{section}.md"
    path.write_text(text, encoding="utf-8")
    write_meta(section_dir, section, "ok")
    return path


def assemble_market_daily_body(section_dir: Path) -> str:
    parts: list[str] = []
    for section in SECTION_ORDER:
        path = section_dir / f"{section}.md"
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8").strip()
        if is_publishable_section(text):
            parts.append(text)
        else:
            write_meta(section_dir, section, "skipped", "section failed publishability check during assembly")
    if not parts:
        raise ValueError(f"no publishable market daily sections found in {section_dir}")
    return "\n\n".join(parts).strip() + "\n"


def build_section(section: str, date_str: str) -> Path | None:
    us_raw = run_script(HERMES_SCRIPTS / "us_market_close_summary.py")
    btc_raw = run_script(HERMES_SCRIPTS / "daily_btc_change.py")
    market_post = read_latest_post("市场日报-*.md")
    ah_text = extract_section(market_post, "A股收盘回顾")
    hk_text = extract_section(market_post, "港股收盘回顾")

    us = parse_us_market(us_raw)
    btc = parse_btc(btc_raw)
    ah_paras = normalize_paragraphs(ah_text)
    hk_paras = normalize_paragraphs(hk_text)
    target_dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=BJT)
    cn_market_open = target_dt.weekday() < 5
    us_market_open = target_dt.weekday() < 5

    builders = {
        "us": lambda: build_us_sections(us, us_market_open),
        "a-share": lambda: build_ah_sections(ah_paras, cn_market_open),
        "hk": lambda: build_hk_sections(hk_paras, cn_market_open),
        "btc": lambda: build_btc_sections(btc),
    }
    if section not in builders:
        raise ValueError(f"unsupported section: {section}")
    if section == "btc" and not is_btc_natural_day_complete(date_str):
        section_dir = section_dir_for(date_str)
        section_dir.mkdir(parents=True, exist_ok=True)
        write_meta(section_dir, section, "skipped", "BTC natural day has not reached Beijing 24:00 cutoff")
        section_path = section_dir / "btc.md"
        if section_path.exists():
            section_path.unlink()
        return None
    return write_section(section_dir_for(date_str), section, builders[section]())


def build_all_sections(date_str: str) -> list[Path]:
    paths = []
    for section in SECTION_ORDER:
        path = build_section(section, date_str)
        if path is not None:
            paths.append(path)
    return paths


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate natural-day Global Market Daily sections")
    parser.add_argument("--date", help="Override output date YYYY-MM-DD in Asia/Shanghai")
    parser.add_argument("--section", choices=SECTION_ORDER, help="Generate one intermediate section file")
    parser.add_argument("--build-sections", action="store_true", help="Generate all intermediate section files")
    parser.add_argument("--assemble", action="store_true", help="Assemble existing section files into final Markdown body")
    args = parser.parse_args()
    now = datetime.now(BJT)
    target_date = args.date or now.strftime("%Y-%m-%d")

    if args.section:
        path = build_section(args.section, target_date)
        if path:
            print(path)
        return 0
    if args.build_sections:
        for path in build_all_sections(target_date):
            print(path)
        return 0
    if args.assemble:
        print(assemble_market_daily_body(section_dir_for(target_date)))
        return 0

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
