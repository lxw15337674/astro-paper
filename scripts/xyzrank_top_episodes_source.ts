#!/usr/bin/env tsx
import { bjtDateString, compact, parseArgs, stringArg, writeStderr, writeStdout } from "./blog_common.ts";
import { type Episode } from "./foreign_tech_podcast_source.ts";
import { isEpisodeSummarized, loadSummarizedFingerprints } from "./podcast_ledger.ts";

const XYZ_RANK_EPISODES_API = "https://xyzrank.com/api/episodes";
const DEFAULT_LIMIT = 5;

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

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "astro-paper-xyzrank/1.0",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return (await response.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
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

function extractJsonLdDescription(html: string): string {
  const raw = html.match(/<script name=["']schema:podcast-show["'] type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/i)?.[1] || "";
  if (!raw) return "";
  try {
    const payload = JSON.parse(raw) as { description?: string };
    return payload.description || "";
  } catch {
    return "";
  }
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
  const payload = await fetchJson<XyzRankEpisodesResponse>(url.toString());
  return payload.items || [];
}

async function toEpisode(item: XyzRankEpisode, index: number, archiveDate: string): Promise<Episode> {
  const rank = Number.isInteger(item.rank) ? Number(item.rank) : index + 1;
  if (!item.link) throw new Error(`XYZ Rank episode #${rank} is missing link`);
  const html = await fetchText(item.link);
  const audioUrl = extractAudioUrl(html);
  if (!audioUrl) throw new Error(`XYZ Rank episode #${rank} is missing audio URL: ${item.link}`);
  const metrics = [
    `XYZ Rank 热门单集 #${rank}`,
    item.primaryGenreName ? `分类：${item.primaryGenreName}` : "",
    Number.isFinite(item.playCount) ? `播放量：${item.playCount}` : "",
    Number.isFinite(item.commentCount) ? `评论量：${item.commentCount}` : "",
  ]
    .filter(Boolean)
    .join("；");
  return {
    show: compact(item.podcastName || "未标明节目"),
    source: "XYZ Rank / 小宇宙",
    title: compact(item.title || `XYZ Rank 热门单集 #${rank}`),
    link: item.link,
    audioUrl,
    guid: item.link,
    pubDate: item.postTime || "",
    date: episodeDate(item.postTime, archiveDate),
    description: extractJsonLdDescription(html) || metrics,
    imageUrl: item.logoURL,
    duration: Number.isFinite(item.duration) ? String(item.duration) : undefined,
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
