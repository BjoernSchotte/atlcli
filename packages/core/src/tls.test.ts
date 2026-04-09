import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { buildTlsOptions } from "./tls.js";
import type { Profile } from "./config.js";

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: "test",
    baseUrl: "https://jira.company.com",
    auth: { type: "bearer", pat: "token" },
    ...overrides,
  };
}

describe("buildTlsOptions", () => {
  test("returns undefined when no TLS settings are configured", () => {
    const profile = makeProfile();
    expect(buildTlsOptions(profile)).toBeUndefined();
  });

  test("sets rejectUnauthorized=false when tlsSkipVerify is true", () => {
    const profile = makeProfile({ tlsSkipVerify: true });
    const opts = buildTlsOptions(profile);
    expect(opts).toBeDefined();
    expect(opts?.rejectUnauthorized).toBe(false);
  });

  test("returns undefined when tlsSkipVerify is false (default)", () => {
    const profile = makeProfile({ tlsSkipVerify: false });
    expect(buildTlsOptions(profile)).toBeUndefined();
  });

  describe("tlsCaFile", () => {
    let tmpDir: string;
    let caFilePath: string;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `atlcli-tls-test-${randomUUID()}`);
      mkdirSync(tmpDir, { recursive: true });
      caFilePath = join(tmpDir, "ca.pem");
      writeFileSync(caFilePath, "-----BEGIN CERTIFICATE-----\nFAKECA\n-----END CERTIFICATE-----\n", "utf8");
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    test("reads CA file and sets ca field", () => {
      const profile = makeProfile({ tlsCaFile: caFilePath });
      const opts = buildTlsOptions(profile);
      expect(opts).toBeDefined();
      expect(opts?.ca).toContain("FAKECA");
    });

    test("combines tlsCaFile and tlsSkipVerify", () => {
      const profile = makeProfile({ tlsCaFile: caFilePath, tlsSkipVerify: true });
      const opts = buildTlsOptions(profile);
      expect(opts?.ca).toContain("FAKECA");
      expect(opts?.rejectUnauthorized).toBe(false);
    });

    test("throws when CA file does not exist", () => {
      const profile = makeProfile({ tlsCaFile: "/nonexistent/path/ca.pem" });
      expect(() => buildTlsOptions(profile)).toThrow(/Failed to read CA certificate file/);
    });
  });
});
