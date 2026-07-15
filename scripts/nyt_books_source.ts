#!/usr/bin/env tsx
import { bjtTimestamp, clipText, compact, fetchJson, parseArgs, stringArg, writeStderr, writeStdout } from "./blog_common.ts";
import { NYT_BOOK_SECTIONS, type NytBookSection } from "./nyt_books_sections.ts";
import {
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

type NytOverviewList = { list_name_encoded?: string; books?: NytBook[] };
type NytOverviewResponse = {
  status?: string;
  results?: { published_date?: string; lists?: NytOverviewList[] };
  fault?: { faultstring?: string };
};

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

// overview.json 一次返回全部活跃榜单，避开 NYT 5 次/分钟的逐榜限流。
async function fetchOverview(key: string): Promise<Map<string, NytBook[]>> {
  const url = new URL(`${NYT_BOOKS_API}/lists/overview.json`);
  url.searchParams.set("api-key", key);
  const payload = await fetchJson<NytOverviewResponse>(url.toString(), { headers: { accept: "application/json" } });
  if (payload.status && payload.status !== "OK") throw new Error(`NYT overview API error: ${payload.fault?.faultstring || payload.status}`);
  const lists = payload.results?.lists || [];
  if (!lists.length) throw new Error("NYT overview returned no lists");
  const byEncoded = new Map<string, NytBook[]>();
  for (const list of lists) {
    const encoded = compact(list.list_name_encoded || "");
    if (encoded) byEncoded.set(encoded, list.books || []);
  }
  return byEncoded;
}

function bookId(book: NytBook): string {
  return compact(book.primary_isbn13 || book.primary_isbn10 || "");
}

function isNewRelease(book: NytBook): boolean {
  const weeks = Number(book.weeks_on_list);
  return Number.isInteger(weeks) && weeks >= 1 && weeks <= MAX_WEEKS_ON_LIST;
}

// 本轮跨榜兜底去重：同名同作者视为同一本，防止个别格式榜用不同 ISBN 造成重复条目。
function titleAuthorKey(book: NytBook): string {
  return `${compact(book.title || "").toLowerCase()}|${compact(book.author || "").toLowerCase()}`;
}

function reviewLink(book: NytBook): string {
  return compact(book.book_review_link || book.sunday_review_link || "");
}

function coverUrl(book: NytBook): string {
  return compact(book.book_image || "") || "-";
}

function sourceBlock(candidate: NytBookCandidate, index: number, section: NytBookSection): string {
  const { book, recommendation } = candidate;
  const title = compact(book.title || `未命名图书 ${index + 1}`);
  return [
    `## ${index + 1}. ${title}`,
    `- 原书名：${title}`,
    `- 榜单类型：${section.label}`,
    `- ISBN：${recommendation.bookId}`,
    `- 作者：${compact(book.author || "-") || "-"}`,
    `- 书评链接：${reviewLink(book) || "-"}`,
    `- 封面：${coverUrl(book)}`,
    `- 简介(EN)：${compact(book.description || "") ? clipText(book.description || "", 400) : "-"}`,
  ].join("\n");
}

function buildSection(
  section: NytBookSection,
  overview: Map<string, NytBook[]>,
  blockedKeys: Set<string>,
  blockedTitleAuthor: Set<string>,
): { blocks: string[]; recommendations: NytBookRecommendation[] } {
  const selected: NytBookCandidate[] = [];
  for (const list of section.lists) {
    for (const book of overview.get(list) || []) {
      if (!isNewRelease(book)) continue;
      const id = bookId(book);
      if (!id) continue; // 畅销书基本都有 ISBN，缺失无法稳定去重，跳过。
      const key = nytBookRecommendationKey(id);
      const taKey = titleAuthorKey(book);
      if (blockedKeys.has(key) || blockedTitleAuthor.has(taKey)) continue;
      blockedKeys.add(key);
      blockedTitleAuthor.add(taKey);
      selected.push({ book, recommendation: { key, listType: section.key, bookId: id, title: compact(book.title || "") } });
    }
  }
  if (!selected.length) return { blocks: [], recommendations: [] };
  return {
    blocks: [`# ${section.label}候选`, "", ...selected.map((entry, index) => sourceBlock(entry, index, section)), ""],
    recommendations: selected.map(entry => entry.recommendation),
  };
}

export async function buildNytBooksWeeklySource(
  date: string,
  { ledgerFile = nytBooksLedgerPath(), excludePostPath = "" }: { ledgerFile?: string; excludePostPath?: string } = {},
): Promise<string> {
  const overview = await fetchOverview(apiKey());
  const blockedKeys = loadNytBookRecommendationKeys(ledgerFile, excludePostPath);
  const blockedTitleAuthor = new Set<string>();
  const sections = NYT_BOOK_SECTIONS.map(section => buildSection(section, overview, blockedKeys, blockedTitleAuthor));
  const total = sections.reduce((sum, section) => sum + section.recommendations.length, 0);
  if (!total) {
    throw new NytBooksNoNewReleasesError(`NYT books lists have no brand-new (week 1) unrecommended titles for ${date}`);
  }
  const sourceLists = [...new Set(NYT_BOOK_SECTIONS.flatMap(section => section.lists))].join(", ");
  return [
    `# 每周图书推荐候选源｜${date}`,
    "",
    "来源：纽约时报畅销书榜 overview（小说 / 非虚构 / 青少年 / 图像小说与漫画）",
    `接口：${NYT_BOOKS_API}/lists/overview.json`,
    `聚合榜单：${sourceLists}`,
    `抓取时间：${bjtTimestamp()}`,
    `筛选口径：仅保留本周首次上榜（上榜周数 = ${MAX_WEEKS_ON_LIST}）且未推荐过的图书，跨榜按 ISBN 与书名作者去重`,
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
