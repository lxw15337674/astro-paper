#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bjtDateString, clipText, compact, ensureDir, fetchText, parseArgs, repoRoot, stringArg, stripHtml, writeStderr, writeStdout } from "./blog_common.ts";
import { podcastFingerprints } from "./foreign_tech_podcast_dedupe.ts";
import { isEpisodeSummarized, loadSummarizedFingerprints } from "./podcast_ledger.ts";
import { renderPrompt } from "./ai_blog_writer.ts";

type FeedSource = {
  show: string;
  source: string;
  url: string;
  chartRank?: number;
  appleId?: string;
  appleUrl?: string;
  genres?: string[];
  artworkUrl?: string;
};

export type Episode = {
  show: string;
  source: string;
  title: string;
  link: string;
  audioUrl: string;
  transcriptUrl?: string;
  guid: string;
  pubDate: string;
  date: string;
  description: string;
  guest?: string;
  imageUrl?: string;
  duration?: string;
  transcript?: string;
  canonicalId?: string;
  chartRank?: number;
  appleId?: string;
  appleUrl?: string;
  genres?: string[];
};

type AppleTopShow = {
  id: string;
  name: string;
  artistName: string;
  url: string;
  genres: string[];
  rank: number;
};

type AppleLookupResult = {
  collectionId?: number;
  collectionName?: string;
  artistName?: string;
  feedUrl?: string;
  collectionViewUrl?: string;
  primaryGenreName?: string;
  genres?: string[];
  artworkUrl600?: string;
  artworkUrl100?: string;
};

export const FEEDS: FeedSource[] = [
  { show: "a16z Podcast", source: "Andreessen Horowitz", url: "https://feeds.simplecast.com/JGE3yC0V" },
  { show: "Decoder", source: "The Verge", url: "https://feeds.megaphone.fm/recodedecode" },
  { show: "Practical AI", source: "Changelog Media", url: "https://changelog.com/practicalai/feed" },
  { show: "Big Technology Podcast", source: "Big Technology", url: "https://feeds.simplecast.com/4T39_jAj" },
  { show: "Software Engineering Daily", source: "Software Engineering Daily", url: "https://softwareengineeringdaily.com/feed/podcast/" },
  { show: "Software Engineering Radio", source: "IEEE Computer Society", url: "https://rss.libsyn.com/shows/21070/destinations/23379.xml" },
  { show: "Oxide and Friends", source: "Oxide Computer Company", url: "https://feeds.transistor.fm/oxide-and-friends" },
  { show: "The InfoQ Podcast", source: "InfoQ", url: "https://feeds.soundcloud.com/users/soundcloud:users:215740450/sounds.rss" },
  { show: "Changelog Interviews", source: "Changelog Media", url: "https://changelog.com/podcast/feed" },
  { show: "The Data Engineering Show", source: "Firebolt", url: "https://feeds.fame.so/the-data-engineering-show" },
  { show: "Latent Space", source: "Substack", url: "https://api.substack.com/feed/podcast/1036440.rss" },
  { show: "The Cognitive Revolution", source: "Turpentine", url: "https://feeds.megaphone.fm/RINTP3108857801" },
  { show: "TWIML AI Podcast", source: "Megaphone", url: "https://feeds.megaphone.fm/MLN2155636147" },
  { show: "AI Engineering Podcast", source: "Podhome", url: "https://serve.podhome.fm/rss/c9abdd38-a5dc-5eb2-96fd-f833f93208a7" },
  { show: "No Priors", source: "Megaphone", url: "https://feeds.megaphone.fm/nopriors" },
  { show: "Engineering with AI", source: "RSS.com", url: "https://media.rss.com/engineeringwithaipodcas/feed.xml" },
  { show: "This Day in AI", source: "Transistor", url: "https://feeds.transistor.fm/this-day-in-ai" },
  { show: "Lex Fridman Podcast", source: "Lex Fridman", url: "https://lexfridman.com/feed/podcast/" },
  { show: "The Dwarkesh Podcast", source: "Substack", url: "https://api.substack.com/feed/podcast/104929.rss" },
  { show: "The AI Daily Brief", source: "Libsyn", url: "https://feeds.libsyn.com/468519/rss" },
  { show: "CoRecursive: Coding Stories", source: "CoRecursive", url: "https://corecursive.com/feed/" },
  { show: "Hard Fork", source: "New York Times", url: "https://feeds.simplecast.com/6HKOhNgS" },
  { show: "Tech Brew Ride Home", source: "Megaphone", url: "https://feeds.megaphone.fm/ridehome" },
  { show: "Waveform: The MKBHD Podcast", source: "Megaphone", url: "https://feeds.megaphone.fm/STU4418364045" },
  { show: "Radiolab", source: "WNYC Studios", url: "https://feeds.megaphone.fm/WNYC1482881651" },
  { show: "Science Vs", source: "Spotify Studios", url: "https://feeds.megaphone.fm/sciencevs" },
  { show: "Unexplainable", source: "Vox", url: "https://feeds.megaphone.fm/unexplainable" },
  { show: "Land of the Giants", source: "Vox", url: "https://feeds.megaphone.fm/landofthegiants" },
  { show: "Business Movers", source: "Wondery", url: "https://rss.art19.com/business-movers" },
  { show: "WSJ: The Future of Everything", source: "Wall Street Journal", url: "https://feeds.content.dowjones.io/public/rss/wsj_future_of_everything" },
  { show: "TED Radio Hour", source: "NPR", url: "https://feeds.npr.org/510298/podcast.xml" },
  { show: "99% Invisible", source: "Radiotopia", url: "https://feeds.megaphone.fm/invisible99" },
];

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] || "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envFloat(name: string, fallback: number): number {
  const value = Number(process.env[name] || "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function sleep(ms: number): Promise<void> {
  if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
}

