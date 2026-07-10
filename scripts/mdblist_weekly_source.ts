#!/usr/bin/env tsx
import { bjtTimestamp, clipText, compact, fetchJson, parseArgs, stringArg, writeStderr, writeStdout } from "./blog_common.ts";
import {
  type MdblistMediaType,
  type MdblistRecommendation,
  loadMdblistRecommendationKeys,
  mdblistLedgerPath,
  mdblistRecommendationKey,
} from "./mdblist_weekly_ledger.ts";

const MDBLIST_API = "https://api.mdblist.com";
const DEFAULT_LIMIT = 5;
const DEFAULT_CANDIDATE_LIMIT = 30;
// mdblist 上 snoak 维护的 Trakt 趋势榜（数字 list id 比 slug 稳定），可用环境变量覆盖。
const DEFAULT_MOVIES_LIST = "87667"; // Trakt's Trending Movies
const DEFAULT_SHOWS_LIST = "88434"; // Trakt's Trending Shows

type MdblistIds = {
  imdb?: string | null;
  trakt?: number | string | null;
  tmdb?: number | string | null;
};

export type MdblistItem = {
  id?: number | string;
  title?: string;
  mediatype?: string;
  imdb_id?: string | null;
  release_year?: number;
  language?: string | null;
  ids?: MdblistIds | null;
};

type MdblistListResponse = { movies?: MdblistItem[]; shows?: MdblistItem[]; error?: string };

type MdblistRating = { source?: string; value?: number | null };
type MdblistGenre = { title?: string; name?: string };
export type MdblistSeasonEpisode = { votes?: number | null; rating?: number | null; episode_number?: number | null };
export type MdblistSeason = { season_number?: number | null; episodes?: MdblistSeasonEpisode[] | null };
export type MdblistMediaInfo = {
  description?: string | null;
  tagline?: string | null;
  year?: number | null;
  runtime?: number | null;
  released?: string | null;
  genres?: MdblistGenre[] | null;
  ratings?: MdblistRating[] | null;
  backdrop?: string | null;
  poster?: string | null;
  seasons?: MdblistSeason[] | null;
  error?: string;
};

type ListSpec = { label: string; mediaLabel: string; mediaType: "movie" | "show"; list: string };

export type EnrichedItem = { item: MdblistItem; info: MdblistMediaInfo | null };
export type SelectedMdblistCandidate = EnrichedItem & { recommendation: MdblistRecommendation };

function apiKey(): string {
  const key = compact(process.env.MDBLIST_API_KEY || "");
  if (!key) throw new Error("MDBLIST_API_KEY is required for mdblist-weekly source");
  return key;
}

function itemLimit(): number {
  const parsed = Number(process.env.MDBLIST_ITEM_LIMIT || DEFAULT_LIMIT);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT;
}

function candidateLimit(): number {
  const parsed = Number(process.env.MDBLIST_CANDIDATE_LIMIT || DEFAULT_CANDIDATE_LIMIT);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CANDIDATE_LIMIT;
}

