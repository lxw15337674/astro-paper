// 技术日报规则层：模型返回「栏目 + 条目」结构 JSON，
// 每条正文放 body_markdown 自由散文字段；链接由规则从 source 池按 source_url 回填校验，
// 模型不再手写链接语法。事实（链接）来自 source，散文来自模型。
import { compact } from "./blog_common.ts";
import { hasChinese, looksLowSignal, parseModelJsonObject } from "./compose_common.ts";

export type DailyDigestItem = {
  title_zh: string;
  source_url: string;
  body_markdown: string;
};

export type DailyDigestSection = {
  title: string;
  items: DailyDigestItem[];
};

function stripLinkTerminalPunctuation(url: string): string {
  return url.replace(/[)）.,，。]+$/, "");
}

function normalizeLink(url: string): string {
  return stripLinkTerminalPunctuation(url).toLowerCase();
}

// 与 generate_scheduled_post.ts 的 sourceLinks 保持同款归一化，作为 compose 内的精确早校验。
// Keys are normalized only for comparisons; values retain canonical source-pool URLs.
function sourceLinkMap(source: string): Map<string, string[]> {
  const links = new Map<string, string[]>();
  for (const line of source.match(/^- 链接：(.+)$/gm) || []) {
    const sourceUrl = stripLinkTerminalPunctuation(line.replace(/^- 链接：/, "").trim());
    const normalized = normalizeLink(sourceUrl);
    if (!normalized) continue;
    const canonicalUrls = links.get(normalized) || [];
    if (!canonicalUrls.includes(sourceUrl)) canonicalUrls.push(sourceUrl);
    links.set(normalized, canonicalUrls);
  }
  return links;
}

// Repair only the observed model corruption: a leading prefix of the final URL slug
// is duplicated. Every other URL component must still match a source-pool URL.
function hasDuplicatedSlugPrefix(url: string, sourceUrl: string): boolean {
  try {
    const candidate = new URL(url);
    const source = new URL(sourceUrl);
    if (
      candidate.origin !== source.origin ||
      candidate.username !== source.username ||
      candidate.password !== source.password ||
      candidate.search !== source.search ||
      candidate.hash !== source.hash
    ) {
      return false;
    }

    const sourceSlash = source.pathname.lastIndexOf("/");
    const candidateSlash = candidate.pathname.lastIndexOf("/");
    if (sourceSlash < 0 || candidateSlash < 0 || source.pathname.slice(0, sourceSlash + 1) !== candidate.pathname.slice(0, candidateSlash + 1)) {
      return false;
    }

    const sourceSlug = source.pathname.slice(sourceSlash + 1);
    const candidateSlug = candidate.pathname.slice(candidateSlash + 1);
    if (!sourceSlug || !candidateSlug.endsWith(sourceSlug)) return false;
    const duplicatedPrefix = candidateSlug.slice(0, -sourceSlug.length);
    return duplicatedPrefix.length > 0 && sourceSlug.startsWith(duplicatedPrefix);
  } catch {
    return false;
  }
}

function reconcileSourceLink(url: string, allowed: Map<string, string[]>): string | undefined {
  const normalized = normalizeLink(url);
  const canonicalCandidate = stripLinkTerminalPunctuation(url.trim());
  const exact = allowed.get(normalized)?.filter(sourceUrl => sourceUrl === canonicalCandidate) || [];
  if (exact.length === 1) return exact[0];
  const normalizedMatches = allowed.get(normalized) || [];
  if (normalizedMatches.length === 1) return normalizedMatches[0];
  const matches = [...allowed].flatMap(([sourceKey, sourceUrls]) => (hasDuplicatedSlugPrefix(normalized, sourceKey) ? sourceUrls : []));
  return matches.length === 1 ? matches[0] : undefined;
}

function parseSections(rawSections: unknown): DailyDigestSection[] {
  if (!Array.isArray(rawSections) || rawSections.length === 0) throw new Error("daily digest model JSON must contain a non-empty sections array");
  return rawSections.map((entry, sectionIndex) => {
    const section = (entry || {}) as Record<string, unknown>;
    const title = String(section.title || "").trim();
    if (!title) throw new Error(`daily digest section ${sectionIndex + 1} is missing title`);
    if (!hasChinese(title)) throw new Error(`daily digest section title should use Chinese: ${title}`);
    const rawItems = section.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) throw new Error(`daily digest section "${title}" has no items`);
    const items = rawItems.map((itemEntry, itemIndex) => {
      const item = (itemEntry || {}) as Record<string, unknown>;
      const titleZh = String(item.title_zh || "").trim();
      if (!titleZh || !hasChinese(titleZh)) throw new Error(`daily digest section "${title}" item ${itemIndex + 1} title_zh should use a Chinese title: ${titleZh}`);
      const sourceUrl = String(item.source_url || "").trim();
      if (!/^https?:\/\//.test(sourceUrl)) throw new Error(`daily digest item "${titleZh}" has invalid source_url: ${sourceUrl}`);
      const body = String(item.body_markdown || "").trim();
      if (!body || looksLowSignal(body)) throw new Error(`daily digest item "${titleZh}" has empty or low-signal body_markdown`);
      return { title_zh: titleZh, source_url: sourceUrl, body_markdown: body };
    });
    return { title, items };
  });
}

export function parseDailyDigestModelJson(raw: string, source: string): { overview: string; sections: DailyDigestSection[] } {
  const parsed = parseModelJsonObject(raw, "daily digest");
  const sections = parseSections(parsed.sections);
  const allowed = sourceLinkMap(source);
  const seenLinks = new Set<string>();
  const seenTitles = new Set<string>();
  for (const section of sections) {
    for (const item of section.items) {
      const sourceUrl = reconcileSourceLink(item.source_url, allowed);
      if (!sourceUrl) throw new Error(`daily digest item "${item.title_zh}" uses a link outside the source pool: ${item.source_url}`);
      item.source_url = sourceUrl;
      const linkKey = normalizeLink(sourceUrl);
      if (seenLinks.has(linkKey)) throw new Error(`daily digest reuses source link: ${item.source_url}`);
      seenLinks.add(linkKey);
      const titleKey = item.title_zh.toLowerCase();
      if (seenTitles.has(titleKey)) throw new Error(`daily digest reuses item title: ${item.title_zh}`);
      seenTitles.add(titleKey);
    }
  }
  const overview = String(parsed.overview || "").trim();
  if (!overview) throw new Error("tech-daily model JSON is missing overview");
  if (/\n/.test(overview)) throw new Error("tech-daily overview must be a single paragraph");
  if (compact(overview).length > 140) throw new Error(`tech-daily overview is too long (${compact(overview).length} > 140)`);
  return { overview, sections };
}

export function composeDailyDigestBody(overview: string, sections: DailyDigestSection[]): string {
  const blocks: string[] = [`## 今日总览\n\n${overview}`];
  for (const section of sections) {
    const items = section.items.map(item => `### [${item.title_zh}](${item.source_url})\n\n${item.body_markdown}`);
    blocks.push(`## ${section.title}\n\n${items.join("\n\n")}`);
  }
  return `${blocks.join("\n\n")}\n`;
}

export function dailyDigestMarkdownFromModelJson(raw: string, source: string): string {
  const { overview, sections } = parseDailyDigestModelJson(raw, source);
  return composeDailyDigestBody(overview, sections);
}
