// 技术/AI/科技商业日报规则层：模型返回「栏目 + 条目」结构 JSON，
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

function normalizeLink(url: string): string {
  return url.replace(/[)）.,，。]+$/, "").toLowerCase();
}

// 与 generate_scheduled_post.ts 的 sourceLinks 保持同款归一化，作为 compose 内的精确早校验。
function sourceLinkSet(source: string): Set<string> {
  return new Set(
    (source.match(/^- 链接：(.+)$/gm) || [])
      .map(line => normalizeLink(line.replace(/^- 链接：/, "")))
      .filter(Boolean),
  );
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

export function parseDailyDigestModelJson(raw: string, source: string, task: string): { overview: string; sections: DailyDigestSection[] } {
  const parsed = parseModelJsonObject(raw, "daily digest");
  const sections = parseSections(parsed.sections);
  const allowed = sourceLinkSet(source);
  const seenLinks = new Set<string>();
  const seenTitles = new Set<string>();
  for (const section of sections) {
    for (const item of section.items) {
      const normalized = normalizeLink(item.source_url);
      if (!allowed.has(normalized)) throw new Error(`daily digest item "${item.title_zh}" uses a link outside the source pool: ${item.source_url}`);
      if (seenLinks.has(normalized)) throw new Error(`daily digest reuses source link: ${item.source_url}`);
      seenLinks.add(normalized);
      const titleKey = item.title_zh.toLowerCase();
      if (seenTitles.has(titleKey)) throw new Error(`daily digest reuses item title: ${item.title_zh}`);
      seenTitles.add(titleKey);
    }
  }
  const overview = String(parsed.overview || "").trim();
  if (task === "tech-daily") {
    if (!overview) throw new Error("tech-daily model JSON is missing overview");
    if (/\n/.test(overview)) throw new Error("tech-daily overview must be a single paragraph");
    if (compact(overview).length > 140) throw new Error(`tech-daily overview is too long (${compact(overview).length} > 140)`);
  }
  return { overview, sections };
}

export function composeDailyDigestBody(overview: string, sections: DailyDigestSection[], task: string): string {
  const blocks: string[] = [];
  if (task === "tech-daily" && overview) blocks.push(`## 今日总览\n\n${overview}`);
  for (const section of sections) {
    const items = section.items.map(item => `### [${item.title_zh}](${item.source_url})\n\n${item.body_markdown}`);
    blocks.push(`## ${section.title}\n\n${items.join("\n\n")}`);
  }
  return `${blocks.join("\n\n")}\n`;
}

export function dailyDigestMarkdownFromModelJson(raw: string, source: string, task: string): string {
  const { overview, sections } = parseDailyDigestModelJson(raw, source, task);
  return composeDailyDigestBody(overview, sections, task);
}