function apiUrl(pathname: string, key: string, params: Record<string, string> = {}): string {
  const url = new URL(`${MDBLIST_API}${pathname}`);
  url.searchParams.set("apikey", key);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

function listItemsPath(list: string): string {
  const trimmed = compact(list).replace(/^\/+|\/+$/g, "");
  if (!trimmed) throw new Error("mdblist list identifier is empty");
  // `user/listname` 与数字 list id 都命中 /lists/{list}/items。
  return `/lists/${trimmed}/items`;
}

async function fetchListItems(spec: ListSpec, key: string, count: number): Promise<MdblistItem[]> {
  const payload = await fetchJson<MdblistListResponse | MdblistItem[]>(apiUrl(listItemsPath(spec.list), key, { limit: String(count) }), {
    headers: { accept: "application/json" },
  });
  if (!Array.isArray(payload) && payload.error) throw new Error(`mdblist API error for ${spec.label}: ${payload.error}`);
  const items = Array.isArray(payload) ? payload : [...(payload.movies || []), ...(payload.shows || [])];
  const trimmed = items.slice(0, count);
  if (!trimmed.length) throw new Error(`mdblist ${spec.label} list returned no items: ${spec.list}`);
  return trimmed;
}

async function fetchMediaInfo(item: MdblistItem, mediaType: "movie" | "show", key: string): Promise<MdblistMediaInfo | null> {
  const tmdb = item.ids?.tmdb;
  const imdb = compact(item.imdb_id || item.ids?.imdb || "");
  const path = tmdb ? `/tmdb/${mediaType}/${tmdb}` : imdb ? `/imdb/${mediaType}/${imdb}` : "";
  if (!path) return null;
  try {
    const info = await fetchJson<MdblistMediaInfo>(apiUrl(path, key), { headers: { accept: "application/json" } });
    return info && !info.error ? info : null;
  } catch {
    return null; // 补全失败不致命，退回稀疏字段。
  }
}

function genreText(info: MdblistMediaInfo | null): string {
  const names = (info?.genres || []).map(genre => compact(genre.title || genre.name || "")).filter(Boolean);
  return names.length ? names.join("、") : "-";
}

function ratingValue(info: MdblistMediaInfo | null, source: string): number | null {
  const rating = (info?.ratings || []).find(entry => entry.source === source);
  return typeof rating?.value === "number" && Number.isFinite(rating.value) ? rating.value : null;
}

function ratingText(info: MdblistMediaInfo | null): string {
  const parts: string[] = [];
  const imdb = ratingValue(info, "imdb");
  if (imdb !== null) parts.push(`IMDb ${imdb.toFixed(1)}`);
  const tomatoes = ratingValue(info, "tomatoes");
  if (tomatoes !== null) parts.push(`烂番茄 ${Math.round(tomatoes)}%`);
  const trakt = ratingValue(info, "trakt");
  if (trakt !== null) parts.push(`Trakt ${Math.round(trakt)}`);
  return parts.length ? parts.join(" / ") : "-";
}

function overviewText(info: MdblistMediaInfo | null): string {
  const overview = compact(info?.description || "");
  return overview ? clipText(overview, 400) : "-";
}

function releaseDateText(info: MdblistMediaInfo | null, item: MdblistItem): string {
  const released = compact(info?.released || "");
  if (released) return released;
  const year = info?.year || item.release_year;
  return typeof year === "number" && year > 0 ? String(year) : "-";
}

function posterUrl(info: MdblistMediaInfo | null): string {
  return compact(info?.backdrop || info?.poster || "") || "-";
}

export function latestStartedSeasonNumber(seasons: MdblistSeason[] | null | undefined): number | null {
  const started = (seasons || [])
    .filter(season => {
      const number = Number(season.season_number);
      if (!Number.isInteger(number) || number <= 0) return false;
      return (season.episodes || []).some(episode => Number(episode.votes || 0) > 0 || (typeof episode.rating === "number" && Number.isFinite(episode.rating)));
    })
    .map(season => Number(season.season_number));
  return started.length ? Math.max(...started) : null;
}

function recommendationForCandidate(candidate: EnrichedItem, mediaType: MdblistMediaType): MdblistRecommendation | null {
  if (!candidate.info) return null;
  const tmdbId = Number(candidate.item.ids?.tmdb);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
  const seasonNumber = mediaType === "show" ? latestStartedSeasonNumber(candidate.info.seasons) : undefined;
  if (mediaType === "show" && seasonNumber === null) return null;
  return {
    key: mdblistRecommendationKey(mediaType, tmdbId, seasonNumber ?? undefined),
    mediaType,
    tmdbId,
    ...(mediaType === "show" ? { seasonNumber: seasonNumber as number } : {}),
    title: compact(candidate.item.title || ""),
  };
}

export function selectUnrecommendedMdblistCandidates(
  candidates: EnrichedItem[],
  mediaType: MdblistMediaType,
  recommendedKeys: Set<string>,
  count: number,
): SelectedMdblistCandidate[] {
  const blocked = new Set(recommendedKeys);
  const selected: SelectedMdblistCandidate[] = [];
  for (const candidate of candidates) {
    const recommendation = recommendationForCandidate(candidate, mediaType);
    if (!recommendation || blocked.has(recommendation.key)) continue;
    selected.push({ ...candidate, recommendation });
    blocked.add(recommendation.key);
    if (selected.length >= count) break;
  }
  return selected;
}

function sourceBlock(enriched: SelectedMdblistCandidate, index: number, spec: ListSpec): string {
  const { item, info, recommendation } = enriched;
  const title = compact(item.title || `未命名作品 ${index + 1}`);
  // 剧集的 runtime 是全季累计分钟，作为单片「片长」会误导，只在电影里给出。
  const runtimeLine = spec.mediaType === "movie" && typeof info?.runtime === "number" && info.runtime > 0 ? [`- 片长：${info.runtime} 分钟`] : [];
  return [
    `## ${index + 1}. ${title}`,
    `- 原标题：${title}`,
    `- 媒体类型：${spec.mediaLabel}`,
    `- TMDB ID：${recommendation.tmdbId}`,
    ...(recommendation.seasonNumber ? [`- 推荐季度：${recommendation.seasonNumber}`] : []),
    `- 题材(EN)：${genreText(info)}`,
    `- 上映日期：${releaseDateText(info, item)}`,
    ...runtimeLine,
    `- 评分：${ratingText(info)}`,
    `- 海报：${posterUrl(info)}`,
    `- 语言：${compact(item.language || "-") || "-"}`,
    `- IMDb：${item.imdb_id ? `https://www.imdb.com/title/${item.imdb_id}/` : "-"}`,
    `- 简介(EN)：${overviewText(info)}`,
  ].join("\n");
}

async function buildSection(spec: ListSpec, key: string, count: number, candidatesToFetch: number, recommendedKeys: Set<string>): Promise<string[]> {
  const items = await fetchListItems(spec, key, candidatesToFetch);
  const selected: SelectedMdblistCandidate[] = [];
  const blocked = new Set(recommendedKeys);
  for (const item of items) {
    const tmdbId = Number(item.ids?.tmdb);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) continue;
    if (spec.mediaType === "movie" && blocked.has(mdblistRecommendationKey("movie", tmdbId))) continue;
    const candidate: EnrichedItem = { item, info: await fetchMediaInfo(item, spec.mediaType, key) };
    const next = selectUnrecommendedMdblistCandidates([candidate], spec.mediaType, blocked, 1)[0];
    if (!next) continue;
    selected.push(next);
    blocked.add(next.recommendation.key);
    if (selected.length >= count) break;
  }
  if (selected.length < count) {
    throw new Error(`mdblist ${spec.label} has only ${selected.length}/${count} unrecommended candidates in the top ${candidatesToFetch}`);
  }
  return [`# ${spec.mediaLabel}候选`, "", ...selected.map((entry, index) => sourceBlock(entry, index, spec)), ""];
}

