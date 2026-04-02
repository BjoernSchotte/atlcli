import { describe, expect, test, mock, beforeEach } from "bun:test";

const outputMock = mock<(data: unknown, opts: { json: boolean }) => void>(() => {});

mock.module("@atlcli/core", () => ({
  output: outputMock,
}));

const { handleHelloworld } = await import("./helloworld");

describe("helloworld command", () => {
  beforeEach(() => {
    outputMock.mockReset();
  });

  test("outputs greeting with repo URL", async () => {
    await handleHelloworld([], {}, { json: false });

    expect(outputMock).toHaveBeenCalledTimes(1);
    const message = outputMock.mock.calls[0]?.[0];
    expect(String(message)).toContain("Hello dear user");
    expect(String(message)).toContain("https://github.com/BjoernSchotte/atlcli");
  });

  test("outputs JSON when json flag is set", async () => {
    await handleHelloworld([], {}, { json: true });

    expect(outputMock).toHaveBeenCalledTimes(1);
    const message = outputMock.mock.calls[0]?.[0];
    expect(String(message)).toContain("Hello dear user");
  });
});
