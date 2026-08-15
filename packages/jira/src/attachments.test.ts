/**
 * Unit tests for the attachment functional core (issue #8).
 *
 * The commands themselves are covered end-to-end in
 * `apps/cli/src/commands/jira-attachments.test.ts`; what lives here are the
 * rules that are painful to provoke through a real Jira — hostile filenames,
 * duplicate names on one issue, `-o` pointing at a file vs a directory.
 */
import { describe, expect, it } from "bun:test";
import {
  formatAttachmentDate,
  formatAttachmentSize,
  formatAttachmentsTable,
  insertIdSuffix,
  outputIsDirectory,
  parseAttachRequest,
  parseAttachmentTarget,
  planDownloads,
  resolveDownloadPath,
  sanitizeAttachmentFilename,
  selectAttachmentsByFilename,
  toAttachmentJson,
} from "./attachments.js";
import type { JiraAttachment } from "./types.js";

const attachment = (over: Partial<JiraAttachment> = {}): JiraAttachment => ({
  id: "10001",
  filename: "screenshot.png",
  author: { displayName: "Alice", emailAddress: "alice@example.com" },
  created: "2026-01-14T10:00:00.000+0000",
  size: 250880,
  mimeType: "image/png",
  content: "https://example.atlassian.net/rest/api/3/attachment/content/10001",
  ...over,
});

