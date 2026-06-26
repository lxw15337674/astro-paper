#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bjtDateString, clipText, compact, ensureDir, fetchText, parseArgs, repoRoot, stringArg, stripHtml, writeStderr, writeStdout } from "./blog_common.ts";
import { historicalPodcastFingerprints, podcastFingerprints } from "./foreign_tech_podcast_dedupe.ts";

type FeedSource = {
  show: string;
  source: string;
  url: string;
  chartRank?: number;
  appleId?: string;
  appleUrl?: string;
  genres?: string[];
};

type Episode = {
  show: string;
  source: string;
  title: string;
  link: string;
  audioUrl: string;
  guid: string;
  pubDate: string;
  date: string;
  description: string;
  guest?: string;
  imageUrl?: string;
  duration?: string;
  transcript?: string;
  canonicalId?: string;
  curated?: boolean;
  chartRank?: number;
  appleId?: string;
  appleUrl?: string;
  genres?: string[];
};

type CuratedEpisodeInput = {
  archiveDate?: string;
  show?: string;
  source?: string;
  title?: string;
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

type CuratedEpisodesFile = {
  episodes?: CuratedEpisodeInput[];
  dates?: Record<string, CuratedEpisodeInput[]>;
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
};

export const FEEDS: FeedSource[] = [
  { show: "a16z Podcast", source: "Andreessen Horowitz", url: "https://feeds.simplecast.com/JGE3yC0V" },
  { show: "Decoder", source: "The Verge", url: "https://feeds.megaphone.fm/recodedecode" },
  { show: "Practical AI", source: "Changelog Media", url: "https://changelog.com/practicalai/feed" },
  { show: "Big Technology Podcast", source: "Big Technology", url: "https://feeds.simplecast.com/4T39_jAj" },
  { show: "The Cognitive Revolution", source: "Turpentine", url: "https://feeds.megaphone.fm/LSHML4766177163" },
  { show: "Training Data", source: "Sequoia Capital", url: "https://feeds.simplecast.com/5tQpR8G8" },
  { show: "Software Engineering Daily", source: "Software Engineering Daily", url: "https://softwareengineeringdaily.com/feed/podcast/" },
  { show: "Software Engineering Radio", source: "IEEE Computer Society", url: "https://rss.libsyn.com/shows/21070/destinations/23379.xml" },
  { show: "Oxide and Friends", source: "Oxide Computer Company", url: "https://feeds.transistor.fm/oxide-and-friends" },
  { show: "The InfoQ Podcast", source: "InfoQ", url: "https://feeds.soundcloud.com/users/soundcloud:users:215740450/sounds.rss" },
  { show: "Changelog Interviews", source: "Changelog Media", url: "https://changelog.com/podcast/feed" },
  { show: "The Data Engineering Show", source: "Firebolt", url: "https://feeds.fame.so/the-data-engineering-show" },
  { show: "Dwarkesh Podcast", source: "Dwarkesh Patel", url: "https://apple.dwarkesh-podcast.workers.dev/feed.rss" },
  { show: "Gradient Dissent", source: "Weights & Biases", url: "https://feeds.captivate.fm/gradient-dissent/" },
];

function envNumber(name: string, fallback: number): number {
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
  ) {
    super(`${sourceName} podcast source found only ${usableEpisodes} usable episodes; need ${requiredEpisodes}`);
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

function parseFeed(feed: FeedSource, xml: string): Episode[] {
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  return items
    .map(item => {
      const pubDate = tag(item, "pubDate") || tag(item, "dc:date");
      const date = pubDate ? new Date(pubDate).toISOString().slice(0, 10) : "";
      const title = stripHtml(tag(item, "title"));
      const description = stripHtml(tag(item, "content:encoded") || tag(item, "description") || tag(item, "itunes:summary"));
      const link = tag(item, "link") || tag(item, "guid");
      const audioUrl = attr(item, "enclosure", "url");
      const guid = tag(item, "guid") || link || `${feed.show}:${title}`;
      const imageUrl = attr(item, "itunes:image", "href");
      const duration = tag(item, "itunes:duration");
      return {
        show: feed.show,
        source: feed.source,
        title,
        link,
        audioUrl,
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
    .filter(episode => episode.title && episode.description && episode.date && episode.link && episode.audioUrl);
}

function parseDate(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid date: ${date}`);
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(a).getTime() - parseDate(b).getTime()) / 86_400_000);
}

function scoreEpisode(episode: Episode): number {
  const text = `${episode.show} ${episode.title} ${episode.description}`.toLowerCase();
  const weightedTerms: [string, number][] = [
    ["interview", 3],
    ["conversation", 3],
    ["with ", 2],
    ["engineer", 3],
    ["engineering", 3],
    ["developer", 2],
    ["software", 2],
    ["architecture", 2],
    ["infrastructure", 2],
    ["platform", 2],
    ["data engineering", 3],
    ["developer tools", 3],
    ["open source", 2],
    ["security", 2],
    ["ai", 1],
    ["agent", 2],
    ["agents", 2],
    ["llm", 2],
    ["model", 1],
    ["researcher", 2],
    ["founder", 2],
    ["ceo", 1],
    ["cto", 2],
    ["product", 1],
    ["cloud", 1],
    ["data center", 2],
  ];
  const penalties: [string, number][] = [
    ["daily brief", 3],
    ["news roundup", 3],
    ["weekly update", 2],
    ["solo episode", 1],
    ["trailer", 3],
  ];
  const positive = weightedTerms.reduce((score, [term, weight]) => score + (text.includes(term) ? weight : 0), 0);
  const negative = penalties.reduce((score, [term, weight]) => score + (text.includes(term) ? weight : 0), 0);
  const showBonus = ["software engineering daily", "software engineering radio", "oxide and friends", "infoq", "changelog", "data engineering show", "dwarkesh", "gradient dissent"].some(show =>
    episode.show.toLowerCase().includes(show),
  )
    ? 2
    : 0;
  return positive + showBonus - negative;
}

function maxEpisodes(): number {
  return envNumber("PODCAST_MAX_EPISODES", 3);
}

function minEpisodes(): number {
  return envNumber("PODCAST_MIN_EPISODES", Math.min(3, maxEpisodes()));
}

function maxWindowDays(): number {
  return envNumber("PODCAST_LOOKBACK_DAYS", 10);
}

function minTranscriptChars(): number {
  return envNumber("PODCAST_MIN_TRANSCRIPT_CHARS", 1000);
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

function curatedEpisodesFile(): string {
  return process.env.PODCAST_CURATED_EPISODES_FILE || path.join(repoRoot(), "data/foreign-tech-podcast/curated-episodes.json");
}

function podcastHistoryPostsDir(): string {
  return process.env.PODCAST_HISTORY_POSTS_DIR || path.join(repoRoot(), "src/content/posts/zh-cn");
}

function normalizeCuratedEpisode(input: CuratedEpisodeInput): Episode | null {
  const title = stripHtml(input.title || "");
  const description = stripHtml(input.description || "");
  const link = input.link || "";
  const date = input.date || (input.pubDate ? new Date(input.pubDate).toISOString().slice(0, 10) : "");
  if (!title || !description || !link || !date) return null;
  return {
    show: input.show || input.source || "外部精选",
    source: input.source || input.show || "外部精选",
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
    curated: true,
  };
}

function loadCuratedEpisodes(date: string): Episode[] {
  const file = curatedEpisodesFile();
  if (!fs.existsSync(file)) return [];
  const payload = JSON.parse(fs.readFileSync(file, "utf8")) as CuratedEpisodesFile;
  const dated = payload.dates?.[date] || [];
  const global = (payload.episodes || []).filter(episode => {
    if (episode.archiveDate) return episode.archiveDate === date;
    if (!episode.date) return false;
    const delta = daysBetween(date, episode.date);
    return delta >= 0 && delta <= maxWindowDays();
  });
  return [...dated, ...global].map(normalizeCuratedEpisode).filter((episode): episode is Episode => Boolean(episode));
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
  return inWindow.toSorted((a, b) => {
    const scoreDelta = scoreEpisode(b) - scoreEpisode(a);
    if (scoreDelta) return scoreDelta;
    return b.date.localeCompare(a.date);
  });
}


function appleTopPodcastsCount(): number {
  return envNumber("APPLE_TOP_PODCASTS_COUNT", 10);
}

function appleTopPodcastsMaxEpisodes(): number {
  return envNumber("APPLE_TOP_PODCASTS_MAX_EPISODES", appleTopPodcastsCount());
}

function appleTopPodcastsMinEpisodes(): number {
  return envNumber("APPLE_TOP_PODCASTS_MIN_EPISODES", Math.min(8, appleTopPodcastsMaxEpisodes()));
}

function appleTopPodcastsTranscribeDelayMs(): number {
  return envNumber("APPLE_TOP_PODCASTS_TRANSCRIBE_DELAY_MS", envNumber("PODCAST_TRANSCRIBE_DELAY_MS", 0));
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
  };
}

function episodeAlreadySeen(seen: Map<string, unknown>, episode: Episode): boolean {
  return podcastFingerprints(episode).some(fingerprint => seen.has(fingerprint));
}

async function fetchAppleTopPodcastEpisodes(date: string): Promise<Episode[]> {
  const shows = await fetchAppleTopShows();
  const seen = historicalPodcastFingerprints(podcastHistoryPostsDir(), date);
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
      for (const fingerprint of podcastFingerprints(episode)) seen.set(fingerprint, { ...episode, file: `candidate:${date}` });
      selected.push(episode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeStderr(`WARN: Apple Top Shows #${show.rank} ${show.name}: ${message}`);
    }
  }
  if (skippedDuplicates) writeStderr(`skipped ${skippedDuplicates} Apple Top Shows duplicate/latest episode(s) already present in archive history`);
  return selected;
}

async function fetchEpisodes(date: string): Promise<Episode[]> {
  const curated = loadCuratedEpisodes(date);
  const rss = await fetchRssEpisodes(date);
  const seen = historicalPodcastFingerprints(podcastHistoryPostsDir(), date);
  const unique: Episode[] = [];
  let skipped = 0;
  for (const episode of [...curated, ...rss]) {
    const fingerprints = podcastFingerprints(episode);
    const duplicate = fingerprints.find(fingerprint => seen.has(fingerprint));
    if (duplicate) {
      skipped += 1;
      writeStderr(`skipping previously archived podcast: ${episode.title}`);
      continue;
    }
    for (const fingerprint of fingerprints) seen.set(fingerprint, { ...episode, file: `candidate:${date}` });
    unique.push(episode);
  }
  if (skipped) writeStderr(`skipped ${skipped} duplicate podcast episode(s) already present in archive history`);
  const curatedCount = unique.filter(episode => episode.curated).length;
  const limit = Math.max(maxEpisodes(), curatedCount);
  return unique.slice(0, limit);
}

async function downloadAudio(url: string, file: string): Promise<void> {
  const maxBytes = envNumber("PODCAST_AUDIO_MAX_MB", 300) * 1024 * 1024;
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36" },
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
}

function splitExtraArgs(value = ""): string[] {
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(token => token.replace(/^['"]|['"]$/g, "")) || [];
}

function runLocalWhisper(audioFile: string, outDir: string): string {
  const bin = process.env.PODCAST_WHISPER_BIN || "whisper";
  const model = process.env.PODCAST_WHISPER_MODEL || "base.en";
  const timeoutMs = envNumber("PODCAST_WHISPER_TIMEOUT_MS", 45 * 60 * 1000);
  ensureDir(outDir);
  const args = [
    audioFile,
    "--model",
    model,
    "--language",
    "en",
    "--task",
    "transcribe",
    "--output_format",
    "txt",
    "--output_dir",
    outDir,
    ...splitExtraArgs(process.env.PODCAST_WHISPER_EXTRA_ARGS || ""),
  ];
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${bin} exited ${result.status}: ${(result.stderr || result.stdout || "").slice(0, 2000)}`);
  const txtFiles = fs
    .readdirSync(outDir)
    .filter(file => file.endsWith(".txt"))
    .map(file => path.join(outDir, file))
    .toSorted((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const transcript = compact(txtFiles.map(file => fs.readFileSync(file, "utf8")).join("\n"));
  if (transcript.length < minTranscriptChars()) throw new Error(`local whisper transcript too short (${transcript.length} chars)`);
  return transcript;
}

function transcriptionProviders(): string[] {
  const raw = process.env.PODCAST_TRANSCRIBE_PROVIDER || process.env.PODCAST_TRANSCRIBE_PROVIDERS || "groq,local";
  return raw
    .split(/[,>]/)
    .map(provider => provider.trim().toLowerCase())
    .filter(Boolean);
}

function groqApiKey(): string {
  return process.env.GROQ_API_KEY || process.env.PODCAST_GROQ_API_KEY || "";
}

function groqModel(): string {
  return process.env.PODCAST_GROQ_MODEL || "whisper-large-v3-turbo";
}

function runFfmpeg(args: string[], timeoutMs: number): void {
  const bin = process.env.PODCAST_FFMPEG_BIN || "ffmpeg";
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${bin} exited ${result.status}: ${(result.stderr || result.stdout || "").slice(0, 2000)}`);
}

function prepareGroqAudioChunks(audioFile: string, outDir: string): string[] {
  ensureDir(outDir);
  const segmentSeconds = envNumber("PODCAST_GROQ_SEGMENT_SECONDS", 20 * 60);
  const bitrate = process.env.PODCAST_GROQ_AUDIO_BITRATE || "64k";
  const timeoutMs = envNumber("PODCAST_FFMPEG_TIMEOUT_MS", 20 * 60 * 1000);
  runFfmpeg(["-y", "-i", audioFile, "-vn", "-ac", "1", "-ar", "16000", "-b:a", bitrate, "-f", "segment", "-segment_time", String(segmentSeconds), "-reset_timestamps", "1", path.join(outDir, "chunk-%03d.mp3")], timeoutMs);
  const maxBytes = envNumber("PODCAST_GROQ_MAX_CHUNK_MB", 24) * 1024 * 1024;
  const chunks = fs
    .readdirSync(outDir)
    .filter(file => file.endsWith(".mp3"))
    .map(file => path.join(outDir, file))
    .toSorted();
  if (!chunks.length) throw new Error("ffmpeg produced no Groq audio chunks");
  const oversized = chunks.find(file => fs.statSync(file).size > maxBytes);
  if (oversized) throw new Error(`Groq audio chunk exceeds ${Math.round(maxBytes / 1024 / 1024)}MB: ${path.basename(oversized)}`);
  return chunks;
}

function groqRetryAttempts(): number {
  return Math.max(1, envNumber("PODCAST_GROQ_RETRY_ATTEMPTS", 3));
}

function groqRetryDelayMs(attempt: number): number {
  return envNumber("PODCAST_GROQ_RETRY_DELAY_MS", 30_000) * attempt;
}

function groqChunkDelayMs(): number {
  return envNumber("PODCAST_GROQ_CHUNK_DELAY_MS", 0);
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function retryableGroqStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

class NonRetryableGroqError extends Error {}

async function transcribeGroqChunk(chunkFile: string): Promise<string> {
  const key = groqApiKey();
  if (!key) throw new Error("GROQ_API_KEY is not configured");
  const timeoutMs = envNumber("PODCAST_GROQ_TIMEOUT_MS", 10 * 60 * 1000);
  let lastError = "";
  for (let attempt = 1; attempt <= groqRetryAttempts(); attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(fs.readFileSync(chunkFile))], { type: "audio/mpeg" }), path.basename(chunkFile));
      form.append("model", groqModel());
      form.append("response_format", "json");
      form.append("temperature", "0");
      const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        lastError = `Groq transcription HTTP ${response.status}: ${text.slice(0, 1000)}`;
        if (attempt < groqRetryAttempts() && retryableGroqStatus(response.status)) {
          const delayMs = retryAfterMs(response.headers.get("retry-after")) ?? groqRetryDelayMs(attempt);
          writeStderr(`WARN: Groq transcription attempt ${attempt}/${groqRetryAttempts()} failed; retrying after ${Math.round(delayMs / 1000)}s: ${lastError}`);
          await sleep(delayMs);
          continue;
        }
        throw new NonRetryableGroqError(lastError);
      }
      const payload = JSON.parse(text) as { text?: string };
      return compact(payload.text || "");
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (error instanceof NonRetryableGroqError) throw error;
      if (attempt < groqRetryAttempts()) {
        const delayMs = groqRetryDelayMs(attempt);
        writeStderr(`WARN: Groq transcription attempt ${attempt}/${groqRetryAttempts()} failed; retrying after ${Math.round(delayMs / 1000)}s: ${lastError}`);
        await sleep(delayMs);
        continue;
      }
      throw new Error(lastError);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError || "Groq transcription failed");
}

async function runGroqWhisper(audioFile: string, outDir: string): Promise<string> {
  if (!groqApiKey()) throw new Error("GROQ_API_KEY is not configured");
  const chunks = prepareGroqAudioChunks(audioFile, outDir);
  const parts: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    if (index > 0) await sleep(groqChunkDelayMs());
    writeStderr(`Groq transcribing chunk ${index + 1}/${chunks.length}: ${path.basename(chunk)}`);
    parts.push(await transcribeGroqChunk(chunk));
  }
  const transcript = compact(parts.join("\n"));
  if (transcript.length < minTranscriptChars()) throw new Error(`Groq transcript too short (${transcript.length} chars)`);
  return transcript;
}

async function transcribeAudio(audioFile: string, outDir: string): Promise<string> {
  const errors: string[] = [];
  for (const provider of transcriptionProviders()) {
    try {
      if (provider === "groq") return await runGroqWhisper(audioFile, path.join(outDir, "groq"));
      if (["local", "local-whisper", "whisper"].includes(provider)) return runLocalWhisper(audioFile, path.join(outDir, "local"));
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
        if (episode.curated || options.tolerateFailures) {
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
      episode.audioUrl ? `- 音频：${episode.audioUrl}` : "- 音频：未提供；使用仓库预置 transcript",
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

export async function buildForeignTechPodcastSource(date = bjtDateString()): Promise<string> {
  const episodes = await enrichWithTranscripts(await fetchEpisodes(date));
  if (episodes.length < minEpisodes()) throw new Error(`foreign tech podcast source found only ${episodes.length} usable episodes; need ${minEpisodes()}`);
  return podcastSourceMarkdown(
    episodes,
    "以下证据来自海外科技访谈/深度讨论类播客 RSS/curated 条目及其可用 transcript。每个候选都必须有音频转写或仓库预置 transcript；没有 transcript 的条目已在 source 阶段跳过。AI 只能依据 transcript 与元数据写作；不得编造嘉宾、观点或未提供的事实。",
    [
      "- 这是基于播客 transcript 的中文长文笔记，不是新闻快讯。需要直接按每期节目独立小节展开，不要额外生成总览或播客清单。",
      "- 若 transcript 或元数据没有明确嘉宾姓名，嘉宾字段写“未标明”，不要猜。",
      "- 每条分析必须能回到 transcript 证据；不得仅凭标题、链接、图片或简短简介扩写。",
      "- 不要生成金融建议、产品购买建议或夸张标题。",
    ],
  );
}

export async function buildAppleTopPodcastsSource(date = bjtDateString()): Promise<string> {
  const episodes = await enrichWithTranscripts(await fetchAppleTopPodcastEpisodes(date), { tolerateFailures: true, transcribeDelayMs: appleTopPodcastsTranscribeDelayMs() });
  if (episodes.length < appleTopPodcastsMinEpisodes()) throw new PodcastSourceInsufficientEpisodesError("Apple Top Shows", episodes.length, appleTopPodcastsMinEpisodes());
  return podcastSourceMarkdown(
    episodes,
    `以下证据来自 Apple Podcasts ${appleStorefront().toUpperCase()} Top Shows 官方榜单、iTunes lookup 得到的 RSS feed、节目 RSS 元数据及其可用 transcript。候选按 Apple 榜单顺序保留；每个节目只选择近 ${maxWindowDays()} 天内第一个未归档且可转写的 episode。没有 RSS、近期音频或 transcript 的条目已在 source 阶段跳过。AI 只能依据 transcript 与元数据写作；不得编造嘉宾、观点或未提供的事实。`,
    [
      "- 这是基于 Apple Top Shows 热门节目近期 episode transcript 的中文长文笔记，不是榜单介绍或节目推荐。",
      "- 需要按输入顺序逐条展开，不要额外生成总览或播客清单；不要把多个节目合并成一个主题。",
      "- 若 transcript 或元数据没有明确嘉宾姓名，嘉宾字段写“未标明”，不要猜。",
      "- 每条分析必须能回到 transcript 证据；不得仅凭榜单排名、标题、链接、图片或简短简介扩写。",
      "- 不要生成金融建议、健康建议、产品购买建议或夸张标题。",
    ],
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  const date = stringArg(args, "date", bjtDateString());
  buildForeignTechPodcastSource(date)
    .then(text => writeStdout(text))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      writeStderr(`ERROR: ${message}`);
      process.exit(1);
    });
}
