import { describe, expect, test } from "bun:test";
import {
  normalizeDocxPageGeometry,
  resolveDocxSections,
  type DocxPageGeometryInputV1,
  type DocxSectionInputV1,
} from "./section-resolution.js";

const a4 = (
  overrides: Partial<DocxPageGeometryInputV1> = {}
): DocxPageGeometryInputV1 => ({
  widthTwips: 11_906,
  heightTwips: 16_838,
  marginTopTwips: 1_440,
  marginRightTwips: 1_440,
  marginBottomTwips: 1_440,
  marginLeftTwips: 1_440,
  ...overrides,
});

const section = (
  index: number,
  overrides: Partial<DocxSectionInputV1> = {}
): DocxSectionInputV1 => ({
  section: index,
  locator: `section.${index}`,
  page: a4(),
  ...overrides,
});

describe("DOCX section and page-master resolution", () => {
  test("normalizes A4 and Letter within tolerance without rounding custom paper", () => {
    expect(
      normalizeDocxPageGeometry(
        a4({ widthTwips: 11_920, heightTwips: 16_820 })
      ).format
    ).toBe("a4");
    expect(
      normalizeDocxPageGeometry(
        a4({ widthTwips: 12_240, heightTwips: 15_840 })
      ).format
    ).toBe("letter");
    const custom = normalizeDocxPageGeometry(
      a4({ widthTwips: 12_000, heightTwips: 16_000 })
    );
    expect(custom.format).toBe("custom");
    expect(custom.widthTwips).toBe(12_000);
    expect(custom.heightTwips).toBe(16_000);
  });

  test("inherits missing first/default/even references and activates variants from settings", async () => {
    const off = await resolveDocxSections({
      evenAndOddHeaders: false,
      sections: [
        section(0, {
          titlePage: false,
          headers: { default: "header-d", even: "header-e", first: "header-f" },
          footers: { default: "footer-d", even: "footer-e", first: "footer-f" },
        }),
        section(1),
      ],
    });
    expect(off.sections[1]?.headers).toEqual(off.sections[0]?.headers);
    expect(off.sections[1]?.footers).toEqual(off.sections[0]?.footers);
    expect(off.sections[0]?.activeVariants).toEqual(["default"]);
    expect(
      off.decorations.find(
        ({ kind, variant, section: index }) =>
          kind === "header" && variant === "even" && index === 0
      )?.status
    ).toBe("inactive");

    const on = await resolveDocxSections({
      evenAndOddHeaders: true,
      sections: [
        section(0, {
          titlePage: true,
          headers: { default: "header-d", even: "header-e", first: "header-f" },
        }),
      ],
    });
    expect(on.sections[0]?.activeVariants).toEqual([
      "default",
      "even",
      "first",
    ]);
    expect(
      on.decorations
        .filter(({ kind }) => kind === "header")
        .map(({ status }) => status)
    ).toEqual(["native", "native", "native"]);
  });

  test("keeps missing variants blank until a same-variant reference can be inherited", async () => {
    const result = await resolveDocxSections({
      evenAndOddHeaders: true,
      sections: [
        section(0, {
          titlePage: true,
          headers: { default: "header-d" },
        }),
        section(1, {
          titlePage: true,
          headers: { first: "header-f" },
        }),
        section(2, { titlePage: true }),
      ],
    });
    expect(result.sections[0]?.headers.even).toBeUndefined();
    expect(result.sections[0]?.headers.first).toBeUndefined();
    expect(result.sections[1]?.headers.default).toBe(
      result.sections[0]?.headers.default
    );
    expect(result.sections[2]?.headers.first).toBe(
      result.sections[1]?.headers.first
    );
    expect(
      result.decorations.find(
        ({ kind, variant, section: index }) =>
          kind === "header" && variant === "first" && index === 0
      )?.status
    ).toBe("inactive");
    expect(
      result.decorations.find(
        ({ kind, variant, section: index }) =>
          kind === "header" && variant === "first" && index === 2
      )?.status
    ).toBe("unsupported-section-scope");
  });

  test("keeps uniform default/even multi-section masters native without restarts", async () => {
    const result = await resolveDocxSections({
      evenAndOddHeaders: true,
      sections: [
        section(0, {
          headers: { default: "header-d", even: "header-e" },
          footers: { default: "footer-d", even: "footer-e" },
        }),
        section(1),
      ],
    });
    expect(result.geometryUniform).toBe(true);
    expect(result.globalPage?.format).toBe("a4");
    expect(
      result.decorations
        .filter(({ status }) => status !== "inactive")
        .every(({ status }) => status === "native")
    ).toBe(true);
  });

  test("blocks first-page multi-section scope and odd/even semantics after a restart", async () => {
    const result = await resolveDocxSections({
      evenAndOddHeaders: true,
      sections: [
        section(0, {
          titlePage: true,
          headers: { default: "header-d", even: "header-e", first: "header-f" },
        }),
        section(1, { titlePage: true, pageNumberStart: 1 }),
      ],
    });
    expect(
      result.decorations
        .filter(({ status }) => status !== "inactive")
        .every(({ status }) => status === "unsupported-section-scope")
    ).toBe(true);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      "DOCX_SECTION_SCOPE_UNSUPPORTED"
    );
    expect(result.sections[1]?.pageNumberRestart).toBe(true);
  });

  test("does not globalize conflicting section geometry", async () => {
    const result = await resolveDocxSections({
      evenAndOddHeaders: false,
      sections: [
        section(0),
        section(1, {
          page: a4({ widthTwips: 12_240, heightTwips: 15_840 }),
        }),
      ],
    });
    expect(result.geometryUniform).toBe(false);
    expect(result.globalPage).toBeUndefined();
    expect(result.sections.map(({ page }) => page.format)).toEqual([
      "a4",
      "letter",
    ]);
  });
});
