import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  ERROR_CODES,
  getActiveProfile,
  getFlag,
  hasFlag,
  loadConfig,
  output,
  type OutputOptions,
  type Profile,
} from "@atlcli/core";
import {
  ConfluenceClient,
  type ExportBlock,
  type ExportNode,
  type ImageSource,
} from "@atlcli/confluence";
import {
  confluenceSourceResolverPortFromClientV1,
  fetchAndMaterializePublicationAssetV1,
  type MaterializedPublicationAssetV1,
  type PublicationAssetRequestV1,
} from "@atlcli/export-wiring";
import { resolveConfluencePageGraphV1 } from "@atlcli/export-wiring/jobs";
import type { ExportSourceV1 } from "@atlcli/export-jobs";
import {
  canonicalPublicationJsonV1,
  digestPublicationJsonV1,
  digestPublicationPageV1,
  planPublicationRefreshV1,
  planPublicationRoutesV1,
  parsePublicationBundleV1,
  parsePublicationProjectV1,
  parseStaticPublicationManifestV1,
  type PublicationBundleV1,
  type PublicationLinkReferenceV1,
  type PublicationPageV1,
  type PublicationProjectV1,
  type PublicationRouteRecordV1,
  type PublicationSourcePageSnapshotV1,
  type PublicationSourceSnapshotV1,
} from "@atlcli/web-publish";
import {
  materializeNodePublicationBundleV1,
  readBoundedPublicationJsonV1,
  sweepNodePublicationRetentionV1,
} from "@atlcli/web-publish/node";
import {
  createAstroStaticPublicationBuilderV1,
  verifyAstroStaticPublicationOutputV1,
  type AstroBuildInventoryV1,
} from "@atlcli/web-publish-astro";
import {
  STARLIGHT_PUBLISHING_EXPERIENCE_V1,
} from "@atlcli/web-publish-starlight";
import { visitExportBlocksV1 } from "@atlcli/export-blocks";

type Flags = Record<string, string | boolean | string[]>;

const PUBLISH_PLAN_SCHEMA_V1 = "atlcli.publish-plan/1" as const;
const DEFAULT_PROJECT_FILE = ".atlcli/publish.json";

export interface PublishProjectStateV1 {
  project: PublicationProjectV1;
  projectPath: string;
  workspaceDirectory: string;
}

export interface PublishPlanReportV1 {
  schema: typeof PUBLISH_PLAN_SCHEMA_V1;
  publicationKey: string;
  complete: boolean;
  pageCount: number;
  changes: readonly unknown[];
  issues: readonly unknown[];
  planDigest: string;
  routeChanges: readonly unknown[];
}

