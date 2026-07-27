import {
  isPinnedAdfMarkType,
  isPinnedAdfNodeType,
  isPinnedAdfStage0NodeType,
  isSupportedAdfNodeType,
} from "./adf-coverage.js";
import {
  AdfValidationError,
  DEFAULT_ADF_PARSE_BUDGET,
  type AdfDiagnostic,
  type AdfDocument,
  type AdfJsonValue,
  type AdfParseBudget,
  type AdfValidationStats,
  type ValidatedAdfDocument,
} from "./adf-types.js";
import { trustValidatedAdf } from "./adf-validation-cache.js";

const utf8 = new TextEncoder();
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const nodeEnvelopeKeys = new Set(["type", "attrs", "content", "marks", "text", "version"]);
const markEnvelopeKeys = new Set(["type", "attrs"]);
const captionInlineNodeTypes = new Set([
  "date",
  "emoji",
  "hardBreak",
  "inlineCard",
  "mention",
  "placeholder",
  "status",
  "text",
]);

const nodeAttributeKeys: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  blockCard: new Set(["data", "datasource", "layout", "localId", "url", "width"]),
  blockTaskItem: new Set(["localId", "state"]),
  blockquote: new Set(["localId"]),
  bodiedExtension: new Set(["extensionKey", "extensionType", "layout", "localId", "parameters", "text"]),
  bodiedSyncBlock: new Set(["localId", "resourceId"]),
  bulletList: new Set(["localId"]),
  caption: new Set(["localId"]),
  codeBlock: new Set(["hideLineNumbers", "language", "localId", "uniqueId", "wrap"]),
  date: new Set(["localId", "timestamp"]),
  decisionItem: new Set(["localId", "state"]),
  decisionList: new Set(["localId"]),
  embedCard: new Set(["layout", "localId", "originalHeight", "originalWidth", "url", "width"]),
  emoji: new Set(["id", "localId", "shortName", "text"]),
  expand: new Set(["localId", "title"]),
  extension: new Set(["extensionKey", "extensionType", "layout", "localId", "parameters", "text"]),
  hardBreak: new Set(["localId", "text"]),
  heading: new Set(["level", "localId"]),
  inlineCard: new Set(["data", "localId", "url"]),
  inlineExtension: new Set(["extensionKey", "extensionType", "localId", "parameters", "text"]),
  layoutColumn: new Set(["localId", "valign", "width"]),
  layoutSection: new Set(["localId"]),
  listItem: new Set(["localId"]),
  media: new Set(["alt", "collection", "height", "id", "localId", "occurrenceKey", "type", "url", "width"]),
  mediaInline: new Set(["alt", "collection", "data", "height", "id", "localId", "occurrenceKey", "type", "width"]),
  mediaSingle: new Set(["layout", "localId", "width", "widthType"]),
  mention: new Set(["accessLevel", "id", "localId", "text", "userType"]),
  multiBodiedExtension: new Set(["extensionKey", "extensionType", "layout", "localId", "parameters", "text"]),
  nestedExpand: new Set(["localId", "title"]),
  orderedList: new Set(["localId", "order"]),
  panel: new Set(["localId", "panelColor", "panelIcon", "panelIconId", "panelIconText", "panelType"]),
  paragraph: new Set(["localId"]),
  placeholder: new Set(["localId", "text"]),
  rule: new Set(["localId"]),
  status: new Set(["color", "localId", "style", "text"]),
  syncBlock: new Set(["localId", "resourceId"]),
  table: new Set(["displayMode", "isNumberColumnEnabled", "layout", "localId", "width"]),
  tableCell: new Set(["background", "colspan", "colwidth", "localId", "rowspan", "valign"]),
  tableHeader: new Set(["background", "colspan", "colwidth", "localId", "rowspan", "valign"]),
  tableRow: new Set(["localId"]),
  taskItem: new Set(["localId", "state"]),
  taskList: new Set(["localId"]),
});

const markAttributeKeys: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  alignment: new Set(["align"]),
  annotation: new Set(["annotationType", "id"]),
  backgroundColor: new Set(["color"]),
  border: new Set(["color", "size"]),
  breakout: new Set(["mode", "width"]),
  dataConsumer: new Set(["sources"]),
  fontSize: new Set(["fontSize"]),
  fragment: new Set(["localId", "name"]),
  indentation: new Set(["level"]),
  link: new Set(["collection", "href", "id", "occurrenceKey", "title"]),
  subsup: new Set(["type"]),
  textColor: new Set(["color"]),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function mergeBudget(overrides?: Partial<AdfParseBudget>): AdfParseBudget {
  const budget = { ...DEFAULT_ADF_PARSE_BUDGET, ...overrides };
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`ADF parse budget ${name} must be a non-negative safe integer.`);
    }
  }
  return budget;
}

function stringBytes(value: string): number {
  return utf8.encode(value).byteLength;
}

function assertStringAttribute(
  attrs: Record<string, unknown> | undefined,
  key: string,
  path: string,
  required = true,
): void {
  const value = attrs?.[key];
  if ((!required && value === undefined) || typeof value === "string") return;
  throw new AdfValidationError(
    "invalid-attributes",
    `ADF attribute ${key} must be a string${required ? "" : " when present"}.`,
    `${path}.attrs.${key}`,
  );
}

const smartCardLayouts = new Set([
  "wide",
  "full-width",
  "center",
  "wrap-right",
  "wrap-left",
  "align-end",
  "align-start",
]);

