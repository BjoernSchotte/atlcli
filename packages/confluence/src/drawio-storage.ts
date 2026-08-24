/**
 * Internal Draw.io Storage XHTML compatibility helpers.
 *
 * This adapter deliberately lives behind `@atlcli/confluence/internal`: it is
 * not the long-term semantic sync model and may be replaced by ADF/Storage
 * writers later without freezing a byte-level patcher as public API.
 */
import { parseXml, type XmlElement, type XmlNode } from "./export-blocks.js";

const DRAWIO_MACRO_NAMES = new Set(["drawio", "inc-drawio", "drawio-sketch"]);

interface ElementSpan {
  name: string;
  start: number;
  startTagEnd: number;
  endTagStart: number;
  end: number;
  parent?: ElementSpan;
}

function tagEnd(xml: string, start: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = start + 1; index < xml.length; index++) {
    const char = xml[index];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index + 1;
    }
  }
  return -1;
}

/** Locate element byte ranges without reserializing the surrounding body. */
function elementSpans(xml: string): ElementSpan[] {
  const spans: ElementSpan[] = [];
  const stack: ElementSpan[] = [];
  let cursor = 0;

  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start < 0) break;
    if (xml.startsWith("<!--", start)) {
      const end = xml.indexOf("-->", start + 4);
      cursor = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", start)) {
      const end = xml.indexOf("]]>", start + 9);
      cursor = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<?", start)) {
      const end = xml.indexOf("?>", start + 2);
      cursor = end < 0 ? xml.length : end + 2;
      continue;
    }

    const end = tagEnd(xml, start);
    if (end < 0) break;
    const tag = xml.slice(start + 1, end - 1).trim();
    if (tag.startsWith("!")) {
      cursor = end;
      continue;
    }

    const closing = tag.startsWith("/");
    const body = closing ? tag.slice(1).trimStart() : tag;
    const name = /^([^\s/>]+)/.exec(body)?.[1]?.toLowerCase();
    if (!name) {
      cursor = end;
      continue;
    }

    if (closing) {
      const open = stack.at(-1);
      if (open?.name === name) {
        stack.pop();
        open.endTagStart = start;
        open.end = end;
        spans.push(open);
      }
    } else {
      const span: ElementSpan = {
        name,
        start,
        startTagEnd: end,
        endTagStart: -1,
        end: -1,
        parent: stack.at(-1),
      };
      if (/\/\s*$/.test(tag)) {
        span.endTagStart = end;
        span.end = end;
        spans.push(span);
      } else {
        stack.push(span);
      }
    }
    cursor = end;
  }

  return spans;
}

function firstElement(fragment: string): XmlElement | undefined {
  return parseXml(fragment).find((node): node is XmlElement => node.type === "element");
}

function openingElement(storage: string, span: ElementSpan): XmlElement | undefined {
  const openingTag = storage.slice(span.start, span.startTagEnd);
  const standalone = /\/\s*>$/.test(openingTag)
    ? openingTag
    : openingTag.replace(/>$/, "/>");
  return firstElement(standalone);
}

function textOf(node: XmlNode): string {
  return node.type === "text" ? node.text : node.children.map(textOf).join("");
}

/**
 * Patch direct Draw.io `contentVer`/`revision` parameters after upload.
 * Source ranges are applied backwards, keeping all unrelated XHTML byte exact.
 */
export function updateDrawioAttachmentVersions(
  storage: string,
  versions: ReadonlyMap<string, number>,
): string {
  if (versions.size === 0) return storage;

  const spans = elementSpans(storage);
  const children = new Map<ElementSpan, ElementSpan[]>();
  for (const span of spans) {
    if (!span.parent) continue;
    const direct = children.get(span.parent) ?? [];
    direct.push(span);
    children.set(span.parent, direct);
  }
  const patches: Array<{ start: number; end: number; value: string }> = [];

  for (const macro of spans) {
    if (macro.name !== "ac:structured-macro" || macro.end < 0) continue;
    const node = openingElement(storage, macro);
    const macroName = node?.attrs["ac:name"]?.toLowerCase();
    if (!node || !macroName || !DRAWIO_MACRO_NAMES.has(macroName)) continue;

    const params = (children.get(macro) ?? []).filter(
      (span) => span.name === "ac:parameter" && span.end >= 0,
    );
    let diagramName: string | undefined;
    for (const param of params) {
      const paramNode = firstElement(storage.slice(param.start, param.end));
      const paramName = paramNode?.attrs["ac:name"]?.toLowerCase();
      if (paramName === "diagramname" || paramName === "name") {
        diagramName = paramNode ? textOf(paramNode).trim() : undefined;
        break;
      }
    }

    const version = diagramName ? versions.get(diagramName) : undefined;
    if (version === undefined) continue;

    for (const param of params) {
      const paramNode = firstElement(storage.slice(param.start, param.end));
      const paramName = paramNode?.attrs["ac:name"]?.toLowerCase();
      if (paramName !== "contentver" && paramName !== "revision") continue;
      const current = storage.slice(param.startTagEnd, param.endTagStart);
      if (!/^\s*\d+\s*$/.test(current)) continue;
      patches.push({
        start: param.startTagEnd,
        end: param.endTagStart,
        value: current.replace(/\d+/, String(version)),
      });
    }
  }

  let result = storage;
  for (const patch of patches.sort((a, b) => b.start - a.start)) {
    result = `${result.slice(0, patch.start)}${patch.value}${result.slice(patch.end)}`;
  }
  return result;
}
