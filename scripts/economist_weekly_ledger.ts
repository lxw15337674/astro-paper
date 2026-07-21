// Thin economist-specific wrappers over the generic magazine ledger.
import {
  appendMagazineIssue,
  hasArchivedMagazineIssue,
  magazineIssueKey,
  magazineLedgerPath,
  magazineLedgerRelPath,
  parseMagazineIssueFromSource,
  type ArchivedMagazineIssue,
  type MagazineIssue,
} from "./magazine_ledger.ts";

const SLUG = "economist-weekly";
const KEY_PREFIX = "economist";
const LEDGER_ENV = "ECONOMIST_ISSUES_LEDGER_FILE";

export type EconomistIssue = MagazineIssue;
export type ArchivedEconomistIssue = ArchivedMagazineIssue;

export const ECONOMIST_LEDGER_REL_PATH = magazineLedgerRelPath(SLUG);

export function economistLedgerPath(): string {
  return magazineLedgerPath(SLUG, LEDGER_ENV);
}

export function economistIssueKey(issueDate: string, epubSha256: string): string {
  return magazineIssueKey(KEY_PREFIX, issueDate, epubSha256);
}

export function hasArchivedEconomistIssue(issue: EconomistIssue, file = economistLedgerPath(), excludePostPath = ""): boolean {
  return hasArchivedMagazineIssue(issue, KEY_PREFIX, file, excludePostPath);
}

export function appendEconomistIssue(issue: EconomistIssue, meta: { archivedAt: string; postPath: string }, file = economistLedgerPath()): void {
  appendMagazineIssue(issue, KEY_PREFIX, meta, file);
}

export function parseEconomistIssueFromSource(source: string): EconomistIssue {
  return parseMagazineIssueFromSource(source, KEY_PREFIX);
}
