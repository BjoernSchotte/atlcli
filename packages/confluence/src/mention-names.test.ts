import { afterEach, describe, expect, test } from "bun:test";
import type { Profile } from "@atlcli/core";
import { ConfluenceClient } from "./client.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function profile(deploymentType: "cloud" | "data-center"): Profile {
  return {
    name: "synthetic",
    baseUrl: "https://wiki.example.invalid",
    deploymentType,
    auth: { type: "apiToken", email: "fixture@example.invalid", token: "fixture-token" },
  } as Profile;
}

const STORAGE = [
  '<p><ac:link><ri:user ri:account-id="acc-1" /></ac:link>',
  '<ac:link><ri:user ri:userkey="key-2" /></ac:link>',
  '<ac:link><ri:user ri:account-id="gone" /></ac:link></p>',
].join("");

describe("ConfluenceClient.mentionNames", () => {
  test("looks up account ids and user keys once per client; unknown users stay unnamed", async () => {
    const queries: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      queries.push(url.search);
      if (url.searchParams.get("accountId") === "acc-1") return Response.json({ accountId: "acc-1", displayName: "Ann" });
      if (url.searchParams.get("key") === "key-2") return Response.json({ userKey: "key-2", displayName: "Bob" });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const client = new ConfluenceClient(profile("cloud"));
    const expected = new Map([["acc-1", "Ann"], ["userkey:key-2", "Bob"]]);
    expect(await client.mentionNames([STORAGE])).toEqual(expected);
    const first = queries.length;
    expect(await client.mentionNames([STORAGE, STORAGE])).toEqual(expected);
    expect(queries.length).toBe(first);
    expect(queries.some((q) => q.includes("key=key-2"))).toBe(true);
  });

  test("a failing lookup leaves the mention unnamed instead of failing", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 403 })) as unknown as typeof fetch;
    expect(await new ConfluenceClient(profile("data-center")).mentionNames([STORAGE])).toEqual(new Map());
  });
});
