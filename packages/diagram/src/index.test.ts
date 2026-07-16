/**
 * Renderer tests (spec 005a Task 2 + Task 4): the six supported types produce
 * real SVG with content landmarks, known-unsupported types are reported by
 * name, malformed source becomes `failed` (never an escaping throw), and the
 * theme flows into the SVG. Runs the REAL beautiful-mermaid renderer — no
 * mocks (repo directive: real test infra).
 */
import { describe, expect, it } from "bun:test";
import { DEFAULT_DIAGRAM_THEME, renderDiagram, type DiagramRenderResult } from "./index.js";

function expectSvg(result: DiagramRenderResult): Extract<DiagramRenderResult, { kind: "svg" }> {
  expect(result.kind).toBe("svg");
  return result as Extract<DiagramRenderResult, { kind: "svg" }>;
}

describe("renderDiagram — supported types", () => {
  it("renders a flowchart", async () => {
    const r = expectSvg(await renderDiagram("graph TD\n  A[Start] --> B{OK?}\n  B -->|yes| C[Done]"));
    expect(r.svg).toStartWith("<svg");
    expect(r.svg).toContain("Start");
    expect(r.svg).toContain("Done");
    expect(r.widthPx).toBeGreaterThan(0);
    expect(r.heightPx).toBeGreaterThan(0);
  });

  it("renders a state diagram", async () => {
    const r = expectSvg(await renderDiagram("stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy: work\n  Busy --> [*]"));
    expect(r.svg).toContain("Idle");
    expect(r.svg).toContain("Busy");
  });

  it("renders a sequence diagram", async () => {
    const r = expectSvg(await renderDiagram("sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi"));
    expect(r.svg).toContain("Alice");
    expect(r.svg).toContain("Bob");
  });

  it("renders a class diagram", async () => {
    const r = expectSvg(
      await renderDiagram("classDiagram\n  class Animal {\n    +name: string\n  }\n  Animal <|-- Dog")
    );
    expect(r.svg).toContain("Animal");
    expect(r.svg).toContain("Dog");
  });

  it("renders the classDiagram-v2 alias through the normalized header", async () => {
    const r = expectSvg(await renderDiagram("classDiagram-v2\n  Animal <|-- Dog"));
    expect(r.svg).toContain("Dog");
  });

  it("renders an ER diagram", async () => {
    const r = expectSvg(
      await renderDiagram("erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE-ITEM : contains")
    );
    expect(r.svg).toContain("CUSTOMER");
    expect(r.svg).toContain("ORDER");
  });

  it("renders an XY chart", async () => {
    const r = expectSvg(
      await renderDiagram('xychart-beta\n  title "Sales"\n  x-axis [jan, feb, mar]\n  y-axis "Rev" 0 --> 100\n  bar [20, 50, 80]')
    );
    expect(r.svg).toContain("Sales");
  });

  it("skips YAML frontmatter and %% comments before the header", async () => {
    const r = expectSvg(
      await renderDiagram("---\ntitle: Fancy\n---\n%% a comment\ngraph LR\n  A --> B")
    );
    expect(r.svg).toStartWith("<svg");
  });

  it("strips the external Google-Fonts @import from the SVG", async () => {
    const r = expectSvg(await renderDiagram("graph TD\n  A --> B"));
    expect(r.svg).not.toContain("fonts.googleapis.com");
    expect(r.svg).not.toContain("@import");
  });
});

describe("renderDiagram — theme (Task 4)", () => {
  it("applies the default theme when none is given", async () => {
    const r = expectSvg(await renderDiagram("graph TD\n  A --> B"));
    expect(r.svg).toContain(DEFAULT_DIAGRAM_THEME.bg);
    expect(r.svg).toContain(DEFAULT_DIAGRAM_THEME.fg);
  });

  it("applies configured brand colors", async () => {
    const r = expectSvg(
      await renderDiagram("graph TD\n  A --> B", { bg: "#112233", fg: "#EEDDCC", accent: "#FF0000" })
    );
    expect(r.svg).toContain("#112233");
    expect(r.svg).toContain("#EEDDCC");
    expect(r.svg).not.toContain(DEFAULT_DIAGRAM_THEME.fg);
  });
});

describe("renderDiagram — unsupported types are named", () => {
  const cases: Array<[string, string]> = [
    ["gantt\n  title A\n  section S\n  T :a1, 2026-01-01, 30d", "Gantt"],
    ['pie title Pets\n  "Dogs" : 50', "Pie"],
    ["mindmap\n  root((m))\n    A", "Mindmap"],
    ["timeline\n  title H\n  2020 : E", "Timeline"],
    ["gitGraph\n  commit", "Git graph"],
    ["journey\n  title J", "User journey"],
    ["quadrantChart\n  title Q", "Quadrant chart"],
    ["C4Context\n  title C", "C4"],
    ["sankey-beta\nA,B,10", "Sankey"],
  ];

  for (const [source, name] of cases) {
    it(`reports ${name} by name`, async () => {
      expect(await renderDiagram(source)).toEqual({ kind: "unsupported", diagramType: name });
    });
  }
});

describe("renderDiagram — failure routes (never throws)", () => {
  it("fails on empty source", async () => {
    const r = await renderDiagram("");
    expect(r.kind).toBe("failed");
  });

  it("fails on comment-only source", async () => {
    const r = await renderDiagram("%% nothing here\n%% still nothing");
    expect(r.kind).toBe("failed");
  });

  it("fails on an unrecognized header with the token in the reason", async () => {
    const r = await renderDiagram("bogusDiagram\n  A --> B");
    expect(r.kind).toBe("failed");
    expect((r as { reason: string }).reason).toContain("bogusDiagram");
  });

  it("fails on prose that is not mermaid at all", async () => {
    const r = await renderDiagram("this is not mermaid at all");
    expect(r.kind).toBe("failed");
  });
});