export class PodcastSourceInsufficientEpisodesError extends Error {
  constructor(
    readonly sourceName: string,
    readonly usableEpisodes: number,
    readonly requiredEpisodes: number,
    detail = "",
  ) {
    super(`${sourceName} podcast source found only ${usableEpisodes} usable episodes; need ${requiredEpisodes}${detail ? ` (${detail})` : ""}`);
    this.name = "PodcastSourceInsufficientEpisodesError";
  }
}

function decodeXml(text = ""): string {
  return text
    .replaceAll("<![CDATA[", "")
    .replaceAll("]]>", "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function tag(block: string, name: string): string {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return decodeXml(match?.[1] || "");
}

function attr(block: string, tagName: string, attrName: string): string {
  const match = new RegExp(`<${tagName}[^>]*\\s${attrName}=["']([^"']+)["'][^>]*>`, "i").exec(block);
  return decodeXml(match?.[1] || "");
}

// 频道级封面：多数 feed 不在 <item> 里带 itunes:image，只在 channel 层声明节目封面。
function channelImageUrl(xml: string): string {
  const channel = xml.replace(/<item[\s\S]*?<\/item>/gi, "");
  const itunes = attr(channel, "itunes:image", "href");
  if (itunes) return itunes;
  return decodeXml(/<image>[\s\S]*?<url>([\s\S]*?)<\/url>/i.exec(channel)?.[1] || "");
}

function parseFeed(feed: FeedSource, xml: string): Episode[] {
  const channelImage = channelImageUrl(xml);
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  return items
    .map(item => {
      const pubDate = tag(item, "pubDate") || tag(item, "dc:date");
      const date = pubDate ? new Date(pubDate).toISOString().slice(0, 10) : "";
      const title = stripHtml(tag(item, "title"));
      const description = stripHtml(tag(item, "content:encoded") || tag(item, "description") || tag(item, "itunes:summary"));
      const link = tag(item, "link") || tag(item, "guid");
      const audioUrl = attr(item, "enclosure", "url");
      const transcriptUrl = attr(item, "podcast:transcript", "url") || attr(item, "transcript", "url");
      const guid = tag(item, "guid") || link || `${feed.show}:${title}`;
      // 封面兜底链：逐集图 → 频道级节目图 → Apple artwork（仅 Apple 池有）。
      const imageUrl = attr(item, "itunes:image", "href") || channelImage || feed.artworkUrl || undefined;
      const duration = tag(item, "itunes:duration");
      return {
        show: feed.show,
        source: feed.source,
        title,
        link,
        audioUrl,
        transcriptUrl,
        guid,
        pubDate,
        date,
        description,
        imageUrl,
        duration,
        chartRank: feed.chartRank,
        appleId: feed.appleId,
        appleUrl: feed.appleUrl,
        genres: feed.genres,
      };
    })
    .filter(episode => episode.title && episode.description && episode.date && episode.link && (episode.audioUrl || episode.transcriptUrl));
}

function parseDate(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid date: ${date}`);
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(a).getTime() - parseDate(b).getTime()) / 86_400_000);
}


function maxEpisodes(): number {
  return envNumber("PODCAST_MAX_EPISODES", 3);
}

function minEpisodes(): number {
  return envNumber("PODCAST_MIN_EPISODES", 1);
}

function candidateEpisodes(): number {
  return Math.max(maxEpisodes(), minEpisodes(), envNumber("PODCAST_CANDIDATE_EPISODES", Math.max(maxEpisodes() * 5, minEpisodes())));
}

function foreignTechPodcastMaxEpisodes(): number {
  return envNumber("FOREIGN_TECH_PODCAST_MAX_EPISODES", 999);
}

function maxWindowDays(): number {
  return envNumber("PODCAST_LOOKBACK_DAYS", 0);
}

function maxDailyEpisodeMinutes(): number {
  return envNumber("PODCAST_DAILY_MAX_EPISODE_MINUTES", 180);
}

function minTranscriptChars(): number {
  return envNumber("PODCAST_MIN_TRANSCRIPT_CHARS", 1000);
}

function parseDurationSeconds(value = ""): number | null {
  const text = value.trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text));
  const parts = text.split(":").map(part => Number(part));
  if (!parts.length || parts.some(part => !Number.isFinite(part) || part < 0)) return null;
  let total = 0;
  for (const part of parts) total = total * 60 + part;
  return Math.round(total);
}

function exceedsDailyEpisodeDurationLimit(episode: Episode): boolean {
  const seconds = parseDurationSeconds(episode.duration);
  if (!seconds) return false;
  return seconds > maxDailyEpisodeMinutes() * 60;
}

function normalizedTranscript(episode: Episode): string {
  return compact(episode.transcript || "");
}

function hasUsableTranscript(episode: Episode): boolean {
  return normalizedTranscript(episode).length >= minTranscriptChars();
}

function rssDisabled(): boolean {
  return ["1", "true", "yes"].includes((process.env.PODCAST_DISABLE_RSS || "").toLowerCase());
}

function audioTranscribeEnabled(): boolean {
  return !["0", "false", "no"].includes((process.env.PODCAST_AUDIO_TRANSCRIBE || "true").toLowerCase());
}

function promptTranscriptChars(): number {
  return envNumber("PODCAST_PROMPT_TRANSCRIPT_CHARS", 12_000);
}

function transcriptForPrompt(episode: Episode): string {
  const transcript = normalizedTranscript(episode);
  const maxChars = promptTranscriptChars();
  if (transcript.length <= maxChars) return transcript;
  const marker = " [transcript clipped for prompt] ";
  const available = maxChars - marker.length;
  if (available < 2_000) return clipText(transcript, maxChars);
  const headChars = Math.min(Math.max(Math.floor(available * 0.65), 1_000), available - 1_000);
  const tailChars = available - headChars;
  return `${clipText(transcript, headChars)}${marker}${transcript.slice(-tailChars).trimStart()}`.trim();
}

// 测试专用注入口：仅当显式设置 PODCAST_TEST_EPISODES_FILE 时生效，把预置 Episode 注入 RSS 池，
// 让单测在不联网的情况下覆盖 transcript 裁剪、音频超时、账本去重等逻辑。生产环境不配置此变量，函数返回空数组。
type InjectedEpisodeInput = {
  title?: string;
  show?: string;
  source?: string;
  link?: string;
  audioUrl?: string;
  guid?: string;
  pubDate?: string;
  date?: string;
  description?: string;
  guest?: string;
  imageUrl?: string;
  duration?: string;
  transcript?: string;
  canonicalId?: string;
};

function normalizeInjectedEpisode(input: InjectedEpisodeInput): Episode | null {
  const title = stripHtml(input.title || "");
  const description = stripHtml(input.description || "");
  const link = input.link || "";
  const date = input.date || (input.pubDate ? new Date(input.pubDate).toISOString().slice(0, 10) : "");
  if (!title || !description || !link || !date) return null;
  return {
    show: input.show || input.source || "测试来源",
    source: input.source || input.show || "测试来源",
    title,
    link,
    audioUrl: input.audioUrl || "",
    guid: input.guid || link || title,
    pubDate: input.pubDate || date,
    date,
    description,
    guest: input.guest,
    imageUrl: input.imageUrl,
    duration: input.duration,
    transcript: input.transcript ? compact(input.transcript) : undefined,
    canonicalId: input.canonicalId,
  };
}

function loadTestInjectedEpisodes(): Episode[] {
  const file = process.env.PODCAST_TEST_EPISODES_FILE;
  if (!file || !fs.existsSync(file)) return [];
  const payload = JSON.parse(fs.readFileSync(file, "utf8")) as { episodes?: InjectedEpisodeInput[] };
  return (payload.episodes || []).map(normalizeInjectedEpisode).filter((episode): episode is Episode => Boolean(episode));
}

async function fetchRssEpisodes(date: string): Promise<Episode[]> {
  if (rssDisabled()) return [];
  const settled = await Promise.allSettled(
    FEEDS.map(async feed => {
      const xml = await fetchText(feed.url, { timeoutMs: 25_000, maxChars: 2_500_000, throwOnMaxChars: true });
      return parseFeed(feed, xml);
    }),
  );
  const episodes = settled.flatMap(result => (result.status === "fulfilled" ? result.value : []));
  const inWindow = episodes.filter(episode => {
    const delta = daysBetween(date, episode.date);
    return delta >= 0 && delta <= maxWindowDays();
  });
  return inWindow.toSorted((a, b) => b.date.localeCompare(a.date));
}


function appleTopPodcastsCount(): number {
  return envNumber("APPLE_TOP_PODCASTS_COUNT", 20);
}

function appleTopPodcastsMaxEpisodes(): number {
  return envNumber("APPLE_TOP_PODCASTS_MAX_EPISODES", 999);
}

function appleStorefront(): string {
  return (process.env.APPLE_PODCASTS_STOREFRONT || "us").toLowerCase();
}

async function fetchAppleTopShows(): Promise<AppleTopShow[]> {
  const storefront = appleStorefront();
  const count = appleTopPodcastsCount();
  const url = `https://rss.applemarketingtools.com/api/v2/${storefront}/podcasts/top/${count}/podcasts.json`;
  const text = await fetchText(url, { timeoutMs: 20_000, maxChars: 500_000, throwOnMaxChars: true });
  const payload = JSON.parse(text) as { feed?: { results?: unknown[] } };
  const results = payload.feed?.results || [];
  return results
    .map((item, index) => {
      const row = item as { id?: unknown; name?: unknown; artistName?: unknown; url?: unknown; genres?: unknown[] };
      const genres = (row.genres || [])
        .map(genre => (typeof genre === "string" ? genre : (genre as { name?: unknown })?.name))
        .filter((genre): genre is string => typeof genre === "string" && Boolean(genre));
      return {
        id: String(row.id || ""),
        name: String(row.name || ""),
        artistName: String(row.artistName || ""),
        url: String(row.url || ""),
        genres,
        rank: index + 1,
      };
    })
    .filter(show => show.id && show.name && show.url);
}

async function lookupApplePodcast(show: AppleTopShow): Promise<FeedSource | null> {
  const storefront = appleStorefront();
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(show.id)}&country=${encodeURIComponent(storefront)}&entity=podcast`;
  const text = await fetchText(url, { timeoutMs: 20_000, maxChars: 300_000, throwOnMaxChars: true });
  const payload = JSON.parse(text) as { results?: AppleLookupResult[] };
  const result = (payload.results || []).find(item => item.feedUrl) || payload.results?.[0];
  if (!result?.feedUrl) return null;
  const genres = [...new Set([...(show.genres || []), ...(result.genres || []), result.primaryGenreName || ""].filter(Boolean))];
  return {
    show: result.collectionName || show.name,
    source: result.artistName || show.artistName || show.name,
    url: result.feedUrl,
    chartRank: show.rank,
    appleId: show.id,
    appleUrl: result.collectionViewUrl || show.url,
    genres,
    artworkUrl: result.artworkUrl600 || result.artworkUrl100 || undefined,
  };
}

function episodeAlreadySeen(seen: Set<string>, episode: Episode): boolean {
  return isEpisodeSummarized(seen, episode);
}

async function fetchAppleTopPodcastEpisodes(date: string, force = false): Promise<Episode[]> {
  const shows = await fetchAppleTopShows();
  const seen = force ? new Set<string>() : loadSummarizedFingerprints();
  const selected: Episode[] = [];
  let skippedDuplicates = 0;
  for (const show of shows) {
    if (selected.length >= appleTopPodcastsMaxEpisodes()) break;
    try {
      const feed = await lookupApplePodcast(show);
      if (!feed) {
        writeStderr(`WARN: Apple Top Shows #${show.rank} ${show.name}: lookup did not return feedUrl`);
        continue;
      }
      const xml = await fetchText(feed.url, { timeoutMs: 25_000, maxChars: 8_000_000, throwOnMaxChars: true });
      const candidates = parseFeed(feed, xml)
        .filter(episode => {
          const delta = daysBetween(date, episode.date);
          return delta >= 0 && delta <= maxWindowDays();
        })
        .toSorted((a, b) => b.date.localeCompare(a.date));
      const episode = candidates.find(candidate => !episodeAlreadySeen(seen, candidate));
      if (!episode) {
        skippedDuplicates += candidates.length ? 1 : 0;
        writeStderr(`WARN: Apple Top Shows #${show.rank} ${feed.show}: no recent unarchived episode in ${maxWindowDays()}d window`);
        continue;
      }
      for (const fingerprint of podcastFingerprints(episode)) seen.add(fingerprint);
      selected.push(episode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeStderr(`WARN: Apple Top Shows #${show.rank} ${show.name}: ${message}`);
    }
  }
  if (skippedDuplicates) writeStderr(`skipped ${skippedDuplicates} Apple Top Shows duplicate/latest episode(s) already present in archive history`);
  return selected.slice(0, appleTopPodcastsMaxEpisodes());
}

