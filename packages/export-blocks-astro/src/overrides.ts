export const ASTRO_EXPORT_BLOCK_OVERRIDE_SLOTS_V1 = [
  "heading", "paragraph", "code", "callout", "expand", "list", "layout", "table",
  "image", "media-fallback", "blockquote", "smart-card", "unknown",
] as const;

export type AstroExportBlockOverrideSlotV1 = (typeof ASTRO_EXPORT_BLOCK_OVERRIDE_SLOTS_V1)[number];

export interface AstroExportBlockOverrideDescriptorV1 {
  id: string;
  version: string;
  slot: AstroExportBlockOverrideSlotV1;
  /** Operator-installed module identity; never sourced from a publication page. */
  module: string;
}

export interface AstroExportBlockOverrideSelectionV1 {
  schema: "atlcli.export-blocks-astro-overrides/1";
  selected: Readonly<Partial<Record<AstroExportBlockOverrideSlotV1, string>>>;
}

export class AstroExportBlockOverrideErrorV1 extends Error {}

function nonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) throw new AstroExportBlockOverrideErrorV1(`${label} must be non-empty`);
}

/**
 * Construct the immutable build-selected registry. This does not import a
 * module: the Astro project resolves selected installed modules statically.
 */
export function createAstroExportBlockOverrideRegistryV1(
  available: readonly AstroExportBlockOverrideDescriptorV1[],
  selection: AstroExportBlockOverrideSelectionV1,
): ReadonlyMap<AstroExportBlockOverrideSlotV1, AstroExportBlockOverrideDescriptorV1> {
  if (selection.schema !== "atlcli.export-blocks-astro-overrides/1") {
    throw new AstroExportBlockOverrideErrorV1("unsupported override-selection schema");
  }
  const byId = new Map<string, AstroExportBlockOverrideDescriptorV1>();
  for (const descriptor of available) {
    nonEmpty(descriptor.id, "override id"); nonEmpty(descriptor.version, "override version"); nonEmpty(descriptor.module, "override module");
    if (!(ASTRO_EXPORT_BLOCK_OVERRIDE_SLOTS_V1 as readonly string[]).includes(descriptor.slot)) throw new AstroExportBlockOverrideErrorV1(`unsupported override slot ${descriptor.slot}`);
    if (byId.has(descriptor.id)) throw new AstroExportBlockOverrideErrorV1(`duplicate override id ${descriptor.id}`);
    byId.set(descriptor.id, Object.freeze({ ...descriptor }));
  }
  const resolved = new Map<AstroExportBlockOverrideSlotV1, AstroExportBlockOverrideDescriptorV1>();
  for (const [slot, id] of Object.entries(selection.selected)) {
    if (!(ASTRO_EXPORT_BLOCK_OVERRIDE_SLOTS_V1 as readonly string[]).includes(slot)) throw new AstroExportBlockOverrideErrorV1(`unsupported selected slot ${slot}`);
    if (id === undefined) continue;
    const descriptor = byId.get(id);
    if (!descriptor) throw new AstroExportBlockOverrideErrorV1(`selected override ${id} is not installed`);
    if (descriptor.slot !== slot) throw new AstroExportBlockOverrideErrorV1(`override ${id} does not implement slot ${slot}`);
    resolved.set(slot as AstroExportBlockOverrideSlotV1, descriptor);
  }
  return resolved;
}