const bodiedSyncBlockChildTypes = new Set([
  "paragraph",
  "blockCard",
  "blockquote",
  "bulletList",
  "codeBlock",
  "decisionList",
  "embedCard",
  "expand",
  "heading",
  "layoutSection",
  "mediaGroup",
  "mediaSingle",
  "orderedList",
  "panel",
  "rule",
  "table",
  "taskList",
]);

const extensionFrameChildTypes = new Set([
  "paragraph",
  "panel",
  "blockquote",
  "orderedList",
  "bulletList",
  "rule",
  "heading",
  "codeBlock",
  "mediaGroup",
  "mediaSingle",
  "decisionList",
  "taskList",
  "table",
  "extension",
  "bodiedExtension",
  "blockCard",
  "embedCard",
]);

function assertSmartCardLayout(
  attrs: Record<string, unknown> | undefined,
  path: string,
  required = false,
): void {
  const layout = attrs?.layout;
  if ((!required && layout === undefined) || (typeof layout === "string" && smartCardLayouts.has(layout))) {
    return;
  }
  throw new AdfValidationError(
    "invalid-attributes",
    `ADF Smart Card layout must be one of the pinned layouts${required ? "" : " when present"}.`,
    `${path}.attrs.layout`,
  );
}

function validateInlineCardAttributes(
  attrs: Record<string, unknown> | undefined,
  path: string,
): void {
  assertStringAttribute(attrs, "localId", path, false);
  const hasUrl = attrs?.url !== undefined;
  const hasData = attrs?.data !== undefined;
  if (hasUrl === hasData) {
    throw new AdfValidationError(
      "invalid-attributes",
      "ADF inlineCard requires exactly one of url or data.",
      `${path}.attrs`,
    );
  }
  if (hasUrl) assertStringAttribute(attrs, "url", path);
}

function validateDatasourcePayload(value: unknown, path: string): void {
  if (!isPlainObject(value)) {
    throw new AdfValidationError(
      "invalid-attributes",
      "ADF blockCard datasource must be an object.",
      path,
    );
  }
  const allowed = new Set(["id", "parameters", "views"]);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) {
    throw new AdfValidationError(
      "invalid-attributes",
      `ADF blockCard datasource contains unsupported key ${extra}.`,
      `${path}.${extra}`,
    );
  }
  if (typeof value.id !== "string" || value.parameters === undefined || !Array.isArray(value.views) || value.views.length === 0) {
    throw new AdfValidationError(
      "invalid-attributes",
      "ADF blockCard datasource requires string id, parameters, and at least one view.",
      path,
    );
  }
  value.views.forEach((view, index) => {
    if (!isPlainObject(view) || typeof view.type !== "string") {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF datasource views require a string type.",
        `${path}.views[${index}]`,
      );
    }
    const extraViewKey = Object.keys(view).find((key) => key !== "type" && key !== "properties");
    if (extraViewKey) {
      throw new AdfValidationError(
        "invalid-attributes",
        `ADF datasource view contains unsupported key ${extraViewKey}.`,
        `${path}.views[${index}].${extraViewKey}`,
      );
    }
  });
}

function validateBlockCardAttributes(
  attrs: Record<string, unknown> | undefined,
  path: string,
): void {
  assertStringAttribute(attrs, "localId", path, false);
  const hasDatasource = attrs?.datasource !== undefined;
  const hasData = attrs?.data !== undefined;
  const hasUrl = attrs?.url !== undefined;
  const variantCount = Number(hasDatasource) + Number(hasData) + Number(hasUrl && !hasDatasource);
  if (variantCount !== 1 || (hasDatasource && hasData) || (hasData && hasUrl)) {
    throw new AdfValidationError(
      "invalid-attributes",
      "ADF blockCard must match exactly one url, data, or datasource variant.",
      `${path}.attrs`,
    );
  }
  if (hasDatasource) {
    validateDatasourcePayload(attrs?.datasource, `${path}.attrs.datasource`);
    assertStringAttribute(attrs, "url", path, false);
    assertOptionalNumberAttribute(attrs, "width", path);
    assertSmartCardLayout(attrs, path);
    return;
  }
  if (attrs?.layout !== undefined || attrs?.width !== undefined) {
    throw new AdfValidationError(
      "invalid-attributes",
      "ADF blockCard layout and width are valid only for datasource cards.",
      `${path}.attrs`,
    );
  }
  if (hasUrl) assertStringAttribute(attrs, "url", path);
}

function validateEmbedCardAttributes(
  attrs: Record<string, unknown> | undefined,
  path: string,
): void {
  assertStringAttribute(attrs, "url", path);
  assertStringAttribute(attrs, "localId", path, false);
  assertSmartCardLayout(attrs, path, true);
  assertOptionalNumberAttribute(attrs, "width", path);
  assertOptionalNumberAttribute(attrs, "originalHeight", path);
  assertOptionalNumberAttribute(attrs, "originalWidth", path);
  const width = attrs?.width;
  if (typeof width === "number" && (width < 0 || width > 100)) {
    throw new AdfValidationError(
      "invalid-attributes",
      "ADF embedCard width must be from 0 through 100.",
      `${path}.attrs.width`,
    );
  }
}

function assertOptionalNumberAttribute(
  attrs: Record<string, unknown> | undefined,
  key: string,
  path: string,
): void {
  const value = attrs?.[key];
  if (value === undefined || typeof value === "number") return;
  throw new AdfValidationError(
    "invalid-attributes",
    `ADF attribute ${key} must be a number when present.`,
    `${path}.attrs.${key}`,
  );
}