async function fetchEpisodes(date: string, force = false): Promise<Episode[]> {
  const rss = await fetchRssEpisodes(date);
  const seen = force ? new Set<string>() : loadSummarizedFingerprints();
  const unique: Episode[] = [];
  let skipped = 0;
  for (const episode of [...loadTestInjectedEpisodes(), ...rss]) {
    const fingerprints = podcastFingerprints(episode);
    const duplicate = fingerprints.find(fingerprint => seen.has(fingerprint));
    if (duplicate) {
      skipped += 1;
      writeStderr(`skipping previously summarized podcast: ${episode.title}`);
      continue;
    }
    for (const fingerprint of fingerprints) seen.add(fingerprint);
    unique.push(episode);
  }
  if (skipped) writeStderr(`skipped ${skipped} duplicate podcast episode(s) already present in archive history`);
  return unique.slice(0, candidateEpisodes());
}

async function downloadAudio(url: string, file: string): Promise<void> {
  const maxBytes = envNumber("PODCAST_AUDIO_MAX_MB", 300) * 1024 * 1024;
  const timeoutMs = envNumber("PODCAST_AUDIO_DOWNLOAD_TIMEOUT_MS", 10 * 60 * 1000);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`audio download HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("audio response missing body");
    ensureDir(path.dirname(file));
    const out = fs.createWriteStream(file);
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new Error(`audio exceeds ${Math.round(maxBytes / 1024 / 1024)}MB limit`);
        out.write(value);
      }
    } finally {
      out.end();
    }
    await new Promise<void>((resolve, reject) => {
      out.on("finish", resolve);
      out.on("error", reject);
    });
  } catch (error) {
    if (error instanceof Error && /audio download HTTP 403/.test(error.message)) {
      writeStderr(`WARN: audio fetch returned 403; retrying with curl: ${url}`);
      downloadAudioWithCurl(url, file, timeoutMs, maxBytes);
      return;
    }
    if (timedOut || (error instanceof Error && error.name === "AbortError")) throw new Error(`audio download timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function downloadAudioWithCurl(url: string, file: string, timeoutMs: number, maxBytes: number): void {
  ensureDir(path.dirname(file));
  const result = spawnSync(
    "curl",
    [
      "-fL",
      "-A",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      "--max-time",
      String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      "--output",
      file,
      url,
    ],
    { encoding: "utf8", timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`audio download HTTP 403`);
  const size = fs.statSync(file).size;
  if (size > maxBytes) throw new Error(`audio exceeds ${Math.round(maxBytes / 1024 / 1024)}MB limit`);
}

function transcriptionProviders(): string[] {
  const raw = process.env.PODCAST_TRANSCRIBE_PROVIDER || "gemini";
  return raw
    .split(/[,>]/)
    .map(provider => provider.trim().toLowerCase())
    .filter(Boolean);
}

function geminiApiKey(): string {
  return process.env.GEMINI_API_KEY || process.env.PODCAST_GEMINI_API_KEY || "";
}

function geminiModel(): string {
  return process.env.PODCAST_GEMINI_MODEL || "gemini-flash-latest";
}

function geminiBaseUrl(): string {
  return (process.env.PODCAST_GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
}

export function geminiArticleBaseUrl(): string {
  return (process.env.PODCAST_GEMINI_ARTICLE_BASE_URL || "").replace(/\/+$/, "") || geminiBaseUrl();
}

function geminiArticleApiKey(): string {
  return process.env.PODCAST_GEMINI_ARTICLE_API_KEY || geminiApiKey();
}

export function geminiArticleModel(): string {
  return process.env.PODCAST_GEMINI_ARTICLE_MODEL || geminiModel();
}

function runFfmpeg(args: string[], timeoutMs: number): void {
  const bin = process.env.PODCAST_FFMPEG_BIN || "ffmpeg";
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${bin} exited ${result.status}: ${(result.stderr || result.stdout || "").slice(0, 2000)}`);
}


function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}


function prepareGeminiAudioChunks(audioFile: string, outDir: string): string[] {
  ensureDir(outDir);
  const segmentSeconds = envNumber("PODCAST_GEMINI_SEGMENT_SECONDS", 20 * 60);
  const bitrate = process.env.PODCAST_GEMINI_AUDIO_BITRATE || "64k";
  const timeoutMs = envNumber("PODCAST_FFMPEG_TIMEOUT_MS", 20 * 60 * 1000);
  runFfmpeg(["-y", "-i", audioFile, "-vn", "-ac", "1", "-ar", "16000", "-b:a", bitrate, "-f", "segment", "-segment_time", String(segmentSeconds), "-reset_timestamps", "1", path.join(outDir, "chunk-%03d.mp3")], timeoutMs);
  const maxBytes = envNumber("PODCAST_GEMINI_MAX_INLINE_CHUNK_MB", 14) * 1024 * 1024;
  const chunks = fs
    .readdirSync(outDir)
    .filter(file => file.endsWith(".mp3"))
    .map(file => path.join(outDir, file))
    .toSorted();
  if (!chunks.length) throw new Error("ffmpeg produced no Gemini audio chunks");
  const oversized = chunks.find(file => fs.statSync(file).size > maxBytes);
  if (oversized) throw new Error(`Gemini audio chunk exceeds ${Math.round(maxBytes / 1024 / 1024)}MB inline limit: ${path.basename(oversized)}`);
  return chunks;
}

function geminiRetryAttempts(): number {
  return Math.max(1, envNumber("PODCAST_GEMINI_RETRY_ATTEMPTS", 3));
}

function geminiRetryDelayMs(attempt: number): number {
  return envNumber("PODCAST_GEMINI_RETRY_DELAY_MS", 30_000) * attempt;
}

function geminiChunkDelayMs(): number {
  return envNumber("PODCAST_GEMINI_CHUNK_DELAY_MS", 0);
}

function retryableGeminiStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

class NonRetryableGeminiError extends Error {}

function geminiTranscriptionPrompt(index: number, total: number): string {
  const position = total > 1 ? ` This is chunk ${index + 1} of ${total}; transcribe only this chunk.` : "";
  return `Transcribe the speech in this podcast audio exactly. Preserve paragraph breaks when natural, omit timestamps unless spoken, and return only the transcript text.${position}`;
}

async function transcribeGeminiChunk(chunkFile: string, index: number, total: number): Promise<string> {
  const key = geminiApiKey();
  if (!key) throw new Error("GEMINI_API_KEY is not configured");
  const timeoutMs = envNumber("PODCAST_GEMINI_TIMEOUT_MS", 10 * 60 * 1000);
  const endpoint = `${geminiBaseUrl()}/v1beta/models/${encodeURIComponent(geminiModel())}:generateContent`;
  const payload = {
    contents: [
      {
        parts: [
          { text: geminiTranscriptionPrompt(index, total) },
          {
            inline_data: {
              mime_type: process.env.PODCAST_GEMINI_AUDIO_MIME_TYPE || "audio/mp3",
              data: fs.readFileSync(chunkFile).toString("base64"),
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: envNumber("PODCAST_GEMINI_MAX_OUTPUT_TOKENS", 8192),
    },
  };
  let lastError = "";
  for (let attempt = 1; attempt <= geminiRetryAttempts(); attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-goog-api-key": key,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        lastError = `Gemini transcription HTTP ${response.status}: ${text.slice(0, 1000)}`;
        if (attempt < geminiRetryAttempts() && retryableGeminiStatus(response.status)) {
          const delayMs = retryAfterMs(response.headers.get("retry-after")) ?? geminiRetryDelayMs(attempt);
          writeStderr(`WARN: Gemini transcription attempt ${attempt}/${geminiRetryAttempts()} failed; retrying after ${Math.round(delayMs / 1000)}s: ${lastError}`);
          await sleep(delayMs);
          continue;
        }
        throw new NonRetryableGeminiError(lastError);
      }
      const json = JSON.parse(text) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } };
      const transcript = compact((json.candidates || []).flatMap(candidate => candidate.content?.parts?.map(part => part.text || "") || []).join("\n"));
      if (!transcript && json.error?.message) throw new NonRetryableGeminiError(json.error.message);
      return transcript;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (error instanceof NonRetryableGeminiError) throw error;
      if (attempt < geminiRetryAttempts()) {
        const delayMs = geminiRetryDelayMs(attempt);
        writeStderr(`WARN: Gemini transcription attempt ${attempt}/${geminiRetryAttempts()} failed; retrying after ${Math.round(delayMs / 1000)}s: ${lastError}`);
        await sleep(delayMs);
        continue;
      }
      throw new Error(lastError);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError || "Gemini transcription failed");
}

async function runGeminiTranscription(audioFile: string, outDir: string): Promise<string> {
  if (!geminiApiKey()) throw new Error("GEMINI_API_KEY is not configured");
  const chunks = prepareGeminiAudioChunks(audioFile, outDir);
  const parts: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    if (index > 0) await sleep(geminiChunkDelayMs());
    writeStderr(`Gemini transcribing chunk ${index + 1}/${chunks.length}: ${path.basename(chunk)}`);
    parts.push(await transcribeGeminiChunk(chunk, index, chunks.length));
  }
  const transcript = compact(parts.join("\n"));
  if (transcript.length < minTranscriptChars()) throw new Error(`Gemini transcript too short (${transcript.length} chars)`);
  return transcript;
}

async function transcribeAudio(audioFile: string, outDir: string): Promise<string> {
  const errors: string[] = [];
  for (const provider of transcriptionProviders()) {
    try {
      if (provider === "gemini") return await runGeminiTranscription(audioFile, path.join(outDir, "gemini"));
      errors.push(`${provider}: unsupported transcription provider`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${provider}: ${message}`);
      writeStderr(`WARN: ${provider} transcription failed; trying next provider: ${message}`);
    }
  }
  throw new Error(`all transcription providers failed: ${errors.join("; ")}`);
}

