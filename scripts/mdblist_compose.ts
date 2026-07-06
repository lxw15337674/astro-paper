// mdblist 每周影视规则层：模型只返回语义字段（中文译名/类型翻译/剧情/推荐/评论），
// 事实字段（原标题、海报 URL、IMDb 评分、上映日期）一律取自 source。
import { bulletValue, extractBullets, hasChinese, looksLowSignal, parseModelJsonObject } from "./compose_common.ts";

export type MdblistModelItem = {
  rank: number;
  title_zh: string;
  genres_zh: string;
  plot: string;
  recommendation: string;
  review: string;
};

export type MdblistFact = {
  rank: number;
  original_title: string;
  release_date: string;
  imdb_rating: string;
  poster: string;
};

type MdblistFacts = { movies: MdblistFact[]; series: MdblistFact[] };

function parseSectionFacts(sectionText: string): MdblistFact[] {
  const blocks = sectionText
    .split(/(?=^##\s+\d+\.\s+)/gm)
    .map(block => block.trim())
    .filter(block => /^##\s+\d+\.\s+/.test(block));
  return blocks.map((block, index) => {
    const bullets = extractBullets(block);
    const ratingText = bulletValue(bullets, "评分");
    const imdb = ratingText.match(/IMDb\s+([\d.]+)/i);
    return {
      rank: index + 1,
      original_title: bulletValue(bullets, "原标题") || block.match(/^##\s+\d+\.\s+(.+)$/m)?.[1]?.trim() || "",
      release_date: bulletValue(bullets, "上映日期"),
      imdb_rating: imdb ? imdb[1] : "",
      poster: bulletValue(bullets, "海报"),
    };
  });
}

// source 分「# 电影候选」「# 剧集候选」两段。
export function parseMdblistFacts(source: string): MdblistFacts {
  const movieMatch = source.indexOf("# 电影候选");
  const seriesMatch = source.indexOf("# 剧集候选");
  const movieText = movieMatch >= 0 ? source.slice(movieMatch, seriesMatch >= 0 ? seriesMatch : undefined) : "";
  const seriesText = seriesMatch >= 0 ? source.slice(seriesMatch) : "";
  return { movies: parseSectionFacts(movieText), series: parseSectionFacts(seriesText) };
}

function formatReleaseDate(raw: string): string {
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return raw || "未标明";
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
}

function validateModelItems(rawItems: unknown, label: string): MdblistModelItem[] {
  if (rawItems === undefined) return [];
  if (!Array.isArray(rawItems)) throw new Error(`mdblist model JSON ${label} must be an array`);
  return rawItems.map((entry, index) => {
    const item = (entry || {}) as Record<string, unknown>;
    const rank = Number(item.rank);
    if (!Number.isInteger(rank) || rank < 1) throw new Error(`mdblist ${label} item ${index + 1} has invalid rank: ${String(item.rank)}`);
    const titleZh = String(item.title_zh || "").trim();
    if (!titleZh || !hasChinese(titleZh)) throw new Error(`mdblist ${label} rank ${rank} title_zh should use a Chinese title: ${titleZh}`);
    const genresZh = String(item.genres_zh || "").trim();
    const plot = String(item.plot || "").trim();
    const recommendation = String(item.recommendation || "").trim();
    const review = String(item.review || "").trim();
    if (!genresZh) throw new Error(`mdblist ${label} rank ${rank} is missing genres_zh`);
    for (const [field, value] of [["plot", plot], ["recommendation", recommendation], ["review", review]] as const) {
      if (!value || looksLowSignal(value)) throw new Error(`mdblist ${label} rank ${rank} has empty or low-signal ${field}`);
    }
    return { rank, title_zh: titleZh, genres_zh: genresZh, plot, recommendation, review };
  });
}

export function parseMdblistModelJson(raw: string): { movies: MdblistModelItem[]; series: MdblistModelItem[] } {
  const parsed = parseModelJsonObject(raw, "mdblist");
  const movies = validateModelItems(parsed.movies, "movies");
  const series = validateModelItems(parsed.series, "series");
  if (movies.length + series.length < 4) throw new Error(`mdblist model JSON needs at least four works, got ${movies.length + series.length}`);
  return { movies, series };
}

function composeWork(model: MdblistModelItem, fact: MdblistFact): string {
  const lines = [`### ${model.title_zh}（${fact.original_title}）`, ""];
  if (fact.poster && fact.poster !== "-") lines.push(`![${model.title_zh}](${fact.poster})`, "");
  lines.push(
    "#### 基本信息",
    "",
    `- 类型：${model.genres_zh}`,
    `- 上映日期：${formatReleaseDate(fact.release_date)}`,
    `- IMDb 评分：${fact.imdb_rating || "未标明"}`,
    "",
    "#### 剧情概要",
    "",
    model.plot,
    "",
    "#### 推荐理由",
    "",
    model.recommendation,
    "",
    "#### 评论总结",
    "",
    model.review,
  );
  return lines.join("\n");
}

function composeSection(heading: string, models: MdblistModelItem[], facts: MdblistFact[]): string {
  const byRank = new Map(facts.map(fact => [fact.rank, fact]));
  const works = models.map(model => {
    const fact = byRank.get(model.rank);
    if (!fact) throw new Error(`mdblist ${heading} model JSON references missing rank ${model.rank}`);
    return composeWork(model, fact);
  });
  return [`## ${heading}`, "", works.join("\n\n")].join("\n");
}

export function composeMdblistBody(
  model: { movies: MdblistModelItem[]; series: MdblistModelItem[] },
  facts: MdblistFacts,
): string {
  const movies = composeSection("电影推荐", model.movies, facts.movies);
  const series = composeSection("剧集推荐", model.series, facts.series);
  return `${movies}\n\n${series}\n`;
}

export function mdblistMarkdownFromModelJson(raw: string, source: string): string {
  const facts = parseMdblistFacts(source);
  const model = parseMdblistModelJson(raw);
  return composeMdblistBody(model, facts);
}
