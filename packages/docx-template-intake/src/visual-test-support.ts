import {
  InMemoryTemplateAssetStore,
  type TemplateAssetHandleV1,
  type TemplateAssetStore,
  type VerifiedAssetCandidateV1,
} from "@atlcli/pdf-template-authoring";
import {
  TEMPLATE_ASSET_CAPABILITIES_SCHEMA_V1,
  type TemplateAssetCapabilitiesV1,
} from "@atlcli/template-pack";
import {
  resolveDocxSections,
  type DocxSectionResolutionV1,
} from "./section-resolution.js";
import {
  A_TRANSITIONAL,
  MC,
  R_TRANSITIONAL,
  WP_TRANSITIONAL,
  W_TRANSITIONAL,
  buildDocx,
  officeRelationshipType,
  relationshipsXml,
} from "./test-support.js";

export const DRAWING_NAMESPACES = [
  `xmlns:w="${W_TRANSITIONAL}"`,
  `xmlns:r="${R_TRANSITIONAL}"`,
  `xmlns:a="${A_TRANSITIONAL}"`,
  `xmlns:wp="${WP_TRANSITIONAL}"`,
  `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`,
  `xmlns:mc="${MC}"`,
  `xmlns:v="urn:schemas-microsoft-com:vml"`,
].join(" ");

export const TEST_VISUAL_CAPABILITIES: TemplateAssetCapabilitiesV1 = {
  schema: TEMPLATE_ASSET_CAPABILITIES_SCHEMA_V1,
  id: "atlcli.pdf-template-assets.test",
  version: 1,
  mediaTypes: ["image/jpeg", "image/png", "image/svg+xml"],
  maxBytes: 64 * 1024,
  maxWidth: 1_000,
  maxHeight: 1_000,
  maxPixels: 500_000,
  svg: {
    maxElements: 32,
    maxPathElements: 4,
    maxFilterPrimitives: 2,
  },
};

export function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

export function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]);
}

export function svg(
  body = "<path d=\"M0 0L1 1\"/>",
  width = 100,
  height = 100
): Uint8Array {
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`
  );
}

export function contentTypes(
  values: Readonly<Record<string, string>> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    svg: "image/svg+xml",
  }
): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`,
    ...Object.entries(values).map(
      ([extension, mediaType]) =>
        `<Default Extension="${extension}" ContentType="${mediaType}"/>`
    ),
    `<Default Extension="xml" ContentType="application/xml"/>`,
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
    `</Types>`,
  ].join("");
}

export function inlineDrawing(
  relationshipId: string | undefined,
  options: {
    crop?: { left: number; top: number; right: number; bottom: number };
    name?: string;
    title?: string;
    description?: string;
    width?: number;
    height?: number;
  } = {}
): string {
  const crop = options.crop
    ? `<a:srcRect l="${options.crop.left}" t="${options.crop.top}" r="${options.crop.right}" b="${options.crop.bottom}"/>`
    : "";
  const blip = relationshipId
    ? `<a:blip r:embed="${relationshipId}"/>`
    : `<a:solidFill><a:srgbClr val="112233"/></a:solidFill>`;
  return [
    `<w:p><w:r><w:drawing><wp:inline>`,
    `<wp:extent cx="${options.width ?? 914400}" cy="${options.height ?? 457200}"/>`,
    `<wp:docPr id="1" name="${options.name ?? "Picture"}"`,
    options.title ? ` title="${options.title}"` : "",
    options.description ? ` descr="${options.description}"` : "",
    `/>`,
    `<a:graphic><a:graphicData uri="picture"><pic:pic>`,
    `<pic:blipFill>${blip}${crop}</pic:blipFill>`,
    `<pic:spPr><a:xfrm flipH="1" flipV="0" rot="900000">`,
    `<a:off x="100" y="200"/><a:ext cx="914400" cy="457200"/>`,
    `</a:xfrm></pic:spPr>`,
    `</pic:pic></a:graphicData></a:graphic>`,
    `</wp:inline></w:drawing></w:r></w:p>`,
  ].join("");
}