async function enrichWithTranscripts(episodes: Episode[], options: { tolerateFailures?: boolean; transcribeDelayMs?: number } = {}): Promise<Episode[]> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-tech-podcast-"));
  try {
    const enriched: Episode[] = [];
    let attemptedTranscriptions = 0;
    for (const [index, episode] of episodes.entries()) {
      if (hasUsableTranscript(episode)) {
        enriched.push({ ...episode, transcript: normalizedTranscript(episode) });
        continue;
      }
      if (episode.transcriptUrl) {
        try {
          const transcript = compact(await fetchText(episode.transcriptUrl, { timeoutMs: 30_000, maxChars: 1_500_000, throwOnMaxChars: true }));
          if (transcript.length >= minTranscriptChars()) {
            enriched.push({ ...episode, transcript });
            continue;
          }
          writeStderr(`WARN: ${episode.title}: podcast transcript URL returned too little text (${transcript.length} chars)`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          writeStderr(`WARN: ${episode.title}: podcast transcript URL unavailable; trying audio if available: ${message}`);
        }
      }
      if (!episode.audioUrl) {
        writeStderr(`skipping podcast without transcript or audio: ${episode.title}`);
        continue;
      }
      if (!audioTranscribeEnabled()) {
        writeStderr(`skipping podcast because audio transcription is disabled and no transcript is available: ${episode.title}`);
        continue;
      }
      if (attemptedTranscriptions > 0) await sleep(options.transcribeDelayMs ?? envNumber("PODCAST_TRANSCRIBE_DELAY_MS", 0));
      attemptedTranscriptions += 1;
      writeStderr(`transcribing podcast ${index + 1}/${episodes.length}: ${episode.title}`);
      const rawAudio = path.join(tmp, `${index}.mp3`);
      const outDir = path.join(tmp, `transcript-${index}`);
      try {
        await downloadAudio(episode.audioUrl, rawAudio);
        const transcript = await transcribeAudio(rawAudio, outDir);
        enriched.push({ ...episode, transcript });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (options.tolerateFailures) {
          writeStderr(`WARN: ${episode.title}: podcast audio transcription unavailable; skipping episode: ${message}`);
          continue;
        }
        throw new Error(`${episode.title}: ${message}`);
      }
    }
    return enriched;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function podcastSourceMarkdown(episodes: Episode[], sourceIntro: string, writingBoundaries: string[]): string {
  const lines = [
    "## 来源说明",
    "",
    sourceIntro,
    "",
    "## 候选播客清单",
    "",
  ];
  for (const [index, episode] of episodes.entries()) {
    const metadata = [
      episode.chartRank ? `- Apple Top Shows 排名：#${episode.chartRank}` : "",
      episode.appleId ? `- Apple ID：${episode.appleId}` : "",
      episode.appleUrl ? `- Apple 页面：${episode.appleUrl}` : "",
      episode.genres?.length ? `- Apple 分类：${episode.genres.join(" / ")}` : "",
      `- 节目：${episode.show}`,
      `- 来源：${episode.source}`,
      episode.guest ? `- 嘉宾：${episode.guest}` : "- 嘉宾：未标明",
      `- 发布日期：${episode.date}`,
      `- 链接：${episode.link}`,
      episode.imageUrl ? `- 图片：${episode.imageUrl}` : "",
      episode.duration ? `- 时长：${episode.duration}` : "",
      episode.canonicalId ? `- canonicalId：${episode.canonicalId}` : "",
      episode.audioUrl ? `- 音频：${episode.audioUrl}` : "- 音频：未提供；使用 transcript",
      episode.transcriptUrl ? `- Transcript：${episode.transcriptUrl}` : "",
      `- Show notes：${episode.description}`,
    ].filter(Boolean);
    lines.push(
      `### ${index + 1}. ${episode.title}`,
      "",
      ...metadata,
      "",
      "#### Transcript",
      "",
      transcriptForPrompt(episode),
      "",
    );
  }
  lines.push("## 写作边界", "", ...writingBoundaries);
  return `${lines.join("\n").trim()}\n`;
}

// 合并数据源：海外科技 RSS 池 + Apple Top Shows 榜单池，交替穿插保证两类来源都在前 N 篇里有代表，再跨池按指纹去重。
async function fetchMergedPodcastEpisodes(date: string, force = false): Promise<Episode[]> {
  const foreign = (await fetchEpisodes(date, force)).slice(0, foreignTechPodcastMaxEpisodes());
  let apple: Episode[] = [];
  try {
    apple = await fetchAppleTopPodcastEpisodes(date, force);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`WARN: Apple Top Shows fetch failed; continuing with foreign episodes only: ${message}`);
  }
  const interleaved: Episode[] = [];
  for (let i = 0; i < Math.max(foreign.length, apple.length); i += 1) {
    if (i < foreign.length) interleaved.push(foreign[i]);
    if (i < apple.length) interleaved.push(apple[i]);
  }
  const merged: Episode[] = [];
  const seen = new Set<string>();
  for (const episode of interleaved) {
    if (exceedsDailyEpisodeDurationLimit(episode)) {
      writeStderr(`WARN: skipping overlong daily podcast episode (${episode.duration}): ${episode.show} — ${episode.title}`);
      continue;
    }
    const fingerprints = podcastFingerprints(episode);
    if (fingerprints.some(fingerprint => seen.has(fingerprint))) continue;
    for (const fingerprint of fingerprints) seen.add(fingerprint);
    merged.push(episode);
  }
  return merged;
}

export async function buildDailyPodcastSource(date = bjtDateString()): Promise<string> {
  const episodes = await enrichWithTranscripts(await fetchMergedPodcastEpisodes(date), { tolerateFailures: true });
  if (episodes.length < minEpisodes()) throw new PodcastSourceInsufficientEpisodesError("daily podcasts", episodes.length, minEpisodes());
  return podcastSourceMarkdown(
    episodes,
    "以下证据来自海外科技播客 RSS 条目与 Apple Podcasts Top Shows 榜单及其可用 transcript。没有 transcript 的条目已在 source 阶段跳过。AI 只能依据 transcript 与元数据写作；不得编造嘉宾、观点或未提供的事实。",
    [
      "- 这是基于播客 transcript 的中文长文笔记，不是新闻快讯。需要直接按每期节目独立小节展开，不要额外生成总览或播客清单。",
      "- 若 transcript 或元数据没有明确嘉宾姓名，嘉宾字段写“未标明”，不要猜。",
      "- 每条分析必须能回到 transcript 证据；不得仅凭标题、链接、图片或简短简介扩写。",
      "- 不要生成金融建议、产品购买建议或夸张标题。",
    ],
  );
}

// 海外科技 RSS 子池的转写式 source；保留为合并 source 的构件并供单测覆盖该数据源。
export async function buildForeignTechPodcastSource(date = bjtDateString()): Promise<string> {
  const episodes = (await enrichWithTranscripts(await fetchEpisodes(date), { tolerateFailures: true })).slice(0, maxEpisodes());
  if (episodes.length < minEpisodes()) throw new PodcastSourceInsufficientEpisodesError("foreign tech podcast", episodes.length, minEpisodes());
  return podcastSourceMarkdown(
    episodes,
    "以下证据来自海外科技访谈/深度讨论类播客 RSS 条目及其可用 transcript。每个候选都必须有音频转写；没有 transcript 的条目已在 source 阶段跳过。AI 只能依据 transcript 与元数据写作；不得编造嘉宾、观点或未提供的事实。",
    [
      "- 这是基于播客 transcript 的中文长文笔记，不是新闻快讯。需要直接按每期节目独立小节展开，不要额外生成总览或播客清单。",
      "- 若 transcript 或元数据没有明确嘉宾姓名，嘉宾字段写“未标明”，不要猜。",
      "- 每条分析必须能回到 transcript 证据；不得仅凭标题、链接、图片或简短简介扩写。",
      "- 不要生成金融建议、产品购买建议或夸张标题。",
    ],
  );
}

type GeminiAudioPart = { inline_data: { mime_type: string; data: string } };

const FOREIGN_PODCAST_AUDIO_INTRO =
  "本期播客的完整音频已作为内联附件随本请求一起提供。请直接听音频并据此写作；下面的元数据只用于填写基本信息（节目名、嘉宾、日期、来源、链接），不得把元数据当成内容来扩写，也不得编造嘉宾、观点或未提供的事实。";

const FOREIGN_PODCAST_WRITING_BOUNDARIES = [
  "- 这是基于播客音频的中文长文笔记，不是新闻快讯。直接按本期节目展开，不要额外生成总览或播客清单。",
  "- 若音频或元数据没有明确嘉宾姓名，嘉宾字段写“未标明”，不要猜。",
  "- 每条分析必须能回到音频内容；不得仅凭标题、链接、图片或简短简介扩写。",
  "- 不要生成金融建议、产品购买建议或夸张标题。",
];

// 多模态文章按时长计费且整集音频拼进同一请求，所以这里比转写路径压得更狠：
// 变速（同时减字节与 token）+ Opus 低码率（已实测代理收 audio/ogg 内联）。
function geminiArticleAudioCodec(): { codec: string; ext: string; mime: string } {
  const codec = process.env.PODCAST_GEMINI_ARTICLE_AUDIO_CODEC || "libopus";
  if (codec === "mp3" || codec === "libmp3lame") return { codec: "libmp3lame", ext: "mp3", mime: "audio/mp3" };
  if (codec === "opus" || codec === "libopus") return { codec: "libopus", ext: "ogg", mime: "audio/ogg" };
  return { codec, ext: "ogg", mime: "audio/ogg" };
}

function prepareGeminiArticleAudioChunks(audioFile: string, outDir: string): { files: string[]; mimeType: string } {
  ensureDir(outDir);
  const segmentSeconds = envNumber("PODCAST_GEMINI_SEGMENT_SECONDS", 20 * 60);
  const bitrate = process.env.PODCAST_GEMINI_ARTICLE_AUDIO_BITRATE || "24k";
  const speed = String(envFloat("PODCAST_GEMINI_ARTICLE_AUDIO_SPEED", 1.5));
  const timeoutMs = envNumber("PODCAST_FFMPEG_TIMEOUT_MS", 20 * 60 * 1000);
  const { codec, ext, mime } = geminiArticleAudioCodec();
  runFfmpeg(
    ["-y", "-i", audioFile, "-vn", "-ac", "1", "-ar", "16000", "-filter:a", `atempo=${speed}`, "-c:a", codec, "-b:a", bitrate, "-f", "segment", "-segment_time", String(segmentSeconds), "-reset_timestamps", "1", path.join(outDir, `chunk-%03d.${ext}`)],
    timeoutMs,
  );
  const maxBytes = envNumber("PODCAST_GEMINI_MAX_INLINE_CHUNK_MB", 14) * 1024 * 1024;
  const chunks = fs
    .readdirSync(outDir)
    .filter(file => file.endsWith(`.${ext}`))
    .map(file => path.join(outDir, file))
    .toSorted();
  if (!chunks.length) throw new Error("ffmpeg produced no Gemini article audio chunks");
  const oversized = chunks.find(file => fs.statSync(file).size > maxBytes);
  if (oversized) throw new Error(`Gemini article audio chunk exceeds ${Math.round(maxBytes / 1024 / 1024)}MB inline limit: ${path.basename(oversized)}`);
  return { files: chunks, mimeType: mime };
}

async function prepareEpisodeAudioParts(episode: Episode, tmpDir: string, index: number): Promise<GeminiAudioPart[]> {
  if (!episode.audioUrl) throw new Error(`${episode.title}: missing audio URL for multimodal article generation`);
  const rawAudio = path.join(tmpDir, `${index}.download`);
  await downloadAudio(episode.audioUrl, rawAudio);
  const { files, mimeType } = prepareGeminiArticleAudioChunks(rawAudio, path.join(tmpDir, `chunks-${index}`));
  return files.map(chunk => ({ inline_data: { mime_type: mimeType, data: fs.readFileSync(chunk).toString("base64") } }));
}

function episodeAudioMetadataBlock(episode: Episode, index: number): string {
  const rankLabel = episode.source.includes("XYZ Rank") ? "XYZ Rank 热门单集排名" : "Apple Top Shows 排名";
  const metadata = [
    episode.chartRank ? `- ${rankLabel}：#${episode.chartRank}` : "",
    `- 节目：${episode.show}`,
    `- 来源：${episode.source}`,
    episode.guest ? `- 嘉宾：${episode.guest}` : "- 嘉宾：未标明",
    `- 发布日期：${episode.date}`,
    `- 链接：${episode.link}`,
    episode.imageUrl ? `- 图片：${episode.imageUrl}` : "",
    episode.duration ? `- 时长：${episode.duration}` : "",
    episode.audioUrl ? `- 音频：${episode.audioUrl}` : "",
    `- Show notes：${episode.description}`,
  ].filter(Boolean);
  return [
    `### ${index + 1}. ${episode.title}`,
    "",
    ...metadata,
    "",
    "#### 音频",
    "",
    "本期完整音频已作为内联附件随本请求一起提供；请直接依据音频内容写作。",
  ].join("\n");
}

async function generateGeminiArticle(prompt: string, audioParts: GeminiAudioPart[]): Promise<string> {
  const key = geminiArticleApiKey();
  if (!key) throw new Error("PODCAST_GEMINI_ARTICLE_API_KEY (or GEMINI_API_KEY) is not configured");
  const timeoutMs = envNumber("PODCAST_GEMINI_TIMEOUT_MS", 10 * 60 * 1000);
  const endpoint = `${geminiArticleBaseUrl()}/v1beta/models/${encodeURIComponent(geminiArticleModel())}:generateContent`;
  const payload = {
    contents: [{ parts: [{ text: prompt }, ...audioParts] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: envNumber("PODCAST_GEMINI_ARTICLE_MAX_OUTPUT_TOKENS", 16384),
      thinkingConfig: { thinkingBudget: envNumber("PODCAST_GEMINI_ARTICLE_THINKING_BUDGET", 0) },
    },
  };
  let lastError = "";
  for (let attempt = 1; attempt <= geminiRetryAttempts(); attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-goog-api-key": key,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        lastError = `Gemini article HTTP ${response.status}: ${text.slice(0, 1000)}`;
        if (attempt < geminiRetryAttempts() && retryableGeminiStatus(response.status)) {
          const delayMs = retryAfterMs(response.headers.get("retry-after")) ?? geminiRetryDelayMs(attempt);
          writeStderr(`WARN: Gemini article attempt ${attempt}/${geminiRetryAttempts()} failed; retrying after ${Math.round(delayMs / 1000)}s: ${lastError}`);
          await sleep(delayMs);
          continue;
        }
        throw new NonRetryableGeminiError(lastError);
      }
      const json = JSON.parse(text) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]; error?: { message?: string } };
      const article = (json.candidates || [])
        .flatMap(candidate => candidate.content?.parts || [])
        .filter(part => part?.thought !== true)
        .map(part => part.text || "")
        .join("")
        .trim();
      if (!article && json.error?.message) throw new NonRetryableGeminiError(json.error.message);
      if (!article) throw new NonRetryableGeminiError("Gemini article response contained no text");
      return article;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (error instanceof NonRetryableGeminiError) throw error;
      if (attempt < geminiRetryAttempts()) {
        const delayMs = geminiRetryDelayMs(attempt);
        writeStderr(`WARN: Gemini article attempt ${attempt}/${geminiRetryAttempts()} failed; retrying after ${Math.round(delayMs / 1000)}s: ${lastError}`);
        await sleep(delayMs);
        continue;
      }
      throw new Error(lastError);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError || "Gemini article generation failed");
}