function assertOptionalBooleanAttribute(
  attrs: Record<string, unknown> | undefined,
  key: string,
  path: string,
): void {
  const value = attrs?.[key];
  if (value === undefined || typeof value === "boolean") return;
  throw new AdfValidationError(
    "invalid-attributes",
    `ADF attribute ${key} must be a boolean when present.`,
    `${path}.attrs.${key}`,
  );
}

function validateKnownNodeShape(
  type: string,
  node: Record<string, unknown>,
  attrs: Record<string, unknown> | undefined,
  path: string,
  parentType?: string,
): void {
  if (type === "text") {
    if (typeof node.text !== "string" || node.content !== undefined) {
      throw new AdfValidationError(
        "invalid-node",
        "ADF text nodes require text and cannot contain child content.",
        path,
      );
    }
  }
  if (type === "heading") {
    const level = attrs?.level;
    if (!Number.isInteger(level) || (level as number) < 1 || (level as number) > 6) {
      throw new AdfValidationError("invalid-attributes", "ADF heading level must be 1..6.", `${path}.attrs.level`);
    }
  }
  if (type === "paragraph" || type === "heading" || type === "listItem") {
    assertStringAttribute(attrs, "localId", path, false);
  }
  if (type === "syncBlock" || type === "bodiedSyncBlock") {
    assertStringAttribute(attrs, "resourceId", path);
    assertStringAttribute(attrs, "localId", path);
    if (
      Array.isArray(node.marks) &&
      node.marks.some((mark) => !isPlainObject(mark) || mark.type !== "breakout")
    ) {
      throw new AdfValidationError(
        "invalid-node",
        `ADF ${type} nodes accept breakout marks only.`,
        `${path}.marks`,
      );
    }
    if (type === "syncBlock" && node.content !== undefined) {
      throw new AdfValidationError(
        "invalid-node",
        "ADF syncBlock is a reference-only node and cannot contain child content.",
        `${path}.content`,
      );
    }
    if (
      type === "bodiedSyncBlock" &&
      (!Array.isArray(node.content) || node.content.length === 0)
    ) {
      throw new AdfValidationError(
        "invalid-node",
        "ADF bodiedSyncBlock requires at least one embedded snapshot block.",
        `${path}.content`,
      );
    }
    if (
      type === "bodiedSyncBlock" &&
      Array.isArray(node.content) &&
      node.content.some(
        (child) =>
          !isPlainObject(child) ||
          typeof child.type !== "string" ||
          !bodiedSyncBlockChildTypes.has(child.type),
      )
    ) {
      throw new AdfValidationError(
        "invalid-node",
        "ADF bodiedSyncBlock content must contain schema-defined top-level snapshot blocks.",
        `${path}.content`,
      );
    }
  }
  if (type === "codeBlock") {
    assertStringAttribute(attrs, "language", path, false);
    assertStringAttribute(attrs, "localId", path, false);
    assertStringAttribute(attrs, "uniqueId", path, false);
    assertOptionalBooleanAttribute(attrs, "wrap", path);
    assertOptionalBooleanAttribute(attrs, "hideLineNumbers", path);
    if (Array.isArray(node.marks) && node.marks.length > 0) {
      const hasOnlyRootBreakout =
        node.marks.length === 1 &&
        isPlainObject(node.marks[0]) &&
        node.marks[0].type === "breakout";
      const isTopLevel = /^\$\.content\[\d+\]$/u.test(path);
      if (!hasOnlyRootBreakout || !isTopLevel) {
        throw new AdfValidationError(
          "invalid-node",
          "ADF code blocks accept one breakout mark only at the document root.",
          `${path}.marks`,
        );
      }
    }
    if (
      Array.isArray(node.content) &&
      node.content.some(
        (child) =>
          !isPlainObject(child) ||
          child.type !== "text" ||
          (
            child.marks !== undefined &&
            (!Array.isArray(child.marks) || child.marks.length > 0)
          ),
      )
    ) {
      throw new AdfValidationError(
        "invalid-node",
        "ADF code-block content must contain only unmarked text nodes.",
        `${path}.content`,
      );
    }
  }
  if (type === "orderedList" && attrs?.order !== undefined && !nonnegativeInteger(attrs.order)) {
    throw new AdfValidationError("invalid-attributes", "ADF ordered-list order must be non-negative.", `${path}.attrs.order`);
  }
  if (type === "taskItem" || type === "blockTaskItem") {
    if (attrs?.state !== "TODO" && attrs?.state !== "DONE") {
      throw new AdfValidationError("invalid-attributes", "ADF task state must be TODO or DONE.", `${path}.attrs.state`);
    }
  }
  if (
    type === "taskList" ||
    type === "taskItem" ||
    type === "blockTaskItem" ||
    type === "decisionList" ||
    type === "decisionItem"
  ) {
    assertStringAttribute(attrs, "localId", path);
  }
  if (type === "decisionItem") {
    assertStringAttribute(attrs, "state", path);
  }
  if (type === "panel") {
    assertStringAttribute(attrs, "localId", path, false);
    assertStringAttribute(attrs, "panelColor", path, false);
    assertStringAttribute(attrs, "panelIcon", path, false);
    assertStringAttribute(attrs, "panelIconId", path, false);
    assertStringAttribute(attrs, "panelIconText", path, false);
    const panelType = attrs?.panelType;
    if (
      panelType !== "info" &&
      panelType !== "note" &&
      panelType !== "tip" &&
      panelType !== "warning" &&
      panelType !== "error" &&
      panelType !== "success" &&
      panelType !== "custom"
    ) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF panel type must be info, note, tip, warning, error, success, or custom.",
        `${path}.attrs.panelType`,
      );
    }
  }
  if (type === "caption") {
    assertStringAttribute(attrs, "localId", path, false);
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) {
        throw new AdfValidationError(
          "invalid-node",
          "ADF caption content must be an array when present.",
          `${path}.content`,
        );
      }
      for (let index = 0; index < node.content.length; index += 1) {
        const child = node.content[index];
        if (
          !isPlainObject(child) ||
          typeof child.type !== "string" ||
          !captionInlineNodeTypes.has(child.type)
        ) {
          throw new AdfValidationError(
            "invalid-node",
            "ADF caption content must contain only pinned inline nodes.",
            `${path}.content[${index}]`,
          );
        }
      }
    }
  }
  if (type === "expand" || type === "nestedExpand") {
    assertStringAttribute(attrs, "title", path, false);
    assertStringAttribute(attrs, "localId", path, false);
    if (!Array.isArray(node.content) || node.content.length === 0) {
      throw new AdfValidationError(
        "invalid-node",
        `ADF ${type} requires at least one child block.`,
        `${path}.content`,
      );
    }
    if (type === "nestedExpand") {
      if (attrs === undefined) {
        throw new AdfValidationError(
          "invalid-attributes",
          "ADF nestedExpand requires an attrs object.",
          `${path}.attrs`,
        );
      }
      if (Array.isArray(node.marks) && node.marks.length > 0) {
        throw new AdfValidationError(
          "invalid-node",
          "ADF nestedExpand does not accept non-empty marks.",
          `${path}.marks`,
        );
      }
    } else if (Array.isArray(node.marks) && node.marks.length > 0) {
      const hasOnlyRootBreakout =
        node.marks.length === 1 &&
        isPlainObject(node.marks[0]) &&
        node.marks[0].type === "breakout";
      const isTopLevel = /^\$\.content\[\d+\]$/u.test(path);
      if (!hasOnlyRootBreakout || !isTopLevel) {
        throw new AdfValidationError(
          "invalid-node",
          "ADF expand nodes accept one breakout mark only at the document root.",
          `${path}.marks`,
        );
      }
    }
  }
  if (type === "date") {
    assertStringAttribute(attrs, "timestamp", path);
    if ((attrs?.timestamp as string).length === 0) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF date timestamp must be non-empty.",
        `${path}.attrs.timestamp`,
      );
    }
    assertStringAttribute(attrs, "localId", path, false);
  }
  if (type === "emoji") assertStringAttribute(attrs, "shortName", path);
  if (type === "mention") {
    assertStringAttribute(attrs, "id", path);
    assertStringAttribute(attrs, "localId", path, false);
    assertStringAttribute(attrs, "text", path, false);
    assertStringAttribute(attrs, "accessLevel", path, false);
    if (
      attrs?.userType !== undefined &&
      attrs.userType !== "DEFAULT" &&
      attrs.userType !== "SPECIAL" &&
      attrs.userType !== "APP"
    ) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF mention userType must be DEFAULT, SPECIAL, or APP.",
        `${path}.attrs.userType`,
      );
    }
  }
  if (type === "placeholder") {
    assertStringAttribute(attrs, "text", path);
    assertStringAttribute(attrs, "localId", path, false);
  }
  if (type === "status") {
    assertStringAttribute(attrs, "text", path);
    if ((attrs?.text as string).length === 0) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF status text must be non-empty.",
        `${path}.attrs.text`,
      );
    }
    const color = attrs?.color;
    if (
      color !== "neutral" &&
      color !== "purple" &&
      color !== "blue" &&
      color !== "red" &&
      color !== "yellow" &&
      color !== "green"
    ) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF status color must be neutral, purple, blue, red, yellow, or green.",
        `${path}.attrs.color`,
      );
    }
    assertStringAttribute(attrs, "localId", path, false);
    assertStringAttribute(attrs, "style", path, false);
  }
  if (type === "inlineCard") validateInlineCardAttributes(attrs, path);
  if (type === "blockCard") validateBlockCardAttributes(attrs, path);
  if (type === "embedCard") validateEmbedCardAttributes(attrs, path);
  if (type === "media" || type === "mediaInline") {
    const mediaType = attrs?.type;
    const allowedTypes =
      type === "media"
        ? new Set(["file", "link", "external"])
        : new Set(["file", "link", "image"]);
    const typeIsRequired = type === "media";
    if (
      (typeIsRequired && typeof mediaType !== "string") ||
      (mediaType !== undefined && (typeof mediaType !== "string" || !allowedTypes.has(mediaType)))
    ) {
      throw new AdfValidationError(
        "invalid-attributes",
        `ADF ${type} type is not part of the pinned schema.`,
        `${path}.attrs.type`,
      );
    }
    assertStringAttribute(attrs, "localId", path, false);
    assertStringAttribute(attrs, "alt", path, false);
    assertOptionalNumberAttribute(attrs, "width", path);
    assertOptionalNumberAttribute(attrs, "height", path);
    if (type === "media" && mediaType === "external") {
      assertStringAttribute(attrs, "url", path);
    } else {
      assertStringAttribute(attrs, "id", path);
      assertStringAttribute(attrs, "collection", path);
      if ((attrs?.id as string).length === 0) {
        throw new AdfValidationError(
          "invalid-attributes",
          `ADF ${type} id must be non-empty.`,
          `${path}.attrs.id`,
        );
      }
    }
    assertStringAttribute(attrs, "occurrenceKey", path, false);
    if (attrs?.occurrenceKey === "") {
      throw new AdfValidationError(
        "invalid-attributes",
        `ADF ${type} occurrenceKey must be non-empty when present.`,
        `${path}.attrs.occurrenceKey`,
      );
    }
  }
  if (type === "mediaSingle" && attrs !== undefined) {
    const layout = attrs.layout;
    if (
      layout !== "wide" &&
      layout !== "full-width" &&
      layout !== "center" &&
      layout !== "wrap-right" &&
      layout !== "wrap-left" &&
      layout !== "align-end" &&
      layout !== "align-start"
    ) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF mediaSingle layout is not part of the pinned schema.",
        `${path}.attrs.layout`,
      );
    }
    assertStringAttribute(attrs, "localId", path, false);
    assertOptionalNumberAttribute(attrs, "width", path);
    const widthType = attrs.widthType;
    if (
      widthType !== undefined &&
      widthType !== "percentage" &&
      widthType !== "pixel"
    ) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF mediaSingle widthType must be percentage or pixel.",
        `${path}.attrs.widthType`,
      );
    }
    if (widthType === "pixel" && typeof attrs.width !== "number") {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF pixel mediaSingle requires a numeric width.",
        `${path}.attrs.width`,
      );
    }
    if (
      widthType !== "pixel" &&
      typeof attrs.width === "number" &&
      (attrs.width < 0 || attrs.width > 100)
    ) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF percentage mediaSingle width must be from 0 through 100.",
        `${path}.attrs.width`,
      );
    }
  }
  if (type === "extension" || type === "inlineExtension" || type === "bodiedExtension") {
    assertStringAttribute(attrs, "extensionType", path);
    assertStringAttribute(attrs, "extensionKey", path);
  }
  if (type === "multiBodiedExtension") {
    if (parentType !== "doc") {
      throw new AdfValidationError(
        "invalid-node",
        "ADF multiBodiedExtension is a root-only Stage-0 node.",
        path,
      );
    }
    assertStringAttribute(attrs, "extensionType", path);
    assertStringAttribute(attrs, "extensionKey", path);
    if ((attrs?.extensionType as string).length === 0 || (attrs?.extensionKey as string).length === 0) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF multiBodiedExtension extensionType and extensionKey must be non-empty.",
        `${path}.attrs`,
      );
    }
    assertStringAttribute(attrs, "text", path, false);
    assertStringAttribute(attrs, "localId", path, false);
    if (attrs?.localId === "") {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF multiBodiedExtension localId must be non-empty when present.",
        `${path}.attrs.localId`,
      );
    }
    const layout = attrs?.layout;
    if (
      layout !== undefined &&
      layout !== "default" &&
      layout !== "wide" &&
      layout !== "full-width"
    ) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF multiBodiedExtension layout must be default, wide, or full-width.",
        `${path}.attrs.layout`,
      );
    }
    if (node.text !== undefined || node.version !== undefined) {
      throw new AdfValidationError(
        "invalid-node",
        "ADF multiBodiedExtension accepts only type, attrs, content, and an empty marks array.",
        path,
      );
    }
    if (node.marks !== undefined && (!Array.isArray(node.marks) || node.marks.length > 0)) {
      throw new AdfValidationError(
        "invalid-node",
        "ADF multiBodiedExtension accepts only an empty marks array.",
        `${path}.marks`,
      );
    }
    if (
      !Array.isArray(node.content) ||
      node.content.some((child) => !isPlainObject(child) || child.type !== "extensionFrame")
    ) {
      throw new AdfValidationError(
        "invalid-node",
        "ADF multiBodiedExtension content must contain only extensionFrame nodes.",
        `${path}.content`,
      );
    }
  }
  if (type === "extensionFrame") {
    if (parentType !== "multiBodiedExtension") {
      throw new AdfValidationError(
        "invalid-node",
        "ADF extensionFrame is valid only inside multiBodiedExtension.",
        path,
      );
    }
    if (attrs !== undefined || node.text !== undefined || node.version !== undefined) {
      throw new AdfValidationError(
        "invalid-node",
        "ADF extensionFrame accepts only type, content, and optional dataConsumer/fragment marks.",
        path,
      );
    }
    if (!Array.isArray(node.content) || node.content.length === 0) {
      throw new AdfValidationError(
        "invalid-node",
        "ADF extensionFrame requires at least one child block.",
        `${path}.content`,
      );
    }
    if (
      node.content.some(
        (child) =>
          !isPlainObject(child) ||
          typeof child.type !== "string" ||
          !extensionFrameChildTypes.has(child.type),
      )
    ) {
      throw new AdfValidationError(
        "invalid-node",
        "ADF extensionFrame contains a child type outside the pinned Stage-0 contract.",
        `${path}.content`,
      );
    }
    if (
      Array.isArray(node.marks) &&
      node.marks.some(
        (mark) =>
          !isPlainObject(mark) ||
          (mark.type !== "dataConsumer" && mark.type !== "fragment"),
      )
    ) {
      throw new AdfValidationError(
        "invalid-node",
        "ADF extensionFrame accepts dataConsumer and fragment marks only.",
        `${path}.marks`,
      );
    }
  }
  if (type === "table") {
    const displayMode = attrs?.displayMode;
    if (displayMode !== undefined && displayMode !== "default" && displayMode !== "fixed") {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF table displayMode must be default or fixed.",
        `${path}.attrs.displayMode`,
      );
    }
    const layout = attrs?.layout;
    if (
      layout !== undefined &&
      layout !== "default" &&
      layout !== "wide" &&
      layout !== "full-width" &&
      layout !== "center" &&
      layout !== "align-start" &&
      layout !== "align-end"
    ) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF table layout is not part of the pinned schema.",
        `${path}.attrs.layout`,
      );
    }
    if (attrs?.isNumberColumnEnabled !== undefined && typeof attrs.isNumberColumnEnabled !== "boolean") {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF table isNumberColumnEnabled must be a boolean.",
        `${path}.attrs.isNumberColumnEnabled`,
      );
    }
    assertOptionalNumberAttribute(attrs, "width", path);
    assertStringAttribute(attrs, "localId", path, false);
    if (attrs?.localId === "") {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF table localId must be non-empty when present.",
        `${path}.attrs.localId`,
      );
    }
  }
  if (type === "tableRow") {
    assertStringAttribute(attrs, "localId", path, false);
  }
  if (type === "tableCell" || type === "tableHeader") {
    assertOptionalNumberAttribute(attrs, "colspan", path);
    assertOptionalNumberAttribute(attrs, "rowspan", path);
    assertStringAttribute(attrs, "background", path, false);
    assertStringAttribute(attrs, "localId", path, false);
    const colwidth = attrs?.colwidth;
    if (
      colwidth !== undefined &&
      (!Array.isArray(colwidth) || colwidth.some((width) => typeof width !== "number"))
    ) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF table-cell colwidth must be an array of numbers.",
        `${path}.attrs.colwidth`,
      );
    }
    const valign = attrs?.valign;
    if (valign !== undefined && valign !== "top" && valign !== "middle" && valign !== "bottom") {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF table-cell valign must be top, middle, or bottom.",
        `${path}.attrs.valign`,
      );
    }
  }
  if (type === "layoutSection") {
    assertStringAttribute(attrs, "localId", path, false);
  }
  if (type === "layoutColumn") {
    const width = attrs?.width;
    if (typeof width !== "number" || width < 0 || width > 100) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF layout-column width must be a number from 0 through 100.",
        `${path}.attrs.width`,
      );
    }
    assertStringAttribute(attrs, "localId", path, false);
    const valign = attrs?.valign;
    if (valign !== undefined && valign !== "top" && valign !== "middle" && valign !== "bottom") {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF layout-column valign must be top, middle, or bottom.",
        `${path}.attrs.valign`,
      );
    }
  }
}