function nonEmptyFlag(flags: Flags, name: string): string | undefined {
  const value = getFlag(flags, name);
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

function projectFile(flags: Flags): string {
  return resolve(nonEmptyFlag(flags, "project") ?? DEFAULT_PROJECT_FILE);
}

function workspaceFor(project: PublicationProjectV1, flags: Flags): string {
  return resolve(nonEmptyFlag(flags, "workspace") ?? join(".atlcli", "publish", project.publicationKey));
}

function requireExplicitPublicationChoices(project: PublicationProjectV1, flags: Flags): void {
  if (project.visibility === "public" && !hasFlag(flags, "confirm-public")) {
    throw new Error("Public publishing requires explicit --confirm-public.");
  }
  if (project.completeness === "allow-partial" && !hasFlag(flags, "allow-partial")) {
    throw new Error("Partial publication requires explicit --allow-partial.");
  }
}

async function loadPublishProject(flags: Flags): Promise<PublishProjectStateV1> {
  const path = projectFile(flags);
  const parsed = parsePublicationProjectV1(await readBoundedPublicationJsonV1(path));
  requireExplicitPublicationChoices(parsed, flags);
  return { project: parsed, projectPath: path, workspaceDirectory: workspaceFor(parsed, flags) };
}

async function resolveProfile(flags: Flags): Promise<Profile> {
  const config = await loadConfig();
  const profile = getActiveProfile(config, nonEmptyFlag(flags, "profile"));
  if (profile === undefined) throw new Error("No active Atlassian profile is configured.");
  return profile;
}

function sourceRequest(project: PublicationProjectV1, profile: Profile): ExportSourceV1 {
  const source = project.source;
  const scope = source.kind === "page"
    ? { kind: "page" as const }
    : source.kind === "tree"
      ? { kind: "tree" as const, includeRoot: true, ...(project.sourcePolicy.maxDepth === undefined ? {} : { maxDepth: project.sourcePolicy.maxDepth }) }
      : { kind: "space" as const };
  const locator = source.kind === "page"
    ? { kind: "page-id" as const, id: source.pageId }
    : source.kind === "tree"
      ? { kind: "page-id" as const, id: source.rootPageId }
      : { kind: "space-key" as const, spaceKey: source.spaceKey };
  return {
    kind: "confluence",
    siteOrigin: profile.baseUrl,
    locator,
    scope,
    ...(project.sourcePolicy.includeLabels.length || project.sourcePolicy.excludeLabels.length ? {
      labels: {
        ...(project.sourcePolicy.includeLabels.length ? { include: [...project.sourcePolicy.includeLabels] } : {}),
        ...(project.sourcePolicy.excludeLabels.length ? { exclude: [...project.sourcePolicy.excludeLabels] } : {}),
        excludeMode: project.sourcePolicy.excludeMode,
      },
    } : {}),
    completenessMode: project.completeness === "allow-partial" ? "partial" : "strict",
    maxPages: project.sourcePolicy.maxPages,
    maxFolders: project.sourcePolicy.maxFolders,
  } as ExportSourceV1;
}

function pageNodes(nodes: readonly ExportNode[]): Extract<ExportNode, { kind: "page" }>[] {
  return nodes.filter((node): node is Extract<ExportNode, { kind: "page" }> => node.kind === "page");
}

/** Keep provider ordering metadata finite before it crosses the publication schema boundary. */
export function normalizePublicationPositionV1(value: number | null, fallback: number): number {
  return value !== null && Number.isFinite(value) ? value : fallback;
}

/** Keep links to pages outside the selected publication scope visible but non-dangling. */
export function normalizePublicationLinksV1(
  links: readonly PublicationLinkReferenceV1[],
  inScopeSourceIds: ReadonlySet<string>,
): readonly PublicationLinkReferenceV1[] {
  return links.map((link) => link.kind === "page" && !inScopeSourceIds.has(link.sourceId)
    ? { referenceId: link.referenceId, kind: "unresolved" as const, reason: "outside-scope" as const, label: "Out-of-scope Confluence link" }
    : link);
}

function safeAssetId(pageId: string, source: ImageSource): string {
  return `asset-${createHash("sha256").update(canonicalPublicationJsonV1({ pageId, source })).digest("hex").slice(0, 32)}`;
}

function collectPageReferences(pageId: string, blocks: readonly ExportBlock[]): {
  links: PublicationPageV1["links"];
  assetIds: readonly string[];
  assets: readonly PublicationAssetRequestV1[];
} {
  const links: PublicationPageV1["links"][number][] = [];
  const assets = new Map<string, PublicationAssetRequestV1>();
  let ordinal = 0;
  const addAsset = (source: ImageSource): void => {
    const normalized = source.kind === "attachment"
      ? { kind: "attachment" as const, pageId: source.pageId ?? pageId, filename: source.filename }
      : { kind: "external" as const, url: source.url, filename: "external-image" };
    const assetId = safeAssetId(pageId, source);
    if (!assets.has(assetId)) assets.set(assetId, { assetId, source: normalized });
  };
  visitExportBlocksV1(blocks, {
    block(block) {
      if (block.type === "image") addAsset(block.source);
    },
    inline(inline) {
      if (inline.type === "media" && inline.source !== undefined) addAsset(inline.source);
      if (inline.type !== "link") return;
      const referenceId = `${pageId}:link:${ordinal++}`;
      if (inline.target.kind === "page" && inline.target.contentId !== undefined) {
        links.push({ referenceId, kind: "page", sourceId: inline.target.contentId, ...(inline.target.anchor === undefined ? {} : { anchorId: inline.target.anchor }) });
      } else if (inline.target.kind === "external" && /^https?:\/\//u.test(inline.target.href)) {
        links.push({ referenceId, kind: "external", href: inline.target.href });
      } else if (inline.target.kind === "attachment") {
        const source: ImageSource = { kind: "attachment", pageId, filename: inline.target.filename };
        addAsset(source);
        links.push({ referenceId, kind: "asset", assetId: safeAssetId(pageId, source) });
      } else {
        links.push({ referenceId, kind: "unresolved", reason: "missing", label: "Unresolved Confluence link" });
      }
    },
  });
  return { links, assetIds: [...assets.keys()], assets: [...assets.values()].sort((left, right) => left.assetId.localeCompare(right.assetId)) };
}

async function snapshotAndPages(
  project: PublicationProjectV1,
  graph: Awaited<ReturnType<typeof resolveConfluencePageGraphV1>>,
): Promise<{
  pages: readonly PublicationPageV1[];
  snapshot: PublicationSourceSnapshotV1;
  assetRequests: readonly PublicationAssetRequestV1[];
}> {
  const nodes = pageNodes(graph.nodes);
  const routePlan = planPublicationRoutesV1({
    pages: nodes.map((node) => ({ sourceId: node.pageId, title: node.title })),
    previousRoutes: [],
    tombstoneSourceIds: [],
    policy: project.routes,
    outputProfile: project.builder.outputProfile,
  });
  const routeById = new Map(routePlan.routes.filter((route) => route.state === "active").map((route) => [route.sourceId, route.route]));
  const inScopeSourceIds = new Set(nodes.map((node) => node.pageId));
  const snapshots: PublicationSourcePageSnapshotV1[] = [];
  const pages: PublicationPageV1[] = [];
  const requestMap = new Map<string, PublicationAssetRequestV1>();
  for (const [index, node] of nodes.entries()) {
    const position = normalizePublicationPositionV1(node.position, index);
    const references = collectPageReferences(node.pageId, node.blocks);
    references.assets.forEach((request) => requestMap.set(request.assetId, request));
    const sourceVersion = String(node.meta.version ?? node.meta.observedVersion ?? "unknown");
    const contentDigest = await digestPublicationJsonV1({ blocks: node.blocks, notes: node.notes });
    const metadataDigest = await digestPublicationJsonV1({ title: node.title, labels: node.meta.labels, parentId: node.parentId, position, depth: node.effectiveDepth });
    const assetMetadataDigest = await digestPublicationJsonV1(references.assets);
    const macroDependencyDigest = await digestPublicationJsonV1({});
    snapshots.push({
      sourceId: node.pageId,
      sourceVersion,
      representation: project.sourcePolicy.representation === "adf-primary" ? "atlas_doc_format" : "storage",
      ...(node.parentId === null ? {} : { parentId: node.parentId }),
      position,
      depth: node.effectiveDepth,
      title: node.title,
      contentDigest,
      metadataDigest,
      assetMetadataDigest,
      macroDependencyDigest,
      state: "included",
    });
    const draft: PublicationPageV1 = {
      schema: "atlcli.publication-page/1" as const,
      sourceId: node.pageId,
      sourceVersion,
      title: node.title,
      ...(node.parentId === null ? {} : { parentId: node.parentId }),
      position,
      depth: node.effectiveDepth,
      route: routeById.get(node.pageId)!,
      blocks: node.blocks,
      notes: node.notes,
      labels: [...node.meta.labels].sort(),
      links: normalizePublicationLinksV1(references.links, inScopeSourceIds),
      assetIds: references.assetIds,
      renderDependencies: [{ kind: "source-page" as const, key: node.pageId, version: sourceVersion, digest: contentDigest, live: false }],
      pageDigest: "pending",
    };
    pages.push({ ...draft, pageDigest: await digestPublicationPageV1(draft) });
  }
  return {
    pages,
    snapshot: {
      sourceDigest: await digestPublicationJsonV1({ rootIds: [graph.root.id], pages: snapshots }),
      complete: graph.complete,
      deletionAuthority: graph.complete ? "complete-scan" : "none",
      rootIds: [graph.root.id],
      pages: snapshots,
    },
    assetRequests: [...requestMap.values()],
  };
}

async function readActiveBundle(workspaceDirectory: string): Promise<{ bundle: PublicationBundleV1; bundlePath: string } | undefined> {
  try {
    const pointer = await readBoundedPublicationJsonV1(join(workspaceDirectory, "current.json"), { maxBytes: 16_384 }) as { schema?: string; bundleDigest?: string };
    if (pointer.schema !== "atlcli.publication-current/1" || typeof pointer.bundleDigest !== "string") throw new Error("active publication pointer is invalid");
    const bundlePath = join(workspaceDirectory, "bundles", pointer.bundleDigest, "publication.json");
    return { bundle: parsePublicationBundleV1(await readBoundedPublicationJsonV1(bundlePath)), bundlePath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function graphAndPlan(state: PublishProjectStateV1, profile: Profile, signal: AbortSignal): Promise<{
  report: PublishPlanReportV1;
  pages: readonly PublicationPageV1[];
  snapshot: PublicationSourceSnapshotV1;
  assetRequests: readonly PublicationAssetRequestV1[];
  routes: readonly PublicationRouteRecordV1[];
  refreshPlan: Awaited<ReturnType<typeof planPublicationRefreshV1>>;
}> {
  const client = new ConfluenceClient(profile);
  const source = sourceRequest(state.project, profile);
  const graph = await resolveConfluencePageGraphV1(source, {
    exporter: "web",
    port: confluenceSourceResolverPortFromClientV1(client),
    signal,
  });
  const { pages, snapshot, assetRequests } = await snapshotAndPages(state.project, graph);
  const previous = await readActiveBundle(state.workspaceDirectory);
  const previousPages = previous === undefined ? undefined : {
    ...previous.bundle.sourceSnapshot,
    pages: previous.bundle.sourceSnapshot.pages,
  };
  const routePlan = planPublicationRoutesV1({
    pages: pages.map((page) => ({ sourceId: page.sourceId, title: page.title })),
    previousRoutes: previous?.bundle.routes ?? [],
    tombstoneSourceIds: snapshot.complete && previous !== undefined
      ? previous.bundle.sourceSnapshot.pages.filter((entry) => !snapshot.pages.some((current) => current.sourceId === entry.sourceId)).map((entry) => entry.sourceId)
      : [],
    policy: state.project.routes,
    outputProfile: state.project.builder.outputProfile,
  });
  const refreshPlan = await planPublicationRefreshV1({
    ...(previous === undefined ? {} : { previousBundleDigest: previous.bundle.bundleDigest, previous: previousPages, previousRoutes: previous.bundle.routes }),
    current: snapshot,
    currentRoutes: routePlan.routes,
  });
  const report: PublishPlanReportV1 = {
    schema: PUBLISH_PLAN_SCHEMA_V1,
    publicationKey: state.project.publicationKey,
    complete: refreshPlan.complete,
    pageCount: pages.length,
    changes: refreshPlan.changes,
    issues: refreshPlan.issues,
    planDigest: refreshPlan.planDigest,
    routeChanges: routePlan.changes,
  };
  return { report, pages, snapshot, assetRequests, routes: routePlan.routes, refreshPlan };
}

async function writePlan(state: PublishProjectStateV1, report: PublishPlanReportV1): Promise<void> {
  await mkdir(state.workspaceDirectory, { recursive: true });
  await writeFile(join(state.workspaceDirectory, "last-plan.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function executeRefresh(state: PublishProjectStateV1, flags: Flags): Promise<PublishPlanReportV1> {
  const profile = await resolveProfile(flags);
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    const planned = await graphAndPlan(state, profile, controller.signal);
    await writePlan(state, planned.report);
    if (hasFlag(flags, "dry-run")) return planned.report;
    if (!planned.refreshPlan.complete) throw new Error("Refresh is incomplete; pass --allow-partial only for a deliberately non-activating plan.");
    const client = new ConfluenceClient(profile);
    const policy = state.project.assets;
    const materialized: MaterializedPublicationAssetV1[] = [];
    for (const request of planned.assetRequests) {
      const asset = await fetchAndMaterializePublicationAssetV1(request, policy, {
        attachmentPort: {
          async fetchAttachment(input) {
            const attachments = await client.listAttachments(input.pageId, { limit: 500, signal: input.signal });
            const attachment = attachments.find((candidate) => candidate.filename === input.filename);
            if (!attachment) throw new Error(`Publication attachment is missing on page ${input.pageId}: ${input.filename}`);
            return { bytes: await client.downloadAttachment(attachment, { signal: input.signal }), mediaType: attachment.mediaType };
          },
        },
      });
      materialized.push(asset);
    }
    const result = await materializeNodePublicationBundleV1({
      workspaceDirectory: state.workspaceDirectory,
      refreshPlan: planned.refreshPlan,
      createdBy: { name: "atlcli", version: "0.17.2" },
      sourcePolicyDigest: await digestPublicationJsonV1(state.project.sourcePolicy),
      rootIds: planned.snapshot.rootIds,
      pages: planned.pages,
      routes: planned.routes,
      assets: materialized,
      issues: planned.refreshPlan.issues,
      assetPolicy: state.project.assets,
      expectedActiveBundleDigest: planned.refreshPlan.previousBundleDigest,
      signal: controller.signal,
    });
    return { ...planned.report, pageCount: result.bundle.pages.length };
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

async function executeBuild(state: PublishProjectStateV1): Promise<Record<string, unknown>> {
  const active = await readActiveBundle(state.workspaceDirectory);
  if (active === undefined) throw new Error("No active publication bundle; run `wiki publish refresh` first.");
  const projectDigest = await digestPublicationJsonV1(state.project);
  const lockfile = await readFile(resolve(state.project.builder.projectDir, "bun.lock"), "utf8").catch(() => "");
  const lockfileDigest = createHash("sha256").update(lockfile).digest("hex");
  const experienceDigest = await digestPublicationJsonV1({ descriptor: STARLIGHT_PUBLISHING_EXPERIENCE_V1, selection: state.project.experience });
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    const builder = createAstroStaticPublicationBuilderV1({
      version: "0.1.0",
      astroVersion: "7.1.6",
      inventoryPath: join(state.workspaceDirectory, "build-inventory.json"),
      outputDirectory: resolve(state.project.builder.projectDir, "dist"),
      signal: controller.signal,
      experience: { id: STARLIGHT_PUBLISHING_EXPERIENCE_V1.id, version: STARLIGHT_PUBLISHING_EXPERIENCE_V1.version, digest: experienceDigest },
    });
    const result = await builder.build({
      project: state.project,
      bundle: active.bundle,
      projectDigest,
      configDigest: projectDigest,
      lockfileDigest,
    });
    const buildDirectory = join(state.workspaceDirectory, "builds", result.manifest.buildDigest);
    await mkdir(buildDirectory, { recursive: true });
    await writeFile(join(buildDirectory, "manifest.json"), `${JSON.stringify(result.manifest, null, 2)}\n`, "utf8");
    return { stage: "built", bundleDigest: active.bundle.bundleDigest, buildDigest: result.manifest.buildDigest, outputDirectory: result.outputDirectory };
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

async function executeVerify(state: PublishProjectStateV1, flags: Flags = {}): Promise<Record<string, unknown>> {
  const builds = await readdir(join(state.workspaceDirectory, "builds"), { withFileTypes: true }).catch(() => []);
  const candidates = builds.filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name));
  const selected = nonEmptyFlag(flags, "build") ?? candidates.at(-1)?.name;
  if (!selected) throw new Error("No publication build manifest is available.");
  const manifest = parseStaticPublicationManifestV1(await readBoundedPublicationJsonV1(join(state.workspaceDirectory, "builds", selected, "manifest.json")));
  if (manifest.buildDigest !== selected) throw new Error(`Publication build directory '${selected}' does not match its manifest digest.`);
  const active = await readActiveBundle(state.workspaceDirectory);
  if (active === undefined || active.bundle.bundleDigest !== manifest.bundleDigest) {
    throw new Error("Publication build does not belong to the active immutable bundle.");
  }
  const projectDigest = await digestPublicationJsonV1(state.project);
  const lockfile = await readFile(resolve(state.project.builder.projectDir, "bun.lock"), "utf8").catch(() => "");
  const lockfileDigest = createHash("sha256").update(lockfile).digest("hex");
  if (manifest.projectDigest !== projectDigest || manifest.configDigest !== projectDigest || manifest.lockfileDigest !== lockfileDigest) {
    throw new Error("Publication build was produced from a different project or lockfile state.");
  }
  if (manifest.base !== state.project.builder.base || manifest.outputProfile !== state.project.builder.outputProfile) {
    throw new Error("Publication build URL/output profile differs from the current project configuration.");
  }
  if (manifest.builder.id !== "astro-static" || manifest.builder.astroVersion !== "7.1.6") {
    throw new Error("Publication build uses an unsupported Astro builder/version.");
  }
  const expectedExperienceDigest = await digestPublicationJsonV1({ descriptor: STARLIGHT_PUBLISHING_EXPERIENCE_V1, selection: state.project.experience });
  if (
    manifest.experience.id !== STARLIGHT_PUBLISHING_EXPERIENCE_V1.id ||
    manifest.experience.version !== STARLIGHT_PUBLISHING_EXPERIENCE_V1.version ||
    manifest.experience.digest !== expectedExperienceDigest
  ) {
    throw new Error("Publication build Starlight capability declaration differs from project configuration.");
  }
  const expectedAnalytics = state.project.analytics.provider === "none" ? "none" : "plausible";
  if (manifest.analytics.provider !== expectedAnalytics) throw new Error("Publication analytics declaration differs from project configuration.");
  if (state.project.analytics.provider === "plausible") {
    if (manifest.analytics.provider !== "plausible" || manifest.analytics.endpointOrigin !== new URL(state.project.analytics.endpoint).origin) {
      throw new Error("Publication analytics endpoint origin differs from project configuration.");
    }
  }
  const expectedEditLinks = state.project.editLink.provider === "none" ? "none" : "confluence";
  if (manifest.editLinks.provider !== expectedEditLinks) throw new Error("Publication edit-link declaration differs from project configuration.");
  if (JSON.stringify(manifest.search.languages) !== JSON.stringify(state.project.search.languages)) {
    throw new Error("Publication search language declaration differs from project configuration.");
  }
  const inventory = await readBoundedPublicationJsonV1(join(state.workspaceDirectory, "build-inventory.json")) as unknown as AstroBuildInventoryV1;
  const outputDirectory = resolve(state.project.builder.projectDir, "dist");
  const verified = await verifyAstroStaticPublicationOutputV1({ manifest, inventory, outputDirectory });
  return { stage: "verified", buildDigest: manifest.buildDigest, bundleDigest: manifest.bundleDigest, ...verified };
}

async function executeStatus(state: PublishProjectStateV1): Promise<Record<string, unknown>> {
  const active = await readActiveBundle(state.workspaceDirectory);
  const builds = await readdir(join(state.workspaceDirectory, "builds"), { withFileTypes: true }).catch(() => []);
  return {
    publicationKey: state.project.publicationKey,
    stage: active === undefined ? "uninitialized" : "bundle-ready",
    activeBundleDigest: active?.bundle.bundleDigest,
    buildCount: builds.filter((entry) => entry.isDirectory()).length,
  };
}

async function executePrune(state: PublishProjectStateV1, flags: Flags): Promise<Record<string, unknown>> {
  if (!hasFlag(flags, "confirm")) throw new Error("Pruning requires explicit --confirm.");
  return { ...await sweepNodePublicationRetentionV1({ workspaceDirectory: state.workspaceDirectory, retention: state.project.retention, now: Date.now() }) };
}

export async function handlePublish(args: string[], flags: Flags, opts: OutputOptions): Promise<void> {
  const operation = args[0];
  if (operation === undefined || hasFlag(flags, "help") || hasFlag(flags, "h")) {
    output(publishHelp(), opts);
    return;
  }
  const state = await loadPublishProject(flags);
  let result: unknown;
  switch (operation) {
    case "plan": {
      const profile = await resolveProfile(flags);
      const controller = new AbortController();
      const onSigint = (): void => controller.abort();
      process.once("SIGINT", onSigint);
      try {
        const planned = await graphAndPlan(state, profile, controller.signal);
        await writePlan(state, planned.report);
        result = { stage: "planned", ...planned.report };
      } finally {
        process.removeListener("SIGINT", onSigint);
      }
      break;
    }
    case "refresh": result = { stage: "bundle-ready", ...(await executeRefresh(state, flags)) }; break;
    case "build": result = await executeBuild(state); break;
    case "verify": result = await executeVerify(state, flags); break;
    case "run": {
      const refreshed = await executeRefresh(state, flags);
      if (hasFlag(flags, "dry-run")) {
        result = { stage: "planned", refresh: refreshed };
        break;
      }
      const built = await executeBuild(state);
      const verified = await executeVerify(state, flags);
      result = { stage: "verified", refresh: refreshed, build: built, verify: verified };
      break;
    }
    case "status": result = await executeStatus(state); break;
    case "prune": result = await executePrune(state, flags); break;
    default: throw new Error(`Unknown wiki publish operation "${operation}".`);
  }
  output(result, opts);
}

export function publishHelp(): string {
  return [
    "atlcli wiki publish <operation>",
    "",
    "Immutable Confluence-to-Astro publishing lifecycle.",
    "",
    "Operations:",
    "  plan      Acquire metadata and show the refresh/route diff",
    "  refresh   Acquire, validate, and atomically activate a bundle",
    "  build     Build the active bundle with the trusted Astro project",
    "  verify    Verify the latest build manifest and output digests",
    "  run       Refresh, build, and verify in sequence",
    "  status    Show local bundle/build stage state",
    "  prune     Remove only verified unreachable state (--confirm required)",
    "",
    "Options:",
    "  --project <path>       Publication project JSON (default .atlcli/publish.json)",
    "  --workspace <path>     Private bundle/build workspace",
    "  --profile <name>       Atlassian auth profile",
    "  --confirm-public       Acknowledge a public publication",
    "  --allow-partial        Acknowledge a partial source policy",
    "  --confirm              Allow verified retention cleanup",
    "  --build <digest>       Verify a specific build manifest",
    "  --dry-run              Plan/refresh without activation",
    "  --json                 Emit machine-readable output",
  ].join("\n");
}
