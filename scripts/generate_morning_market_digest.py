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
CRON_OUTPUT = ROOT / ".hermes" / "cron" / "output"
AHK_JOB_ID = "190aaa34df04"
HK_IPO_JOB_ID = "074ca3b35a55"


def run_cmd(cmd: list[str]) -> str:
    result = subprocess.run(cmd, text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"command failed: {' '.join(cmd)}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result.stdout.strip()


def run_script(path: Path) -> str:
    return run_cmd(["python3", str(path)])


def latest_cron_response(job_id: str) -> str:
    outdir = CRON_OUTPUT / job_id
    if not outdir.exists():
        raise FileNotFoundError(f"cron output dir not found: {outdir}")
    files = sorted(p for p in outdir.iterdir() if p.is_file())
    if not files:
        raise FileNotFoundError(f"no cron artifacts in: {outdir}")
    text = files[-1].read_text(encoding="utf-8")
    marker = "## Response"
    idx = text.find(marker)
    if idx == -1:
        raise ValueError(f"missing response marker in {files[-1]}")
    return text[idx + len(marker):].strip()


def strip_missing_skill_notice(text: str) -> str:
    lines = [
        line
        for line in text.splitlines()
        if not line.startswith("⚠️ Skill(s) not found and skipped:")
    ]
    return "\n".join(lines).strip()


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


def split_ah_hk(text: str) -> tuple[str, str]:
    text = strip_missing_skill_notice(text)
    parts = text.split("===SPLIT===")
    if len(parts) != 2:
        raise ValueError("A/H cron output missing ===SPLIT=== separator")
    return parts[0].strip(), parts[1].strip()


def parse_brief_sections(text: str) -> list[str]:
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]
    if lines and lines[0].startswith("《"):
        lines = lines[1:]
    joined = "\n".join(lines).strip()
    if not joined:
        return []
    paras = [p.strip() for p in joined.split("\n\n") if p.strip()]
    return paras or [joined]


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
    text = strip_missing_skill_notice(text)
    result: dict[str, object] = {"has_ipo": False, "body": text}
    if "今日非港股交易日" in text or "今日无可申购港股新股" in text:
        return result
    if "【港股打新】" in text:
        result["has_ipo"] = True
        result["body"] = text
    return result


def build_key_points(us: dict[str, str], btc: dict[str, str], has_ipo: bool) -> list[str]:
    points = []
    if us.get("indexes"):
        points.append(
            f"隔夜美股方面，{us['indexes']}，整体呈现{us.get('sentiment', '分化整理')}。"
        )
    if us.get("macro"):
        macro = us["macro"]
        points.append(macro if macro.startswith("消息面") else f"消息面上，{macro}")
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
    else:
        points.append(
            "今天无新增港股打新附录内容，正文聚焦隔夜美股、A股、港股与 BTC 四个市场观察模块。"
        )
    return points[:5]


def build_btc_paragraph(btc: dict[str, str]) -> str:
    parts = []
    if btc.get("price"):
        parts.append(f"截至发文时，BTC 报 {btc['price']}。")
    if btc.get("change_24h") and btc.get("change_12h"):
        parts.append(
            f"过去 24 小时变动为 {btc['change_24h']}，过去 12 小时变动为 {btc['change_12h']}。"
        )
    elif btc.get("change_24h"):
        parts.append(f"过去 24 小时变动为 {btc['change_24h']}。")
    if btc.get("mtd"):
        parts.append(f"按月初口径计算，本月累计变动为 {btc['mtd']}。")
    if btc.get("note") and "获取失败" in btc["note"]:
        parts.append(f"备注：{btc['note']}")
    return " ".join(parts)


def clean_macro_for_summary(macro: str) -> str:
    macro = macro.rstrip("。")
    macro = re.sub(r"^消息面", "", macro)
    macro = re.sub(r"^主要围绕", "", macro)
    return macro.lstrip("，,：:；; ")


def build_summary(us: dict[str, str], btc: dict[str, str], has_ipo: bool) -> str:
    lines = []
    if us.get("macro"):
        macro = clean_macro_for_summary(us["macro"])
        lines.append(f"从晨间横向观察看，外盘主线仍主要围绕{macro}展开。")
    if btc.get("change_24h"):
        lines.append(
            f"加密资产方面，BTC 的短线表现为 {btc['change_24h']}，可作为风险情绪的补充观察窗口。"
        )
    lines.append(
        "A股与港股部分则分别对应最近一个交易日的收盘状态，便于在开盘前快速建立当日市场背景。"
    )
    if has_ipo:
        lines.append("若需要关注一级市场机会，可直接查看文末港股打新附录。")
    return "\n\n".join(lines)


def build_markdown(
    date_str: str,
    us_raw: str,
    ah_raw: str,
    hk_raw: str,
    btc_raw: str,
    ipo_raw: str,
) -> str:
    us = parse_us_market(us_raw)
    btc = parse_btc(btc_raw)
    ah_paras = parse_brief_sections(ah_raw)
    hk_paras = parse_brief_sections(hk_raw)
    ipo = parse_hk_ipo(ipo_raw)
    key_points = build_key_points(us, btc, bool(ipo.get("has_ipo")))

    lines: list[str] = [
        f"《晨间市场观察》{date_str}",
        "",
        "## 今日要点",
        "",
    ]
    lines.extend([f"- {point}" for point in key_points])
    lines.extend(["", "## 隔夜美股", ""])
    if us.get("indexes"):
        lines.append(f"隔夜美股收盘方面，{us['indexes']}。")
    if us.get("sentiment"):
        lines.append(f"从指数层面看，整体呈现{us['sentiment']}。")
    if us.get("tech"):
        lines.extend(["", f"科技权重方面，{us['tech']}"])
    if us.get("macro"):
        macro = us["macro"]
        lines.extend(["", macro if macro.startswith("消息面") else f"消息面上，{macro}"])
    if us.get("risk"):
        lines.extend(["", f"盘后仍需留意{us['risk']}"])

    lines.extend(["", "## A股收盘回顾", ""])
    lines.extend(ah_paras or ["暂无可用的 A 股收盘内容。"])

    lines.extend(["", "## 港股收盘回顾", ""])
    lines.extend(hk_paras or ["暂无可用的港股收盘内容。"])

    lines.extend([
        "",
        "## BTC 市场动态",
        "",
        build_btc_paragraph(btc),
        "",
        "## 总结",
        "",
        build_summary(us, btc, bool(ipo.get("has_ipo"))),
        "",
    ])
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
    ahk_response = latest_cron_response(AHK_JOB_ID)
    ah_raw, hk_raw = split_ah_hk(ahk_response)
    ipo_raw = latest_cron_response(HK_IPO_JOB_ID)

    print(build_markdown(target_date, us_raw, ah_raw, hk_raw, btc_raw, ipo_raw))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
