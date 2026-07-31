export interface T0PublicationPage {
  id: string;
  route: string;
  title: string;
  description: string;
  locale: string;
  direction: "ltr" | "rtl";
  spaceKey: string;
  labels: readonly string[];
  contentType: "page" | "landing";
  parentId?: string;
  translationKey?: string;
  position: number;
  blocks: readonly Record<string, unknown>[];
  headings: readonly { depth: number; slug: string; text: string }[];
  chart?: Record<string, unknown>;
  resolvedAssets?: Readonly<Record<string, string>>;
  editUrl?: string;
  editLabel?: "Edit in Confluence" | "Open in Confluence";
  editRelation?: {
    deployment: "cloud" | "data-center";
    href: string;
    kind: "edit" | "webui";
  };
}

export interface T0PublicationBundle {
  schema: "atlcli.publication-bundle/1-t0";
  revision: string;
  providerOrigins: readonly string[];
  pages: readonly T0PublicationPage[];
}

export declare function loadT0PublicationBundle(bundlePath: string): Promise<T0PublicationBundle>;
export declare function publicationLoader(options: { bundlePath: string }): Loader;
export declare function publicationIntegration(options: {
  bundlePath: string;
  manifestPath: string;
  routePrefix?: string;
}): AstroIntegration;
export declare function findRouteCollisions(
  sourceRoutes: readonly (string | Pick<T0PublicationPage, "route" | "locale">)[],
  resolvedRoutes: readonly { pathname?: string; component?: string }[],
  routePrefix?: string,
): readonly string[];
export declare function publicationRoutePath(
  page: string | Pick<T0PublicationPage, "route" | "locale">,
  routePrefix?: string,
  defaultLocale?: string,
): string;
export declare function trustedConfluenceAction(
  relation: T0PublicationPage["editRelation"] | unknown,
  providerOrigins: readonly string[],
): { href: string; label: "Edit in Confluence" | "Open in Confluence" } | undefined;
export declare function trustedAnalyticsConfig(
  config: { domain?: unknown; endpoint?: unknown } | unknown,
  allowedOrigins: readonly string[],
): { domain: string; endpoint: string } | undefined;
import type { AstroIntegration } from "astro";
import type { Loader } from "astro/loaders";
