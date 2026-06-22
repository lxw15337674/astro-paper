#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import time
import urllib.error
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

BJT = ZoneInfo("Asia/Shanghai")
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
EASTMONEY_FIELDS = "f12,f14,f2,f3,f4,f5,f6,f17,f18"
EASTMONEY_INDEX_SECS = {
    "dji": "100.DJIA",
    "nasdaq": "100.NDX",
    "spx": "100.SPX",
    "sh": "1.000001",
    "sz": "0.399001",
    "cyb": "0.399006",
    "hsi": "100.HSI",
    "hscei": "100.HSCEI",
}


def fetch_text(url: str, timeout: int = 20, attempts: int = 3) -> str:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return response.read().decode("utf-8", errors="replace")
        except (TimeoutError, urllib.error.URLError) as error:
            last_error = error
            if attempt == attempts:
                break
            time.sleep(2 * attempt)
    raise RuntimeError(f"failed to fetch {url}: {last_error}")


def fetch_json(url: str, timeout: int = 20) -> object:
    return json.loads(fetch_text(url, timeout=timeout))


def pct(value: object) -> str:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return ""
    sign = "+" if num > 0 else ""
    return f"{sign}{num:.2f}%"


def number(value: object, digits: int = 2) -> str:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return ""
    return f"{num:.{digits}f}"


def amount_yi(value: object) -> str:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return ""
    return f"{num / 100000000:.0f}亿元"


def amount_wan_yi(value: object) -> str:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return ""
    return f"{num / 1000000000000:.2f}万亿元"


def eastmoney_indices(secids: list[str]) -> dict[str, dict[str, object]]:
    url = (
        "https://push2.eastmoney.com/api/qt/ulist.np/get"
        f"?fltt=2&invt=2&fields={EASTMONEY_FIELDS}&secids={','.join(secids)}"
    )
    payload = fetch_json(url)
    if not isinstance(payload, dict):
        return {}
    rows = ((payload.get("data") or {}).get("diff") or []) if isinstance(payload.get("data"), dict) else []
    out: dict[str, dict[str, object]] = {}
    for row in rows:
        if isinstance(row, dict) and row.get("f12"):
            out[str(row["f12"])] = row
    return out


def by_code(rows: dict[str, dict[str, object]], code: str) -> dict[str, object]:
    return rows.get(code, {})


def is_missing_quote(row: dict[str, object]) -> bool:
    value = row.get("f2")
    return value in (None, "-", 0) or (isinstance(value, float) and math.isnan(value))


def build_us_section(rows: dict[str, dict[str, object]]) -> str:
    dji = by_code(rows, "DJIA")
    nasdaq = by_code(rows, "NDX")
    spx = by_code(rows, "SPX")
    if any(is_missing_quote(row) for row in (dji, nasdaq, spx)):
        return ""

    parts = [
        f"道指 {pct(dji.get('f3'))}",
        f"纳指 {pct(nasdaq.get('f3'))}",
        f"标普500 {pct(spx.get('f3'))}",
    ]
    direction = "风险偏好回升" if float(nasdaq.get("f3") or 0) > float(dji.get("f3") or 0) else "大盘权重相对均衡"
    return "\n".join(
        [
            "## 美股",
            "",
            "### 指数表现",
            "",
            "本自然日归档的美股部分，采用最近一次已完整落地的收盘数据。三大指数表现为："
            + "；".join(parts)
            + "。",
            "",
            "### 科技股与结构",
            "",
            f"从指数结构看，纳指表现为 {pct(nasdaq.get('f3'))}，标普500表现为 {pct(spx.get('f3'))}，道指表现为 {pct(dji.get('f3'))}，整体呈现{direction}。",
            "",
            "### 消息面",
            "",
            "美股部分以主要指数的已落地收盘表现为准；若需要进一步拆解个股和行业新闻，应以后续人工复盘或更完整的行情源为准。",
        ]
    )


