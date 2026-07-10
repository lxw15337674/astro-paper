import fs from "node:fs";
import path from "node:path";
import { compact, ensureDir, repoRoot } from "./blog_common.ts";
import { bulletValue, extractBullets } from "./compose_common.ts";

export type MdblistMediaType = "movie" | "show";

export type MdblistRecommendation = {
  key: string;
  mediaType: MdblistMediaType;
  tmdbId: number;
  seasonNumber?: number;
  title: string;
};

export type ArchivedMdblistRecommendation = MdblistRecommendation & {
  archivedAt: string;
  postPath: string;
};

type MdblistLedger = {
  version: 1;
  recommendations: ArchivedMdblistRecommendation[];
};

export const MDBLIST_LEDGER_REL_PATH = "data/mdblist-weekly/recommended.json";

export function mdblistLedgerPath(): string {
  return process.env.MDBLIST_RECOMMENDED_LEDGER_FILE || path.join(repoRoot(), MDBLIST_LEDGER_REL_PATH);
}

export function mdblistRecommendationKey(mediaType: MdblistMediaType, tmdbId: number, seasonNumber?: number): string {
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) throw new Error(`invalid MDBList TMDB id: ${tmdbId}`);
  if (mediaType === "movie") return `movie:${tmdbId}`;
  if (!Number.isInteger(seasonNumber) || Number(seasonNumber) <= 0) {
    throw new Error(`invalid MDBList season number for show ${tmdbId}: ${String(seasonNumber)}`);
  }
  return `show:${tmdbId}:season:${seasonNumber}`;
}

function readLedger(file: string): MdblistLedger {
  if (!fs.existsSync(file)) return { version: 1, recommendations: [] };
  let parsed: Partial<MdblistLedger>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<MdblistLedger>;
  } catch (error) {
    throw new Error(`invalid MDBList recommendation ledger ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.recommendations)) {
    throw new Error(`invalid MDBList recommendation ledger structure: ${file}`);
  }
  for (const entry of parsed.recommendations) {
    const expected = mdblistRecommendationKey(entry.mediaType, Number(entry.tmdbId), entry.seasonNumber);
    if (entry.key !== expected || !compact(entry.title) || !compact(entry.archivedAt) || !compact(entry.postPath)) {
      throw new Error(`invalid MDBList recommendation ledger entry: ${entry.key || "missing key"}`);
    }
  }
  return parsed as MdblistLedger;
}

export function loadMdblistRecommendationKeys(file = mdblistLedgerPath(), excludePostPath = ""): Set<string> {
  return new Set(
    readLedger(file)
      .recommendations.filter(entry => !excludePostPath || entry.postPath !== excludePostPath)
      .map(entry => entry.key),
  );
}

export function appendMdblistRecommendations(
  recommendations: MdblistRecommendation[],
  meta: { archivedAt: string; postPath: string },
  file = mdblistLedgerPath(),
): void {
  if (!recommendations.length) throw new Error("cannot archive an empty MDBList recommendation selection");
  const unique = new Map<string, MdblistRecommendation>();
  for (const recommendation of recommendations) {
    const expected = mdblistRecommendationKey(recommendation.mediaType, recommendation.tmdbId, recommendation.seasonNumber);
    if (recommendation.key !== expected) throw new Error(`MDBList recommendation key mismatch: ${recommendation.key} vs ${expected}`);
    if (!compact(recommendation.title)) throw new Error(`MDBList recommendation ${recommendation.key} is missing title`);
    unique.set(recommendation.key, recommendation);
  }
  if (unique.size !== recommendations.length) throw new Error("MDBList recommendation selection contains duplicate identities");

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

export function parseMdblistRecommendationsFromSource(source: string): MdblistRecommendation[] {
  const blocks = source
    .split(/(?=^##\s+\d+\.\s+)/gm)
    .map(block => block.trim())
    .filter(block => /^##\s+\d+\.\s+/.test(block));
  return blocks.map(block => {
    const bullets = extractBullets(block);
    const mediaLabel = bulletValue(bullets, "媒体类型");
    const mediaType: MdblistMediaType = mediaLabel === "电影" ? "movie" : mediaLabel === "剧集" ? "show" : (() => {
      throw new Error(`MDBList source has unsupported media type: ${mediaLabel || "missing"}`);
    })();
    const tmdbId = Number(bulletValue(bullets, "TMDB ID"));
    const seasonText = bulletValue(bullets, "推荐季度");
    const seasonNumber = mediaType === "show" ? Number(seasonText) : undefined;
    const title = bulletValue(bullets, "原标题") || block.match(/^##\s+\d+\.\s+(.+)$/m)?.[1]?.trim() || "";
    return {
      key: mdblistRecommendationKey(mediaType, tmdbId, seasonNumber),
      mediaType,
      tmdbId,
      ...(mediaType === "show" ? { seasonNumber } : {}),
      title,
    };
  });
}
