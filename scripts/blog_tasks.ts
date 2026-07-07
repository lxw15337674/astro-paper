import path from "node:path";
import { TOTAL_TAG } from "./blog_common.ts";

export type BlogTaskInfo = {
  titlePrefix: string;
  tag: string;
  description: string;
  fileName: string;
};

export const BLOG_TASKS = {
  "hn-top10": {
    titlePrefix: "HackerNews Top 10",
    tag: "HackerNews",
    description: "每日 Hacker News 热门文章 Top 10 中文整理，按当天归档并覆盖更新。",
    fileName: "hackernews-{date}.md",
  },
  "capital-market-daily": {
    titlePrefix: "资本市场日报",
    tag: "资本市场日报",
    description: "每日资本市场日报，一篇汇总美股、A股/港股与比特币三段行情，按交易日增量拼合。",
    fileName: "资本市场日报-{date}.md",
  },
  "github-trending-daily": {
    titlePrefix: "GitHub 项目日报",
    tag: "GitHub项目日报",
    description: "每日 GitHub Trending 项目中文整理，基于榜单元数据与 README 正文提炼开源项目趋势。",
    fileName: "GitHub项目日报-{date}.md",
  },
  "daily-podcasts": {
    titlePrefix: "每日播客笔记",
    tag: "播客",
    description: "每日海外 Podcasts 热门节目中文长文笔记。",
    fileName: "每日播客-{date}.md",
  },
  "xyzrank-top-episodes": {
    titlePrefix: "XYZ Rank 热门播客",
    tag: "中文播客榜",
    description: "每周 XYZ Rank 中文播客热门单集 Top 5 音频长文笔记。",
    fileName: "XYZRank热门播客-{date}.md",
  },
  "tech-daily": {
    titlePrefix: "技术日报",
    tag: "技术日报",
    description: "每日技术综合整理，基于文章级 AI 摘要动态聚合过去 24 小时的 AI、工程、安全、平台与科技商业变化。",
    fileName: "技术日报-{date}.md",
  },
  "mdblist-weekly": {
    titlePrefix: "每周影视推荐",
    tag: "每周影视推荐",
    description: "每周影视推荐专栏，基于 mdblist 聚合的 Trakt 趋势电影与剧集榜单，汇总本周值得看的作品并补充口碑观察。",
    fileName: "每周影视推荐-{date}.md",
  },
} as const satisfies Record<string, BlogTaskInfo>;

export type Task = keyof typeof BLOG_TASKS;
export type TaskInput = Task | "all";

export const TASKS = Object.keys(BLOG_TASKS) as Task[];

export const SCHEDULED_TASK_INPUTS: Record<string, { task: TaskInput; dateOffset?: number; dateTimeZone?: string }> = {
  "30 0 * * *": { task: "tech-daily", dateTimeZone: "America/Los_Angeles" },
  "30 1 * * *": { task: "daily-podcasts" },
  "0 6 * * *": { task: "hn-top10", dateTimeZone: "America/Los_Angeles" },
  "0 2 * * 1": { task: "xyzrank-top-episodes", dateTimeZone: "Asia/Shanghai" },
  // 资本市场日报：UTC 22:00 美股收盘后，一次性拉取全部市场数据、一次 AI 调用生成完整日报。
  "0 22 * * 1-5": { task: "capital-market-daily", dateTimeZone: "Asia/Shanghai" },
  "0 23 * * *": { task: "github-trending-daily", dateTimeZone: "America/Los_Angeles" },
  "0 2 * * 5": { task: "mdblist-weekly", dateTimeZone: "Asia/Shanghai" },
};

export function isTask(value: string): value is Task {
  return value in BLOG_TASKS;
}

export function isTaskInput(value: string): value is TaskInput {
  return value === "all" || isTask(value);
}

export function taskInfo(task: string): BlogTaskInfo {
  if (!isTask(task)) throw new Error(`unsupported task: ${task}`);
  return BLOG_TASKS[task];
}

export function taskTags(task: Task): string[] {
  return [TOTAL_TAG, taskInfo(task).tag];
}

export function taskTitle(task: Task, date: string): string {
  return `${taskInfo(task).titlePrefix}｜${date}`;
}

export function taskPostRelPath(task: Task, date: string): string {
  return path.join("src/content/posts/zh-cn", taskInfo(task).fileName.replace("{date}", date));
}

export function tasksForInput(input: TaskInput): Task[] {
  if (input === "all") return [...TASKS];
  return [input];
}

export function scheduledTaskInput(schedule: string): { task: TaskInput; dateOffset: number; dateTimeZone?: string } {
  const mapped = SCHEDULED_TASK_INPUTS[schedule];
  return { task: mapped?.task || "all", dateOffset: mapped?.dateOffset || 0, dateTimeZone: mapped?.dateTimeZone };
}
