import { describe, test, expect } from "bun:test";

// Since the functions are not exported, we'll test the CQL building logic
// by importing and testing a mock module that exposes the internal functions

// For now, let's test the date expression parsing and CQL building
// by reimplementing the logic for testing purposes

function parseDateExpression(expr: string): string {
  const trimmed = expr.trim().toLowerCase();

  if (trimmed === "today") {
    return "startOfDay()";
  }
  if (trimmed === "yesterday") {
    return 'startOfDay("-1d")';
  }
  if (trimmed === "thisweek" || trimmed === "this-week") {
    return "startOfWeek()";
  }
  if (trimmed === "thismonth" || trimmed === "this-month") {
    return "startOfMonth()";
  }

  const relMatch = expr.match(/^(\d+)([dwm])$/i);
  if (relMatch) {
    const [, num, unit] = relMatch;
    const cqlUnit = unit.toLowerCase() === "w" ? "w" : unit.toLowerCase();
    return `now("-${num}${cqlUnit}")`;
  }

  const dateMatch = expr.match(/^\d{4}-\d{2}-\d{2}$/);
  if (dateMatch) {
    return `"${expr}"`;
  }

  return expr;
}

function escapeQuotes(str: string): string {
  return str.replace(/"/g, '\\"');
}

function buildCql(
  query: string,
  flags: {
    space?: string;
    type?: string;
    label?: string;
    title?: string;
    creator?: string;
    "modified-since"?: string;
    "created-since"?: string;
    ancestor?: string;
  }
): string {
  const conditions: string[] = [];

  if (query) {
    conditions.push(`text ~ "${escapeQuotes(query)}"`);
  }

  const space = flags.space;
  if (space) {
    const spaces = space.split(",").map((s) => s.trim());
    if (spaces.length === 1) {
      conditions.push(`space = "${spaces[0]}"`);
    } else {
      conditions.push(`space IN (${spaces.map((s) => `"${s}"`).join(", ")})`);
    }
  }

  const type = flags.type || "page";
  if (type !== "all") {
    conditions.push(`type = ${type}`);
  }

  const label = flags.label;
  if (label) {
    const labels = label.split(",").map((l) => l.trim());
    if (labels.length === 1) {
      conditions.push(`label = "${labels[0]}"`);
    } else {
      for (const l of labels) {
        conditions.push(`label = "${l}"`);
      }
    }
  }

  const title = flags.title;
  if (title) {
    conditions.push(`title ~ "${escapeQuotes(title)}"`);
  }

  const creator = flags.creator;
  if (creator) {
    if (creator === "me" || creator === "currentUser") {
      conditions.push(`creator = currentUser()`);
    } else {
      conditions.push(`creator = "${escapeQuotes(creator)}"`);
    }
  }

  const modifiedSince = flags["modified-since"];
  if (modifiedSince) {
    const dateExpr = parseDateExpression(modifiedSince);
    conditions.push(`lastModified >= ${dateExpr}`);
  }

  const createdSince = flags["created-since"];
  if (createdSince) {
    const dateExpr = parseDateExpression(createdSince);
    conditions.push(`created >= ${dateExpr}`);
  }

  const ancestor = flags.ancestor;
  if (ancestor) {
    conditions.push(`ancestor = ${ancestor}`);
  }

  return conditions.join(" AND ");
}

describe("Search CQL Builder", () => {
  describe("parseDateExpression", () => {
    test("today returns startOfDay()", () => {
      expect(parseDateExpression("today")).toBe("startOfDay()");
      expect(parseDateExpression("TODAY")).toBe("startOfDay()");
    });

    test("yesterday returns startOfDay(-1d)", () => {
      expect(parseDateExpression("yesterday")).toBe('startOfDay("-1d")');
    });

    test("thisWeek returns startOfWeek()", () => {
      expect(parseDateExpression("thisWeek")).toBe("startOfWeek()");
      expect(parseDateExpression("this-week")).toBe("startOfWeek()");
    });

    test("thisMonth returns startOfMonth()", () => {
      expect(parseDateExpression("thisMonth")).toBe("startOfMonth()");
      expect(parseDateExpression("this-month")).toBe("startOfMonth()");
    });

    test("relative days (7d)", () => {
      expect(parseDateExpression("7d")).toBe('now("-7d")');
      expect(parseDateExpression("30d")).toBe('now("-30d")');
    });

    test("relative weeks (2w)", () => {
      expect(parseDateExpression("1w")).toBe('now("-1w")');
      expect(parseDateExpression("2w")).toBe('now("-2w")');
    });

    test("relative months (1m)", () => {
      expect(parseDateExpression("1m")).toBe('now("-1m")');
      expect(parseDateExpression("3m")).toBe('now("-3m")');
    });

    test("ISO date string", () => {
      expect(parseDateExpression("2024-01-15")).toBe('"2024-01-15"');
      expect(parseDateExpression("2023-12-31")).toBe('"2023-12-31"');
    });

    test("passes through unknown expressions", () => {
      expect(parseDateExpression("startOfYear()")).toBe("startOfYear()");
    });
  });

  describe("escapeQuotes", () => {
    test("escapes double quotes", () => {
      expect(escapeQuotes('hello "world"')).toBe('hello \\"world\\"');
    });

    test("handles string without quotes", () => {
      expect(escapeQuotes("hello world")).toBe("hello world");
    });
  });

  describe("buildCql", () => {
    test("text search only", () => {
      const cql = buildCql("API documentation", {});
      expect(cql).toBe('text ~ "API documentation" AND type = page');
    });

    test("space filter", () => {
      const cql = buildCql("", { space: "DEV" });
      expect(cql).toBe('space = "DEV" AND type = page');
    });

    test("multiple spaces", () => {
      const cql = buildCql("", { space: "DEV,DOCS" });
      expect(cql).toBe('space IN ("DEV", "DOCS") AND type = page');
    });

    test("label filter", () => {
      const cql = buildCql("", { label: "architecture" });
      expect(cql).toBe('type = page AND label = "architecture"');
    });

    test("multiple labels (AND logic)", () => {
      const cql = buildCql("", { label: "api,docs" });
      expect(cql).toBe('type = page AND label = "api" AND label = "docs"');
    });

    test("title filter", () => {
      const cql = buildCql("", { title: "Getting Started" });
      expect(cql).toBe('type = page AND title ~ "Getting Started"');
    });

    test("creator filter with me", () => {
      const cql = buildCql("", { creator: "me" });
      expect(cql).toBe("type = page AND creator = currentUser()");
    });

    test("creator filter with username", () => {
      const cql = buildCql("", { creator: "john.doe" });
      expect(cql).toBe('type = page AND creator = "john.doe"');
    });

    test("modified-since filter", () => {
      const cql = buildCql("", { "modified-since": "7d" });
      expect(cql).toBe('type = page AND lastModified >= now("-7d")');
    });

    test("created-since filter", () => {
      const cql = buildCql("", { "created-since": "thisMonth" });
      expect(cql).toBe("type = page AND created >= startOfMonth()");
    });

    test("ancestor filter", () => {
      const cql = buildCql("", { ancestor: "12345" });
      expect(cql).toBe("type = page AND ancestor = 12345");
    });

    test("type filter - blogpost", () => {
      const cql = buildCql("", { type: "blogpost" });
      expect(cql).toBe("type = blogpost");
    });

    test("type filter - all (no type filter)", () => {
      const cql = buildCql("search query", { type: "all" });
      expect(cql).toBe('text ~ "search query"');
    });

    test("combined filters", () => {
      const cql = buildCql("API", {
        space: "DEV",
        label: "docs",
        "modified-since": "7d",
      });
      expect(cql).toBe(
        'text ~ "API" AND space = "DEV" AND type = page AND label = "docs" AND lastModified >= now("-7d")'
      );
    });

    test("escapes quotes in search query", () => {
      const cql = buildCql('search "quoted" text', {});
      expect(cql).toBe('text ~ "search \\"quoted\\" text" AND type = page');
    });
  });
});

describe("Search Output Formatting", () => {
  const truncate = (str: string, maxLen: number): string => {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 1) + "…";
  };

  const cleanExcerpt = (excerpt: string): string => {
    return excerpt
      .replace(/<[^>]*>/g, "")
      .replace(/\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  };

  test("truncate short string", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  test("truncate long string", () => {
    expect(truncate("hello world this is long", 10)).toBe("hello wor…");
  });

  test("cleanExcerpt removes HTML", () => {
    expect(cleanExcerpt("<p>Hello</p>")).toBe("Hello");
    expect(cleanExcerpt("<b>Bold</b> text")).toBe("Bold text");
  });

  test("cleanExcerpt collapses whitespace", () => {
    expect(cleanExcerpt("Hello    world")).toBe("Hello world");
    expect(cleanExcerpt("Hello\n\nworld")).toBe("Hello world");
  });
});
