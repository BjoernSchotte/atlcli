/**
 * The port is only useful if the real client still fits through it.
 *
 * This is a compile-time assertion with a runtime smoke test attached: if
 * someone changes a `ConfluenceClient` signature the VFS depends on, the
 * `satisfies` below stops compiling and `bun run typecheck` fails, rather than
 * the mismatch surfacing as a runtime error inside a mounted filesystem.
 */
import { describe, expect, it } from "bun:test";
import { ConfluenceClient } from "@atlcli/confluence";
import type { VfsClient } from "./client-port.js";
import { FakeConfluenceClient } from "./testing/fake-client.js";

describe("VfsClient port", () => {
  it("is satisfied by the real ConfluenceClient", () => {
    // Structural check only — never constructed, so no network is involved.
    type RealIsAssignable = ConfluenceClient extends VfsClient ? true : never;
    const proof: RealIsAssignable = true;
    expect(proof).toBe(true);
  });

  it("is satisfied by the fake", () => {
    const fake: VfsClient = new FakeConfluenceClient();
    expect(fake.deploymentType).toBe("cloud");
  });
});
