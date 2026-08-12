export const RELEASE_INFO_SCHEMA = "atlcli.release-info/v1" as const;

export type ReleaseBuildChannel = "stable" | "dev" | "source";

export interface ReleaseInfoV1 {
  schema: typeof RELEASE_INFO_SCHEMA;
  version: string;
  channel: ReleaseBuildChannel;
  sourceSha: string;
  buildId: string;
  releaseTag: string | null;
  homebrewVersion: string | null;
}

export interface ReleaseInfoInput {
  version: string;
  channel: ReleaseBuildChannel;
  sourceSha: string;
  buildId: string;
  releaseTag?: string | null;
  homebrewVersion?: string | null;
}

declare const __ATLCLI_VERSION__: string;
declare const __ATLCLI_RELEASE_CHANNEL__: string;
declare const __ATLCLI_SOURCE_SHA__: string;
declare const __ATLCLI_BUILD_ID__: string;
declare const __ATLCLI_RELEASE_TAG__: string;
declare const __ATLCLI_HOMEBREW_VERSION__: string;

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;

export function createReleaseInfo(input: ReleaseInfoInput): ReleaseInfoV1 {
  if (!input.version) throw new Error("release version must not be empty");
  if (!input.buildId) throw new Error("release buildId must not be empty");
  if (
    input.sourceSha !== "unknown" &&
    !FULL_SHA_PATTERN.test(input.sourceSha)
  ) {
    throw new Error("release sourceSha must be a lowercase 40-character Git SHA or unknown");
  }
  if (input.channel === "dev" && input.sourceSha === "unknown") {
    throw new Error("dev release identity requires a full source SHA");
  }
  return {
    schema: RELEASE_INFO_SCHEMA,
    version: input.version,
    channel: input.channel,
    sourceSha: input.sourceSha,
    buildId: input.buildId,
    releaseTag: input.releaseTag || null,
    homebrewVersion: input.homebrewVersion || null,
  };
}

/**
 * Read the compile-time identity injected by the release builder.
 *
 * Older stable build commands only injected `__ATLCLI_VERSION__`. They retain
 * their stable version behavior while honestly reporting unknown provenance;
 * the new release builder injects every field and is verified fail-closed.
 */
export function getReleaseInfo(): ReleaseInfoV1 {
  const version = typeof __ATLCLI_VERSION__ !== "undefined" ? __ATLCLI_VERSION__ : "dev";
  const injectedChannel =
    typeof __ATLCLI_RELEASE_CHANNEL__ !== "undefined" ? __ATLCLI_RELEASE_CHANNEL__ : undefined;
  const channel: ReleaseBuildChannel =
    injectedChannel === "stable" || injectedChannel === "dev" || injectedChannel === "source"
      ? injectedChannel
      : version === "dev"
        ? "source"
        : "stable";
  const sourceSha =
    typeof __ATLCLI_SOURCE_SHA__ !== "undefined" && __ATLCLI_SOURCE_SHA__
      ? __ATLCLI_SOURCE_SHA__
      : "unknown";
  const buildId =
    typeof __ATLCLI_BUILD_ID__ !== "undefined" && __ATLCLI_BUILD_ID__
      ? __ATLCLI_BUILD_ID__
      : channel === "stable"
        ? `v${version}`
        : "source";

  return createReleaseInfo({
    version,
    channel,
    sourceSha,
    buildId,
    releaseTag:
      typeof __ATLCLI_RELEASE_TAG__ !== "undefined" ? __ATLCLI_RELEASE_TAG__ : null,
    homebrewVersion:
      typeof __ATLCLI_HOMEBREW_VERSION__ !== "undefined"
        ? __ATLCLI_HOMEBREW_VERSION__
        : null,
  });
}

export function getCurrentVersion(): string {
  return getReleaseInfo().version;
}
