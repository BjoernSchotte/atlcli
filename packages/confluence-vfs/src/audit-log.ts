/**
 * The write audit log (WP5.10).
 *
 * Every write operation, successful or not, appends one JSONL line. Two reasons
 * it is not optional:
 *
 *  - An agent editing Confluence through a shell can change a lot of pages in a
 *    few seconds. "What did it touch?" has to be answerable afterwards, by a
 *    human, without replaying the session.
 *  - The `ro` default is only credible if breaking it leaves a trace.
 *
 * The log records **what was touched, never what was written**: page ids,
 * versions and paths, never bodies and never credentials. A log that quoted
 * page content would itself become a copy of the space, which section 1b
 * forbids, and a log that quoted headers would leak a token.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { WriteOp } from "./mode.js";

export interface AuditEntry {
  ts: string;
  profile: string;
  accountId: string;
  op: WriteOp | "conflict";
  path: string;
  pageId?: string;
  fromVersion?: number;
  toVersion?: number;
  /** For renames and moves. */
  target?: string;
  result: "ok" | "error";
  /** The VfsError code, never a message that might quote content. */
  errorCode?: string;
}

/** Rotates at ten megabytes, keeping one previous file. */
const MAX_BYTES = 10 * 1024 * 1024;

export class AuditLog {
  constructor(
    private readonly file: string,
    private readonly profile: string,
    private readonly accountId: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  record(entry: Omit<AuditEntry, "ts" | "profile" | "accountId">): void {
    const line: AuditEntry = {
      ts: new Date(this.now()).toISOString(),
      profile: this.profile,
      accountId: this.accountId,
      ...entry,
    };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      this.rotateIfNeeded();
      appendFileSync(this.file, `${JSON.stringify(line)}\n`);
    } catch {
      // A failed audit write must never fail the operation being audited: the
      // page change already happened, and throwing here would misreport it.
    }
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.file)) return;
    if (statSync(this.file).size < MAX_BYTES) return;
    renameSync(this.file, `${this.file}.1`);
  }
}