describe("parseAttachRequest", () => {
  it("reads the issue key positionally (issue #90)", () => {
    expect(parseAttachRequest(["PROJ-123", "./a.png"])).toEqual({
      ok: true,
      request: { issueKey: "PROJ-123", files: ["./a.png"] },
    });
  });

  it("keeps every file of an expanded glob", () => {
    // The regression: only args[0] was uploaded, the rest vanished silently.
    expect(parseAttachRequest(["PROJ-123", "a.png", "b.pdf", "logs.zip"])).toEqual({
      ok: true,
      request: { issueKey: "PROJ-123", files: ["a.png", "b.pdf", "logs.zip"] },
    });
  });

  it("still accepts --key for backward compatibility", () => {
    expect(parseAttachRequest(["a.png", "b.png"], "PROJ-123")).toEqual({
      ok: true,
      request: { issueKey: "PROJ-123", files: ["a.png", "b.png"] },
    });
  });

  it("does not treat a repeated --key value as a file", () => {
    expect(parseAttachRequest(["PROJ-123", "a.png"], "PROJ-123")).toEqual({
      ok: true,
      request: { issueKey: "PROJ-123", files: ["a.png"] },
    });
  });

  it("names the real problem when the key is missing", () => {
    const result = parseAttachRequest(["./a.png"]);
    expect(result.ok).toBe(false);
    // Not the old "File not found: PROJ-123"-shaped confusion.
    expect(result.ok === false && result.error).toContain("is not an issue key");
  });

  it("requires at least one file", () => {
    expect(parseAttachRequest(["PROJ-123"]).ok).toBe(false);
    expect(parseAttachRequest([], "PROJ-123").ok).toBe(false);
  });

  it("requires arguments at all", () => {
    const result = parseAttachRequest([]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("Issue key");
  });

  it("accepts lowercase and underscored project keys", () => {
    expect(parseAttachRequest(["proj_x-9", "a.png"])).toEqual({
      ok: true,
      request: { issueKey: "proj_x-9", files: ["a.png"] },
    });
  });
});

describe("parseAttachmentTarget", () => {
  it("reads a bare numeric id", () => {
    expect(parseAttachmentTarget(["10001"])).toEqual({
      ok: true,
      target: { kind: "id", id: "10001" },
    });
  });

  it("reads issue key plus filename", () => {
    expect(parseAttachmentTarget(["PROJ-123", "screenshot.png"])).toEqual({
      ok: true,
      target: { kind: "issue", issueKey: "PROJ-123", filename: "screenshot.png" },
    });
  });

  it("tells a lone issue key what it is missing", () => {
    const result = parseAttachmentTarget(["PROJ-123"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/filename/i);
  });

  it("rejects an empty invocation", () => {
    expect(parseAttachmentTarget([]).ok).toBe(false);
    expect(parseAttachmentTarget([""]).ok).toBe(false);
  });

  it("rejects an id used where an issue key belongs", () => {
    const result = parseAttachmentTarget(["10001", "screenshot.png"]);
    expect(result.ok).toBe(false);
  });

  it("rejects more than two positionals", () => {
    expect(parseAttachmentTarget(["PROJ-1", "a.png", "b.png"]).ok).toBe(false);
  });
});

describe("selectAttachmentsByFilename", () => {
  it("returns every attachment sharing the name", () => {
    const list = [
      attachment({ id: "1" }),
      attachment({ id: "2", filename: "other.png" }),
      attachment({ id: "3" }),
    ];
    expect(selectAttachmentsByFilename(list, "screenshot.png").map((a) => a.id)).toEqual([
      "1",
      "3",
    ]);
  });

  it("falls back to a case-insensitive match only when nothing matches exactly", () => {
    const list = [attachment({ id: "1", filename: "Screenshot.PNG" })];
    expect(selectAttachmentsByFilename(list, "screenshot.png").map((a) => a.id)).toEqual(["1"]);
  });

  it("does not let a case-insensitive match shadow an exact one", () => {
    const list = [
      attachment({ id: "1", filename: "Screenshot.PNG" }),
      attachment({ id: "2", filename: "screenshot.png" }),
    ];
    expect(selectAttachmentsByFilename(list, "screenshot.png").map((a) => a.id)).toEqual(["2"]);
  });

  it("returns nothing for an unknown name", () => {
    expect(selectAttachmentsByFilename([attachment()], "nope.txt")).toEqual([]);
  });
});

describe("sanitizeAttachmentFilename", () => {
  it("keeps an ordinary name", () => {
    expect(sanitizeAttachmentFilename("screenshot.png", "1")).toBe("screenshot.png");
  });

  it("strips a traversal path down to its basename", () => {
    // The filename is whatever the uploader typed — it must never steer the write.
    expect(sanitizeAttachmentFilename("../../.ssh/authorized_keys", "1")).toBe(
      "authorized_keys"
    );
    expect(sanitizeAttachmentFilename("/etc/passwd", "1")).toBe("passwd");
    expect(sanitizeAttachmentFilename("..\\..\\windows\\system32\\evil.dll", "1")).toBe(
      "evil.dll"
    );
  });

  it("falls back to attachment-<id> when nothing usable is left", () => {
    expect(sanitizeAttachmentFilename("..", "42")).toBe("attachment-42");
    expect(sanitizeAttachmentFilename("/", "42")).toBe("attachment-42");
    expect(sanitizeAttachmentFilename("   ", "42")).toBe("attachment-42");
  });

  it("drops control characters", () => {
    expect(sanitizeAttachmentFilename("re\u0000port\u001b.pdf", "1")).toBe("report.pdf");
  });
});

describe("insertIdSuffix", () => {
  it("inserts before the extension", () => {
    expect(insertIdSuffix("screenshot.png", "10001")).toBe("screenshot.10001.png");
  });

  it("uses the last dot", () => {
    expect(insertIdSuffix("archive.tar.gz", "7")).toBe("archive.tar.7.gz");
  });

  it("appends when there is no extension", () => {
    expect(insertIdSuffix("logfile", "7")).toBe("logfile.7");
  });

  it("treats a leading dot as part of the name, not an extension", () => {
    expect(insertIdSuffix(".gitignore", "7")).toBe(".gitignore.7");
  });
});

describe("planDownloads", () => {
  it("leaves a unique name alone", () => {
    expect(planDownloads([attachment()]).map((p) => p.filename)).toEqual(["screenshot.png"]);
  });

  it("disambiguates duplicate names with the attachment id", () => {
    // Jira happily accepts the same filename twice on one issue; without this
    // the second download silently overwrote the first.
    const planned = planDownloads([attachment({ id: "10001" }), attachment({ id: "10002" })]);
    expect(planned.map((p) => p.filename)).toEqual([
      "screenshot.10001.png",
      "screenshot.10002.png",
    ]);
  });

  it("only suffixes the names that actually collide", () => {
    const planned = planDownloads([
      attachment({ id: "1" }),
      attachment({ id: "2" }),
      attachment({ id: "3", filename: "notes.txt" }),
    ]);
    expect(planned.map((p) => p.filename)).toEqual([
      "screenshot.1.png",
      "screenshot.2.png",
      "notes.txt",
    ]);
  });

  it("sanitizes before deciding on collisions", () => {
    const planned = planDownloads([
      attachment({ id: "1", filename: "../a/report.pdf" }),
      attachment({ id: "2", filename: "../../b/report.pdf" }),
    ]);
    expect(planned.map((p) => p.filename)).toEqual(["report.1.pdf", "report.2.pdf"]);
  });
});

describe("outputIsDirectory", () => {
  it("defaults to the current directory when -o is absent", () => {
    expect(outputIsDirectory(undefined, { existsAsDirectory: false, fileCount: 1 })).toBe(true);
  });

  it("honours an existing directory", () => {
    expect(outputIsDirectory("./out", { existsAsDirectory: true, fileCount: 1 })).toBe(true);
  });

  it("honours a trailing separator even when the directory is not there yet", () => {
    expect(outputIsDirectory("./downloads/", { existsAsDirectory: false, fileCount: 1 })).toBe(
      true
    );
  });

  it("treats a plain path as a file for a single download", () => {
    expect(outputIsDirectory("./out.png", { existsAsDirectory: false, fileCount: 1 })).toBe(
      false
    );
  });

  it("treats a plain path as a directory once several files are involved", () => {
    expect(outputIsDirectory("./out", { existsAsDirectory: false, fileCount: 2 })).toBe(true);
  });
});

describe("resolveDownloadPath", () => {
  it("writes to the working directory by default", () => {
    expect(resolveDownloadPath(undefined, "a.png", { isDirectory: true })).toBe("a.png");
  });

  it("joins into a directory, trailing slash or not", () => {
    expect(resolveDownloadPath("./downloads/", "a.png", { isDirectory: true })).toBe(
      "./downloads/a.png"
    );
    expect(resolveDownloadPath("./downloads", "a.png", { isDirectory: true })).toBe(
      "./downloads/a.png"
    );
  });

  it("uses the path verbatim when it names the file", () => {
    expect(resolveDownloadPath("./out/renamed.png", "a.png", { isDirectory: false })).toBe(
      "./out/renamed.png"
    );
  });
});

describe("formatAttachmentSize", () => {
  it("formats the units the docs table promises", () => {
    expect(formatAttachmentSize(512)).toBe("512 B");
    expect(formatAttachmentSize(250880)).toBe("245 KB");
    expect(formatAttachmentSize(1258291)).toBe("1.2 MB");
    expect(formatAttachmentSize(2 * 1024 ** 3)).toBe("2.0 GB");
  });

  it("degrades gracefully on nonsense", () => {
    expect(formatAttachmentSize(Number.NaN)).toBe("-");
    expect(formatAttachmentSize(-1)).toBe("-");
  });
});

describe("formatAttachmentDate", () => {
  it("keeps the day, drops the clock", () => {
    expect(formatAttachmentDate("2026-01-14T10:00:00.000+0000")).toBe("2026-01-14");
  });

  it("passes anything unparseable through", () => {
    expect(formatAttachmentDate(undefined)).toBe("-");
    expect(formatAttachmentDate("whenever")).toBe("whenever");
  });
});

describe("toAttachmentJson", () => {
  it("matches the documented shape", () => {
    expect(toAttachmentJson(attachment())).toEqual({
      id: "10001",
      filename: "screenshot.png",
      size: 250880,
      mimeType: "image/png",
      created: "2026-01-14T10:00:00.000+0000",
      author: { displayName: "Alice", email: "alice@example.com" },
      content: "https://example.atlassian.net/rest/api/3/attachment/content/10001",
    });
  });

  it("omits an email Jira did not expose", () => {
    const json = toAttachmentJson(attachment({ author: { displayName: "Bob" } }));
    expect(json.author).toEqual({ displayName: "Bob" });
  });
});

describe("formatAttachmentsTable", () => {
  it("sizes columns to the widest row", () => {
    const lines = formatAttachmentsTable([
      attachment({ id: "10001" }),
      attachment({ id: "100002", filename: "a-much-longer-name.log", size: 12288 }),
    ]);
    expect(lines[0]).toStartWith("ID      FILENAME");
    expect(lines[0]).toContain("SIZE");
    expect(lines[0]).toContain("CREATED");
    expect(lines[1]).toContain("screenshot.png");
    expect(lines[1]).toContain("245 KB");
    expect(lines[1]).toContain("2026-01-14");
    expect(lines).toHaveLength(3);
  });
});
