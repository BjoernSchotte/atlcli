/**
 * SVG portability flattening (spec 005a, Word E2E finding).
 *
 * beautiful-mermaid styles its SVG through CSS custom properties,
 * `color-mix()` derivations and class rules inside `<style>` elements. That
 * is fine in a browser, but the consumers this adapter exists for have a
 * much smaller SVG subset: **Word's svgBlip renderer** supports neither CSS
 * variables nor `color-mix()` (observed: every var()-styled shape renders
 * black, arrowhead markers vanish), and the PDF path's SVG consumers
 * (resvg/Typst) share those limits.
 *
 * `flattenSvgStyles` therefore rewrites the SVG to the portable subset:
 *
 *  1. resolve every custom property (root `style` attribute + `svg { … }`
 *     rules), evaluating `var(--x, fallback)` and `color-mix(in srgb, …)`
 *     numerically;
 *  2. inline every class/tag rule from the `<style>` blocks into literal
 *     presentation attributes on the matching elements (CSS rules override
 *     presentation attributes, so inlined declarations replace existing
 *     attributes of the same name);
 *  3. drop the `<style>` blocks entirely (this also removes the external
 *     Google-Fonts `@import`) and paint the background as a real `<rect>`.
 *
 * The rewrite is conservative: values that cannot be resolved are left
 * untouched, and non-CSS `style` attributes beautiful-mermaid emits (e.g.
 * `style="solid"` on edges) are ignored rather than mangled.
 */

interface Rule {
  selectors: SimpleSelector[];
  decls: Map<string, string>;
}

interface SimpleSelector {
  tag?: string;
  classes: string[];
}

/** Parse `#rgb` / `#rrggbb` into channels; null for anything else. */
function parseHexColor(value: string): [number, number, number] | null {
  const v = value.trim();
  const short = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) return [short[1], short[2], short[3]].map((c) => parseInt(c + c, 16)) as [number, number, number];
  const long = v.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (long) return [long[1], long[2], long[3]].map((c) => parseInt(c, 16)) as [number, number, number];
  return null;
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Evaluate every `color-mix(in srgb, A p%, B [q%])` in `value` (innermost
 * first) over hex colors — the sRGB channel interpolation Word can't do.
 * Unresolvable mixes are left as-is.
 */
function evaluateColorMix(value: string): string {
  const MIX_RE = /color-mix\(in srgb,\s*([^,()]+?)\s+([\d.]+)%\s*,\s*([^,()]+?)(?:\s+([\d.]+)%)?\s*\)/;
  let out = value;
  for (let guard = 0; guard < 10; guard++) {
    const m = out.match(MIX_RE);
    if (!m) break;
    const c1 = parseHexColor(m[1]);
    const c2 = parseHexColor(m[3]);
    if (!c1 || !c2) break;
    const p1 = Number(m[2]);
    const p2 = m[4] !== undefined ? Number(m[4]) : 100 - p1;
    const total = p1 + p2 || 100;
    const mixed = toHex([
      (c1[0] * p1 + c2[0] * p2) / total,
      (c1[1] * p1 + c2[1] * p2) / total,
      (c1[2] * p1 + c2[2] * p2) / total,
    ]);
    out = out.slice(0, m.index!) + mixed + out.slice(m.index! + m[0].length);
  }
  return out;
}

/** Substitute `var(--name[, fallback])` from `props`, innermost first. */
function substituteVars(value: string, props: Map<string, string>, depth = 0): string {
  if (depth > 10) return value;
  // Innermost var(): its argument list contains no further `var(`.
  const VAR_RE = /var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*?))?\s*\)/;
  let out = value;
  for (let guard = 0; guard < 20; guard++) {
    const m = out.match(VAR_RE);
    if (!m) break;
    const replacement = props.get(m[1]) ?? m[2];
    if (replacement === undefined) break; // unknown var, no fallback — leave it
    out = out.slice(0, m.index!) + replacement + out.slice(m.index! + m[0].length);
  }
  return out;
}

/** Fully resolve a CSS value: vars substituted, color-mix evaluated. */
function resolveValue(value: string, props: Map<string, string>): string {
  return evaluateColorMix(substituteVars(value, props)).trim();
}

/** Parse `prop: value; …` declarations (CSS comments already stripped). */
function parseDecls(block: string): Map<string, string> {
  const decls = new Map<string, string>();
  for (const part of block.split(";")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (prop && value) decls.set(prop, value);
  }
  return decls;
}

function parseSelector(selector: string): SimpleSelector | null {
  // Supported grammar (all beautiful-mermaid emits): `tag`, `.class`,
  // `tag.class`, `.class.class`. Anything else (descendants, pseudo, @media)
  // fails the whole rule — safer to leave that rule un-inlined.
  const m = selector.trim().match(/^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)$/);
  if (!m || (!m[1] && !m[2])) return null;
  return { tag: m[1] || undefined, classes: m[2] ? m[2].split(".").filter(Boolean) : [] };
}