def build_a_share_section(rows: dict[str, dict[str, object]]) -> str:
    sh = by_code(rows, "000001")
    sz = by_code(rows, "399001")
    cyb = by_code(rows, "399006")
    if any(is_missing_quote(row) for row in (sh, sz, cyb)):
        return ""
    turnover = sum(float(row.get("f6") or 0) for row in (sh, sz, cyb))
    leader = max((sh, sz, cyb), key=lambda row: float(row.get("f3") or 0))
    laggard = min((sh, sz, cyb), key=lambda row: float(row.get("f3") or 0))
    return "\n".join(
        [
            "## A股",
            "",
            "### 指数与成交",
            "",
            f"A股最近一个交易日，上证指数收报 {number(sh.get('f2'))} 点，{pct(sh.get('f3'))}；深证成指收报 {number(sz.get('f2'))} 点，{pct(sz.get('f3'))}；创业板指收报 {number(cyb.get('f2'))} 点，{pct(cyb.get('f3'))}。三项指数口径合计成交额约 {amount_wan_yi(turnover)}。",
            "",
            "### 强弱板块",
            "",
            f"从宽基指数强弱看，{leader.get('f14')}相对占优，{laggard.get('f14')}表现偏弱。这个口径只能说明指数层面的风险偏好，不能替代完整行业涨跌幅。",
            "",
            "### 当日主线",
            "",
            "A股部分暂以公开指数和成交额作为自动化日报底稿；若指数分化扩大，后续应优先补充行业和资金流数据，再判断真实主线。",
        ]
    )


def build_hk_section(rows: dict[str, dict[str, object]]) -> str:
    hsi = by_code(rows, "HSI")
    hscei = by_code(rows, "HSCEI")
    if any(is_missing_quote(row) for row in (hsi, hscei)):
        return ""
    total_turnover = sum(float(row.get("f6") or 0) for row in (hsi, hscei))
    return "\n".join(
        [
            "## 港股",
            "",
            "### 指数与资金",
            "",
            f"港股最近一个交易日，恒生指数收报 {number(hsi.get('f2'))} 点，{pct(hsi.get('f3'))}；国企指数收报 {number(hscei.get('f2'))} 点，{pct(hscei.get('f3'))}。两项指数口径成交额合计约 {amount_yi(total_turnover)}。",
            "",
            "### 强弱板块",
            "",
            "自动化口径目前只使用主要指数数据，能够判断大盘风险偏好，但不足以可靠还原行业强弱。后续若接入行业涨跌幅和南向资金，可再扩展这一节。",
            "",
            "### 当日主线",
            "",
            "港股部分先以恒生指数和国企指数的方向为主线观察；若两者同步走弱，说明市场风险偏好偏谨慎，若国企指数相对更强，则更偏向权重和中资资产修复。",
        ]
    )


def fetch_btc_from_coingecko() -> tuple[str, str]:
    payload = fetch_json(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
        timeout=15,
    )
    if not isinstance(payload, dict):
        return "", ""
    bitcoin = payload.get("bitcoin")
    if not isinstance(bitcoin, dict):
        return "", ""
    return number(bitcoin.get("usd"), digits=0), pct(bitcoin.get("usd_24h_change"))


def build_btc_section() -> str:
    try:
        price, change = fetch_btc_from_coingecko()
    except Exception:
        price, change = "", ""
    if not price and not change:
        return ""
    return "\n".join(
        [
            "## BTC 市场动态",
            "",
            "### 自然日价格与涨跌",
            "",
            f"BTC 当前参考价约为 {price} 美元，近 24 小时变动 {change}。",
            "",
            "### 市场观察",
            "",
            "BTC 部分采用公开报价接口生成，仅作为风险资产情绪的辅助观察；若接口不可用或波动异常，应以后续人工复核为准。",
        ]
    )


def build_summary(sections: list[str]) -> str:
    names = []
    for section in sections:
        if section.startswith("## 美股"):
            names.append("美股")
        elif section.startswith("## A股"):
            names.append("A股")
        elif section.startswith("## 港股"):
            names.append("港股")
        elif section.startswith("## BTC"):
            names.append("BTC")
    if not names:
        return ""
    return "\n".join(
        [
            "## 总结",
            "",
            f"本篇自动化日报覆盖 {'、'.join(names)}。当前版本优先保证关键指数、成交额与 BTC 报价可复核，不在数据不足时硬编行业结论。",
        ]
    )


def generate(date: str) -> str:
    del date  # Date is used by the archive layer; quotes are latest available public data.
    rows = eastmoney_indices(list(EASTMONEY_INDEX_SECS.values()))
    sections = [
        build_us_section(rows),
        build_a_share_section(rows),
        build_hk_section(rows),
        build_btc_section(),
    ]
    sections = [section for section in sections if section.strip()]
    summary = build_summary(sections)
    if summary:
        sections.append(summary)
    if not sections:
        raise RuntimeError("no publishable market sections generated")
    return "\n\n".join(sections).strip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate Global Market Daily markdown from public data sources")
    parser.add_argument("--date", help="Archive date YYYY-MM-DD in Asia/Shanghai")
    args = parser.parse_args()
    date = args.date or datetime.now(BJT).strftime("%Y-%m-%d")
    print(generate(date), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
