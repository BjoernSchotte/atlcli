/**
 * Minimal namespace-aware XML → element-tree reader on saxes.
 *
 * The archive boundary (`unzipDocx`) already enforced the size budget before
 * any part reaches this module, so materializing one part as a tree is
 * bounded. DTDs are rejected outright (no entity expansion surface).
 */
import { SaxesParser } from "./vendor/saxes-runtime.js";

export interface XmlAttr {
  local: string;
  uri: string;
  value: string;
}

export interface XmlElement {
  local: string;
  uri: string;
  attrs: XmlAttr[];
  children: (XmlElement | string)[];
}

export function attr(el: XmlElement, local: string, uri?: string): string | undefined {
  for (const a of el.attrs) {
    if (a.local === local && (uri === undefined || a.uri === uri)) return a.value;
  }
  return undefined;
}

export function childElements(el: XmlElement): XmlElement[] {
  return el.children.filter((c): c is XmlElement => typeof c !== "string");
}

export function firstChild(el: XmlElement, local: string): XmlElement | undefined {
  return childElements(el).find((c) => c.local === local);
}

/** Concatenated text content of an element subtree. */
export function textContent(el: XmlElement): string {
  let out = "";
  for (const c of el.children) {
    out += typeof c === "string" ? c : textContent(c);
  }
  return out;
}

export function parseXmlTree(xml: string): XmlElement {
  const parser = new SaxesParser({ xmlns: true });
  const root: XmlElement = { local: "#root", uri: "", attrs: [], children: [] };
  const stack: XmlElement[] = [root];
  let error: Error | undefined;

  parser.on("error", (err) => {
    error = error ?? err;
  });
  parser.on("doctype", () => {
    error = error ?? new Error("XML DOCTYPE declarations are not allowed in DOCX parts.");
  });
  parser.on("opentag", (tag) => {
    const el: XmlElement = {
      local: tag.local,
      uri: tag.uri,
      attrs: Object.values(tag.attributes)
        .filter((a) => a.uri !== "http://www.w3.org/2000/xmlns/")
        .map((a) => ({ local: a.local, uri: a.uri, value: a.value })),
      children: [],
    };
    stack[stack.length - 1].children.push(el);
    stack.push(el);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.on("text", (text) => {
    stack[stack.length - 1].children.push(text);
  });

  parser.write(xml).close();
  if (error) throw error;
  const rootChildren = childElements(root);
  if (rootChildren.length !== 1) {
    throw new Error(`Expected exactly one XML root element, found ${rootChildren.length}.`);
  }
  return rootChildren[0];
}
