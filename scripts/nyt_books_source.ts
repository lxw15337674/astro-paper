#!/usr/bin/env tsx
import { bjtTimestamp, clipText, compact, fetchJson, parseArgs, stringArg, writeStderr, writeStdout } from "./blog_common.ts";
import {
  type NytBookListType,
  type NytBookRecommendation,
  loadNytBookRecommendationKeys,
  nytBookRecommendationKey,
  nytBooksLedgerPath,
} from "./nyt_books_ledger.ts";

const NYT_BOOKS_API = "https://api.nytimes.com/svc/books/v3";
// 只推「本周首次上榜」的真·新书：weeks_on_list==1 排除回榜老书。
const MAX_WEEKS_ON_LIST = 1;

type NytBook = {
  rank?: number;
  rank_last_week?: number;
  weeks_on_list?: number;
  title?: string;
  author?: string;
  publisher?: string;
  description?: string;
  book_image?: string;
  primary_isbn13?: string;
  primary_isbn10?: string;
  book_review_link?: string;
  sunday_review_link?: string;
};

type NytListResponse = {
  status?: string;
  results?: { books?: NytBook[] };
  fault?: { faultstring?: string };
};

type ListSpec = { listType: NytBookListType; label: string; list: string };

export type NytBookCandidate = { book: NytBook; recommendation: NytBookRecommendation };

// 抛出后由 generate_scheduled_post 识别为「本周无新书」跳过，而不是记为失败。
export class NytBooksNoNewReleasesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NytBooksNoNewReleasesError";
  }
}

function apiKey(): string {
  const key = compact(process.env.NYT_API_KEY || "");
  if (!key) throw new Error("NYT_API_KEY is required for nyt-books-weekly source");
  return key;
}

function listSpecs(): ListSpec[] {
  return [
    { listType: "fiction", label: "小说", list: compact(process.env.NYT_FICTION_LIST || "combined-print-and-e-book-fiction") },
    { listType: "nonfiction", label: "非虚构", list: compact(process.env.NYT_NONFICTION_LIST || "combined-print-and-e-book-nonfiction") },
  ];
}

function apiUrl(list: string, key: string): string {
  const trimmed = compact(list).replace(/^\/+|\/+$/g, "");
  if (!trimmed) throw new Error("NYT list identifier is empty");
  const url = new URL(`${NYT_BOOKS_API}/lists/current/${trimmed}.json`);
  url.searchParams.set("api-key", key);
  return url.toString();
}

async function fetchListBooks(spec: ListSpec, key: string): Promise<NytBook[]> {
  const payload = await fetchJson<NytListResponse>(apiUrl(spec.list, key), { headers: { accept: "application/json" } });
  if (payload.status && payload.status !== "OK") throw new Error(`NYT API error for ${spec.label}: ${payload.fault?.faultstring || payload.status}`);
  const books = payload.results?.books || [];
  if (!books.length) throw new Error(`NYT ${spec.label} list returned no books: ${spec.list}`);
  return books;
}

function bookId(book: NytBook): string {
  return compact(book.primary_isbn13 || book.primary_isbn10 || "");
}

function isNewRelease(book: NytBook): boolean {
  const weeks = Number(book.weeks_on_list);
  return Number.isInteger(weeks) && weeks >= 1 && weeks <= MAX_WEEKS_ON_LIST;
}

function reviewLink(book: NytBook): string {
  return compact(book.book_review_link || book.sunday_review_link || "");
}

function coverUrl(book: NytBook): string {
  return compact(book.book_image || "") || "-";
}

export function selectNewBookCandidates(books: NytBook[], listType: NytBookListType, recommendedKeys: Set<string>): NytBookCandidate[] {
  const blocked = new Set(recommendedKeys);
  const selected: NytBookCandidate[] = [];
  for (const book of books) {
    if (!isNewRelease(book)) continue;
    const id = bookId(book);
    if (!id) continue; // 畅销书基本都有 ISBN，缺失则无法稳定去重，跳过。
    const key = nytBookRecommendationKey(id);
    if (blocked.has(key)) continue;
    selected.push({ book, recommendation: { key, listType, bookId: id, title: compact(book.title || "") } });
    blocked.add(key);
  }
  return selected;
}

