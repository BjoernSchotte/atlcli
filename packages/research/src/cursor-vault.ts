import { ResearchContractError, type ResearchToolId } from "./contracts.js";

interface CursorRecord {
  tool: ResearchToolId;
  queryFingerprint: string;
  providerCursor: string;
  expiresAt: number;
  /**
   * Provider cursors are only meaningful relative to one pagination chain.
   * Two concurrent, identical first-page searches may legitimately receive
   * the same native next cursor, while a repeated cursor after consuming a
   * prior token is a provider loop.
   */
  chain: ResearchCursorChain;
}

export interface ResearchCursorChain {
  readonly seenProviderCursorKeys: readonly string[];
}

export interface ResearchCursorResolution {
  queryFingerprint: string;
  providerCursor: string;
  chain: ResearchCursorChain;
}

export interface ResearchCursorVaultOptions {
  maxEntries?: number;
  createId?: () => string;
  now?: () => number;
  ttlMs?: number;
}

/**
 * Per-run indirection for provider cursors.
 *
 * Confluence may return a complete `_links.next` URL. That URL must never
 * become a guest-controlled fetch target, so QuickJS sees only the opaque key
 * produced here. A new vault is created for every research run.
 */
export class ResearchCursorVault {
  readonly #maxEntries: number;
  readonly #createId: () => string;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #records = new Map<string, CursorRecord>();
  #issued = 0;

  constructor(options: ResearchCursorVaultOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 256;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#createId =
      options.createId ??
      (() => {
        if (typeof crypto?.randomUUID !== "function") {
          throw new ResearchContractError("unknown", "Secure cursor IDs are unavailable.");
        }
        return crypto.randomUUID();
      });
  }

  issue(
    tool: ResearchToolId,
    queryFingerprint: string,
    providerCursor: string | undefined,
    previousChain?: ResearchCursorChain,
  ): string | undefined {
    if (!providerCursor) return undefined;
    if (this.#issued >= this.#maxEntries) {
      throw new ResearchContractError("limit-exceeded", "The cursor budget was exhausted.");
    }
    const providerKey = `${tool}\u0000${queryFingerprint}\u0000${providerCursor}`;
    if (previousChain?.seenProviderCursorKeys.includes(providerKey)) {
      throw new ResearchContractError(
        "provider-error",
        "The provider returned a repeated pagination cursor."
      );
    }
    const token = `research-cursor:${this.#createId()}`;
    if (this.#records.has(token)) {
      throw new ResearchContractError("unknown", "A secure cursor id was reused.");
    }
    this.#issued += 1;
    this.#records.set(token, {
      tool,
      queryFingerprint,
      providerCursor,
      expiresAt: this.#now() + this.#ttlMs,
      chain: {
        seenProviderCursorKeys: [
          ...(previousChain?.seenProviderCursorKeys ?? []),
          providerKey,
        ],
      },
    });
    return token;
  }

  resolve(
    tool: ResearchToolId,
    token: string | undefined
  ): ResearchCursorResolution | undefined {
    if (token === undefined) return undefined;
    const record = this.#records.get(token);
    if (
      !record ||
      record.tool !== tool ||
      record.expiresAt < this.#now()
    ) {
      this.#records.delete(token);
      throw new ResearchContractError(
        "invalid-request",
        "The pagination cursor is unknown or belongs to another capability query."
      );
    }
    this.#records.delete(token);
    return {
      queryFingerprint: record.queryFingerprint,
      providerCursor: record.providerCursor,
      chain: record.chain,
    };
  }

  clear(): void {
    this.#records.clear();
  }
}
