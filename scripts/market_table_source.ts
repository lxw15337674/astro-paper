// 市场速览：资本市场日报顶部的纯数据表格。数据由 Python/AkShare 抓取（+ CoinGecko 的 BTC），
// TS 只负责计算涨跌/YTD 并渲染 Markdown 表格。红涨绿跌用 +/- 符号表示（纯 Markdown，无底色）。
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { bjtDateString, repoRoot } from "./blog_common.ts";

export type MarketTableRow = {
  category: string;
  name: string;
  latest: number | null;
  prev_close: number | null;
  year_open: number | null;
  unit: "pct" | "bp";
  decimals: number;
};

export type MarketTableData = {
  date: string;
  asof: string;
  rows: MarketTableRow[];
};

function formatLatest(value: number | null, decimals: number): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(decimals);
}

// 股票/外汇/黄金/原油/比特币按百分比，国债收益率按 BP（1% = 100BP）。
function formatChange(latest: number | null, ref: number | null, unit: "pct" | "bp"): string {
  if (latest === null || ref === null || !Number.isFinite(latest) || !Number.isFinite(ref) || ref === 0) return "—";
  const value = unit === "bp" ? (latest - ref) * 100 : (latest / ref - 1) * 100;
  const suffix = unit === "bp" ? "BP" : "%";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

export function renderMarketTable(data: MarketTableData): string {
  const lines = [
    "## 市场速览",
    "",
    `> 截至前一交易日 16:30 收盘（${data.asof || data.date}）。数据来源：AkShare（东财 / 新浪 / 中债 / 上金所）与 CoinGecko；行情缺失以 — 表示。`,
    "",
    "| 分类 | 品种 | 最新 | 当日 | 今年以来 |",
    "| :-- | :-- | --: | --: | --: |",
  ];
  let lastCategory = "";
  for (const row of data.rows) {
    const category = row.category === lastCategory ? "" : row.category;
    lastCategory = row.category;
    lines.push(
      `| ${category} | ${row.name} | ${formatLatest(row.latest, row.decimals)} | ${formatChange(row.latest, row.prev_close, row.unit)} | ${formatChange(row.latest, row.year_open, row.unit)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function fetchMarketTableData(date: string): MarketTableData {
  const script = path.join(repoRoot(), "scripts", "market_table.py");
  const cacheDir = path.join(repoRoot(), "data", "market-table");
  const python = process.env.PYTHON_BIN || "python3";
  const raw = execFileSync(python, [script, "--date", date, "--cache-dir", cacheDir], {
    encoding: "utf8",
    timeout: Number(process.env.MARKET_TABLE_TIMEOUT_MS || "180000"),
    maxBuffer: 16 * 1024 * 1024,
    // stdout 取 JSON，stderr（各品种 candidate failed 诊断）透传到日志。
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(raw) as MarketTableData;
}

// 生成顶部 `## 市场速览` 表格块；fixtureDir 提供时读取本地 JSON，否则实时调 Python/AkShare。
export function buildMarketTable(date = bjtDateString(), { fixtureDir = "" }: { fixtureDir?: string } = {}): string {
  const data = fixtureDir
    ? (JSON.parse(fs.readFileSync(path.join(fixtureDir, "capital-market-daily-table.json"), "utf8")) as MarketTableData)
    : fetchMarketTableData(date);
  return renderMarketTable(data);
}