function sourceBlock(candidate: NytBookCandidate, index: number, spec: ListSpec): string {
  const { book, recommendation } = candidate;
  const title = compact(book.title || `未命名图书 ${index + 1}`);
  const link = reviewLink(book);
  return [
    `## ${index + 1}. ${title}`,
    `- 原书名：${title}`,
    `- 榜单类型：${spec.label}`,
    `- ISBN：${recommendation.bookId}`,
    `- 作者：${compact(book.author || "-") || "-"}`,
    `- 出版社：${compact(book.publisher || "-") || "-"}`,
    `- 榜单排名：${Number.isInteger(Number(book.rank)) ? book.rank : "-"}`,
    `- 上榜周数：${Number.isInteger(Number(book.weeks_on_list)) ? book.weeks_on_list : "-"}`,
    `- 书评链接：${link || "-"}`,
    `- 封面：${coverUrl(book)}`,
    `- 简介(EN)：${compact(book.description || "") ? clipText(book.description || "", 400) : "-"}`,
  ].join("\n");
}

async function buildSection(spec: ListSpec, key: string, recommendedKeys: Set<string>): Promise<{ heading: string; blocks: string[] }> {
  const books = await fetchListBooks(spec, key);
  const selected = selectNewBookCandidates(books, spec.listType, recommendedKeys);
  for (const candidate of selected) recommendedKeys.add(candidate.recommendation.key);
  return {
    heading: spec.label,
    blocks: selected.length ? [`# ${spec.label}候选`, "", ...selected.map((entry, index) => sourceBlock(entry, index, spec)), ""] : [],
  };
}

export async function buildNytBooksWeeklySource(
  date: string,
  { ledgerFile = nytBooksLedgerPath(), excludePostPath = "" }: { ledgerFile?: string; excludePostPath?: string } = {},
): Promise<string> {
  const key = apiKey();
  const specs = listSpecs();
  const recommendedKeys = loadNytBookRecommendationKeys(ledgerFile, excludePostPath);
  // 两榜共享去重集合，逐榜串行以保证幂等（同一书跨榜只出现一次）。
  const sections: Array<{ heading: string; blocks: string[] }> = [];
  for (const spec of specs) sections.push(await buildSection(spec, key, recommendedKeys));
  const total = sections.reduce((sum, section) => sum + (section.blocks.length ? 1 : 0), 0);
  if (!total) {
    throw new NytBooksNoNewReleasesError(`NYT books lists have no brand-new (week 1) unrecommended titles for ${date}`);
  }
  return [
    `# 每周图书推荐候选源｜${date}`,
    "",
    "来源：纽约时报畅销书榜（Combined Print & E-Book 小说 / 非虚构）",
    `接口：${NYT_BOOKS_API}/lists/current/{list}.json`,
    `抓取时间：${bjtTimestamp()}`,
    `筛选口径：仅保留本周首次上榜（上榜周数 = ${MAX_WEEKS_ON_LIST}）且未推荐过的图书`,
    "",
    "数据说明：榜单代表纽约时报统计的近期销量热度。请据证据翻译改写，不要编造作者、情节或评分。",
    "",
    ...sections.flatMap(section => section.blocks),
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs();
  const date = stringArg(args, "date", new Date().toISOString().slice(0, 10));
  writeStdout(
    await buildNytBooksWeeklySource(date, {
      ledgerFile: stringArg(args, "ledger-file", nytBooksLedgerPath()),
      excludePostPath: stringArg(args, "exclude-post-path"),
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`ERROR: ${message}`);
    process.exit(1);
  });
}
