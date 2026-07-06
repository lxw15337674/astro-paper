#!/usr/bin/env python3
"""市场速览取数器：用 AkShare 抓 A股/港股指数、国债收益率、外汇、黄金、原油，用 CoinGecko 抓比特币。

输出一份 JSON 到 stdout，供 scripts/market_table_source.ts 渲染成 Markdown 表格：
  {"date": "...", "asof": "...", "rows": [{category,name,latest,prev_close,year_open,unit,decimals}, ...]}

设计原则：每个品种独立 try/except，抓不到就返回 null（前端显示 —），绝不让整张表失败。
注意：AkShare 底层多为中国站点（东财/新浪/中债/上金所），从境外 runner 访问可能不稳定。
个别品种（美元指数、伦敦金、原油、欧元/日元兑人民币）的 AkShare 函数名随版本变化，这里用
「多候选回退链」尽量命中；若某行仍为 —，请看 stderr 的 candidate failed 报错，按你的 akshare
版本微调对应函数名/符号（伦敦金退回 COMEX 黄金期货 GC、原油用外盘期货 OIL/B/CL 为近似口径）。
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime


def retry(fn, attempts=3, delay=2):
    """对抓取函数做几次重试：CN 站点从境外 runner 访问常见瞬断（RemoteDisconnected）。"""
    last = None
    for _ in range(attempts):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(delay)
    raise last if last else RuntimeError("retry failed")

try:
    import akshare as ak
except Exception as exc:  # noqa: BLE001
    print(f"akshare import failed: {exc}", file=sys.stderr)
    ak = None


def year_start(date_str: str) -> str:
    return f"{date_str[:4]}0101"


def triple_from_series(pairs):
    """pairs: 已按日期升序的 [(date_str, value)]，返回 (latest, prev_close, year_open)。"""
    pairs = [(d, float(v)) for d, v in pairs if v is not None and str(v) not in ("", "nan")]
    if not pairs:
        return None, None, None
    latest = pairs[-1][1]
    prev_close = pairs[-2][1] if len(pairs) >= 2 else None
    year = pairs[-1][0][:4]
    year_rows = [v for d, v in pairs if d[:4] == year]
    year_open = year_rows[0] if year_rows else pairs[0][1]
    return latest, prev_close, year_open


def df_triple(df, close_names):
    """通用：从 akshare 返回的 DataFrame 里挑日期列 + 收盘列，算 (latest, prev_close, year_open)。"""
    if df is None or len(df) == 0:
        return None, None, None
    cols = [str(c) for c in df.columns]
    date_col = next((c for cand in ("date", "日期", "时间", "datetime") for c in cols if c.lower() == cand or c == cand), cols[0])
    close_col = next((c for cand in close_names for c in cols if c == cand), None)
    if close_col is None:
        return None, None, None
    sub = df[[date_col, close_col]].dropna()
    pairs = sorted(((str(d), v) for d, v in zip(sub[date_col], sub[close_col])), key=lambda x: x[0])
    return triple_from_series(pairs)


def chain(*producers):
    """依次尝试多个候选取数函数，返回第一个成功的 triple；全失败返回 (None, None, None)。"""
    for producer in producers:
        try:
            result = producer()
            if result and result[0] is not None:
                return result
        except Exception as exc:  # noqa: BLE001
            print(f"candidate failed: {exc}", file=sys.stderr)
    return None, None, None


def row(category, name, unit, decimals, latest=None, prev_close=None, year_open=None):
    return {
        "category": category,
        "name": name,
        "unit": unit,
        "decimals": decimals,
        "latest": latest,
        "prev_close": prev_close,
        "year_open": year_open,
    }


def a_index_triple(symbol: str):
    # A股指数日线：东财优先、新浪兜底，均带重试（CN 站点从境外常瞬断）。symbol 形如 sh000001 / sz399006。
    return chain(
        lambda: df_triple(retry(lambda: ak.stock_zh_index_daily_em(symbol=symbol)), _CLOSE_NAMES),
        lambda: df_triple(retry(lambda: ak.stock_zh_index_daily(symbol=symbol)), _CLOSE_NAMES),
    )


def bond_yield_triple(column: str, date_str: str):
    # 中债国债收益率曲线：列含 '日期' 与 '1年'/'10年'/'30年' 等（单位 %）。用 df_triple 保证按日期排序去空。
    df = retry(lambda: ak.bond_china_yield(start_date=year_start(date_str), end_date=date_str.replace("-", "")))
    # bond_china_yield 每个日期含多条曲线（国债/地方债/金融债…），只保留「国债」曲线，
    # 否则「前收」会取到同一天的另一条曲线，导致当日 BP 异常偏大。
    if "曲线名称" in df.columns:
        name = df["曲线名称"].astype(str)
        df = df[name.str.contains("国债") & ~name.str.contains("地方") & ~name.str.contains("政策") & ~name.str.contains("政金")]
    return df_triple(df, [column])


def sge_gold_triple(symbol: str):
    # 上金所现货历史：列含 date/收盘价。
    df = ak.spot_hist_sge(symbol=symbol)
    date_col = "date" if "date" in df.columns else df.columns[0]
    close_col = "close" if "close" in df.columns else "收盘价"
    pairs = list(zip(df[date_col].astype(str), df[close_col]))
    return triple_from_series(pairs)


_CLOSE_NAMES = ["收盘", "close", "收盘价", "最新价", "收盘点位"]


def scale_triple(triple, scale):
    if scale in (1, None):
        return triple
    return tuple(None if v is None else v / scale for v in triple)


def hk_index_triple(symbol):
    # 港股指数：新浪港股指数日线优先（symbol=HSI/HSCEI/HSTECH），退回东财。
    return chain(
        lambda: df_triple(ak.stock_hk_index_daily_sina(symbol=symbol), _CLOSE_NAMES),
        lambda: df_triple(ak.stock_hk_index_daily_em(symbol=symbol), _CLOSE_NAMES),
    )


def dxy_triple(date_str):
    # 美元指数：akshare 全球指数（东财）优先，退回新浪美股指数 .DXY。
    return chain(
        lambda: df_triple(retry(lambda: ak.index_global_hist_em(symbol="美元指数")), _CLOSE_NAMES),
        lambda: df_triple(retry(lambda: ak.index_us_stock_sina(symbol=".DXY")), _CLOSE_NAMES),
    )


def cny_pair_triple(boc_symbol, date_str, scale=1):
    # 人民币汇率：中行牌价（新浪）央行中间价。美元/欧元报价为「每 100 单位」，scale=100 折成每 1 单位；日元保持每 100。
    triple = df_triple(
        ak.currency_boc_sina(symbol=boc_symbol, start_date=year_start(date_str), end_date=date_str.replace("-", "")),
        ["央行中间价", "中行汇卖价", "中行汇买价", "现汇卖出价", "现汇买入价"],
    )
    return scale_triple(triple, scale)


def london_gold_triple():
    # 伦敦金（美元/盎司）：东财外汇现货优先，退回 COMEX 黄金期货（GC）作近似口径。
    return chain(
        lambda: df_triple(ak.forex_hist_em(symbol="伦敦金"), _CLOSE_NAMES),
        lambda: df_triple(ak.futures_foreign_hist(symbol="GC"), _CLOSE_NAMES),
    )


def foreign_oil_triple(*symbols):
    # 外盘原油期货历史（新浪外盘）：Brent 常用 OIL/B，WTI 常用 CL。
    return chain(*(lambda s=s: df_triple(ak.futures_foreign_hist(symbol=s), _CLOSE_NAMES) for s in symbols))


def btc_triple():
    # 比特币走 CoinGecko：当前价 + 24h前 + 年初价。
    import urllib.request

    def get_json(url):
        with urllib.request.urlopen(url, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))

    market = get_json("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin")
    latest = float(market[0]["current_price"])
    change_24h_pct = float(market[0].get("price_change_percentage_24h") or 0)
    prev_close = latest / (1 + change_24h_pct / 100) if change_24h_pct else latest
    # 年初价：CoinGecko history?date=01-01-YYYY（dd-mm-yyyy）。
    year = datetime.now().year
    hist = get_json(f"https://api.coingecko.com/api/v3/coins/bitcoin/history?date=01-01-{year}&localization=false")
    year_open = float(hist.get("market_data", {}).get("current_price", {}).get("usd") or 0) or None
    return latest, prev_close, year_open


def safe(fn, *args):
    try:
        return fn(*args)
    except Exception as exc:  # noqa: BLE001
        print(f"fetch failed for {fn.__name__}{args}: {exc}", file=sys.stderr)
        return None, None, None


def build_rows(date_str: str):
    rows = []

    # —— 股票（% / 2 位）——
    stock_indices = [
        ("上证指数", "sh000001"),
        ("深证成指", "sz399001"),
        ("创业板指数", "sz399006"),
        ("沪深300", "sh000300"),
        ("中证500", "sh000905"),
        ("科创50", "sh000688"),
    ]
    for name, symbol in stock_indices:
        rows.append(row("股票", name, "pct", 2, *safe(a_index_triple, symbol)))
    for name, symbol in [("恒生指数", "HSI"), ("国企指数", "HSCEI"), ("恒生科技指数", "HSTECH")]:
        rows.append(row("股票", name, "pct", 2, *safe(hk_index_triple, symbol)))

    # —— 债券（BP / 4 位；数值是收益率 %）——
    for name, column in [("1年国债到期收益率", "1年"), ("10年国债到期收益率", "10年"), ("30年国债到期收益率", "30年")]:
        latest, prev_close, year_open = safe(bond_yield_triple, column, date_str)
        rows.append(row("债券", name, "bp", 4, latest, prev_close, year_open))

    # —— 外汇（% / 4 位）—— 中行牌价按每 100 单位报价：美元/欧元 ÷100 折成每 1 单位，日元保持每 100。
    rows.append(row("外汇", "美元指数", "pct", 4, *safe(dxy_triple, date_str)))
    rows.append(row("外汇", "美元兑人民币", "pct", 4, *safe(cny_pair_triple, "美元", date_str, 100)))
    rows.append(row("外汇", "欧元兑人民币", "pct", 4, *safe(cny_pair_triple, "欧元", date_str, 100)))
    rows.append(row("外汇", "100日元兑人民币", "pct", 4, *safe(cny_pair_triple, "日元", date_str, 1)))

    # —— 黄金（% / 2 位）——
    rows.append(row("黄金", "伦敦金（美元/盎司）", "pct", 2, *safe(london_gold_triple)))
    rows.append(row("黄金", "上海金（元/克）", "pct", 2, *safe(sge_gold_triple, "Au99.99")))

    # —— 原油（% / 2 位）——
    rows.append(row("原油", "布伦特原油（美元/桶）", "pct", 2, *safe(foreign_oil_triple, "OIL", "B")))
    rows.append(row("原油", "WTI原油（美元/桶）", "pct", 2, *safe(foreign_oil_triple, "CL", "WTI")))

    # —— 比特币（% / 0 位）——
    latest, prev_close, year_open = safe(btc_triple)
    rows.append(row("比特币", "比特币（美元）", "pct", 0, latest, prev_close, year_open))

    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default=datetime.now().strftime("%Y-%m-%d"))
    parser.add_argument("--cache-dir", default="")
    args = parser.parse_args()
    if ak is None:
        print("akshare is required: pip install akshare", file=sys.stderr)
        sys.exit(1)
    rows = build_rows(args.date)
    out = {"date": args.date, "asof": args.date, "rows": rows}
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
