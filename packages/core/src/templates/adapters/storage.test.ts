import { describe, expect, test, beforeAll } from "bun:test";
import { initJinja } from "@atlcli/jinja";
import { createTemplateScope } from "../render.js";
import { renderStorage, storageTextUnits } from "./storage.js";

beforeAll(() => initJinja());

const scope = createTemplateScope({
  vars: { customer: "ACME", project: "AUD", html: `<b a="1">&]]></b>`, systems: ["IAM", "Backup"], on: true },
});
const render = (s: string) => renderStorage(s, scope, { unit: "page 1" });

describe("renderStorage", () => {
  test("keeps bytes of a page without placeholders", () => {
    const s = `<p>a&nbsp;b &amp; c</p><ac:structured-macro ac:name="info"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro><!-- c --><![CDATA[ y ]]>`;
    expect(render(s).value).toBe(s);
  });
  test("keeps untouched tokens byte-identical; a changed token keeps its meaning", () => {
    const s = `<p class="x">a&nbsp;b &#169; &lt;x&gt; {{customer}}</p><p>  &lt;kept&gt; &#169; </p>`;
    expect(render(s).value).toBe(`<p class="x">a&nbsp;b © &lt;x&gt; ACME</p><p>  &lt;kept&gt; &#169; </p>`);
  });
  test("renders across inline elements and keeps tags", () => {
    expect(render(`<p>for {{cus<strong>tomer}}</strong> &amp; co</p>`).value).toBe(`<p>for ACME<strong></strong> &amp; co</p>`);
  });
  test("escapes a value with markup", () => {
    expect(render(`<p>{{html}}</p>`).value).toBe(`<p>&lt;b a="1"&gt;&amp;]]&gt;&lt;/b&gt;</p>`);
  });
  test("renders macro parameters", () => {
    const s = `<ac:structured-macro ac:name="jira"><ac:parameter ac:name="jqlQuery">project = {{project}}</ac:parameter></ac:structured-macro>`;
    expect(render(s).value).toBe(s.replace("{{project}}", "AUD"));
  });
  test("never renders code macros, pre and code", () => {
    const s = `<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[{{customer}}]]></ac:plain-text-body></ac:structured-macro><pre>{{customer}}</pre><p><code>{{customer}}</code></p>`;
    expect(render(s).value).toBe(s);
  });
  test("noformat macro bodies are skipped", () => {
    const s = `<ac:structured-macro ac:name="noformat"><ac:plain-text-body><![CDATA[{{customer}}]]></ac:plain-text-body></ac:structured-macro>`;
    expect(render(s).value).toBe(s);
  });
  test("links are boundaries", () => {
    const s = `<p>{{cus<ac:link><ri:page ri:content-title="X" /></ac:link>tomer}}</p>`;
    expect(render(s).value).toBe(s);
  });
  test("control paragraphs, list items and table rows", () => {
    expect(render(`<p>{% if on %}</p><p>A</p><p>{% endif %}</p>`).value).toBe(`<p>A</p>`);
    expect(render(`<ul><li>{% for s in systems %}</li><li>{{ s }}</li><li>{% endfor %}</li></ul>`).value).toBe(`<ul><li>IAM</li><li>Backup</li></ul>`);
    expect(
      render(`<table><tbody><tr><td>{% for s in systems %}</td></tr><tr><td>{{ s }}</td></tr><tr><td>{% endfor %}</td></tr></tbody></table>`).value,
    ).toBe(`<table><tbody><tr><td>IAM</td></tr><tr><td>Backup</td></tr></tbody></table>`);
  });
  test("entity-encoded quotes and operators inside an expression still render", () => {
    expect(render(`<p>{{ missing | default(&quot;x&quot;) }}</p>`).value).toBe(`<p>x</p>`);
    expect(render(`<p>{% if systems | length &gt; 1 %}many{% endif %}</p>`).value).toBe(`<p>many</p>`);
  });
  test("nested macros keep their bytes", () => {
    const s = `<ac:structured-macro ac:name="expand"><ac:rich-text-body><ac:structured-macro ac:name="info"><ac:rich-text-body><p>Hi {{customer}}</p></ac:rich-text-body></ac:structured-macro></ac:rich-text-body></ac:structured-macro>`;
    expect(render(s).value).toBe(s.replace("{{customer}}", "ACME"));
  });
  test("unbalanced tags leave the page as is with a warning", () => {
    const out = render(`<p>{{customer}}</div>`);
    expect(out.value).toBe(`<p>{{customer}}</div>`);
    expect(out.warnings[0]!.code).toBe("parse-error");
  });
  test("text units for variable collection", () => {
    expect(storageTextUnits(`<p>a {{x}}<em>b</em></p><pre>{{no}}</pre><p>{{#if y}}</p>`)).toEqual(["a {{x}}b", "{{#if y}}"]);
  });
});
