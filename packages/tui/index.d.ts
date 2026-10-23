/**
 * The public face of `@atlcli/tui`, hand-written so that importers (the CLI)
 * typecheck without OpenTUI's declarations, which need `skipLibCheck`. The
 * `types` condition points here; Bun resolves `development`/`default` to
 * `src/`. `src/facade.test.ts` checks that the implementation matches.
 */
import type { JiraClient } from "@atlcli/jira";
import type { ConfluenceClient } from "@atlcli/confluence";

export type TuiArea = "jira" | "wiki";

/** `tui` in `~/.atlcli/config.json`. */
export interface TuiConfig {
  /** Start area (default `jira`). */
  area?: TuiArea;
  /** Colors (default `dark`). */
  theme?: "dark" | "light";
  /** Extra or replacement keys per command id, e.g. `{ "jira.transition": ["t", "ctrl+t"] }`. */
  keymap?: Record<string, string[]>;
  /** Issue list columns, in order; the summary always comes last. Default: key, status, assignee. */
  columns?: TuiColumn[];
}

export type TuiColumn = "key" | "type" | "status" | "priority" | "assignee" | "updated";

export interface TuiOptions {
  /** Profile name, shown in the header. */
  profile: string;
  /** Site base URL without trailing slash, for browse links. */
  siteUrl: string;
  jira: JiraClient;
  confluence: ConfluenceClient;
  /** Start area; overrides `config.area`. */
  area?: TuiArea;
  /** Initial Jira list; default: my open issues. */
  jql?: string;
  /** Default project and board (`atlcli config`), preselected in the navigator. */
  project?: string;
  board?: number;
  /** Default Confluence space. */
  space?: string;
  /** Statuses `flow.statusMap` counts as done although Jira's category is not Done ("Fertig"). */
  doneStatuses?: string[];
  config?: TuiConfig;
  openUrl(url: string): Promise<void>;
  /** Edits text in `$VISUAL`/`$EDITOR`; the TUI suspends while it runs. */
  editText(initial: string, fileName: string): Promise<string>;
}

/** Runs the TUI until the user quits, then restores the terminal. */
export declare function runTui(options: TuiOptions): Promise<void>;

/** Draws the shell once without a terminal or network and returns the frame; throws if it cannot. */
export declare function selfTest(): Promise<string>;
