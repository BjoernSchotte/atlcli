/**
 * Deterministic, browser-safe DOCX template-intake fixture.
 *
 * The source contains one page-sized, behind-document DrawingML image wrapped
 * in AlternateContent. Both branches reference the same safe SVG bytes so the
 * analyzer must preserve branch provenance while deduplicating asset identity.
 * The anchor intentionally carries crop, horizontal/vertical references, and
 * section scope for the independent DOCX-to-raster proof chain.
 */
import PizZip from "pizzip";

// ZIP/DOS timestamps encode local calendar components. Construct the fixture
// date locally so the archive bytes stay identical in every host timezone.
const FIXED_DATE = new Date(2026, 6, 27, 0, 0, 0, 0);
const W =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const A =
  "http://schemas.openxmlformats.org/drawingml/2006/main";
const WP =
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const MC =
  "http://schemas.openxmlformats.org/markup-compatibility/2006";

export const DOCX_TEMPLATE_INTAKE_FIXTURE_DATE =
  "2026-07-27T00:00:00.000Z";
export const DOCX_TEMPLATE_INTAKE_FIXTURE_RELATIONSHIP_ID = "rIdBrandBackground";
export const DOCX_TEMPLATE_INTAKE_FIXTURE_HEADER_RELATIONSHIP_ID =
  "rIdBrandHeader";
export const DOCX_TEMPLATE_INTAKE_FIXTURE_ALTERNATE_BRANCH = "choice.0";
export const DOCX_TEMPLATE_INTAKE_FIXTURE_SECTION = 0;
export const DOCX_TEMPLATE_INTAKE_FIXTURE_MASTER = "";
export const DOCX_TEMPLATE_INTAKE_FIXTURE_CROP = Object.freeze({
  left: 2,
  top: 3,
  right: 4,
  bottom: 5,
  unit: "percent" as const,
});
export const DOCX_TEMPLATE_INTAKE_FIXTURE_ANCHOR = Object.freeze({
  horizontalReference: "page",
  verticalReference: "page",
  horizontalOffsetEmu: 0,
  verticalOffsetEmu: 0,
  widthEmu: 7_559_100,
  heightEmu: 10_692_000,
});
export const DOCX_TEMPLATE_INTAKE_FIXTURE_ORACLE = Object.freeze({
  sourceDigest:
    "706f5826d8424113d23dcac2fe14b455a0ad6e26d0cbd18a5fe474c080f4ef5e",
  background: Object.freeze({
    assetSha256:
      "ed170911b4925f992167141b5d83cafb4875bd9ffdbd2af4991b961b54e749d7",
    relationshipRef: "relationship.0.c954b59a13f1",
    targetFingerprint:
      "f94b1eaeb18dd201a33173b4583e8bbcb41899312e9b63775087b77f7f8b2a5f",
    alternateBranch: DOCX_TEMPLATE_INTAKE_FIXTURE_ALTERNATE_BRANCH,
    crop: DOCX_TEMPLATE_INTAKE_FIXTURE_CROP,
    horizontalReference:
      DOCX_TEMPLATE_INTAKE_FIXTURE_ANCHOR.horizontalReference,
    verticalReference: DOCX_TEMPLATE_INTAKE_FIXTURE_ANCHOR.verticalReference,
    section: DOCX_TEMPLATE_INTAKE_FIXTURE_SECTION,
    master: DOCX_TEMPLATE_INTAKE_FIXTURE_MASTER,
  }),
  header: Object.freeze({
    assetSha256:
      "75e8d0de8f65472212b8c52bf0956c12fc12233708494a94a252ef60b18f8181",
    relationshipRef: "relationship.0.7184670888dc",
    targetFingerprint:
      "9f6f3d1ab5e7956f57297a25ef068a5736d7b04641244e7b1ab85be221cb04db",
    alternateBranch: "",
    crop: null,
    horizontalReference: "",
    verticalReference: "",
    section: DOCX_TEMPLATE_INTAKE_FIXTURE_SECTION,
    master: "default",
  }),
});

