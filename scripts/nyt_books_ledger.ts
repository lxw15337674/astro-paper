import fs from "node:fs";
import path from "node:path";
import { compact, ensureDir, repoRoot } from "./blog_common.ts";
import { bulletValue, extractBullets } from "./compose_common.ts";
import { NYT_BOOK_SECTIONS, sectionByLabel } from "./nyt_books_sections.ts";

// listType 取分节 key（fiction / nonfiction / young_adult / graphic）；仅作元数据，去重靠 ISBN key。
export type NytBookListType = string;

export type NytBookRecommendation = {
  key: string;
  listType: NytBookListType;
  bookId: string;
  title: string;
};

export type ArchivedNytBookRecommendation = NytBookRecommendation & {
  archivedAt: string;
  postPath: string;
};

type NytBooksLedger = {
  version: 1;
  recommendations: ArchivedNytBookRecommendation[];
};

export const NYT_BOOKS_LEDGER_REL_PATH = "data/nyt-books-weekly/recommended.json";

export function nytBooksLedgerPath(): string {
  return process.env.NYT_BOOKS_RECOMMENDED_LEDGER_FILE || path.join(repoRoot(), NYT_BOOKS_LEDGER_REL_PATH);
}

export function nytBookRecommendationKey(bookId: string): string {
  const id = compact(bookId);
  if (!id) throw new Error("invalid NYT book identifier: empty");
  return `book:${id}`;
}

function listTypeFromLabel(label: string): NytBookListType {
  return sectionByLabel(label).key;
}

function readLedger(file: string): NytBooksLedger {
  if (!fs.existsSync(file)) return { version: 1, recommendations: [] };
  let parsed: Partial<NytBooksLedger>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<NytBooksLedger>;
  } catch (error) {
    throw new Error(`invalid NYT books recommendation ledger ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.recommendations)) {
    throw new Error(`invalid NYT books recommendation ledger structure: ${file}`);
  }
  for (const entry of parsed.recommendations) {
    const expected = nytBookRecommendationKey(entry.bookId);
    if (entry.key !== expected || !compact(entry.title) || !compact(entry.archivedAt) || !compact(entry.postPath)) {
      throw new Error(`invalid NYT books recommendation ledger entry: ${entry.key || "missing key"}`);
    }
  }
  return parsed as NytBooksLedger;
}

export function loadNytBookRecommendationKeys(file = nytBooksLedgerPath(), excludePostPath = ""): Set<string> {
  return new Set(
    readLedger(file)
      .recommendations.filter(entry => !excludePostPath || entry.postPath !== excludePostPath)
      .map(entry => entry.key),
  );
}

export function appendNytBookRecommendations(
  recommendations: NytBookRecommendation[],
  meta: { archivedAt: string; postPath: string },
  file = nytBooksLedgerPath(),
): void {
  if (!recommendations.length) throw new Error("cannot archive an empty NYT books recommendation selection");
  const unique = new Map<string, NytBookRecommendation>();
  for (const recommendation of recommendations) {
    const expected = nytBookRecommendationKey(recommendation.bookId);
    if (recommendation.key !== expected) throw new Error(`NYT book recommendation key mismatch: ${recommendation.key} vs ${expected}`);
    if (!compact(recommendation.title)) throw new Error(`NYT book recommendation ${recommendation.key} is missing title`);
    unique.set(recommendation.key, recommendation);
  }
  if (unique.size !== recommendations.length) throw new Error("NYT books recommendation selection contains duplicate identities");

  const ledger = readLedger(file);
  const newKeys = new Set(unique.keys());
  ledger.recommendations = ledger.recommendations.filter(entry => entry.postPath !== meta.postPath && !newKeys.has(entry.key));
  ledger.recommendations.push(
    ...[...unique.values()].map(recommendation => ({
      ...recommendation,
      archivedAt: meta.archivedAt,
      postPath: meta.postPath,
    })),
  );
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

// 从候选源 markdown 反解出本篇推荐的图书身份，供归档后写入 ledger。
export function parseNytBookRecommendationsFromSource(source: string): NytBookRecommendation[] {
  // 按分节标题「# {label}候选」切段，逐段解析编号块。
  const marks = NYT_BOOK_SECTIONS.map(section => ({ section, at: source.indexOf(`# ${section.label}候选`) }))
    .filter(entry => entry.at >= 0)
    .sort((a, b) => a.at - b.at);
  return marks.flatMap((entry, index) => {
    const text = source.slice(entry.at, index + 1 < marks.length ? marks[index + 1].at : undefined);
    const blocks = text
      .split(/(?=^##\s+\d+\.\s+)/gm)
      .map(block => block.trim())
      .filter(block => /^##\s+\d+\.\s+/.test(block));
    return blocks.map(block => {
      const bullets = extractBullets(block);
      const listType = listTypeFromLabel(bulletValue(bullets, "榜单类型"));
      if (listType !== entry.section.key) throw new Error(`NYT books source block list type mismatch: ${listType} vs ${entry.section.key}`);
      const bookId = bulletValue(bullets, "ISBN");
      const title = bulletValue(bullets, "原书名") || block.match(/^##\s+\d+\.\s+(.+)$/m)?.[1]?.trim() || "";
      return {
        key: nytBookRecommendationKey(bookId),
        listType,
        bookId: compact(bookId),
        title,
      };
    });
  });
}
