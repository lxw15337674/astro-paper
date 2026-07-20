import crypto from "node:crypto";
import path from "node:path";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import { JSDOM } from "jsdom";
import { bjtTimestamp, compact, parseArgs, stringArg, writeStderr, writeStdout } from "./blog_common.ts";
import { economistLedgerPath, economistIssueKey, hasArchivedEconomistIssue, type EconomistIssue } from "./economist_weekly_ledger.ts";

const REPOSITORY = "hehonghui/awesome-english-ebooks";
const ECONOMIST_DIR = "01_economist";
const MAX_EPUB_BYTES = 30 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 80 * 1024 * 1024;
const MAX_ARTICLES = 8;
const MIN_ARTICLE_CHARS = 900;
const MAX_ARTICLE_CHARS = 12_000;
const NON_ARTICLE_SECTIONS = new Set(["the world this week", "letters", "economic & financial indicators"]);

export class EconomistIssueUnavailableError extends Error {}
export class EconomistIssueAlreadyArchivedError extends Error {}

type GithubEntry = { type: string; name: string; sha: string; size?: number; download_url?: string | null };
type ManifestItem = { id: string; href: string; mediaType: string };

export type EconomistArticle = {
  rank: number;
  originalTitle: string;
  section: string;
  author: string;
  sourceFile: string;
  originUrl: string;
  text: string;
};

export type EconomistParsedIssue = { title: string; articles: EconomistArticle[] };

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function cleanPath(base: string, href: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(base), href.split("#")[0]));
}

function normalizedText(value = ""): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function textFromDocument(html: string): { title: string; section: string; author: string; originUrl: string; text: string } {
  const dom = new JSDOM(html);
  const { document } = dom.window;
  const title = normalizedText(document.querySelector("h1.te_article_title, h1, h2")?.textContent || document.title);
  const section = normalizedText(document.querySelector(".te_section_title")?.textContent || "未标明");
  const authorNode = document.querySelector('[class*="author" i], [class*="byline" i]');
  const authorText = normalizedText(authorNode?.textContent || "").replace(/^by\s+/i, "");
  const originUrl = ((document.querySelector("a.origin_link") as HTMLAnchorElement | null)?.href || "").replace(/^(https?:\/\/[^/]+)\/+/i, "$1/");
  const paragraphs = [...document.querySelectorAll("p")]
    .filter(node => !node.closest(".link_navbar, nav, header, footer") && !/downloaded by|subscribers only/i.test(node.textContent || ""))
    .map(node => normalizedText(node.textContent || ""))
    .filter(text => text.length > 30);
  return { title, section, author: authorText || "未标明", originUrl, text: paragraphs.join("\n\n") };
}

export function parseEconomistEpub(buffer: Buffer): EconomistParsedIssue {
  if (buffer.length > MAX_EPUB_BYTES) throw new Error(`Economist EPUB exceeds ${MAX_EPUB_BYTES} byte safety limit`);
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const uncompressed = entries.reduce((total, entry) => total + (entry.header.size || 0), 0);
  if (uncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error(`Economist EPUB exceeds ${MAX_UNCOMPRESSED_BYTES} byte uncompressed safety limit`);
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
  const title = compact(packageNode?.metadata?.title || "The Economist");
  const manifest = new Map(
    asArray<Record<string, string>>(packageNode?.manifest?.item).map(item => [item.id, { id: item.id, href: item.href, mediaType: item["media-type"] } satisfies ManifestItem]),
  );
  const spine = asArray<Record<string, string>>(packageNode?.spine?.itemref);
  const candidates: Omit<EconomistArticle, "rank">[] = [];
  for (const ref of spine) {
    const item = manifest.get(ref.idref);
    if (!item || !/html/i.test(item.mediaType)) continue;
    const sourceFile = cleanPath(opfPath, item.href);
    if (/book_toc|cover|ad_page/i.test(sourceFile)) continue;
    const entry = zip.getEntry(sourceFile);
    if (!entry) continue;
    const parsed = textFromDocument(entry.getData().toString("utf8"));
    if (
      !parsed.title ||
      parsed.text.length < MIN_ARTICLE_CHARS ||
      /^(contents|advertisement)$/i.test(parsed.title) ||
      NON_ARTICLE_SECTIONS.has(parsed.section.toLowerCase())
    ) {
      continue;
    }
    candidates.push({ originalTitle: parsed.title, section: parsed.section, author: parsed.author, sourceFile, originUrl: parsed.originUrl, text: parsed.text.slice(0, MAX_ARTICLE_CHARS) });
  }
  const unique = candidates.filter((article, index) => candidates.findIndex(other => other.originalTitle.toLowerCase() === article.originalTitle.toLowerCase()) === index);
  const selected: Omit<EconomistArticle, "rank">[] = [];
  const sections = new Set<string>();
  for (const article of unique) {
    if (!sections.has(article.section)) {
      selected.push(article);
      sections.add(article.section);
    }
    if (selected.length >= MAX_ARTICLES) break;
  }
  for (const article of unique) {
    if (selected.length >= MAX_ARTICLES) break;
    if (!selected.includes(article)) selected.push(article);
  }
  if (selected.length < 3) throw new Error(`Economist EPUB produced too few complete articles: ${selected.length}`);
  return { title, articles: selected.map((article, index) => ({ ...article, rank: index + 1 })) };
}

async function githubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
  if (!response.ok) throw new EconomistIssueUnavailableError(`GitHub API HTTP ${response.status}: ${url}`);
  return (await response.json()) as T;
}

