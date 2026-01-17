import { describe, expect, test } from "bun:test";
import { handleHelloworld } from "./helloworld";

describe("helloworld command", () => {
  test("outputs greeting with repo URL", async () => {
    const originalWrite = process.stdout.write;
    const captured: string[] = [];
    process.stdout.write = ((chunk: string) => {
      captured.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      await handleHelloworld([], {}, { json: false });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("Hello dear user");
    expect(captured[0]).toContain("https://github.com/BjoernSchotte/atlcli");
  });

  test("outputs JSON when json flag is set", async () => {
    const originalWrite = process.stdout.write;
    const captured: string[] = [];
    process.stdout.write = ((chunk: string) => {
      captured.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      await handleHelloworld([], {}, { json: true });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(captured.length).toBe(1);
    const parsed = JSON.parse(captured[0]);
    expect(parsed).toContain("Hello dear user");
  });
});
