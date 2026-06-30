import fs from "node:fs";
import path from "node:path";
import { compact } from "./blog_common.ts";

export type PodcastFingerprintInput = {
  title: string;
  show?: string;
  link?: string;
  audioUrl?: string;
  guid?: string;
  date?: string;
  canonicalId?: string;
};

export type HistoricalPodcastEpisode = PodcastFingerprintInput & {
  file: string;
};

type HistoricalPodcastFileOptions = {
  includeCurrentDate?: boolean;
  excludeFile?: string;
};

function normalizeText(value = ""): string {
  return compact(value)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(value = ""): string {
  return normalizeText(value)
    .replace(/^[#\d.\s-]+/, "")
    .replace(/[|｜].*$/g, "")
    .replace(/[^\p{L}\p{N}\s'"-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizePodcastUrl(value = ""): string {
  if (!value.trim()) return "";
  try {
    const url = new URL(value.trim());
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    const params = [...url.searchParams.entries()]
      .filter(([key]) => !/^utm_/i.test(key) && !["uo", "fbclid", "gclid", "igshid", "mc_cid", "mc_eid"].includes(key.toLowerCase()))
      .toSorted(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
    url.search = "";
    for (const [key, paramValue] of params) url.searchParams.append(key, paramValue);
    const normalized = url.toString().replace(/\/$/, "");
    return normalized;
  } catch {
    return normalizeText(value);
  }
}

function youtubeId(value = ""): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.hostname.includes("youtu.be")) return url.pathname.split("/").filter(Boolean)[0] || "";
    if (url.hostname.includes("youtube.com")) return url.searchParams.get("v") || url.pathname.match(/\/(?:embed|shorts)\/([^/?#]+)/)?.[1] || "";
  } catch {
    // fall through to regex fallback
  }
  return value.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([^&#?/]+)/i)?.[1] || "";
}

export function podcastFingerprints(input: PodcastFingerprintInput): string[] {
  const ids = new Set<string>();
  const canonicalId = normalizeText(input.canonicalId || "");
  if (canonicalId) ids.add(`canonical:${canonicalId}`);

  for (const raw of [input.link, input.audioUrl, input.guid].filter(Boolean) as string[]) {
    const yt = youtubeId(raw);
    if (yt) ids.add(`youtube:${yt}`);
    const normalizedUrl = normalizePodcastUrl(raw);
    if (normalizedUrl) ids.add(`url:${normalizedUrl}`);
  }

  const guid = input.guid && !/^https?:\/\//i.test(input.guid) ? normalizeText(input.guid) : "";
  if (guid) ids.add(`guid:${guid}`);

  const title = normalizeTitle(input.title);
  if (title) {
    const show = normalizeTitle(input.show || "");
    const date = normalizeText(input.date || "");
    ids.add(`title:${show}:${title}:${date}`);
  }

  return [...ids];
}

function bulletValue(block: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    block.match(new RegExp(`^-\\s+\\*\\*${escaped}\\*\\*[：:]\\s*(.+)$`, "m"))?.[1] ||
    block.match(new RegExp(`^-\\s+${escaped}[：:]\\s*(.+)$`, "m"))?.[1] ||
    ""
  ).trim();
}

export function extractPodcastEpisodesFromMarkdown(markdown: string, file = ""): HistoricalPodcastEpisode[] {
  const body = markdown.replace(/^---[\s\S]*?---\s*/m, "");
  return body
    .split(/(?=^##\s+)/gm)
    .map(block => block.trim())
    .filter(block => /^##\s+/.test(block))
    .map(block => {
      const title = block.match(/^##\s+(.+)$/m)?.[1]?.trim() || "";
      return {
        title,
        show: bulletValue(block, "节目"),
        link: bulletValue(block, "链接"),
        audioUrl: bulletValue(block, "音频"),
        guid: bulletValue(block, "GUID") || bulletValue(block, "guid"),
        date: bulletValue(block, "日期") || bulletValue(block, "发布日期"),
        canonicalId: bulletValue(block, "canonicalId") || bulletValue(block, "Canonical ID"),
        file,
      };
    })
    .filter(episode => episode.title);
}

function podcastPostDate(file: string): string {
  return /^(?:海外科技播客|每日播客)-(\d{4}-\d{2}-\d{2})(?:-.+)?\.md$/.exec(path.basename(file))?.[1] || "";
}

function sameFile(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

export function listHistoricalPodcastFiles(postsDir: string, currentDate: string, options: HistoricalPodcastFileOptions = {}): string[] {
  if (!fs.existsSync(postsDir)) return [];
  return fs
    .readdirSync(postsDir)
    .filter(file => {
      const fullPath = path.join(postsDir, file);
      const date = podcastPostDate(file);
      if (!date) return false;
      if (options.excludeFile && sameFile(fullPath, options.excludeFile)) return false;
      return options.includeCurrentDate || date !== currentDate;
    })
    .map(file => path.join(postsDir, file))
    .toSorted();
}

export function historicalPodcastEpisodes(postsDir: string, currentDate: string, options: HistoricalPodcastFileOptions = {}): HistoricalPodcastEpisode[] {
  return listHistoricalPodcastFiles(postsDir, currentDate, options).flatMap(file => extractPodcastEpisodesFromMarkdown(fs.readFileSync(file, "utf8"), file));
}

export function historicalPodcastFingerprints(postsDir: string, currentDate: string, options: HistoricalPodcastFileOptions = {}): Map<string, HistoricalPodcastEpisode> {
  const fingerprints = new Map<string, HistoricalPodcastEpisode>();
  for (const episode of historicalPodcastEpisodes(postsDir, currentDate, options)) {
    for (const fingerprint of podcastFingerprints(episode)) fingerprints.set(fingerprint, episode);
  }
  return fingerprints;
}

export function assertNoHistoricalPodcastDuplicates(markdown: string, postsDir: string, currentDate: string, options: HistoricalPodcastFileOptions = {}): void {
  const historical = historicalPodcastFingerprints(postsDir, currentDate, options);
  const seen = new Map<string, HistoricalPodcastEpisode>();
  for (const episode of extractPodcastEpisodesFromMarkdown(markdown, `current:${currentDate}`)) {
    const fingerprints = podcastFingerprints(episode);
    const currentDuplicate = fingerprints.map(fingerprint => seen.get(fingerprint)).find(Boolean);
    if (currentDuplicate) throw new Error(`foreign tech podcast duplicates episode within current article: ${episode.title}`);
    const historicalDuplicate = fingerprints.map(fingerprint => historical.get(fingerprint)).find(Boolean);
    if (historicalDuplicate) {
      throw new Error(`foreign tech podcast episode was already archived: ${episode.title} duplicates ${historicalDuplicate.title} in ${path.basename(historicalDuplicate.file)}`);
    }
    for (const fingerprint of fingerprints) seen.set(fingerprint, episode);
  }
}
