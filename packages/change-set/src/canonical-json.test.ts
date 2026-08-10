import { describe, expect, test } from "bun:test";
import {
  CanonicalJsonErrorV1,
  canonicalJsonBytesV1,
  canonicalJsonV1,
} from "./index.js";

describe("canonicalJsonV1", () => {
  test("sorts object keys recursively while preserving array order", () => {
    const value = {
      z: 1,
      a: [{ y: true, x: "first" }, "second"],
      nested: { beta: null, alpha: -0 },
    };
    expect(canonicalJsonV1(value)).toBe(
      '{"a":[{"x":"first","y":true},"second"],"nested":{"alpha":0,"beta":null},"z":1}',
    );
    expect(new TextDecoder().decode(canonicalJsonBytesV1(value)))
      .toBe(canonicalJsonV1(value));
  });

  test("produces identical bytes for equivalent insertion orders", () => {
    const left = { outer: { b: 2, a: 1 }, list: [3, 2, 1] };
    const right = { list: [3, 2, 1], outer: { a: 1, b: 2 } };
    expect(canonicalJsonBytesV1(left)).toEqual(canonicalJsonBytesV1(right));
  });

  test("rejects JavaScript values that JSON.stringify would coerce or omit", () => {
    expect(() => canonicalJsonV1({ missing: undefined })).toThrow("JSON-only data");
    expect(() => canonicalJsonV1([undefined])).toThrow("JSON-only data");
    expect(() => canonicalJsonV1({ value: Number.NaN })).toThrow("finite number");
    expect(() => canonicalJsonV1({ value: Number.POSITIVE_INFINITY })).toThrow("finite number");
    expect(() => canonicalJsonV1({ value: 1n })).toThrow("JSON-only data");
    expect(() => canonicalJsonV1({ value: () => 1 })).toThrow("JSON-only data");
    expect(() => canonicalJsonV1(new Map([["a", 1]]))).toThrow("plain object");
    expect(() => canonicalJsonV1(new Set([1]))).toThrow("plain object");
    expect(() => canonicalJsonV1(new Date(0))).toThrow("plain object");
  });

  test("rejects cycles, sparse arrays, accessors, and symbols", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => canonicalJsonV1(cyclic)).toThrow("cyclic value");

    const sparse = new Array<unknown>(2);
    sparse[1] = "present";
    expect(() => canonicalJsonV1(sparse)).toThrow("sparse arrays");

    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => "not invoked",
    });
    expect(() => canonicalJsonV1(accessor)).toThrow("enumerable data property");

    const symbol = Symbol("hidden");
    expect(() => canonicalJsonV1({ [symbol]: "value" })).toThrow("symbol properties");
  });

  test("preserves JSON keys that are unsafe only when assigned as object properties", () => {
    expect(canonicalJsonV1(JSON.parse('{"prototype":2,"__proto__":1,"constructor":3}')))
      .toBe('{"__proto__":1,"constructor":3,"prototype":2}');
  });

  test("enforces depth, node, string, and output budgets", () => {
    expect(() => canonicalJsonV1({ nested: { value: true } }, {
      maxDepth: 1,
      maxNodes: 100,
      maxStringBytes: 100,
      maxOutputBytes: 100,
    })).toThrow("depth budget exceeded");
    expect(() => canonicalJsonV1([1, 2], {
      maxDepth: 10,
      maxNodes: 2,
      maxStringBytes: 100,
      maxOutputBytes: 100,
    })).toThrow("node budget exceeded");
    expect(() => canonicalJsonV1({ key: "long" }, {
      maxDepth: 10,
      maxNodes: 100,
      maxStringBytes: 3,
      maxOutputBytes: 100,
    })).toThrow("string-byte budget exceeded");
    expect(() => canonicalJsonV1([1, 2, 3], {
      maxDepth: 10,
      maxNodes: 100,
      maxStringBytes: 100,
      maxOutputBytes: 3,
    })).toThrow("output-byte budget exceeded");
  });

  test("reports a typed error with the failing path", () => {
    try {
      canonicalJsonV1({ nested: { bad: undefined } });
      throw new Error("expected canonicalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalJsonErrorV1);
      expect((error as CanonicalJsonErrorV1).path).toBe("$.nested.bad");
    }
  });
});
