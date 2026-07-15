// 每周图书推荐的分节与榜源集中配置，供 source / compose / ledger 共用，避免多文件漂移。
// key：模型 JSON 数组名与 ledger listType；label：正文小节与候选源标题；lists：该节聚合的 NYT 榜（overview 内的 list_name_encoded）。
export type NytBookSection = { key: string; label: string; lists: string[] };

export const NYT_BOOK_SECTIONS: NytBookSection[] = [
  {
    key: "fiction",
    label: "小说",
    lists: ["combined-print-and-e-book-fiction", "hardcover-fiction", "trade-fiction-paperback"],
  },
  {
    key: "nonfiction",
    label: "非虚构",
    lists: [
      "combined-print-and-e-book-nonfiction",
      "hardcover-nonfiction",
      "paperback-nonfiction-monthly",
      "advice-how-to-and-miscellaneous",
      "business-books",
    ],
  },
  {
    key: "young_adult",
    label: "青少年",
    lists: ["young-adult-hardcover", "young-adult-paperback-monthly", "series-books"],
  },
  {
    key: "graphic",
    label: "图像小说与漫画",
    lists: ["graphic-books-and-manga"],
  },
];

export function sectionByLabel(label: string): NytBookSection {
  const section = NYT_BOOK_SECTIONS.find(entry => entry.label === label);
  if (!section) throw new Error(`unknown NYT books section label: ${label || "missing"}`);
  return section;
}

export function sectionKeys(): string[] {
  return NYT_BOOK_SECTIONS.map(section => section.key);
}
