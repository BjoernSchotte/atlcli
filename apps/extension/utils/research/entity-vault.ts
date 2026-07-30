import { ResearchContractError } from "./contracts.js";

export type ResearchEntityKind = "jira" | "wiki";

export interface ResearchEntityRecord {
  kind: ResearchEntityKind;
  entityId: string;
  projectKey?: string;
  spaceKey?: string;
}

export interface ResearchEntityVaultOptions {
  maxEntries: number;
  createId?: () => string;
}

/**
 * Search-before-get enforcement for one run.
 *
 * A guest can read details only through an opaque ref issued for a scoped
 * search hit. Raw Jira keys and Confluence content ids are never accepted by a
 * detail capability.
 */
export class ResearchEntityVault {
  readonly #maxEntries: number;
  readonly #createId: () => string;
  readonly #records = new Map<string, ResearchEntityRecord>();

  constructor(options: ResearchEntityVaultOptions) {
    this.#maxEntries = options.maxEntries;
    this.#createId =
      options.createId ??
      (() => {
        if (typeof crypto?.randomUUID !== "function") {
          throw new ResearchContractError("unknown", "Secure entity refs are unavailable.");
        }
        return crypto.randomUUID();
      });
  }

  issue(record: ResearchEntityRecord): string {
    if (this.#records.size >= this.#maxEntries) {
      throw new ResearchContractError("limit-exceeded", "The entity-ref budget was exhausted.");
    }
    const ref = `research-entity:${this.#createId()}`;
    if (this.#records.has(ref)) {
      throw new ResearchContractError("unknown", "A secure entity ref was reused.");
    }
    this.#records.set(ref, { ...record });
    return ref;
  }

  resolve(kind: ResearchEntityKind, ref: string): ResearchEntityRecord {
    const record = this.#records.get(ref);
    if (!record || record.kind !== kind) {
      throw new ResearchContractError(
        "invalid-request",
        "The entity reference is unknown or belongs to another capability."
      );
    }
    return { ...record };
  }

  clear(): void {
    this.#records.clear();
  }
}
