// NYT 每周图书规则层：模型只返回语义字段（中文书名/类型/内容简介/推荐理由），
// 事实字段（原书名、作者、出版社、排名、上榜周数、封面、书评链接）一律取自 source。
import { bulletValue, extractBullets, hasChinese, looksLowSignal, parseModelJsonObject } from "./compose_common.ts";

export type NytBookModelItem = {
  rank: number;
  title_zh: string;
  genre_zh: string;
  summary: string;
  recommendation: string;
};

export type NytBookFact = {
  rank: number;
  original_title: string;
  author: string;
  publisher: string;
  nyt_rank: string;
  weeks_on_list: string;
  review_link: string;
  cover: string;
};

type NytBookFacts = { fiction: NytBookFact[]; nonfiction: NytBookFact[] };

function parseSectionFacts(sectionText: string): NytBookFact[] {
  const blocks = sectionText
    .split(/(?=^##\s+\d+\.\s+)/gm)
    .map(block => block.trim())
    .filter(block => /^##\s+\d+\.\s+/.test(block));
  return blocks.map((block, index) => {
    const bullets = extractBullets(block);
    const link = bulletValue(bullets, "书评链接");
    return {
      rank: index + 1,
      original_title: bulletValue(bullets, "原书名") || block.match(/^##\s+\d+\.\s+(.+)$/m)?.[1]?.trim() || "",
      author: bulletValue(bullets, "作者"),
      publisher: bulletValue(bullets, "出版社"),
      nyt_rank: bulletValue(bullets, "榜单排名"),
      weeks_on_list: bulletValue(bullets, "上榜周数"),
      review_link: link && link !== "-" ? link : "",
      cover: bulletValue(bullets, "封面"),
    };
  });
}

// source 分「# 小说候选」「# 非虚构候选」两段，任一段可能缺席（当周该榜无新书）。
export function parseNytBookFacts(source: string): NytBookFacts {
  const fictionAt = source.indexOf("# 小说候选");
  const nonfictionAt = source.indexOf("# 非虚构候选");
  const fictionText = fictionAt >= 0 ? source.slice(fictionAt, nonfictionAt >= 0 && nonfictionAt > fictionAt ? nonfictionAt : undefined) : "";
  const nonfictionText = nonfictionAt >= 0 ? source.slice(nonfictionAt) : "";
  return { fiction: parseSectionFacts(fictionText), nonfiction: parseSectionFacts(nonfictionText) };
}

function validateModelItems(rawItems: unknown, label: string): NytBookModelItem[] {
  if (rawItems === undefined) return [];
  if (!Array.isArray(rawItems)) throw new Error(`nyt-books model JSON ${label} must be an array`);
  return rawItems.map((entry, index) => {
    const item = (entry || {}) as Record<string, unknown>;
    const rank = Number(item.rank);
    if (!Number.isInteger(rank) || rank < 1) throw new Error(`nyt-books ${label} item ${index + 1} has invalid rank: ${String(item.rank)}`);
    const titleZh = String(item.title_zh || "").trim();
    if (!titleZh || !hasChinese(titleZh)) throw new Error(`nyt-books ${label} rank ${rank} title_zh should use a Chinese title: ${titleZh}`);
    const genreZh = String(item.genre_zh || "").trim();
    if (!genreZh) throw new Error(`nyt-books ${label} rank ${rank} is missing genre_zh`);
    const summary = String(item.summary || "").trim();
    const recommendation = String(item.recommendation || "").trim();
    for (const [field, value] of [["summary", summary], ["recommendation", recommendation]] as const) {
      if (!value || looksLowSignal(value)) throw new Error(`nyt-books ${label} rank ${rank} has empty or low-signal ${field}`);
    }
    return { rank, title_zh: titleZh, genre_zh: genreZh, summary, recommendation };
  });
}

export function parseNytBookModelJson(raw: string): { fiction: NytBookModelItem[]; nonfiction: NytBookModelItem[] } {
  const parsed = parseModelJsonObject(raw, "nyt-books");
  const fiction = validateModelItems(parsed.fiction, "fiction");
  const nonfiction = validateModelItems(parsed.nonfiction, "nonfiction");
  if (fiction.length + nonfiction.length < 1) throw new Error("nyt-books model JSON needs at least one book");
  return { fiction, nonfiction };
}

function composeWork(model: NytBookModelItem, fact: NytBookFact): string {
  const lines = [`### ${model.title_zh}（${fact.original_title}）`, ""];
  if (fact.cover && fact.cover !== "-") lines.push(`![${model.title_zh}](${fact.cover})`, "");
  const rankText = fact.nyt_rank && fact.nyt_rank !== "-" ? `本周榜单第 ${fact.nyt_rank} 名` : "本周新上榜";
  const weeksText = fact.weeks_on_list && fact.weeks_on_list !== "-" ? `（上榜 ${fact.weeks_on_list} 周）` : "";
  lines.push(
    "#### 基本信息",
    "",
    `- 作者：${fact.author || "未标明"}`,
    `- 出版社：${fact.publisher || "未标明"}`,
    `- 类型：${model.genre_zh}`,
    `- 榜单表现：${rankText}${weeksText}`,
    "",
    "#### 内容简介",
    "",
    model.summary,
    "",
    "#### 推荐理由",
    "",
    model.recommendation,
  );
  if (fact.review_link) lines.push("", `> 延伸阅读：[纽约时报书评](${fact.review_link})`);
  return lines.join("\n");
}

function composeSection(heading: string, models: NytBookModelItem[], facts: NytBookFact[]): string {
  if (!models.length) return "";
  if (models.length !== facts.length) {
    throw new Error(`nyt-books ${heading} model count does not match source count: ${models.length} vs ${facts.length}`);
  }
  const modelRanks = new Set(models.map(model => model.rank));
  if (modelRanks.size !== models.length) throw new Error(`nyt-books ${heading} model contains duplicate ranks`);
  const byRank = new Map(facts.map(fact => [fact.rank, fact]));
  const works = models.map(model => {
    const fact = byRank.get(model.rank);
    if (!fact) throw new Error(`nyt-books ${heading} model JSON references missing rank ${model.rank}`);
    return composeWork(model, fact);
  });
  return [`## ${heading}`, "", works.join("\n\n")].join("\n");
}

export function composeNytBooksBody(
  model: { fiction: NytBookModelItem[]; nonfiction: NytBookModelItem[] },
  facts: NytBookFacts,
): string {
  const sections = [composeSection("小说", model.fiction, facts.fiction), composeSection("非虚构", model.nonfiction, facts.nonfiction)].filter(Boolean);
  if (!sections.length) throw new Error("nyt-books produced no book sections");
  return `${sections.join("\n\n")}\n`;
}

export function nytBooksMarkdownFromModelJson(raw: string, source: string): string {
  const facts = parseNytBookFacts(source);
  const model = parseNytBookModelJson(raw);
  return composeNytBooksBody(model, facts);
}