// 合并池里每个 episode 各出一篇（多模态：音频→文章），由编排层循环调用。
export async function fetchDailyPodcastEpisodes(date = bjtDateString(), force = false): Promise<Episode[]> {
  const episodes = (await fetchEpisodes(date, force)).filter(episode => episode.audioUrl);
  if (episodes.length < minEpisodes()) throw new PodcastSourceInsufficientEpisodesError("daily podcasts", episodes.length, minEpisodes());
  return episodes;
}

export async function fetchAppleTopPodcastEpisodeList(date = bjtDateString(), force = false): Promise<Episode[]> {
  const episodes = (await fetchAppleTopPodcastEpisodes(date, force)).filter(episode => episode.audioUrl);
  if (episodes.length < minEpisodes()) throw new PodcastSourceInsufficientEpisodesError("apple top podcasts", episodes.length, minEpisodes());
  return episodes;
}

export async function buildDailyPodcastEpisodeArticle(episode: Episode, date = bjtDateString(), options: { promptDir?: string } = {}): Promise<string> {
  const promptDir = options.promptDir || path.join(repoRoot(), "prompts", "blog");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "daily-podcast-article-"));
  try {
    const audioParts = await prepareEpisodeAudioParts(episode, tmp, 0);
    const sourceText = [
      "## 来源说明",
      "",
      FOREIGN_PODCAST_AUDIO_INTRO,
      "",
      "## 本期元数据",
      "",
      episodeAudioMetadataBlock(episode, 0),
      "",
      "## 写作边界",
      "",
      ...FOREIGN_PODCAST_WRITING_BOUNDARIES,
    ].join("\n");
    const prompt = renderPrompt({ task: "daily-podcasts", date, sourceText, promptDir });
    writeStderr(`generating daily podcast article via ${geminiArticleModel()} (${audioParts.length} audio chunk(s)): ${episode.title}`);
    return await generateGeminiArticle(prompt, audioParts);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  const date = stringArg(args, "date", bjtDateString());
  buildDailyPodcastSource(date)
    .then(text => writeStdout(text))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      writeStderr(`ERROR: ${message}`);
      process.exit(1);
    });
}
