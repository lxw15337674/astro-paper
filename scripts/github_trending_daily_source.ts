#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { bjtDateString, clipText, compact, ensureDir, fetchJson, fetchText, parseArgs, repoRoot, stringArg, writeStderr, writeStdout } from "./blog_common.ts";

type GitHubTrendingRepo = {
  rank: number;
  fullName: string;
  owner: string;
  repo: string;
  description: string;
  language: string;
  stars: number;
  forks: number;
  todayStars: number;
  url: string;
  readmeExcerpt: string;
  readmeStatus: "ok" | "missing" | "error";
  errorMessage?: string;
};

type GitHubTrendingArchive = {
  date: string;
  since: "daily";
  totalRepos: number;
  successCount: number;
  failedCount: number;
  repos: GitHubTrendingRepo[];
  metadata: {
    createdAt: string;
    source: string;
    version: string;
  };
};

type GitHubReadmeResponse = {
  download_url?: string | null;
  content?: string;
  encoding?: string;
};

const VERSION = "1.0.0";
const TRENDING_URL = "https://github.com/trending?since=daily";
const DEFAULT_LIMIT = 10;
const README_EXCERPT_CHARS = 1800;

function parseCount(text: string): number {
  const cleaned = compact(text).replace(/,/g, "").toLowerCase();
  const match = cleaned.match(/([\d.]+)\s*([km])?/);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  if (match[2] === "m") return Math.round(value * 1_000_000);
  if (match[2] === "k") return Math.round(value * 1_000);
  return Math.round(value);
}

export function parseGitHubTrendingHtml(html: string, limit = DEFAULT_LIMIT): GitHubTrendingRepo[] {
  const dom = new JSDOM(html, { url: "https://github.com" });
  const document = dom.window.document;
  return [...document.querySelectorAll("article.Box-row")]
    .slice(0, limit)
    .map((article, index) => {
      const repoLink = article.querySelector<HTMLAnchorElement>("h2 a")?.href || "";
      const pathname = repoLink ? new URL(repoLink).pathname : "";
      const fullName = pathname.replace(/^\/+/, "").trim();
      const [owner = "", repo = ""] = fullName.split("/");
      const description = compact(article.querySelector("p")?.textContent || "");
      const language = compact(article.querySelector('[itemprop="programmingLanguage"]')?.textContent || "");
      const stars = parseCount(article.querySelector('a[href$="/stargazers"]')?.textContent || "");
      const forks = parseCount(article.querySelector('a[href$="/forks"]')?.textContent || "");
      const todayStars = parseCount(article.querySelector("span.d-inline-block.float-sm-right")?.textContent || "");
      return {
        rank: index + 1,
        fullName,
        owner,
        repo,
        description,
        language,
        stars,
        forks,
        todayStars,
        url: fullName ? `https://github.com/${fullName}` : "",
        readmeExcerpt: "",
        readmeStatus: "missing" as const,
      };
    })
    .filter(item => item.fullName && item.owner && item.repo && item.url);
}

function decodeBase64(text: string): string {
  return Buffer.from(text.replace(/\s+/g, ""), "base64").toString("utf8");
}