export function anchorDrawing(
  relationshipId: string,
  options: {
    horizontal?: string;
    vertical?: string;
    width?: number;
    height?: number;
    behindDoc?: boolean;
    simplePos?: boolean;
    opacity?: number;
    rotation?: number;
  } = {}
): string {
  const alpha =
    options.opacity === undefined
      ? ""
      : `<a:alpha val="${Math.round(options.opacity * 100_000)}"/>`;
  return [
    `<w:p><w:r><w:drawing>`,
    `<wp:anchor distT="10" distR="20" distB="30" distL="40"`,
    ` simplePos="${options.simplePos ? "1" : "0"}" relativeHeight="42"`,
    ` behindDoc="${options.behindDoc ? "1" : "0"}" allowOverlap="1" layoutInCell="0">`,
    `<wp:simplePos x="111" y="222"/>`,
    `<wp:positionH relativeFrom="${options.horizontal ?? "page"}"><wp:align>center</wp:align></wp:positionH>`,
    `<wp:positionV relativeFrom="${options.vertical ?? "margin"}"><wp:posOffset>333</wp:posOffset></wp:positionV>`,
    `<wp:extent cx="${options.width ?? 7000000}" cy="${options.height ?? 9000000}"/>`,
    `<wp:effectExtent l="1" t="2" r="3" b="4"/>`,
    `<wp:wrapSquare/>`,
    `<wp:docPr id="2" name="Anchor"/>`,
    `<a:graphic><a:graphicData uri="picture"><pic:pic>`,
    `<pic:blipFill><a:blip r:embed="${relationshipId}"/></pic:blipFill>`,
    `<pic:spPr><a:xfrm flipH="1" flipV="1" rot="${Math.round((options.rotation ?? 30) * 60_000)}">`,
    `<a:off x="10" y="20"/><a:ext cx="${options.width ?? 7000000}" cy="${options.height ?? 9000000}"/>`,
    `</a:xfrm><a:solidFill><a:srgbClr val="AABBCC">${alpha}</a:srgbClr></a:solidFill></pic:spPr>`,
    `</pic:pic></a:graphicData></a:graphic>`,
    `</wp:anchor></w:drawing></w:r></w:p>`,
  ].join("");
}

export function wordDocument(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><w:document ${DRAWING_NAMESPACES}><w:body>${body}</w:body></w:document>`;
}

export function storyDocument(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${DRAWING_NAMESPACES}>${body}</w:hdr>`;
}

export function imageRelationships(
  values: readonly {
    id: string;
    target: string;
    external?: boolean;
  }[]
): string {
  return relationshipsXml(
    values.map(({ id, target, external }) => ({
      id,
      target,
      type: officeRelationshipType("image"),
      ...(external ? { targetMode: "External" as const } : {}),
    }))
  );
}

export function visualDocx(
  input: {
    document?: string;
    documentRelationships?: string;
    entries?: Readonly<Record<string, string | Uint8Array>>;
    types?: string;
  } = {}
): Uint8Array {
  return buildDocx({
    "[Content_Types].xml": input.types ?? contentTypes(),
    "word/document.xml": input.document ?? wordDocument(""),
    ...(input.documentRelationships
      ? { "word/_rels/document.xml.rels": input.documentRelationships }
      : {}),
    ...(input.entries ?? {}),
  });
}

export async function singleSection(
  overrides: {
    titlePage?: boolean;
    pageNumberStart?: number;
    headers?: Partial<Record<"default" | "even" | "first", string>>;
    footers?: Partial<Record<"default" | "even" | "first", string>>;
    evenAndOddHeaders?: boolean;
  } = {}
): Promise<DocxSectionResolutionV1> {
  return resolveDocxSections({
    evenAndOddHeaders: overrides.evenAndOddHeaders ?? false,
    sections: [
      {
        section: 0,
        locator: "document.section.0",
        page: {
          widthTwips: 11_906,
          heightTwips: 16_838,
          marginTopTwips: 1_440,
          marginRightTwips: 1_440,
          marginBottomTwips: 1_440,
          marginLeftTwips: 1_440,
        },
        ...(overrides.titlePage === undefined
          ? {}
          : { titlePage: overrides.titlePage }),
        ...(overrides.pageNumberStart === undefined
          ? {}
          : { pageNumberStart: overrides.pageNumberStart }),
        ...(overrides.headers ? { headers: overrides.headers } : {}),
        ...(overrides.footers ? { footers: overrides.footers } : {}),
      },
    ],
  });
}

export class TrackingAssetStore implements TemplateAssetStore {
  readonly inner = new InMemoryTemplateAssetStore();
  puts = 0;

  async put(
    candidate: VerifiedAssetCandidateV1
  ): Promise<TemplateAssetHandleV1> {
    this.puts += 1;
    return this.inner.put(candidate);
  }

  get(handle: TemplateAssetHandleV1): Promise<Uint8Array> {
    return this.inner.get(handle);
  }

  verify(handle: TemplateAssetHandleV1): Promise<void> {
    return this.inner.verify(handle);
  }
}