function validateKnownMarkShape(
  type: string,
  attrs: Record<string, unknown> | undefined,
  path: string,
): void {
  if (type === "alignment" && attrs?.align !== "center" && attrs?.align !== "end") {
    throw new AdfValidationError(
      "invalid-attributes",
      "ADF alignment must be center or end.",
      `${path}.attrs.align`,
    );
  }
  if (type === "indentation") {
    const level = attrs?.level;
    if (!Number.isInteger(level) || (level as number) < 1 || (level as number) > 6) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF indentation level must be an integer from 1 through 6.",
        `${path}.attrs.level`,
      );
    }
  }
  if (type === "fontSize" && attrs?.fontSize !== "small") {
    throw new AdfValidationError(
      "invalid-attributes",
      'ADF fontSize must be "small".',
      `${path}.attrs.fontSize`,
    );
  }
  if (type === "annotation") {
    assertStringAttribute(attrs, "id", path);
    if (attrs?.annotationType !== "inlineComment") {
      throw new AdfValidationError(
        "invalid-attributes",
        'ADF annotationType must be "inlineComment".',
        `${path}.attrs.annotationType`,
      );
    }
  }
  if (type === "fragment") {
    assertStringAttribute(attrs, "localId", path);
    if ((attrs?.localId as string).length === 0) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF fragment localId must be non-empty.",
        `${path}.attrs.localId`,
      );
    }
    assertStringAttribute(attrs, "name", path, false);
  }
  if (type === "breakout") {
    if (attrs?.mode !== "wide" && attrs?.mode !== "full-width") {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF breakout mode must be wide or full-width.",
        `${path}.attrs.mode`,
      );
    }
    assertOptionalNumberAttribute(attrs, "width", path);
  }
  if (type === "dataConsumer") {
    const sources = attrs?.sources;
    if (
      !Array.isArray(sources) ||
      sources.length === 0 ||
      sources.some((source) => typeof source !== "string")
    ) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF dataConsumer sources must be a non-empty array of strings.",
        `${path}.attrs.sources`,
      );
    }
  }
  if (type === "link") assertStringAttribute(attrs, "href", path);
  if (type === "border") {
    const size = attrs?.size;
    const color = attrs?.color;
    if (size !== 1 && size !== 2 && size !== 3) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF media border size must be 1, 2, or 3.",
        `${path}.attrs.size`,
      );
    }
    if (typeof color !== "string" || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(color)) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF media border color must be a six- or eight-digit hex color.",
        `${path}.attrs.color`,
      );
    }
  }
  if (type === "textColor" || type === "backgroundColor") {
    assertStringAttribute(attrs, "color", path);
  }
  if (type === "subsup" && attrs?.type !== "sub" && attrs?.type !== "sup") {
    throw new AdfValidationError("invalid-attributes", "ADF subsup type must be sub or sup.", `${path}.attrs.type`);
  }
}

