#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bjtDateString, compact, ensureDir, fetchText, parseArgs, repoRoot, stringArg, stripHtml, writeStderr, writeStdout } from "./blog_common.ts";

type FeedSource = {
  show: string;
  source: string;
  url: string;
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
  curated?: boolean;
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
};

type CuratedEpisodesFile = {
  episodes?: CuratedEpisodeInput[];
  dates?: Record<string, CuratedEpisodeInput[]>;
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
      return { show: feed.show, source: feed.source, title, link, audioUrl, guid, pubDate, date, description };
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

function transcriptChars(): number {
  return envNumber("PODCAST_TRANSCRIPT_CHARS", 10_000);
}
function rssDisabled(): boolean {
  return ["1", "true", "yes"].includes((process.env.PODCAST_DISABLE_RSS || "").toLowerCase());
}

function audioTranscribeEnabled(): boolean {
  return !["0", "false", "no"].includes((process.env.PODCAST_AUDIO_TRANSCRIBE || "true").toLowerCase());
}

function audioTranscriptFallbackEnabled(): boolean {
  return !["0", "false", "no"].includes((process.env.PODCAST_AUDIO_TRANSCRIPT_FALLBACK || "true").toLowerCase());
}

function curatedEpisodesFile(): string {
  return process.env.PODCAST_CURATED_EPISODES_FILE || path.join(repoRoot(), "data/foreign-tech-podcast/curated-episodes.json");
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
      const xml = await fetchText(feed.url, { timeoutMs: 25_000, maxChars: 2_500_000 });
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

async function fetchEpisodes(date: string): Promise<Episode[]> {
  const curated = loadCuratedEpisodes(date);
  const rss = await fetchRssEpisodes(date);
  const seen = new Set<string>();
  const unique: Episode[] = [];
  for (const episode of [...curated, ...rss]) {
    const key = `${episode.link || episode.guid || episode.title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(episode);
  }
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
  if (transcript.length < envNumber("PODCAST_MIN_TRANSCRIPT_CHARS", 1000)) throw new Error(`local whisper transcript too short (${transcript.length} chars)`);
  return transcript;
}

async function enrichWithTranscripts(episodes: Episode[]): Promise<Episode[]> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-tech-podcast-"));
  try {
    const enriched: Episode[] = [];
    for (const [index, episode] of episodes.entries()) {
      if (!episode.audioUrl) {
        if (!episode.transcript && episode.description.length < 80) throw new Error(`${episode.title}: curated episode needs a useful description when no audio URL is provided`);
        enriched.push(episode);
        continue;
      }
      if (episode.transcript) {
        enriched.push(episode);
        continue;
      }
      if (episode.curated && !audioTranscribeEnabled()) {
        enriched.push(episode);
        continue;
      }
      writeStderr(`transcribing podcast ${index + 1}/${episodes.length}: ${episode.title}`);
      const rawAudio = path.join(tmp, `${index}.mp3`);
      const outDir = path.join(tmp, `transcript-${index}`);
      try {
        await downloadAudio(episode.audioUrl, rawAudio);
        const transcript = runLocalWhisper(rawAudio, outDir);
        enriched.push({ ...episode, transcript });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (episode.curated && !episode.transcript && episode.description.length >= 80 && audioTranscriptFallbackEnabled()) {
          writeStderr(`WARN: ${episode.title}: podcast audio transcription unavailable; falling back to curated metadata: ${message}`);
          enriched.push(episode);
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

export async function buildForeignTechPodcastSource(date = bjtDateString()): Promise<string> {
  const episodes = await enrichWithTranscripts(await fetchEpisodes(date));
  if (episodes.length < minEpisodes()) throw new Error(`foreign tech podcast source found only ${episodes.length} usable episodes; need ${minEpisodes()}`);
  const lines = [
    "## 来源说明",
    "",
    "以下证据来自海外科技访谈/深度讨论类播客 RSS 元数据、仓库内 curated 外部精选条目与可用的本地 Whisper 音频转写文本。AI 只允许依据标题、节目、嘉宾、发布日期、链接、图片、show notes 与 transcript 写作；不得编造嘉宾、未出现的观点或未提供的事实。",
    "",
    "## 候选播客清单",
    "",
  ];
  for (const [index, episode] of episodes.entries()) {
    const metadata = [
      `- 节目：${episode.show}`,
      `- 来源：${episode.source}`,
      episode.guest ? `- 嘉宾：${episode.guest}` : "- 嘉宾：未标明",
      `- 发布日期：${episode.date}`,
      `- 链接：${episode.link}`,
      episode.imageUrl ? `- 图片：${episode.imageUrl}` : "",
      episode.duration ? `- 时长：${episode.duration}` : "",
      episode.audioUrl ? `- 音频：${episode.audioUrl}` : "- 音频：未提供；本条目不做 Whisper 转写",
      `- Show notes：${episode.description}`,
    ].filter(Boolean);
    lines.push(
      `### ${index + 1}. ${episode.title}`,
      "",
      ...metadata,
      "",
      "#### Transcript excerpt",
      "",
      episode.transcript ? String(episode.transcript).slice(0, transcriptChars()) : "未提供 transcript；本条目只能依据元数据、图片和 show notes 写作，不得假装听过完整音频。",
      "",
    );
  }
  lines.push(
    "## 写作边界",
    "",
    "- 这是基于播客音频转写文本或外部精选元数据的中文长文笔记，不是新闻快讯。需要直接按每期节目独立小节展开，不要额外生成总览或播客清单。",
    "- 若 transcript、show notes 或 curated 条目没有明确嘉宾姓名，嘉宾字段写“未标明”，不要猜。",
    "- 每条分析必须能回到 transcript、show notes、curated 元数据或链接信息，不得假装读过未提供的内容。",
    "- 不要生成投资建议、产品购买建议或夸张标题。",
  );
  return `${lines.join("\n").trim()}\n`;
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
