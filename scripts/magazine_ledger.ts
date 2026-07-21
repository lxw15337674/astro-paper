import fs from "node:fs";
import path from "node:path";
import { compact, ensureDir, repoRoot } from "./blog_common.ts";

export type MagazineIssue = {
  key: string;
  issueDate: string;
  sourceCommit: string;
  epubSha256: string;
};

export type ArchivedMagazineIssue = MagazineIssue & {
  archivedAt: string;
  postPath: string;
};

type MagazineLedger = { version: 1; issues: ArchivedMagazineIssue[] };

export function magazineLedgerRelPath(slug: string): string {
  return `data/${slug}/issues.json`;
}

export function magazineLedgerPath(slug: string, envOverride = ""): string {
  return (envOverride && process.env[envOverride]) || path.join(repoRoot(), magazineLedgerRelPath(slug));
}

export function magazineIssueKey(keyPrefix: string, issueDate: string, epubSha256: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) throw new Error(`invalid ${keyPrefix} issue date: ${issueDate}`);
  if (!/^[a-f0-9]{64}$/i.test(epubSha256)) throw new Error(`invalid ${keyPrefix} EPUB SHA-256`);
  return `${keyPrefix}:${issueDate}:${epubSha256.toLowerCase()}`;
}

function readLedger(file: string, keyPrefix: string): MagazineLedger {
  if (!fs.existsSync(file)) return { version: 1, issues: [] };
  let parsed: Partial<MagazineLedger>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<MagazineLedger>;
  } catch (error) {
    throw new Error(`invalid ${keyPrefix} issue ledger ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.issues)) throw new Error(`invalid ${keyPrefix} issue ledger structure: ${file}`);
  for (const issue of parsed.issues) {
    if (
      issue.key !== magazineIssueKey(keyPrefix, issue.issueDate, issue.epubSha256) ||
      !compact(issue.sourceCommit) ||
      !compact(issue.archivedAt) ||
      !compact(issue.postPath)
    ) {
      throw new Error(`invalid ${keyPrefix} issue ledger entry: ${issue.key || "missing key"}`);
    }
  }
  return parsed as MagazineLedger;
}

export function hasArchivedMagazineIssue(issue: MagazineIssue, keyPrefix: string, file: string, excludePostPath = ""): boolean {
  return readLedger(file, keyPrefix).issues.some(entry => entry.key === issue.key && (!excludePostPath || entry.postPath !== excludePostPath));
}

export function appendMagazineIssue(issue: MagazineIssue, keyPrefix: string, meta: { archivedAt: string; postPath: string }, file: string): void {
  if (issue.key !== magazineIssueKey(keyPrefix, issue.issueDate, issue.epubSha256)) throw new Error(`${keyPrefix} issue ledger key mismatch`);
  const ledger = readLedger(file, keyPrefix);
  ledger.issues = ledger.issues.filter(entry => entry.postPath !== meta.postPath && entry.key !== issue.key);
  ledger.issues.push({ ...issue, archivedAt: meta.archivedAt, postPath: meta.postPath });
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

export function parseMagazineIssueFromSource(source: string, keyPrefix: string): MagazineIssue {
  const issueDate = source.match(/^- 刊期：(\d{4}-\d{2}-\d{2})$/m)?.[1] || "";
  const sourceCommit = source.match(/^- 来源提交：([a-f0-9]{40})$/im)?.[1] || "";
  const epubSha256 = source.match(/^- EPUB SHA-256：([a-f0-9]{64})$/im)?.[1] || "";
  return { key: magazineIssueKey(keyPrefix, issueDate, epubSha256), issueDate, sourceCommit, epubSha256 };
}
