import { describe, expect, test, mock, afterAll, beforeEach } from "bun:test";
import type { OutputOptions } from "@atlcli/core";

const outputMock = mock<(data: unknown, opts: OutputOptions) => void>(() => {});

// Spread the real barrel rather than replacing it: when `@atlcli/core` has not
// been evaluated yet, Bun treats the factory result as the COMPLETE export set,
// so a bare `{ output }` would make every other export vanish for this process.
const actualCore = { ...(await import("@atlcli/core")) };

mock.module("@atlcli/core", () => ({
  ...actualCore,
  output: outputMock,
}));

// `mock.module` is process-wide; restore the genuine barrel so this stub does
// not leak into later test files.
afterAll(() => {
  mock.module("@atlcli/core", () => actualCore);
});

const { handleHelloworld } = await import("./helloworld");

describe("helloworld command", () => {
  beforeEach(() => {
    outputMock.mockReset();
  });

  test("outputs greeting with repo URL", async () => {
    await handleHelloworld([], {}, { json: false });

    expect(outputMock).toHaveBeenCalledTimes(1);
    const message = outputMock.mock.calls[0]?.[0];
    const opts = outputMock.mock.calls[0]?.[1];
    expect(String(message)).toContain("Hello dear user");
    expect(String(message)).toContain("https://github.com/BjoernSchotte/atlcli");
    expect(opts).toEqual({ json: false });
  });

  test("outputs JSON when json flag is set", async () => {
    await handleHelloworld([], {}, { json: true });

    expect(outputMock).toHaveBeenCalledTimes(1);
    const message = outputMock.mock.calls[0]?.[0];
    const opts = outputMock.mock.calls[0]?.[1];
    expect(String(message)).toContain("Hello dear user");
    expect(opts).toEqual({ json: true });
  });
});