export const DOCX_TEMPLATE_INTAKE_BACKGROUND_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="794" height="1123" viewBox="0 0 794 1123">` +
  `<rect width="794" height="1123" fill="#eef2ff"/>` +
  `<rect x="0" y="0" width="36" height="1123" fill="#4f46e5"/>` +
  `<circle cx="706" cy="92" r="54" fill="#c7d2fe"/>` +
  `<path d="M606 1123L794 935V1123Z" fill="#a5b4fc"/>` +
  `</svg>`;
export const DOCX_TEMPLATE_INTAKE_HEADER_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="64" viewBox="0 0 320 64">` +
  `<rect width="320" height="64" rx="12" fill="#312e81"/>` +
  `<circle cx="34" cy="32" r="18" fill="#a5b4fc"/>` +
  `<path d="M72 21H284V29H72ZM72 37H224V43H72Z" fill="#eef2ff"/>` +
  `</svg>`;

function anchorDrawing(): string {
  return [
    `<w:p><w:r><w:drawing>`,
    `<wp:anchor distT="0" distR="0" distB="0" distL="0" simplePos="0"`,
    ` relativeHeight="0" behindDoc="1" allowOverlap="1" layoutInCell="1">`,
    `<wp:simplePos x="0" y="0"/>`,
    `<wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH>`,
    `<wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>`,
    `<wp:extent cx="${DOCX_TEMPLATE_INTAKE_FIXTURE_ANCHOR.widthEmu}" cy="${DOCX_TEMPLATE_INTAKE_FIXTURE_ANCHOR.heightEmu}"/>`,
    `<wp:wrapNone/>`,
    `<wp:docPr id="1" name="Brand background" descr="Decorative brand background"/>`,
    `<a:graphic><a:graphicData uri="picture">`,
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`,
    `<pic:blipFill><a:blip r:embed="${DOCX_TEMPLATE_INTAKE_FIXTURE_RELATIONSHIP_ID}"/>`,
    `<a:srcRect l="2000" t="3000" r="4000" b="5000"/></pic:blipFill>`,
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/>`,
    `<a:ext cx="${DOCX_TEMPLATE_INTAKE_FIXTURE_ANCHOR.widthEmu}" cy="${DOCX_TEMPLATE_INTAKE_FIXTURE_ANCHOR.heightEmu}"/>`,
    `</a:xfrm></pic:spPr>`,
    `</pic:pic></a:graphicData></a:graphic>`,
    `</wp:anchor></w:drawing></w:r></w:p>`,
  ].join("");
}

function headerDrawing(): string {
  return [
    `<w:p><w:r><w:drawing><wp:inline>`,
    `<wp:extent cx="3048000" cy="609600"/>`,
    `<wp:docPr id="2" name="Brand header" descr="Decorative header graphic"/>`,
    `<a:graphic><a:graphicData uri="picture">`,
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`,
    `<pic:blipFill><a:blip r:embed="${DOCX_TEMPLATE_INTAKE_FIXTURE_HEADER_RELATIONSHIP_ID}"/></pic:blipFill>`,
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3048000" cy="609600"/></a:xfrm></pic:spPr>`,
    `</pic:pic></a:graphicData></a:graphic>`,
    `</wp:inline></w:drawing></w:r></w:p>`,
  ].join("");
}

