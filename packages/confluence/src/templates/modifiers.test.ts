import { describe, test, expect } from "bun:test";
import { defaultModifiers, applyModifierChain } from "./modifiers.js";

describe("string modifiers", () => {
  test("upper converts to uppercase", () => {
    expect(defaultModifiers.upper("hello")).toBe("HELLO");
    expect(defaultModifiers.upper("Hello World")).toBe("HELLO WORLD");
  });

  test("lower converts to lowercase", () => {
    expect(defaultModifiers.lower("HELLO")).toBe("hello");
    expect(defaultModifiers.lower("Hello World")).toBe("hello world");
  });

  test("capitalize capitalizes first letter", () => {
    expect(defaultModifiers.capitalize("hello")).toBe("Hello");
    expect(defaultModifiers.capitalize("HELLO")).toBe("Hello");
  });

  test("titleCase converts to title case", () => {
    expect(defaultModifiers.titleCase("hello world")).toBe("Hello World");
    expect(defaultModifiers.titleCase("the quick brown fox")).toBe("The Quick Brown Fox");
  });

  test("slug creates URL-safe slug", () => {
    expect(defaultModifiers.slug("Hello World")).toBe("hello-world");
    expect(defaultModifiers.slug("Hello  World!")).toBe("hello-world");
    expect(defaultModifiers.slug("Some & Other")).toBe("some-other");
  });

  test("camelCase converts to camelCase", () => {
    expect(defaultModifiers.camelCase("hello world")).toBe("helloWorld");
    expect(defaultModifiers.camelCase("Hello World")).toBe("helloWorld");
  });

  test("pascalCase converts to PascalCase", () => {
    expect(defaultModifiers.pascalCase("hello world")).toBe("HelloWorld");
  });

  test("kebabCase converts to kebab-case", () => {
    expect(defaultModifiers.kebabCase("Hello World")).toBe("hello-world");
    expect(defaultModifiers.kebabCase("helloWorld")).toBe("hello-world");
  });

  test("snakeCase converts to snake_case", () => {
    expect(defaultModifiers.snakeCase("Hello World")).toBe("hello_world");
    expect(defaultModifiers.snakeCase("helloWorld")).toBe("hello_world");
  });

  test("truncate limits string length", () => {
    expect(defaultModifiers.truncate("Hello World", "5")).toBe("He...");
    expect(defaultModifiers.truncate("Hi", "10")).toBe("Hi");
    expect(defaultModifiers.truncate("Hello World", "8", "---")).toBe("Hello---");
  });

  test("trim removes whitespace", () => {
    expect(defaultModifiers.trim("  hello  ")).toBe("hello");
    expect(defaultModifiers.trim("\n\thello\n\t")).toBe("hello");
  });

  test("pad pads string to length", () => {
    expect(defaultModifiers.pad("hi", "5")).toBe("hi   ");
    expect(defaultModifiers.pad("hi", "5", "-")).toBe("hi---");
  });

  test("padStart pads at start", () => {
    expect(defaultModifiers.padStart("5", "3", "0")).toBe("005");
    expect(defaultModifiers.padStart("123", "3", "0")).toBe("123");
  });

  test("replace replaces substring", () => {
    expect(defaultModifiers.replace("hello world", "world", "there")).toBe("hello there");
  });

  test("default provides fallback", () => {
    expect(defaultModifiers.default("", "fallback")).toBe("fallback");
    expect(defaultModifiers.default(null, "fallback")).toBe("fallback");
    expect(defaultModifiers.default(undefined, "fallback")).toBe("fallback");
    expect(defaultModifiers.default("value", "fallback")).toBe("value");
  });

  test("prefix adds prefix", () => {
    expect(defaultModifiers.prefix("name", "Dr. ")).toBe("Dr. name");
  });

  test("suffix adds suffix", () => {
    expect(defaultModifiers.suffix("name", " PhD")).toBe("name PhD");
  });

  test("wrap wraps value", () => {
    expect(defaultModifiers.wrap("text", '"')).toBe('"text"');
    expect(defaultModifiers.wrap("text", "(", ")")).toBe("(text)");
  });

  test("repeat repeats string", () => {
    expect(defaultModifiers.repeat("ab", "3")).toBe("ababab");
  });

  test("reverse reverses string", () => {
    expect(defaultModifiers.reverse("hello")).toBe("olleh");
  });

  test("length returns string length", () => {
    expect(defaultModifiers.length("hello")).toBe(5);
    expect(defaultModifiers.length([1, 2, 3])).toBe(3);
  });

  test("substr extracts substring", () => {
    expect(defaultModifiers.substr("hello world", "0", "5")).toBe("hello");
    expect(defaultModifiers.substr("hello world", "6")).toBe("world");
  });

  test("split splits string", () => {
    expect(defaultModifiers.split("a,b,c", ",")).toEqual(["a", "b", "c"]);
  });

  test("escape escapes HTML", () => {
    expect(defaultModifiers.escape("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;"
    );
  });

  test("unescape unescapes HTML", () => {
    expect(defaultModifiers.unescape("&lt;div&gt;")).toBe("<div>");
  });

  test("urlEncode encodes URL", () => {
    expect(defaultModifiers.urlEncode("hello world")).toBe("hello%20world");
  });

  test("urlDecode decodes URL", () => {
    expect(defaultModifiers.urlDecode("hello%20world")).toBe("hello world");
  });
});

describe("number modifiers", () => {
  test("number formats with thousands separator", () => {
    expect(defaultModifiers.number(1234567)).toBe("1,234,567");
    expect(defaultModifiers.number(1234.5678, "2")).toBe("1,234.57");
  });

  test("currency formats as currency", () => {
    expect(defaultModifiers.currency(1234.5, "USD")).toContain("1,234.50");
  });

  test("percent formats as percentage", () => {
    expect(defaultModifiers.percent(0.85)).toBe("85%");
    expect(defaultModifiers.percent(0.8567, "1")).toBe("85.7%");
  });

  test("round rounds number", () => {
    expect(defaultModifiers.round(1.5)).toBe(2);
    expect(defaultModifiers.round(1.567, "2")).toBe(1.57);
  });

  test("floor floors number", () => {
    expect(defaultModifiers.floor(1.9)).toBe(1);
  });

  test("ceil ceils number", () => {
    expect(defaultModifiers.ceil(1.1)).toBe(2);
  });

  test("abs returns absolute value", () => {
    expect(defaultModifiers.abs(-5)).toBe(5);
    expect(defaultModifiers.abs(5)).toBe(5);
  });

  test("ordinal adds ordinal suffix", () => {
    expect(defaultModifiers.ordinal(1)).toBe("1st");
    expect(defaultModifiers.ordinal(2)).toBe("2nd");
    expect(defaultModifiers.ordinal(3)).toBe("3rd");
    expect(defaultModifiers.ordinal(4)).toBe("4th");
    expect(defaultModifiers.ordinal(11)).toBe("11th");
    expect(defaultModifiers.ordinal(21)).toBe("21st");
  });

  test("bytes formats byte sizes", () => {
    expect(defaultModifiers.bytes(0)).toBe("0 B");
    expect(defaultModifiers.bytes(1024)).toBe("1 KB");
    expect(defaultModifiers.bytes(1048576)).toBe("1 MB");
    expect(defaultModifiers.bytes(1536)).toBe("1.5 KB");
  });
});

describe("array modifiers", () => {
  test("join joins array elements", () => {
    expect(defaultModifiers.join(["a", "b", "c"], ", ")).toBe("a, b, c");
    expect(defaultModifiers.join(["a", "b"], " and ")).toBe("a and b");
  });

  test("first returns first element", () => {
    expect(defaultModifiers.first(["a", "b", "c"])).toBe("a");
    expect(defaultModifiers.first([])).toBe(undefined);
  });

  test("last returns last element", () => {
    expect(defaultModifiers.last(["a", "b", "c"])).toBe("c");
    expect(defaultModifiers.last([])).toBe(undefined);
  });

  test("nth returns element at index", () => {
    expect(defaultModifiers.nth(["a", "b", "c"], "1")).toBe("b");
    expect(defaultModifiers.nth(["a", "b", "c"], "5")).toBe(undefined);
  });

  test("sort sorts array", () => {
    expect(defaultModifiers.sort(["c", "a", "b"])).toEqual(["a", "b", "c"]);
    expect(defaultModifiers.sort([3, 1, 2])).toEqual([1, 2, 3]);
  });

  test("sortBy sorts by property", () => {
    const items = [{ name: "c" }, { name: "a" }, { name: "b" }];
    const result = defaultModifiers.sortBy(items, "name") as any[];
    expect(result[0].name).toBe("a");
    expect(result[2].name).toBe("c");
  });

  test("reverse reverses array", () => {
    expect(defaultModifiers.reverse(["a", "b", "c"])).toEqual(["c", "b", "a"]);
  });

  test("unique removes duplicates", () => {
    expect(defaultModifiers.unique(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  test("compact removes null, undefined, and empty strings", () => {
    expect(defaultModifiers.compact([1, null, 2, undefined, 3, "", 0])).toEqual([1, 2, 3, 0]);
  });

  test("slice extracts portion", () => {
    expect(defaultModifiers.slice(["a", "b", "c", "d"], "1", "3")).toEqual(["b", "c"]);
    expect(defaultModifiers.slice(["a", "b", "c"], "1")).toEqual(["b", "c"]);
  });

  test("pluck extracts property", () => {
    const items = [{ name: "a" }, { name: "b" }];
    expect(defaultModifiers.pluck(items, "name")).toEqual(["a", "b"]);
  });

  test("where filters by property", () => {
    const items = [
      { name: "a", active: true },
      { name: "b", active: false },
      { name: "c", active: true },
    ];
    const result = defaultModifiers.where(items, "active", "true") as any[];
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("a");
  });
});

describe("conditional modifiers", () => {
  test("or returns value or fallback", () => {
    expect(defaultModifiers.or("value", "fallback")).toBe("value");
    expect(defaultModifiers.or("", "fallback")).toBe("fallback");
    expect(defaultModifiers.or(null, "fallback")).toBe("fallback");
  });

  test("and returns suffix if truthy", () => {
    expect(defaultModifiers.and("value", "suffix")).toBe("suffix");
    expect(defaultModifiers.and("", "suffix")).toBe("");
    expect(defaultModifiers.and(null, "suffix")).toBe(null);
  });

  test("not negates boolean", () => {
    expect(defaultModifiers.not(true)).toBe(false);
    expect(defaultModifiers.not(false)).toBe(true);
    expect(defaultModifiers.not("")).toBe(true);
    expect(defaultModifiers.not("value")).toBe(false);
  });

  test("eq compares equality", () => {
    expect(defaultModifiers.eq("test", "test")).toBe(true);
    expect(defaultModifiers.eq("test", "other")).toBe(false);
    expect(defaultModifiers.eq(5, "5")).toBe(true);
  });

  test("neq compares inequality", () => {
    expect(defaultModifiers.neq("test", "other")).toBe(true);
    expect(defaultModifiers.neq("test", "test")).toBe(false);
  });

  test("gt compares greater than", () => {
    expect(defaultModifiers.gt(5, "3")).toBe(true);
    expect(defaultModifiers.gt(3, "5")).toBe(false);
    expect(defaultModifiers.gt(5, "5")).toBe(false);
  });

  test("gte compares greater or equal", () => {
    expect(defaultModifiers.gte(5, "3")).toBe(true);
    expect(defaultModifiers.gte(5, "5")).toBe(true);
    expect(defaultModifiers.gte(3, "5")).toBe(false);
  });

  test("lt compares less than", () => {
    expect(defaultModifiers.lt(3, "5")).toBe(true);
    expect(defaultModifiers.lt(5, "3")).toBe(false);
  });

  test("lte compares less or equal", () => {
    expect(defaultModifiers.lte(3, "5")).toBe(true);
    expect(defaultModifiers.lte(5, "5")).toBe(true);
    expect(defaultModifiers.lte(5, "3")).toBe(false);
  });

  test("between checks range", () => {
    expect(defaultModifiers.between(5, "1", "10")).toBe(true);
    expect(defaultModifiers.between(0, "1", "10")).toBe(false);
    expect(defaultModifiers.between(11, "1", "10")).toBe(false);
  });

  test("in checks membership", () => {
    expect(defaultModifiers.in("b", "a", "b", "c")).toBe(true);
    expect(defaultModifiers.in("d", "a", "b", "c")).toBe(false);
  });

  test("empty checks emptiness", () => {
    expect(defaultModifiers.empty("")).toBe(true);
    expect(defaultModifiers.empty(null)).toBe(true);
    expect(defaultModifiers.empty(undefined)).toBe(true);
    expect(defaultModifiers.empty([])).toBe(true);
    expect(defaultModifiers.empty("value")).toBe(false);
    expect(defaultModifiers.empty([1])).toBe(false);
  });

  test("present checks presence", () => {
    expect(defaultModifiers.present("value")).toBe(true);
    expect(defaultModifiers.present([1])).toBe(true);
    expect(defaultModifiers.present("")).toBe(false);
    expect(defaultModifiers.present([])).toBe(false);
  });
});

describe("date modifiers", () => {
  const testDate = "2025-01-12T10:30:00Z";

  test("date formats date", () => {
    const result = defaultModifiers.date(testDate, "YYYY-MM-DD") as string;
    expect(result).toBe("2025-01-12");
  });

  test("date formats with time", () => {
    const result = defaultModifiers.date(testDate, "HH:mm") as string;
    // Time depends on timezone, just check format
    expect(result).toMatch(/\d{2}:\d{2}/);
  });

  test("relative returns relative time", () => {
    const now = new Date().toISOString();
    const result = defaultModifiers.relative(now) as string;
    expect(result).toContain("now");
  });

  test("add adds time", () => {
    const result = defaultModifiers.add(testDate, "7", "days") as string;
    expect(result).toContain("2025-01-19");
  });

  test("subtract subtracts time", () => {
    const result = defaultModifiers.subtract(testDate, "7", "days") as string;
    expect(result).toContain("2025-01-05");
  });

  test("startOf returns start of period", () => {
    const result = defaultModifiers.startOf(testDate, "month") as string;
    expect(result).toContain("2025-01-01");
  });

  test("endOf returns end of period", () => {
    const result = defaultModifiers.endOf(testDate, "month") as string;
    expect(result).toContain("2025-01-31");
  });
});

describe("applyModifierChain", () => {
  test("applies single modifier", () => {
    const result = applyModifierChain("hello", [{ name: "upper", args: [] }], defaultModifiers);
    expect(result).toBe("HELLO");
  });

  test("applies chain in order", () => {
    const result = applyModifierChain(
      "  hello  ",
      [
        { name: "trim", args: [] },
        { name: "upper", args: [] },
      ],
      defaultModifiers
    );
    expect(result).toBe("HELLO");
  });

  test("passes arguments to modifiers", () => {
    const result = applyModifierChain(
      "hello world",
      [{ name: "truncate", args: ["5"] }],
      defaultModifiers
    );
    expect(result).toBe("he...");
  });

  test("handles unknown modifier gracefully", () => {
    const result = applyModifierChain(
      "hello",
      [{ name: "nonexistent", args: [] }],
      defaultModifiers
    );
    expect(result).toBe("hello");
  });
});