/**
 * Parse and structurally validate untrusted ADF without recursive traversal.
 *
 * Unknown node, mark, and attribute names survive as bounded drift
 * diagnostics. Malformed envelopes, hostile object graphs, and exceeded
 * resource budgets fail closed before a decoder can run.
 */
export function validateAdf(
  input: string | unknown,
  options: { budget?: Partial<AdfParseBudget> } = {},
): ValidatedAdfDocument {
  const budget = mergeBudget(options.budget);
  let value: unknown = input;
  let inputBytes: number | undefined;
  if (typeof input === "string") {
    inputBytes = stringBytes(input);
    if (inputBytes > budget.maxInputBytes) {
      throw new AdfValidationError("input-too-large", "ADF input exceeds its UTF-8 byte budget.");
    }
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      throw new AdfValidationError("invalid-json", "ADF body is not valid JSON.");
    }
  }

  if (!isPlainObject(value) || value.type !== "doc" || !Array.isArray(value.content)) {
    throw new AdfValidationError("invalid-root", "ADF root must be a doc object with content.");
  }
  if (value.version !== 1) {
    throw new AdfValidationError("unsupported-version", "Only ADF document version 1 is supported.", "$.version");
  }

  const stats: AdfValidationStats = {
    inputBytes,
    nodes: 0,
    marks: 0,
    maxDepth: 0,
    textBytes: 0,
    attributeBytes: 0,
    attributeValues: 0,
  };
  const diagnostics: AdfDiagnostic[] = [];
  let droppedDiagnostics = 0;
  const seen = new WeakSet<object>();
  const claim = (candidate: object, path: string, code: "invalid-node" | "invalid-mark" | "invalid-attributes"): void => {
    if (seen.has(candidate)) {
      throw new AdfValidationError(code, "ADF object graph contains a cycle or shared object.", path);
    }
    seen.add(candidate);
  };
  const addDiagnostic = (diagnostic: AdfDiagnostic): void => {
    if (diagnostics.length < budget.maxDiagnostics) diagnostics.push(diagnostic);
    else droppedDiagnostics += 1;
  };

  claim(value, "$", "invalid-node");
  const stack: Array<{
    node: Record<string, unknown>;
    path: string;
    depth: number;
    claimed: boolean;
    parentType?: string;
  }> = [
    { node: value, path: "$", depth: 0, claimed: true },
  ];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const { node, path, depth, parentType } = current;
    if (!current.claimed) claim(node, path, "invalid-node");
    stats.nodes += 1;
    if (stats.nodes > budget.maxNodes) {
      throw new AdfValidationError("node-budget-exceeded", "ADF node budget exceeded.", path);
    }
    if (depth > budget.maxDepth) {
      throw new AdfValidationError("depth-budget-exceeded", "ADF depth budget exceeded.", path);
    }
    stats.maxDepth = Math.max(stats.maxDepth, depth);

    const type = node.type;
    if (typeof type !== "string" || type.length === 0 || type.length > 256) {
      throw new AdfValidationError("invalid-node", "ADF node type must be a bounded non-empty string.", `${path}.type`);
    }
    for (const key of Object.keys(node)) {
      if (forbiddenKeys.has(key)) {
        throw new AdfValidationError("invalid-node", `Forbidden ADF object key ${key}.`, `${path}.${key}`);
      }
      if (!nodeEnvelopeKeys.has(key)) {
        addDiagnostic({ kind: "unknown-attribute", path, type, attribute: key });
      }
    }
    if (!isSupportedAdfNodeType(type)) addDiagnostic({ kind: "unknown-node", path, type });

    if (node.text !== undefined) {
      if (typeof node.text !== "string") {
        throw new AdfValidationError("invalid-node", "ADF node text must be a string.", `${path}.text`);
      }
      stats.textBytes += stringBytes(node.text);
      if (stats.textBytes > budget.maxTextBytes) {
        throw new AdfValidationError("text-budget-exceeded", "ADF text budget exceeded.", `${path}.text`);
      }
    }

    let attrs: Record<string, unknown> | undefined;
    if (node.attrs !== undefined) {
      if (!isPlainObject(node.attrs)) {
        throw new AdfValidationError("invalid-attributes", "ADF node attrs must be a plain object.", `${path}.attrs`);
      }
      attrs = node.attrs;
      const allowed = nodeAttributeKeys[type] ?? new Set<string>();
      for (const key of Object.keys(attrs)) {
        if (!allowed.has(key)) addDiagnostic({ kind: "unknown-attribute", path, type, attribute: key });
      }
      validateAttributeGraph(attrs, `${path}.attrs`, budget, stats, claim);
    }
    if (isPinnedAdfNodeType(type) || isPinnedAdfStage0NodeType(type)) {
      validateKnownNodeShape(type, node, attrs, path, parentType);
    }

    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks)) {
        throw new AdfValidationError("invalid-node", "ADF marks must be an array.", `${path}.marks`);
      }
      claim(node.marks, `${path}.marks`, "invalid-mark");
      for (let index = 0; index < node.marks.length; index += 1) {
        const markPath = `${path}.marks[${index}]`;
        const mark = node.marks[index];
        if (!isPlainObject(mark)) {
          throw new AdfValidationError("invalid-mark", "ADF mark must be a plain object.", markPath);
        }
        claim(mark, markPath, "invalid-mark");
        stats.marks += 1;
        if (stats.marks > budget.maxMarks) {
          throw new AdfValidationError("mark-budget-exceeded", "ADF mark budget exceeded.", markPath);
        }
        if (typeof mark.type !== "string" || mark.type.length === 0 || mark.type.length > 256) {
          throw new AdfValidationError("invalid-mark", "ADF mark type must be a bounded non-empty string.", `${markPath}.type`);
        }
        for (const key of Object.keys(mark)) {
          if (forbiddenKeys.has(key)) {
            throw new AdfValidationError("invalid-mark", `Forbidden ADF object key ${key}.`, `${markPath}.${key}`);
          }
          if (!markEnvelopeKeys.has(key)) {
            addDiagnostic({ kind: "unknown-attribute", path: markPath, type: mark.type, attribute: key });
          }
        }
        if (!isPinnedAdfMarkType(mark.type)) {
          addDiagnostic({ kind: "unknown-mark", path: markPath, type: mark.type });
        }
        let markAttrs: Record<string, unknown> | undefined;
        if (mark.attrs !== undefined) {
          if (!isPlainObject(mark.attrs)) {
            throw new AdfValidationError("invalid-attributes", "ADF mark attrs must be a plain object.", `${markPath}.attrs`);
          }
          markAttrs = mark.attrs;
          const allowed = markAttributeKeys[mark.type] ?? new Set<string>();
          for (const key of Object.keys(markAttrs)) {
            if (!allowed.has(key)) {
              addDiagnostic({ kind: "unknown-attribute", path: markPath, type: mark.type, attribute: key });
            }
          }
          validateAttributeGraph(markAttrs, `${markPath}.attrs`, budget, stats, claim);
        }
        if (isPinnedAdfMarkType(mark.type)) validateKnownMarkShape(mark.type, markAttrs, markPath);
      }
    }

    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) {
        throw new AdfValidationError("invalid-node", "ADF node content must be an array.", `${path}.content`);
      }
      claim(node.content, `${path}.content`, "invalid-node");
      for (let index = node.content.length - 1; index >= 0; index -= 1) {
        const child = node.content[index];
        const childPath = `${path}.content[${index}]`;
        if (!isPlainObject(child)) {
          throw new AdfValidationError("invalid-node", "ADF child must be a plain object.", childPath);
        }
        stack.push({
          node: child,
          path: childPath,
          depth: depth + 1,
          claimed: false,
          parentType: type,
        });
      }
    }
  }

  if (droppedDiagnostics > 0 && budget.maxDiagnostics > 0) {
    const summary: AdfDiagnostic = {
      kind: "diagnostics-truncated",
      path: "$",
      count: droppedDiagnostics + (diagnostics.length === budget.maxDiagnostics ? 1 : 0),
    };
    if (diagnostics.length === budget.maxDiagnostics) diagnostics[diagnostics.length - 1] = summary;
    else diagnostics.push(summary);
  }

  return trustValidatedAdf({
    document: value as unknown as AdfDocument,
    diagnostics,
    stats,
  });
}

