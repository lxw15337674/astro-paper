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
  "asia-market-daily": {
    titlePrefix: "亚洲市场日报",
    tag: "亚洲市场日报",
    description: "每日 A股与港股市场日报，按北京时间自然日汇总主要指数、成交与板块结构。",
    fileName: "亚洲市场日报-{date}.md",
  },
  "crypto-market-daily": {
    titlePrefix: "比特币日报",
    tag: "比特币日报",
    description: "每日比特币市场日报，汇总 BTC 现货、永续、期权保护结构、情绪与风险边界。",
    fileName: "比特币日报-{date}.md",
  },
  "us-market-daily": {
    titlePrefix: "美股市场日报",
    tag: "美股市场日报",
    description: "每日美股市场日报，按完整常规收盘口径汇总主要指数与行业板块结构。",
    fileName: "美股市场日报-{date}.md",
  },
  "github-trending-daily": {
    titlePrefix: "GitHub 项目日报",
    tag: "GitHub项目日报",
    description: "每日 GitHub Trending 项目中文整理，基于榜单元数据与 README 摘录提炼开源项目趋势。",
    fileName: "GitHub项目日报-{date}.md",
  },
  "foreign-tech-podcast": {
    titlePrefix: "海外科技访谈播客笔记",
    tag: "海外科技播客",
    description: "每日海外科技访谈播客中文长文笔记，整理技术、产品、产业与职业判断。",
    fileName: "海外科技播客-{date}.md",
  },
  "tech-weekly": {
    titlePrefix: "技术趋势与工程观察",
    tag: "技术周刊",
    description: "每周技术趋势与工程观察，覆盖全技术领域的事件、工具、版本、安全与工程实践变化，不做纯教程搬运。",
    fileName: "技术周刊-{date}.md",
  },
  "ai-weekly": {
    titlePrefix: "AI 周刊",
    tag: "AI周刊",
    description: "每周 AI 模型、Agent、AI infra、安全评测与企业落地观察，过滤融资、营销、工具榜单和纯论文导读。",
    fileName: "AI周刊-{date}.md",
  },
  "tech-business-weekly": {
    titlePrefix: "科技商业观察周刊",
    tag: "科技商业观察",
    description: "每周科技商业观察，覆盖科技公司、平台政策、AI/芯片/云、监管、安全事件、开源生态与商业落地。",
    fileName: "科技商业观察-{date}.md",
  },
  "tech-daily": {
    titlePrefix: "技术工程日报",
    tag: "技术工程日报",
    description: "每日技术工程深度整理，覆盖过去 24 小时的工程实践、开源项目、版本、安全、架构与工具链变化。",
    fileName: "技术工程日报-{date}.md",
  },
  "ai-daily": {
    titlePrefix: "AI 工程日报",
    tag: "AI工程日报",
    description: "每日 AI 工程深度整理，覆盖过去 24 小时的模型、Agent、AI infra、评测、安全治理与企业落地。",
    fileName: "AI工程日报-{date}.md",
  },
  "tech-business-daily": {
    titlePrefix: "科技商业观察日报",
    tag: "科技商业观察日报",
    description: "每日科技商业观察，覆盖过去 24 小时的科技公司、平台政策、监管、安全事件、芯片/云供应链与产业竞争。",
    fileName: "科技商业观察日报-{date}.md",
  },
} as const satisfies Record<string, BlogTaskInfo>;

export type Task = keyof typeof BLOG_TASKS;
export type TaskInput = Task | "all" | "daily-digests";

export const TASKS = Object.keys(BLOG_TASKS) as Task[];
export const DAILY_DIGEST_TASKS = ["tech-daily", "ai-daily", "tech-business-daily"] as const satisfies readonly Task[];
export const SOURCE_LINK_WHITELIST_TASKS = new Set<Task>(["tech-business-weekly", ...DAILY_DIGEST_TASKS]);

export const SCHEDULED_TASK_INPUTS: Record<string, { task: TaskInput; dateOffset?: number }> = {
  "30 0 * * *": { task: "daily-digests" },
  "30 1 * * *": { task: "foreign-tech-podcast" },
  "30 9 * * *": { task: "hn-top10" },
  "0 14 * * *": { task: "asia-market-daily" },
  "0 17 * * *": { task: "crypto-market-daily", dateOffset: -1 },
  "30 22 * * *": { task: "us-market-daily", dateOffset: -1 },
  "0 23 * * *": { task: "github-trending-daily" },
};

export function isTask(value: string): value is Task {
  return value in BLOG_TASKS;
}

export function isTaskInput(value: string): value is TaskInput {
  return value === "all" || value === "daily-digests" || isTask(value);
}

export function isDailyDigestTask(task: string): task is (typeof DAILY_DIGEST_TASKS)[number] {
  return (DAILY_DIGEST_TASKS as readonly string[]).includes(task);
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
  if (input === "daily-digests") return [...DAILY_DIGEST_TASKS];
  return [input];
}

export function scheduledTaskInput(schedule: string): { task: TaskInput; dateOffset: number } {
  const mapped = SCHEDULED_TASK_INPUTS[schedule];
  return { task: mapped?.task || "all", dateOffset: mapped?.dateOffset || 0 };
}
