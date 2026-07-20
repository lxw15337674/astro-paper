import fs from "node:fs";
import path from "node:path";
import { compact, ensureDir, repoRoot } from "./blog_common.ts";

export type EconomistIssue = {
  key: string;
  issueDate: string;
  sourceCommit: string;
  epubSha256: string;
};

export type ArchivedEconomistIssue = EconomistIssue & {
  archivedAt: string;
  postPath: string;
};

type EconomistLedger = { version: 1; issues: ArchivedEconomistIssue[] };

export const ECONOMIST_LEDGER_REL_PATH = "data/economist-weekly/issues.json";

export function economistLedgerPath(): string {
  return process.env.ECONOMIST_ISSUES_LEDGER_FILE || path.join(repoRoot(), ECONOMIST_LEDGER_REL_PATH);
}

export function economistIssueKey(issueDate: string, epubSha256: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) throw new Error(`invalid Economist issue date: ${issueDate}`);
  if (!/^[a-f0-9]{64}$/i.test(epubSha256)) throw new Error("invalid Economist EPUB SHA-256");
  return `economist:${issueDate}:${epubSha256.toLowerCase()}`;
}

function readLedger(file: string): EconomistLedger {
  if (!fs.existsSync(file)) return { version: 1, issues: [] };
  let parsed: Partial<EconomistLedger>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<EconomistLedger>;
  } catch (error) {
    throw new Error(`invalid Economist issue ledger ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.issues)) throw new Error(`invalid Economist issue ledger structure: ${file}`);
  for (const issue of parsed.issues) {
    if (
      issue.key !== economistIssueKey(issue.issueDate, issue.epubSha256) ||
      !compact(issue.sourceCommit) ||
      !compact(issue.archivedAt) ||
      !compact(issue.postPath)
    ) {
      throw new Error(`invalid Economist issue ledger entry: ${issue.key || "missing key"}`);
    }
  }
  return parsed as EconomistLedger;
}

export function hasArchivedEconomistIssue(issue: EconomistIssue, file = economistLedgerPath(), excludePostPath = ""): boolean {
  return readLedger(file).issues.some(entry => entry.key === issue.key && (!excludePostPath || entry.postPath !== excludePostPath));
}

export function appendEconomistIssue(issue: EconomistIssue, meta: { archivedAt: string; postPath: string }, file = economistLedgerPath()): void {
  if (issue.key !== economistIssueKey(issue.issueDate, issue.epubSha256)) throw new Error("Economist issue ledger key mismatch");
  const ledger = readLedger(file);
  ledger.issues = ledger.issues.filter(entry => entry.postPath !== meta.postPath && entry.key !== issue.key);
  ledger.issues.push({ ...issue, archivedAt: meta.archivedAt, postPath: meta.postPath });
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

export function parseEconomistIssueFromSource(source: string): EconomistIssue {
  const issueDate = source.match(/^- 刊期：(\d{4}-\d{2}-\d{2})$/m)?.[1] || "";
  const sourceCommit = source.match(/^- 来源提交：([a-f0-9]{40})$/im)?.[1] || "";
  const epubSha256 = source.match(/^- EPUB SHA-256：([a-f0-9]{64})$/im)?.[1] || "";
  return { key: economistIssueKey(issueDate, epubSha256), issueDate, sourceCommit, epubSha256 };
}
