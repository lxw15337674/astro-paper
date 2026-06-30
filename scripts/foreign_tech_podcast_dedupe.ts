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