function selectorMatches(sel: SimpleSelector, tag: string, classes: Set<string>): boolean {
  if (sel.tag && sel.tag !== tag) return false;
  return sel.classes.every((c) => classes.has(c));
}

/**
 * Flatten CSS custom properties, `color-mix()` and `<style>` class rules
 * into literal presentation attributes — the SVG subset Word's svgBlip
 * renderer (and resvg/Typst on the PDF path) actually supports.
 */
export function flattenSvgStyles(svg: string): string {
  // ---- 1. Collect stylesheet text and custom properties -------------------
  // NB: the Google-Fonts @import URL contains semicolons (`wght@400;500;…`),
  // so the strip must consume the full url(…) rather than stop at the first `;`.
  const styleBlocks = [...svg.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) =>
    m[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import\s+url\([^)]*\)\s*;?/g, "")
  );

  const props = new Map<string, string>();
  // Root <svg style="--bg:…;--fg:…;…"> — the theme's base values.
  const rootTag = svg.match(/<svg[^>]*>/)?.[0] ?? "";
  const rootStyle = rootTag.match(/style="([^"]*)"/)?.[1] ?? "";
  for (const [prop, value] of parseDecls(rootStyle)) {
    if (prop.startsWith("--")) props.set(prop, value);
  }

  const rules: Rule[] = [];
  for (const block of styleBlocks) {
    for (const m of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectorList = m[1].trim();
      const decls = parseDecls(m[2]);
      // `svg { --_x: … }` rules define the derived palette.
      const selectors: SimpleSelector[] = [];
      let allParsed = true;
      for (const sel of selectorList.split(",")) {
        const parsed = parseSelector(sel);
        if (!parsed) {
          allParsed = false;
          break;
        }
        selectors.push(parsed);
      }
      if (!allParsed) continue;
      if (selectors.some((s) => s.tag === "svg" && s.classes.length === 0)) {
        for (const [prop, value] of decls) {
          if (prop.startsWith("--")) props.set(prop, value);
        }
      }
      const attrDecls = new Map([...decls].filter(([p]) => !p.startsWith("--")));
      if (attrDecls.size > 0) rules.push({ selectors, decls: attrDecls });
    }
  }

  // Resolve prop definitions against each other (e.g. --xychart-bar-fill-0
  // mixes --xychart-color-0, which itself falls back through --accent).
  for (const [name, value] of props) props.set(name, resolveValue(value, props));

  // ---- 2. Rewrite every element open tag ----------------------------------
  let out = svg.replace(/<([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g, (whole, tag: string, attrText: string, selfClose: string) => {
    if (tag === "style") return whole;

    const attrs = new Map<string, string>();
    for (const a of attrText.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs.set(a[1], a[2]);

    // Matching class/tag rules, in stylesheet order (later rules win); their
    // declarations REPLACE same-name attributes (CSS beats presentation attrs).
    const classes = new Set((attrs.get("class") ?? "").split(/\s+/).filter(Boolean));
    for (const rule of rules) {
      if (!rule.selectors.some((s) => selectorMatches(s, tag, classes))) continue;
      for (const [prop, value] of rule.decls) attrs.set(prop, resolveValue(value, props));
    }

    // Resolve var()/color-mix() left in literal attributes (fill="var(--_text)").
    for (const [name, value] of attrs) {
      if (value.includes("var(") || value.includes("color-mix(")) {
        attrs.set(name, resolveValue(value, props));
      }
    }

    // The style attribute: drop custom-prop declarations, resolve the rest in
    // place. Non-CSS values (`style="solid"`) pass through untouched.
    const styleAttr = attrs.get("style");
    if (styleAttr && styleAttr.includes(":")) {
      const kept: string[] = [];
      for (const [prop, value] of parseDecls(styleAttr)) {
        if (prop.startsWith("--")) continue;
        kept.push(`${prop}:${resolveValue(value, props)}`);
      }
      if (kept.length > 0) attrs.set("style", kept.join(";"));
      else attrs.delete("style");
    }

    const rebuilt = [...attrs].map(([k, v]) => `${k}="${v}"`).join(" ");
    return `<${tag}${rebuilt ? " " + rebuilt : ""}${selfClose ? "/" : ""}>`;
  });

  // ---- 3. Drop <style> blocks, paint the background as a real rect --------
  out = out.replace(/<style>[\s\S]*?<\/style>/g, "");
  const bg = props.get("--bg") ? resolveValue(props.get("--bg")!, props) : undefined;
  if (bg && parseHexColor(bg)) {
    out = out.replace(/(<svg[^>]*>)/, `$1<rect x="0" y="0" width="100%" height="100%" fill="${bg}"/>`);
  }
  return out;
}
