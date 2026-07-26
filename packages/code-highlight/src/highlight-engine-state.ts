import type { RegexEngine } from "shiki/core";

/**
 * Host-owned RegExp engine factory. Concrete engine modules live behind
 * separate package subpaths so a browser bundler never discovers Oniguruma.
 */
export interface CodeHighlightEngine {
  readonly id: string;
  create(): RegexEngine | Promise<RegexEngine>;
}

export class CodeHighlightEngineConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeHighlightEngineConfigurationError";
  }
}

let installedEngine: CodeHighlightEngine | null = null;
let engineLocked = false;

/**
 * Install the host's engine before the first highlighter use.
 *
 * Reinstalling the same engine is idempotent. A host may replace a provisional
 * registration before first use, but caches bind the choice permanently as
 * soon as initialization starts.
 */
export function installCodeHighlightEngine(engine: CodeHighlightEngine): void {
  if (!engine.id.trim()) {
    throw new CodeHighlightEngineConfigurationError(
      "The code-highlighting engine must have a stable non-empty id.",
    );
  }
  if (engineLocked && installedEngine?.id !== engine.id) {
    throw new CodeHighlightEngineConfigurationError(
      `Cannot switch the code-highlighting engine from '${installedEngine?.id ?? "unconfigured"}' to '${engine.id}' after first use.`,
    );
  }
  if (installedEngine?.id === engine.id) return;
  installedEngine = engine;
}

/** Diagnostic identity of the host-selected engine without initializing it. */
export function getCodeHighlightEngineId(): string | null {
  return installedEngine?.id ?? null;
}

/** Lock and return the configured engine when highlighter initialization begins. */
export function lockCodeHighlightEngine(): CodeHighlightEngine {
  engineLocked = true;
  if (!installedEngine) {
    throw new CodeHighlightEngineConfigurationError(
      "No code-highlighting engine is installed. Import a browser or Node runtime entry before highlighting.",
    );
  }
  return installedEngine;
}
