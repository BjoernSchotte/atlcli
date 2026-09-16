/**
 * Pure, browser-safe type declarations shared across the isomorphic core.
 *
 * This module MUST have zero imports so it can be resolved by a browser
 * bundler without dragging any Node-only code into the graph.
 */

export type AuthType = "apiToken" | "bearer" | "oauth" | "session";

export type DeploymentType = "cloud" | "data-center";

export type AuthConfig = {
  type: AuthType;
  // Basic auth (Cloud)
  email?: string;
  token?: string;
  // Bearer auth (Server/Data Center)
  pat?: string;
  username?: string; // For keychain lookup
  // OAuth (future)
  clientId?: string;
};

export type Profile = {
  name: string;
  baseUrl: string;
  /** Atlassian hosting model. Optional for backwards compatibility with existing profiles. */
  deploymentType?: DeploymentType;
  auth: AuthConfig;
  cloudId?: string;
  /** Profile-specific Jira project key */
  project?: string;
  /** Profile-specific Confluence space key */
  space?: string;
  /** Profile-specific Jira board ID */
  board?: number;
  /** Path to a custom CA certificate file (PEM format) for self-signed/private CA certificates */
  tlsCaFile?: string;
  /** Skip TLS certificate verification. Not recommended for production use. */
  tlsSkipVerify?: boolean;
  /**
   * Virtual filesystem settings for this profile, overriding the global ones.
   * Typed as a record rather than importing `VfsConfig` because `config.ts`
   * already imports this module, and the other direction would be a cycle.
   */
  vfs?: {
    cacheDir?: string;
    mode?: "ro" | "rw";
    spaces?: string[];
    cacheMaxMb?: number;
    prefetchMaxPages?: number;
    cqlGrep?: boolean;
  };
};
