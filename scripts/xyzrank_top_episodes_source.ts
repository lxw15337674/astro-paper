#!/usr/bin/env tsx
import { bjtDateString, compact, parseArgs, stringArg, writeStderr, writeStdout } from "./blog_common.ts";
import { type Episode } from "./foreign_tech_podcast_source.ts";
import { isEpisodeSummarized, loadSummarizedFingerprints } from "./podcast_ledger.ts";

const XYZ_RANK_EPISODES_API = "https://xyzrank.com/api/episodes";
const XYZ_RANK_READER_URL = "https://r.jina.ai/http://r.jina.ai/http://https://xyzrank.com/";
const DEFAULT_LIMIT = 5;
const BROWSER_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36";

type XyzRankEpisode = {
  rank?: number;
  title?: string;
  podcastName?: string;
  link?: string;
  duration?: number;
  playCount?: number;
  commentCount?: number;
  primaryGenreName?: string;
  postTime?: string;
  logoURL?: string;
};

type XyzRankEpisodesResponse = {
  items?: XyzRankEpisode[];
};

type XiaoyuzhouEpisodeMetadata = {
  title?: string;
  show?: string;
  audioUrl?: string;
  description?: string;
  datePublished?: string;
  duration?: string;
  imageUrl?: string;
};

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "cache-control": "no-cache",
      pragma: "no-cache",
      referer: "https://xyzrank.com/",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "user-agent": BROWSER_USER_AGENT,
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return (await response.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "user-agent": BROWSER_USER_AGENT,
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return await response.text();
}

function decodeHtmlAttr(value = ""): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
}

function extractAudioUrl(html: string): string {
  const ogAudio = html.match(/<meta\s+property=["']og:audio["']\s+content=["']([^"']+)["']/i)?.[1];
  if (ogAudio) return decodeHtmlAttr(ogAudio);
  const contentUrl = html.match(/"contentUrl"\s*:\s*"([^"]+)"/)?.[1];
  return contentUrl ? decodeHtmlAttr(contentUrl) : "";
}

function extractJsonLdPayload(html: string): Record<string, unknown> {
  const raw = html.match(/<script name=["']schema:podcast-show["'] type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/i)?.[1] || "";
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function extractXiaoyuzhouMetadata(html: string): XiaoyuzhouEpisodeMetadata {
  const payload = extractJsonLdPayload(html);
  const associatedMedia = typeof payload.associatedMedia === "object" && payload.associatedMedia ? (payload.associatedMedia as Record<string, unknown>) : {};
  const partOfSeries = typeof payload.partOfSeries === "object" && payload.partOfSeries ? (payload.partOfSeries as Record<string, unknown>) : {};
  return {
    title: stringField(payload.name) || decodeHtmlAttr(html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1] || ""),
    show: stringField(partOfSeries.name),
    audioUrl: stringField(associatedMedia.contentUrl) || extractAudioUrl(html),
    description: stringField(payload.description),
    datePublished: stringField(payload.datePublished),
    duration: stringField(payload.timeRequired),
    imageUrl: decodeHtmlAttr(html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)?.[1] || ""),
  };
}

function isoDurationMinutes(value?: string): string | undefined {
  const match = value?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!match) return undefined;
  const hours = Number(match[1] || "0");
  const minutes = Number(match[2] || "0");
  const total = hours * 60 + minutes;
  return total > 0 ? String(total) : undefined;
}

function episodeDate(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString().slice(0, 10);
}

function episodeLimit(): number {
  const value = Number(process.env.XYZRANK_TOP_EPISODES_LIMIT || "");
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_LIMIT;
}

async function fetchXyzRankEpisodeItems(limit = episodeLimit()): Promise<XyzRankEpisode[]> {
  const url = new URL(XYZ_RANK_EPISODES_API);
  url.searchParams.set("offset", "0");
  url.searchParams.set("limit", String(limit));
  try {
    const payload = await fetchJson<XyzRankEpisodesResponse>(url.toString());
    return payload.items || [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`WARN: XYZ Rank API unavailable (${message}); retrying with reader fallback`);
    return fetchXyzRankEpisodeItemsFromReader(limit);
  }
}

async function fetchXyzRankEpisodeItemsFromReader(limit: number): Promise<XyzRankEpisode[]> {
  const markdown = await fetchText(XYZ_RANK_READER_URL);
  const items: XyzRankEpisode[] = [];
  const pattern = /^(\d+)\[!\[Image \d+\]\(([^)]+)\)\]\((https:\/\/www\.xiaoyuzhoufm\.com\/episode\/[^)]+)\)([^\n]*)/gm;
  for (const match of markdown.matchAll(pattern)) {
    const rank = Number(match[1]);
    const tail = match[4] || "";
    const duration = Number(tail.match(/(\d+)′/)?.[1] || "");
    const genre = tail.match(/天前\s+(.+)$/)?.[1]?.trim();
    items.push({
      rank,
      link: match[3],
      logoURL: decodeHtmlAttr(match[2]),
      duration: Number.isFinite(duration) ? duration : undefined,
      primaryGenreName: genre,
    });
    if (items.length >= limit) break;
  }
  if (!items.length) throw new Error("XYZ Rank reader fallback returned no episode links");
  return items;
}

