// Thin economist-specific wrappers over the generic magazine source pipeline.
import { parseArgs, stringArg, writeStderr, writeStdout } from "./blog_common.ts";
import { economistLedgerPath } from "./economist_weekly_ledger.ts";
import {
  buildMagazineWeeklySource,
  magazineConfig,
  MagazineIssueAlreadyArchivedError,
  MagazineIssueUnavailableError,
  parseMagazineEpub,
  renderMagazineSource,
  type MagazineArticle,
  type MagazineConfig,
  type MagazineParsedIssue,
} from "./magazine.ts";
import type { EconomistIssue } from "./economist_weekly_ledger.ts";

const CONFIG: MagazineConfig = magazineConfig("economist-weekly");

export const EconomistIssueUnavailableError = MagazineIssueUnavailableError;
export const EconomistIssueAlreadyArchivedError = MagazineIssueAlreadyArchivedError;

export type EconomistArticle = MagazineArticle;
export type EconomistParsedIssue = MagazineParsedIssue;

export function parseEconomistEpub(buffer: Buffer): EconomistParsedIssue {
  return parseMagazineEpub(buffer, CONFIG);
}

export function renderEconomistWeeklySource(issue: EconomistIssue, parsed: EconomistParsedIssue, issueUrl: string): string {
  return renderMagazineSource(CONFIG, issue, parsed, issueUrl);
}

export function buildEconomistWeeklySource(
  date: string,
  opts: { ledgerFile?: string; excludePostPath?: string; excludePostPathForIssueDate?: (issueDate: string) => string } = {},
): Promise<string> {
  return buildMagazineWeeklySource(CONFIG, date, opts);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const date = stringArg(args, "date", new Date().toISOString().slice(0, 10));
  writeStdout(await buildEconomistWeeklySource(date, { ledgerFile: stringArg(args, "ledger-file", economistLedgerPath()), excludePostPath: stringArg(args, "exclude-post-path") }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    writeStderr(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
