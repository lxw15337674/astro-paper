import crypto from "node:crypto";
import path from "node:path";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import { JSDOM } from "jsdom";
import { bjtTimestamp, compact } from "./blog_common.ts";
import {
  hasArchivedMagazineIssue,
  magazineIssueKey,
  magazineLedgerPath,
  type MagazineIssue,
} from "./magazine_ledger.ts";

const REPOSITORY = "hehonghui/awesome-english-ebooks";
const MAX_EPUB_BYTES = 64 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 160 * 1024 * 1024;

export class MagazineIssueUnavailableError extends Error {}
export class MagazineIssueAlreadyArchivedError extends Error {}

type GithubEntry = { type: string; name: string; sha: string; size?: number; download_url?: string | null };
type ManifestItem = { id: string; href: string; mediaType: string };

export type MagazineArticle = {
  rank: number;
  originUrl: string;
  text: string;
};

export type MagazineParsedIssue = { title: string; articles: MagazineArticle[] };

// Per-magazine extraction of one EPUB document; drop=true excludes it (non-article page/section).
export type ArticleExtraction = { originUrl: string; text: string; drop?: boolean };

export type MagazineConfig = {
  task: string;
  slug: string; // ledger directory slug, e.g. "economist-weekly"
  keyPrefix: string; // ledger key namespace, e.g. "economist"
  ledgerEnvOverride: string; // env var that can override the ledger path
  dir: string; // repository directory, e.g. "01_economist"
  dirRe: RegExp; // dated issue directory pattern
  issueDateFromDir: (name: string) => string; // -> YYYY-MM-DD
  name: string; // Chinese magazine name, e.g. 经济学人
  defaultEpubTitle: string;
  minArticleChars: number;
  extractArticle: (html: string) => ArticleExtraction;
};

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function cleanPath(base: string, href: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(base), href.split("#")[0]));
}

function normalizedText(value = ""): string {
  return value
    .replace(/ /g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "") // strip zero-width chars carried from the EPUB source
    .replace(/\s+/g, " ")
    .trim();
}

// --- The Economist ---------------------------------------------------------
const ECONOMIST_NON_ARTICLE_SECTIONS = new Set(["the world this week", "letters", "economic & financial indicators"]);

function economistExtract(html: string): ArticleExtraction {
  const { document } = new JSDOM(html).window;
  const section = normalizedText(document.querySelector(".te_section_title")?.textContent || "未标明");
  const originUrl = ((document.querySelector("a.origin_link") as HTMLAnchorElement | null)?.href || "").replace(/^(https?:\/\/[^/]+)\/+/i, "$1/");
  const paragraphs = [...document.querySelectorAll("p")]
    .filter(node => !node.closest(".link_navbar, nav, header, footer") && !/downloaded by|subscribers only/i.test(node.textContent || ""))
    .map(node => normalizedText(node.textContent || ""))
    .filter(text => text.length > 30);
  return { originUrl, text: paragraphs.join("\n\n"), drop: ECONOMIST_NON_ARTICLE_SECTIONS.has(section.toLowerCase()) };
}

