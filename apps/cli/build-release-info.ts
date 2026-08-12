import {
  createReleaseInfo,
  type ReleaseBuildChannel,
  type ReleaseInfoV1,
} from "../../packages/core/src/release-info.js";

export interface BuildReleaseEnvironment {
  ATLCLI_RELEASE_CHANNEL?: string;
  ATLCLI_RELEASE_VERSION?: string;
  ATLCLI_SOURCE_SHA?: string;
  ATLCLI_BUILD_ID?: string;
  ATLCLI_RELEASE_TAG?: string;
  ATLCLI_HOMEBREW_VERSION?: string;
}

export function resolveBuildReleaseInfo(input: {
  environment: BuildReleaseEnvironment;
  rootVersion: string;
  gitSha: string;
}): ReleaseInfoV1 {
  // Stable remains the compatibility default for the existing release builder.
  // Dev must always opt in and provide its complete immutable identity.
  const channelValue = input.environment.ATLCLI_RELEASE_CHANNEL ?? "stable";
  if (channelValue !== "stable" && channelValue !== "dev" && channelValue !== "source") {
    throw new Error(`Invalid ATLCLI_RELEASE_CHANNEL: ${channelValue}`);
  }
  const channel: ReleaseBuildChannel = channelValue;
  const version = input.environment.ATLCLI_RELEASE_VERSION ?? input.rootVersion;
  return createReleaseInfo({
    version,
    channel,
    sourceSha: input.environment.ATLCLI_SOURCE_SHA ?? input.gitSha,
    buildId:
      input.environment.ATLCLI_BUILD_ID ??
      (channel === "stable" ? `v${input.rootVersion}` : channel === "source" ? "source" : ""),
    releaseTag:
      input.environment.ATLCLI_RELEASE_TAG ??
      (channel === "stable" ? `v${input.rootVersion}` : null),
    homebrewVersion:
      input.environment.ATLCLI_HOMEBREW_VERSION ??
      (channel === "stable" ? input.rootVersion : null),
  });
}