function listSpecs(): ListSpec[] {
  return [
    { label: "movies", mediaLabel: "电影", mediaType: "movie", list: compact(process.env.MDBLIST_MOVIES_LIST || DEFAULT_MOVIES_LIST) },
    { label: "shows", mediaLabel: "剧集", mediaType: "show", list: compact(process.env.MDBLIST_SHOWS_LIST || DEFAULT_SHOWS_LIST) },
  ];
}

export async function buildMdblistWeeklySource(
  date: string,
  count = itemLimit(),
  {
    candidatesToFetch = candidateLimit(),
    ledgerFile = mdblistLedgerPath(),
    excludePostPath = "",
  }: { candidatesToFetch?: number; ledgerFile?: string; excludePostPath?: string } = {},
): Promise<string> {
  const key = apiKey();
  const specs = listSpecs();
  if (!Number.isInteger(candidatesToFetch) || candidatesToFetch < count) {
    throw new Error(`MDBList candidate limit must be at least the final item limit: ${candidatesToFetch} < ${count}`);
  }
  const recommendedKeys = loadMdblistRecommendationKeys(ledgerFile, excludePostPath);
  const sections = await Promise.all(specs.map(spec => buildSection(spec, key, count, candidatesToFetch, recommendedKeys)));
  return [
    `# 每周影视推荐候选源｜${date}`,
    "",
    "来源：mdblist 聚合的 Trakt 趋势电影与剧集榜单（media 元数据来自 IMDb/TMDb/Trakt 等）",
    `接口：${MDBLIST_API}/lists/{list}/items`,
    `抓取时间：${bjtTimestamp()}`,
    `候选池：电影与剧集各取前 ${candidatesToFetch}，过滤历史推荐后各选 ${count} 部`,
    "",
    "数据说明：榜单代表近期 Trakt 趋势热度，不是官方权威排名。请据证据写推荐，不要编造评分、剧情或上线日期。",
    "",
    ...sections.flat(),
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs();
  const date = stringArg(args, "date", new Date().toISOString().slice(0, 10));
  const count = Number(stringArg(args, "limit", String(itemLimit())));
  const candidatesToFetch = Number(stringArg(args, "candidate-limit", String(candidateLimit())));
  writeStdout(
    await buildMdblistWeeklySource(date, Number.isInteger(count) && count > 0 ? count : itemLimit(), {
      candidatesToFetch: Number.isInteger(candidatesToFetch) && candidatesToFetch > 0 ? candidatesToFetch : candidateLimit(),
      ledgerFile: stringArg(args, "ledger-file", mdblistLedgerPath()),
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