// --- The New Yorker --------------------------------------------------------
function newYorkerExtract(html: string): ArticleExtraction {
  const { document } = new JSDOM(html).window;
  const article = document.querySelector(".article");
  if (!article) return { originUrl: "", text: "", drop: true };
  const paragraphs = [...article.querySelectorAll("p")]
    .map(node => normalizedText(node.textContent || ""))
    .filter(text => text.length > 30);
  // The New Yorker EPUB has no dedicated origin link; take the first canonical article URL if present.
  const link = [...document.querySelectorAll('a[href*="newyorker.com/"]')]
    .map(anchor => (anchor as HTMLAnchorElement).href)
    .find(href => /newyorker\.com\/[a-z]/i.test(href)) || "";
  const originUrl = link.replace(/[#?].*$/, "");
  return { originUrl, text: paragraphs.join("\n\n") };
}

// --- Calibre-generic (The Atlantic, Wired) ---------------------------------
// Bodies are one article per file with hashed calibre classes; feed/TOC pages carry
// little prose and fall below minArticleChars. No reliable canonical source link.
function calibreExtract(html: string): ArticleExtraction {
  const { document } = new JSDOM(html).window;
  const paragraphs = [...document.querySelectorAll("p")]
    .filter(node => !node.closest('nav, header, footer, [class*="navbar"]'))
    .map(node => normalizedText(node.textContent || ""))
    .filter(text => text.length > 30);
  return { originUrl: "", text: paragraphs.join("\n\n") };
}

export const MAGAZINES: Record<string, MagazineConfig> = {
  "economist-weekly": {
    task: "economist-weekly",
    slug: "economist-weekly",
    keyPrefix: "economist",
    ledgerEnvOverride: "ECONOMIST_ISSUES_LEDGER_FILE",
    dir: "01_economist",
    dirRe: /^te_\d{4}\.\d{2}\.\d{2}$/,
    issueDateFromDir: name => name.slice(3).replaceAll(".", "-"),
    name: "经济学人",
    defaultEpubTitle: "The Economist",
    minArticleChars: 900,
    extractArticle: economistExtract,
  },
  "new-yorker-weekly": {
    task: "new-yorker-weekly",
    slug: "new-yorker-weekly",
    keyPrefix: "new-yorker",
    ledgerEnvOverride: "NEW_YORKER_ISSUES_LEDGER_FILE",
    dir: "02_new_yorker",
    dirRe: /^\d{4}\.\d{2}\.\d{2}$/,
    issueDateFromDir: name => name.replaceAll(".", "-"),
    name: "纽约客",
    defaultEpubTitle: "The New Yorker",
    minArticleChars: 1200,
    extractArticle: newYorkerExtract,
  },
  "atlantic-monthly": {
    task: "atlantic-monthly",
    slug: "atlantic-monthly",
    keyPrefix: "atlantic",
    ledgerEnvOverride: "ATLANTIC_ISSUES_LEDGER_FILE",
    dir: "04_atlantic",
    dirRe: /^\d{4}\.\d{2}\.\d{2}$/,
    issueDateFromDir: name => name.replaceAll(".", "-"),
    name: "大西洋月刊",
    defaultEpubTitle: "The Atlantic",
    minArticleChars: 1500,
    extractArticle: calibreExtract,
  },
  "wired-monthly": {
    task: "wired-monthly",
    slug: "wired-monthly",
    keyPrefix: "wired",
    ledgerEnvOverride: "WIRED_ISSUES_LEDGER_FILE",
    dir: "05_wired",
    dirRe: /^\d{4}\.\d{2}\.\d{2}$/,
    issueDateFromDir: name => name.replaceAll(".", "-"),
    name: "连线",
    defaultEpubTitle: "Wired",
    minArticleChars: 1500,
    extractArticle: calibreExtract,
  },
};

export function isMagazineTask(task: string): boolean {
  return task in MAGAZINES;
}

export function magazineConfig(task: string): MagazineConfig {
  const config = MAGAZINES[task];
  if (!config) throw new Error(`no magazine config for task: ${task}`);
  return config;
}

export function magazineLedgerFile(config: MagazineConfig): string {
  return magazineLedgerPath(config.slug, config.ledgerEnvOverride);
}

export function parseMagazineEpub(buffer: Buffer, config: MagazineConfig): MagazineParsedIssue {
  if (buffer.length > MAX_EPUB_BYTES) throw new Error(`${config.name} EPUB exceeds ${MAX_EPUB_BYTES} byte safety limit`);
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const uncompressed = entries.reduce((total, entry) => total + (entry.header.size || 0), 0);
  if (uncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error(`${config.name} EPUB exceeds ${MAX_UNCOMPRESSED_BYTES} byte uncompressed safety limit`);
  const read = (name: string): string => {
    const entry = zip.getEntry(name);
    if (!entry) throw new Error(`EPUB missing required file: ${name}`);
    return entry.getData().toString("utf8");
  };
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", removeNSPrefix: true });
  const container = parser.parse(read("META-INF/container.xml"));
  const opfPath = asArray<Record<string, string>>(container?.container?.rootfiles?.rootfile)[0]?.["full-path"];
  if (!opfPath) throw new Error("EPUB container has no OPF rootfile");
  const opf = parser.parse(read(opfPath));
  const packageNode = opf?.package;
  const title = compact(packageNode?.metadata?.title || config.defaultEpubTitle);
  const manifest = new Map(
    asArray<Record<string, string>>(packageNode?.manifest?.item).map(item => [item.id, { id: item.id, href: item.href, mediaType: item["media-type"] } satisfies ManifestItem]),
  );
  const spine = asArray<Record<string, string>>(packageNode?.spine?.itemref);
  const articles: Omit<MagazineArticle, "rank">[] = [];
  for (const ref of spine) {
    const item = manifest.get(ref.idref);
    if (!item || !/html/i.test(item.mediaType)) continue;
    const sourceFile = cleanPath(opfPath, item.href);
    if (/book_toc|cover|ad_page/i.test(sourceFile)) continue;
    const entry = zip.getEntry(sourceFile);
    if (!entry) continue;
    const extracted = config.extractArticle(entry.getData().toString("utf8"));
    if (extracted.drop || extracted.text.length < config.minArticleChars) continue;
    articles.push({ originUrl: extracted.originUrl, text: extracted.text });
  }
  if (articles.length < 3) throw new Error(`${config.name} EPUB produced too few complete articles: ${articles.length}`);
  return { title, articles: articles.map((article, index) => ({ ...article, rank: index + 1 })) };
}

async function githubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
  if (!response.ok) throw new MagazineIssueUnavailableError(`GitHub API HTTP ${response.status}: ${url}`);
  return (await response.json()) as T;
}

async function downloadEpub(url: string, config: MagazineConfig): Promise<Buffer> {
  const response = await fetch(url, { headers: { Accept: "application/epub+zip" } });
  if (!response.ok) throw new MagazineIssueUnavailableError(`${config.name} EPUB download HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") || "0");
  if (length > MAX_EPUB_BYTES) throw new Error(`${config.name} EPUB content-length exceeds ${MAX_EPUB_BYTES} byte safety limit`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_EPUB_BYTES || bytes.subarray(0, 2).toString() !== "PK") throw new Error(`${config.name} source is not a valid EPUB ZIP payload`);
  return bytes;
}

export function renderMagazineSource(config: MagazineConfig, issue: MagazineIssue, parsed: MagazineParsedIssue, issueUrl: string): string {
  return [
    `# 《${config.name}》本期候选｜${issue.issueDate}`,
    "",
    `- 刊期：${issue.issueDate}`,
    `- 来源仓库：https://github.com/${REPOSITORY}`,
    `- 刊期目录：${issueUrl}`,
    `- 来源提交：${issue.sourceCommit}`,
    `- EPUB SHA-256：${issue.epubSha256}`,
    `- EPUB 标题：${parsed.title}`,
    `- 抓取时间：${bjtTimestamp()}`,
    "",
    "数据说明：以下正文来自 EPUB 的阅读顺序。每篇文章会独立请求中文标题与摘要。",
    "",
    ...parsed.articles.flatMap(article => [
      `## ${article.rank}. 文章`,
      "",
      `- 原文链接：${article.originUrl || "-"}`,
      "",
      article.text,
      "",
    ]),
  ].join("\n");
}

export async function buildMagazineWeeklySource(
  config: MagazineConfig,
  date: string,
  {
    ledgerFile = magazineLedgerFile(config),
    excludePostPath = "",
    excludePostPathForIssueDate,
  }: { ledgerFile?: string; excludePostPath?: string; excludePostPathForIssueDate?: (issueDate: string) => string } = {},
): Promise<string> {
  const root = await githubJson<GithubEntry[]>(`https://api.github.com/repos/${REPOSITORY}/contents/${config.dir}`);
  const dirs = root
    .filter(entry => entry.type === "dir" && config.dirRe.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  if (!dirs.length) throw new MagazineIssueUnavailableError(`${config.name} source has no dated issue directories`);
  // Newest issue directories can exist as placeholders before their EPUB is uploaded; pick the
  // latest non-future directory that actually contains an EPUB (scan a bounded number of them).
  let issueDate = "";
  let epubUrl = "";
  let sourceCommit = "";
  let issueDirName = "";
  for (const dir of dirs.slice(0, 6)) {
    const candidateDate = config.issueDateFromDir(dir.name);
    if (candidateDate > date) continue;
    const files = await githubJson<GithubEntry[]>(`https://api.github.com/repos/${REPOSITORY}/contents/${config.dir}/${dir.name}`);
    const epub = files.find(entry => entry.type === "file" && /\.epub$/i.test(entry.name) && Boolean(entry.download_url));
    if (epub?.download_url) {
      issueDate = candidateDate;
      epubUrl = epub.download_url;
      sourceCommit = dir.sha;
      issueDirName = dir.name;
      break;
    }
  }
  if (!epubUrl) throw new MagazineIssueUnavailableError(`${config.name} source has no available EPUB issue on or before ${date}`);
  const epubBytes = await downloadEpub(epubUrl, config);
  const epubSha256 = crypto.createHash("sha256").update(epubBytes).digest("hex");
  const issue: MagazineIssue = { key: magazineIssueKey(config.keyPrefix, issueDate, epubSha256), issueDate, sourceCommit, epubSha256 };
  const excludedPostPath = excludePostPathForIssueDate?.(issueDate) || excludePostPath;
  if (hasArchivedMagazineIssue(issue, config.keyPrefix, ledgerFile, excludedPostPath)) throw new MagazineIssueAlreadyArchivedError(`${config.name} issue ${issueDate} is already archived`);
  const parsed = parseMagazineEpub(epubBytes, config);
  return renderMagazineSource(config, issue, parsed, `https://github.com/${REPOSITORY}/tree/master/${config.dir}/${issueDirName}`);
}
