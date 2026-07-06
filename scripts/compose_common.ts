// 各任务 compose 规则层共用的解析工具：source 编号块解析 + 模型 JSON 容错解析。
import { hasChinese, looksLowSignal } from "./astro_paper_archive.ts";

export { hasChinese, looksLowSignal };

export function extractBullets(block: string): string[] {
  return block
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("- "))
    .map(line => line.slice(2).trim());
}

export function bulletValue(bullets: string[], label: string): string {
  return bullets.find(bullet => bullet.startsWith(label))?.split("：").slice(1).join("：").trim() || "";
}

// 去掉模型可能裹上的 ```json 围栏，截取第一个 {...} 到最后一个 }。
export function stripJsonFence(raw: string): string {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return trimmed;
  return trimmed.slice(start, end + 1);
}

export function parseModelJsonObject(raw: string, label: string): Record<string, unknown> {
  try {
    return JSON.parse(stripJsonFence(raw)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${label} model output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
