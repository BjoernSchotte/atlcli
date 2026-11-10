import { expect, test } from "bun:test";
import { scanHtmlV1 } from "./html-scan.js";

const names = (html: string): string[] => scanHtmlV1(html).tags.map((tag) => tag.name);
const handlers = (html: string): string[] =>
  scanHtmlV1(html).tags.filter((tag) => tag.attributes.has("onerror")).map((tag) => tag.name);

// A browser ends these elements at their end tag whatever the content looks
// like; `<!--` inside used to swallow the rest of the document.
test.each(["textarea", "title", "style", "xmp", "noscript", "noembed", "noframes"])(
  "markup after <%s> is seen although its text opens a comment",
  (name) => {
    expect(handlers(`<${name}><!--</${name}><img src=x onerror=alert(1)>`)).toEqual(["img"]);
    expect(handlers(`<${name.toUpperCase()}><!--</${name.toUpperCase()}\n><img src=x onerror=alert(1)>`)).toEqual(["img"]);
  },
);

test("a quoted attribute inside raw text does not hide the markup after the end tag", () => {
  expect(handlers('<textarea><a title="</textarea><img src=x onerror=alert(1)>">')).toEqual(["img"]);
  expect(handlers('<style><a title="</style><!--"><img src=x onerror=alert(1)>')).toEqual(["img"]);
});

test("raw text is still scanned as markup, comments included", () => {
  expect(names("<textarea><b>x</b></textarea><i>")).toEqual(["textarea", "b", "i"]);
  expect(handlers("<textarea><!-- <img onerror=alert(1)> --></textarea>")).toEqual(["img"]);
  expect(handlers("<plaintext><!-- <img onerror=alert(1)>")).toEqual(["img"]);
});

test("a tag reached by more than one reading is reported once, in document order", () => {
  expect(names("<title>a</title><style>b{}</style><p><noscript><img></noscript><em>")).toEqual([
    "title", "style", "p", "noscript", "img", "em",
  ]);
});

// With scripting off a browser parses <noscript> content as markup.
test("<noscript> is read as raw text and as markup", () => {
  expect(handlers('<noscript><a title="</noscript><!--"><img src=x onerror=alert(1)>')).toEqual(["img"]);
  expect(handlers("<noscript><!-- </noscript> --><img src=x onerror=alert(1)>")).toEqual(["img"]);
});

test("a script body ends where a browser ends it", () => {
  // `<!--` then `<script` makes the first `</script` text; the second one ends the element.
  const escaped = "<script><!--<script></script><!--</script><img src=x onerror=alert(1)>";
  expect(handlers(escaped)).toEqual(["img"]);
  expect(scanHtmlV1(escaped).scripts).toEqual(["<!--<script></script><!--"]);
  // `<!-->` opens and closes the escape at once.
  expect(scanHtmlV1("<script><!--><script></script><b>").scripts).toEqual(["<!--><script>"]);
  expect(scanHtmlV1("<script>if (a<b) x='<!--'</script><i><script>1</script>")).toMatchObject({
    scripts: ["if (a<b) x='<!--'", "1"],
  });
  expect(names("<script>var s = '<img onerror=1>';</script><i>")).toEqual(["script", "i"]);
});

// Inside <svg>/<math> the scanner cannot tell foreign content (markup) from an
// HTML integration point (raw text), so it reads both.
test("raw text elements in foreign content are read both ways", () => {
  expect(handlers("<svg><foreignObject><script><!--</script><img src=x onerror=alert(1)>")).toEqual(["img"]);
  expect(handlers("<svg><foreignObject><textarea><!--</textarea><img src=x onerror=alert(1)>")).toEqual(["img"]);
  expect(handlers("<math><annotation-xml encoding='text/html'><style><!--</style><img src=x onerror=alert(1)>")).toEqual(["img"]);
  expect(handlers("<svg><script><img onerror=alert(1)></script></svg>")).toEqual(["img"]);
  expect(handlers('<svg><script><a title="</script><!--"><img src=x onerror=alert(1)>')).toEqual(["img"]);
});

test("many ambiguous elements do not multiply the work", () => {
  const html = "<svg>" + "<script><!--</script><noscript><!--</noscript><p>".repeat(2000);
  const started = performance.now();
  expect(scanHtmlV1(html).tags.filter((tag) => tag.name === "p").length).toBe(2000);
  expect(performance.now() - started).toBeLessThan(5000);
});