async function toEpisode(item: XyzRankEpisode, index: number, archiveDate: string): Promise<Episode> {
  const rank = Number.isInteger(item.rank) ? Number(item.rank) : index + 1;
  if (!item.link) throw new Error(`XYZ Rank episode #${rank} is missing link`);
  const html = await fetchText(item.link);
  const metadata = extractXiaoyuzhouMetadata(html);
  const audioUrl = metadata.audioUrl || "";
  if (!audioUrl) throw new Error(`XYZ Rank episode #${rank} is missing audio URL: ${item.link}`);
  const pubDate = item.postTime || metadata.datePublished || "";
  const metrics = [
    `XYZ Rank 热门单集 #${rank}`,
    item.primaryGenreName ? `分类：${item.primaryGenreName}` : "",
    Number.isFinite(item.playCount) ? `播放量：${item.playCount}` : "",
    Number.isFinite(item.commentCount) ? `评论量：${item.commentCount}` : "",
  ]
    .filter(Boolean)
    .join("；");
  return {
    show: compact(item.podcastName || metadata.show || "未标明节目"),
    source: "XYZ Rank / 小宇宙",
    title: compact(item.title || metadata.title || `XYZ Rank 热门单集 #${rank}`),
    link: item.link,
    audioUrl,
    guid: item.link,
    pubDate,
    date: episodeDate(pubDate, archiveDate),
    description: metadata.description || metrics,
    imageUrl: item.logoURL || metadata.imageUrl,
    duration: Number.isFinite(item.duration) ? String(item.duration) : isoDurationMinutes(metadata.duration),
    chartRank: rank,
    genres: item.primaryGenreName ? [item.primaryGenreName] : undefined,
  };
}

export async function fetchXyzRankTopEpisodes(date = bjtDateString(), force = false, limit = episodeLimit()): Promise<Episode[]> {
  const items = await fetchXyzRankEpisodeItems(limit);
  if (!items.length) throw new Error("XYZ Rank top episodes source returned no items");
  const episodes: Episode[] = [];
  const summarized = force ? new Set<string>() : loadSummarizedFingerprints();
  for (const [index, item] of items.entries()) {
    const episode = await toEpisode(item, index, date);
    if (!force && isEpisodeSummarized(summarized, episode)) {
      writeStderr(`skipping previously summarized XYZ Rank episode: ${episode.title}`);
      continue;
    }
    episodes.push(episode);
  }
  return episodes;
}

export async function buildXyzRankTopEpisodesSource(date: string, limit = episodeLimit()): Promise<string> {
  const episodes = await fetchXyzRankTopEpisodes(date, true, limit);
  return [
    `# XYZ Rank 热门播客单集候选源｜${date}`,
    "",
    "来源：XYZ Rank 热门单集榜与小宇宙单集页 og:audio",
    `接口：${XYZ_RANK_EPISODES_API}?offset=0&limit=${limit}`,
    `候选数量：${episodes.length}`,
    "",
    ...episodes.map((episode, index) =>
      [
        `## ${index + 1}. ${episode.title}`,
        `- 节目：${episode.show}`,
        `- 来源：${episode.source}`,
        `- 链接：${episode.link}`,
        `- 音频：${episode.audioUrl}`,
        `- 日期：${episode.date}`,
        episode.duration ? `- 时长：${episode.duration}` : "",
        episode.genres?.length ? `- 分类：${episode.genres.join(" / ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs();
  const date = stringArg(args, "date", bjtDateString());
  const limit = Number(stringArg(args, "limit", String(episodeLimit())));
  writeStdout(await buildXyzRankTopEpisodesSource(date, Number.isInteger(limit) && limit > 0 ? limit : episodeLimit()));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`ERROR: ${message}`);
    process.exit(1);
  });
}
