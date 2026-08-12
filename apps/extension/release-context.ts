export type ExtensionBuildChannel = "stable" | "dev" | "source";

export interface ExtensionReleaseEnvironment {
  [name: string]: string | undefined;
  ATLCLI_RELEASE_CHANNEL?: string;
  ATLCLI_SOURCE_SHA?: string;
  ATLCLI_BUILD_ID?: string;
  ATLCLI_EXTENSION_VERSION?: string;
  ATLCLI_EXTENSION_VERSION_NAME?: string;
}

export interface ExtensionReleaseContext {
  channel: ExtensionBuildChannel;
  sourceSha: string;
  buildId: string;
  version: string;
  versionName: string;
  artifactName: string;
}

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const ASSET_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateChromeExtensionVersion(version: string): string {
  const parts = version.split(".");
  if (parts.length < 1 || parts.length > 4) {
    throw new Error(`Chrome extension version must contain 1 to 4 components: ${version}`);
  }
  for (const part of parts) {
    if (!/^(0|[1-9]\d*)$/.test(part) || Number(part) > 65535) {
      throw new Error(`Chrome extension version component must be 0..65535: ${version}`);
    }
  }
  return version;
}

export function resolveExtensionReleaseContext(
  environment: ExtensionReleaseEnvironment,
): ExtensionReleaseContext {
  const channelValue = environment.ATLCLI_RELEASE_CHANNEL ?? "source";
  if (channelValue !== "stable" && channelValue !== "dev" && channelValue !== "source") {
    throw new Error(`Invalid ATLCLI_RELEASE_CHANNEL: ${channelValue}`);
  }

  if (channelValue === "source") {
    const releaseOnlyInputs = [
      environment.ATLCLI_BUILD_ID,
      environment.ATLCLI_EXTENSION_VERSION,
      environment.ATLCLI_EXTENSION_VERSION_NAME,
    ];
    if (releaseOnlyInputs.some((value) => value !== undefined)) {
      throw new Error("release extension inputs require an explicit stable or dev channel");
    }
    return {
      channel: "source",
      sourceSha: environment.ATLCLI_SOURCE_SHA ?? "unknown",
      buildId: "source",
      version: "0.0.0",
      versionName: "source",
      artifactName: "atlcli-extension-chrome-mv3-source.zip",
    };
  }

  const sourceSha = environment.ATLCLI_SOURCE_SHA;
  const buildId = environment.ATLCLI_BUILD_ID;
  const version = environment.ATLCLI_EXTENSION_VERSION;
  const versionName = environment.ATLCLI_EXTENSION_VERSION_NAME;
  if (!sourceSha || !FULL_SHA_PATTERN.test(sourceSha)) {
    throw new Error("release extension context requires a lowercase full source SHA");
  }
  if (!buildId || !ASSET_COMPONENT_PATTERN.test(buildId)) {
    throw new Error("release extension context requires a safe build ID");
  }
  if (!version) throw new Error("release extension context requires ATLCLI_EXTENSION_VERSION");
  validateChromeExtensionVersion(version);
  if (!versionName || versionName.length > 128 || /[\r\n]/.test(versionName)) {
    throw new Error("release extension version_name must contain 1 to 128 single-line characters");
  }

  return {
    channel: channelValue,
    sourceSha,
    buildId,
    version,
    versionName,
    artifactName: `atlcli-extension-chrome-mv3-${buildId}.zip`,
  };
}