function validateAttributeGraph(
  root: Record<string, unknown>,
  rootPath: string,
  budget: AdfParseBudget,
  stats: AdfValidationStats,
  claim: (candidate: object, path: string, code: "invalid-attributes") => void,
): asserts root is Record<string, AdfJsonValue> {
  claim(root, rootPath, "invalid-attributes");
  const stack: Array<{ value: unknown; path: string; key?: string; claimed?: boolean }> = [
    { value: root, path: rootPath, claimed: true },
  ];
  while (stack.length > 0) {
    const current = stack.pop()!;
    stats.attributeValues += 1;
    if (stats.attributeValues > budget.maxAttributeValues) {
      throw new AdfValidationError("attribute-budget-exceeded", "ADF attribute value budget exceeded.", current.path);
    }
    if (current.key !== undefined) stats.attributeBytes += stringBytes(current.key);
    const candidate = current.value;
    if (candidate === null || typeof candidate === "boolean") {
      stats.attributeBytes += candidate === null ? 4 : candidate ? 4 : 5;
    } else if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new AdfValidationError("invalid-attributes", "ADF attributes cannot contain non-finite numbers.", current.path);
      }
      stats.attributeBytes += String(candidate).length;
    } else if (typeof candidate === "string") {
      stats.attributeBytes += stringBytes(candidate);
    } else if (Array.isArray(candidate)) {
      if (!current.claimed) claim(candidate, current.path, "invalid-attributes");
      for (let index = candidate.length - 1; index >= 0; index -= 1) {
        stack.push({ value: candidate[index], path: `${current.path}[${index}]` });
      }
    } else if (isPlainObject(candidate)) {
      if (!current.claimed) claim(candidate, current.path, "invalid-attributes");
      for (const key of Object.keys(candidate)) {
        if (forbiddenKeys.has(key)) {
          throw new AdfValidationError("invalid-attributes", `Forbidden ADF attribute key ${key}.`, `${current.path}.${key}`);
        }
        stack.push({ value: candidate[key], path: `${current.path}.${key}`, key });
      }
    } else {
      throw new AdfValidationError("invalid-attributes", "ADF attributes must contain only JSON values.", current.path);
    }
    if (stats.attributeBytes > budget.maxAttributeBytes) {
      throw new AdfValidationError("attribute-budget-exceeded", "ADF attribute byte budget exceeded.", current.path);
    }
  }
}
