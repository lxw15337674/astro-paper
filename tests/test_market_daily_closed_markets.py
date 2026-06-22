from __future__ import annotations

import importlib.util
from pathlib import Path


def load_module(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


REPO = Path(__file__).resolve().parents[1]
generate = load_module(
    "generate_morning_market_digest",
    str(REPO / "scripts" / "generate_morning_market_digest.py"),
)


def test_closed_a_share_section_keeps_heading_without_recap():
    out = generate.build_ah_sections([
        "最近一个交易日A股回顾1",
        "最近一个交易日A股回顾2",
        "最近一个交易日A股回顾3",
    ], market_open=False)

    text = "\n".join(out)
    assert "## A股" in text
    assert "本自然日 A 股未开盘，无新增收盘数据。" in text
    assert "最近一个交易日" not in text
    assert "### 指数与成交" not in text


def test_closed_hk_section_keeps_heading_without_recap():
    out = generate.build_hk_sections([
        "最近一个交易日港股回顾1",
        "最近一个交易日港股回顾2",
        "最近一个交易日港股回顾3",
    ], market_open=False)

    text = "\n".join(out)
    assert "## 港股" in text
    assert "本自然日港股未开盘，无新增收盘数据。" in text
    assert "最近一个交易日" not in text
    assert "### 指数与资金" not in text


def test_closed_us_section_keeps_heading_without_data():
    out = generate.build_us_sections(
        {
            "indexes": "+1%",
            "sentiment": "风险偏好回升",
            "tech": "英伟达领涨",
            "macro": "市场关注停火进展",
            "risk": "美债收益率",
        },
        market_open=False,
    )

    text = "\n".join(out)
    assert "## 美股" in text
    assert "本自然日美股未开盘，无新增市场数据。" in text
    assert "+1%" not in text
    assert "### 指数表现" not in text


def test_market_daily_weekend_keeps_placeholders_and_btc_only_data():
    us_raw = "标普500 +1.44%；道指 +1.41%；纳指 +2.74%。谷歌 +2.87%；英伟达 +2.84%；Meta +1.55%。市场关注美伊谈判。"
    btc_raw = "价格 103000 美元，24 小时变动 +2.1%，12 小时变动 +0.4%。"
    ah_text = "最近一个交易日，A股回顾。\n\n科技股较强。\n\n主线仍是算力。"
    hk_text = "最近一个交易日，港股回顾。\n\n成长方向相对占优。\n\n主线是等待外部变量。"
    ipo_text = "无打新。"

    body = generate.build_markdown("2026-06-21", us_raw, ah_text, hk_text, btc_raw, ipo_text)

    assert "## 美股" in body
    assert "本自然日美股未开盘，无新增市场数据。" in body
    assert "## A股" in body
    assert "本自然日 A 股未开盘，无新增收盘数据。" in body
    assert "## 港股" in body
    assert "本自然日港股未开盘，无新增收盘数据。" in body
    assert "最近一个交易日表现" not in body
    assert "最近一次已完整落地的收盘数据" not in body
    assert "## BTC 市场动态" in body