export function createDocxTemplateIntakeFixture(): Uint8Array {
  const zip = new PizZip();
  const file = (
    name: string,
    value: string
  ): void => {
    (
      zip.file as (
        path: string,
        data: string,
        options: { date: Date }
      ) => unknown
    )(name, value, { date: FIXED_DATE });
  };
  file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="svg" ContentType="image/svg+xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
      `<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
      `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>` +
      `</Types>`
  );
  file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`
  );
  file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdStyles" Type="${R}/styles" Target="styles.xml"/>` +
      `<Relationship Id="rIdTheme" Type="${R}/theme" Target="theme/theme1.xml"/>` +
      `<Relationship Id="rIdHeader" Type="${R}/header" Target="header1.xml"/>` +
      `<Relationship Id="${DOCX_TEMPLATE_INTAKE_FIXTURE_RELATIONSHIP_ID}" Type="${R}/image" Target="media/brand-background.svg"/>` +
      `</Relationships>`
  );
  const drawing = anchorDrawing();
  file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:a="${A}" xmlns:wp="${WP}" xmlns:mc="${MC}">` +
      `<w:background w:color="F7F8FC"/>` +
      `<w:body>` +
      `<mc:AlternateContent><mc:Choice Requires="a">${drawing}</mc:Choice><mc:Fallback>${drawing}</mc:Fallback></mc:AlternateContent>` +
      `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Brand document</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>Neutral content for template intake.</w:t></w:r></w:p>` +
      `<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/>` +
      `<w:pgSz w:w="11906" w:h="16838"/>` +
      `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>` +
      `</w:sectPr></w:body></w:document>`
  );
  file(
    "word/header1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<w:hdr xmlns:w="${W}" xmlns:r="${R}" xmlns:a="${A}" xmlns:wp="${WP}">` +
      `${headerDrawing()}</w:hdr>`
  );
  file(
    "word/_rels/header1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="${DOCX_TEMPLATE_INTAKE_FIXTURE_HEADER_RELATIONSHIP_ID}" Type="${R}/image" Target="media/brand-header.svg"/>` +
      `</Relationships>`
  );
  file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<w:styles xmlns:w="${W}">` +
      `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/>` +
      `<w:sz w:val="22"/><w:color w:val="1F2937"/></w:rPr></w:rPrDefault>` +
      `<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
      `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
      `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/>` +
      `<w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="0" w:after="240"/></w:pPr>` +
      `<w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/>` +
      `<w:b/><w:color w:val="4338CA"/><w:sz w:val="40"/></w:rPr></w:style>` +
      `</w:styles>`
  );
  file(
    "word/theme/theme1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<a:theme xmlns:a="${A}" name="Neutral Brand">` +
      `<a:themeElements><a:clrScheme name="Neutral Brand">` +
      `<a:dk1><a:srgbClr val="111827"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>` +
      `<a:dk2><a:srgbClr val="312E81"/></a:dk2><a:lt2><a:srgbClr val="F7F8FC"/></a:lt2>` +
      `<a:accent1><a:srgbClr val="4F46E5"/></a:accent1><a:accent2><a:srgbClr val="A5B4FC"/></a:accent2>` +
      `<a:accent3><a:srgbClr val="0F766E"/></a:accent3><a:accent4><a:srgbClr val="B45309"/></a:accent4>` +
      `<a:accent5><a:srgbClr val="7C3AED"/></a:accent5><a:accent6><a:srgbClr val="BE123C"/></a:accent6>` +
      `<a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7E22CE"/></a:folHlink>` +
      `</a:clrScheme><a:fontScheme name="Neutral Fonts">` +
      `<a:majorFont><a:latin typeface="Inter"/></a:majorFont>` +
      `<a:minorFont><a:latin typeface="Inter"/></a:minorFont>` +
      `</a:fontScheme><a:fmtScheme name="Neutral Format"/>` +
      `</a:themeElements></a:theme>`
  );
  file("word/media/brand-background.svg", DOCX_TEMPLATE_INTAKE_BACKGROUND_SVG);
  file("word/media/brand-header.svg", DOCX_TEMPLATE_INTAKE_HEADER_SVG);
  return zip.generate({
    type: "uint8array",
    compression: "DEFLATE",
  }) as unknown as Uint8Array;
}

export const DOCX_TEMPLATE_INTAKE_FIXTURE_BYTES =
  createDocxTemplateIntakeFixture();