async function downloadEpub(url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { Accept: "application/epub+zip" } });
  if (!response.ok) throw new EconomistIssueUnavailableError(`Economist EPUB download HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") || "0");
  if (length > MAX_EPUB_BYTES) throw new Error(`Economist EPUB content-length exceeds ${MAX_EPUB_BYTES} byte safety limit`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_EPUB_BYTES || bytes.subarray(0, 2).toString() !== "PK") throw new Error("Economist source is not a valid EPUB ZIP payload");
  return bytes;
}

export function renderEconomistWeeklySource(issue: EconomistIssue, parsed: EconomistParsedIssue, issueUrl: string): string {
  return [
    `# 《经济学人》本期候选｜${issue.issueDate}`,
    "",
    `- 刊期：${issue.issueDate}`,
    `- 来源仓库：https://github.com/${REPOSITORY}`,
    `- 刊期目录：${issueUrl}`,
    `- 来源提交：${issue.sourceCommit}`,
    `- EPUB SHA-256：${issue.epubSha256}`,
    `- EPUB 标题：${parsed.title}`,
    `- 抓取时间：${bjtTimestamp()}`,
    "",
    "数据说明：以下正文来自 EPUB 的阅读顺序。原标题、栏目、作者、来源链接与刊期均为确定性事实，模型只可生成中文标题、一句话摘要、核心观点、内容总结与整期导读。",
    "",
    ...parsed.articles.flatMap(article => [
      `## ${article.rank}. ${article.originalTitle}`,
      "",
      `- 栏目：${article.section}`,
      `- 作者：${article.author}`,
      `- 原文链接：${article.originUrl || "-"}`,
      `- EPUB 文件：${article.sourceFile}`,
      "",
      article.text,
      "",
    ]),
  ].join("\n");
}

export async function buildEconomistWeeklySource(date: string, { ledgerFile = economistLedgerPath(), excludePostPath = "" }: { ledgerFile?: string; excludePostPath?: string } = {}): Promise<string> {
  const root = await githubJson<GithubEntry[]>(`https://api.github.com/repos/${REPOSITORY}/contents/${ECONOMIST_DIR}`);
  const dirs = root.filter(entry => entry.type === "dir" && /^te_\d{4}\.\d{2}\.\d{2}$/.test(entry.name)).sort((a, b) => b.name.localeCompare(a.name));
  if (!dirs.length) throw new EconomistIssueUnavailableError("Economist source has no dated issue directories");
  const latest = dirs[0];
  const issueDate = latest.name.slice(3).replaceAll(".", "-");
  if (issueDate > date) throw new EconomistIssueUnavailableError(`latest Economist issue ${issueDate} is later than archive date ${date}`);
  const files = await githubJson<GithubEntry[]>(`https://api.github.com/repos/${REPOSITORY}/contents/${ECONOMIST_DIR}/${latest.name}`);
  const epub = files.find(entry => entry.type === "file" && /\.epub$/i.test(entry.name) && Boolean(entry.download_url));
  if (!epub?.download_url) throw new EconomistIssueUnavailableError(`Economist issue ${issueDate} has no EPUB file`);
  const epubBytes = await downloadEpub(epub.download_url);
  const epubSha256 = crypto.createHash("sha256").update(epubBytes).digest("hex");
  const issue: EconomistIssue = { key: economistIssueKey(issueDate, epubSha256), issueDate, sourceCommit: latest.sha, epubSha256 };
  if (hasArchivedEconomistIssue(issue, ledgerFile, excludePostPath)) throw new EconomistIssueAlreadyArchivedError(`Economist issue ${issueDate} is already archived`);
  const parsed = parseEconomistEpub(epubBytes);
  return renderEconomistWeeklySource(issue, parsed, `https://github.com/${REPOSITORY}/tree/master/${ECONOMIST_DIR}/${latest.name}`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const date = stringArg(args, "date", new Date().toISOString().slice(0, 10));
  writeStdout(await buildEconomistWeeklySource(date, { ledgerFile: stringArg(args, "ledger-file", economistLedgerPath()), excludePostPath: stringArg(args, "exclude-post-path") }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    writeStderr(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