function sanitizeReadmeExcerpt(text: string): string {
  return clipText(
    text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<img\b[^>]*>/gi, " ")
      .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/^\s{0,3}#{1,6}\s*/gm, "")
      .replace(/[`*_>]+/g, " "),
    README_EXCERPT_CHARS,
  );
}

async function fetchReadme(owner: string, repo: string): Promise<string> {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/readme`;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const payload = await fetchJson<GitHubReadmeResponse>(apiUrl, {
    timeoutMs: 15_000,
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "X-GitHub-Api-Version": "2022-11-28",
    },
    maxChars: 1_000_000,
  });
  if (payload.download_url) return fetchText(payload.download_url, { timeoutMs: 15_000, maxChars: 500_000 });
  if (payload.content && payload.encoding === "base64") return decodeBase64(payload.content);
  throw new Error("GitHub README API response missing download_url/content");
}

async function enrichReadmes(repos: GitHubTrendingRepo[]): Promise<GitHubTrendingRepo[]> {
  const enriched: GitHubTrendingRepo[] = [];
  for (const repo of repos) {
    try {
      const readme = await fetchReadme(repo.owner, repo.repo);
      const excerpt = sanitizeReadmeExcerpt(readme);
      enriched.push({ ...repo, readmeExcerpt: excerpt, readmeStatus: excerpt ? "ok" : "missing" });
    } catch (error) {
      enriched.push({ ...repo, readmeStatus: "error", errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }
  return enriched;
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function archivePayload(date: string, repos: GitHubTrendingRepo[]): GitHubTrendingArchive {
  return {
    date,
    since: "daily",
    totalRepos: repos.length,
    successCount: repos.filter(repo => repo.readmeStatus === "ok").length,
    failedCount: repos.filter(repo => repo.readmeStatus !== "ok").length,
    repos,
    metadata: {
      createdAt: new Date().toISOString(),
      source: TRENDING_URL,
      version: VERSION,
    },
  };
}

function writeArchive(dataDir: string, payload: GitHubTrendingArchive): string {
  if (!dataDir) return "";
  ensureDir(dataDir);
  const file = path.join(dataDir, `${payload.date}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return file;
}

function buildSourceMarkdown(payload: GitHubTrendingArchive, archivePath = ""): string {
  const lines = [
    "## 数据边界",
    "",
    `- 日期：${payload.date}`,
    `- 来源：GitHub Trending daily 榜单（${TRENDING_URL}）`,
    `- 候选项目数：${payload.totalRepos}`,
    `- README 获取成功：${payload.successCount}`,
    `- README 获取失败或缺失：${payload.failedCount}`,
    archivePath ? `- 结构化数据归档：${archivePath}` : "- 结构化数据归档：未写入文件（测试或预览模式）",
    "- 数据边界：GitHub Trending 是 GitHub 页面榜单，不等同于全网开源趋势；README 是项目自述，不代表第三方验证。",
    "",
    "## 榜单项目证据",
    "",
  ];

  for (const repo of payload.repos) {
    lines.push(
      `### ${repo.rank}. [${repo.fullName}](${repo.url})`,
      "",
      `- 描述：${repo.description || "未提供描述"}`,
      `- 语言：${repo.language || "未标明"}`,
      `- Stars：${formatNumber(repo.stars)}`,
      `- Forks：${formatNumber(repo.forks)}`,
      `- 今日新增 Stars：${formatNumber(repo.todayStars)}`,
      `- README 状态：${repo.readmeStatus}${repo.errorMessage ? `（${repo.errorMessage}）` : ""}`,
      `- README 摘录：${repo.readmeExcerpt || "未获取到可用 README 摘录，本项目只能基于榜单元数据描述。"}`,
      "",
    );
  }

  return `${lines.join("\n").trim()}\n`;
}

export async function buildGitHubTrendingDailySource(date = bjtDateString(), { dataDir = "", limit = DEFAULT_LIMIT }: { dataDir?: string; limit?: number } = {}): Promise<string> {
  const html = await fetchText(TRENDING_URL, { timeoutMs: 30_000, maxChars: 1_500_000 });
  const repos = await enrichReadmes(parseGitHubTrendingHtml(html, limit));
  if (!repos.length) throw new Error("GitHub Trending source produced zero repositories");
  const payload = archivePayload(date, repos);
  const archivePath = writeArchive(dataDir, payload);
  return buildSourceMarkdown(payload, archivePath ? path.relative(repoRoot(), archivePath) : "");
}

async function main(): Promise<void> {
  const args = parseArgs();
  const date = stringArg(args, "date", bjtDateString());
  const repo = path.resolve(stringArg(args, "repo", repoRoot()));
  const limit = Number(stringArg(args, "limit", String(DEFAULT_LIMIT)));
  const dataDir = args["no-archive"] === true ? "" : path.join(repo, "data/github-trending");
  writeStdout(await buildGitHubTrendingDailySource(date, { dataDir, limit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`ERROR: ${message}`);
    process.exit(1);
  });
}
