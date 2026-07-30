import { describe, expect, test } from "bun:test";
import {
  AttachmentDeliveryError,
  createPageAttachmentWriterV1,
  type ConfluenceProductRequestV1,
} from "./attachment-delivery.js";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function v1Attachment(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "att-1",
    title: "report.pdf",
    metadata: {
      mediaType: "application/pdf",
      comment: "generated",
    },
    extensions: { fileSize: 42 },
    version: {
      number: 3,
      when: "2026-07-30T10:00:00.000Z",
    },
    _links: {
      base: "https://example.atlassian.net/wiki",
      webui: "/spaces/DOCSY/pages/123?preview=/123/att-1",
      download: "/download/attachments/123/report.pdf",
    },
    ...overrides,
  };
}

function expectDeliveryError(
  value: unknown,
  kind: AttachmentDeliveryError["kind"],
): AttachmentDeliveryError {
  expect(value).toBeInstanceOf(AttachmentDeliveryError);
  const error = value as AttachmentDeliveryError;
  expect(error.kind).toBe(kind);
  return error;
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

describe("createPageAttachmentWriterV1", () => {
  test("uses one bounded v2 filename request and normalizes the browser response", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const request: ConfluenceProductRequestV1 = async (path, init) => {
      calls.push({ path, init });
      return jsonResponse({
        results: [
          {
            id: "9001",
            title: "Résumé #1?.pdf",
            mediaType: "application/pdf",
            fileSize: 987,
            comment: "direct comment",
            webuiLink: "/spaces/DOCSY/pages/123",
            downloadLink: "/download/attachments/123/resume.pdf",
            version: {
              number: 7,
              createdAt: "2026-07-30T11:00:00.000Z",
              message: "version comment",
            },
          },
        ],
        _links: { next: "/wiki/api/v2/pages/123/attachments?cursor=ignored" },
      });
    };

    const attachment = await createPageAttachmentWriterV1(request).findByFilename({
      pageId: "page/123",
      filename: "Résumé #1?.pdf",
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.path, "https://example.invalid");
    expect(url.pathname).toBe("/wiki/api/v2/pages/page%2F123/attachments");
    expect(url.searchParams.get("filename")).toBe("Résumé #1?.pdf");
    expect(url.searchParams.get("limit")).toBe("1");
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(calls[0]!.init?.method).toBe("GET");
    expect(new Headers(calls[0]!.init?.headers).get("Accept")).toBe(
      "application/json",
    );
    expect(attachment).toEqual({
      id: "9001",
      filename: "Résumé #1?.pdf",
      mediaType: "application/pdf",
      fileSize: 987,
      version: 7,
      modified: "2026-07-30T11:00:00.000Z",
      pageId: "page/123",
      downloadUrl: "/download/attachments/123/resume.pdf",
      url: "/spaces/DOCSY/pages/123",
      comment: "direct comment",
    });
  });

  test("returns undefined for an empty exact-name result", async () => {
    const writer = createPageAttachmentWriterV1(async () =>
      jsonResponse({ results: [] })
    );
    await expect(
      writer.findByFilename({ pageId: "123", filename: "missing.pdf" }),
    ).resolves.toBeUndefined();
  });

  test("creates with Blob-first multipart, explicit minorEdit, and a Unicode comment", async () => {
    class NoMaterializationBlob extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error("Blob.arrayBuffer() must not be called");
      }
    }

    const body = new NoMaterializationBlob(["pdf-content"], {
      type: "application/pdf",
    });
    let postCount = 0;
    const writer = createPageAttachmentWriterV1(async (path, init) => {
      if (init?.method === "GET") return jsonResponse({ results: [] });
      postCount++;
      expect(path).toBe("/wiki/rest/api/content/123/child/attachment");
      const headers = new Headers(init?.headers);
      expect(headers.get("Accept")).toBe("application/json");
      expect(headers.get("X-Atlassian-Token")).toBe("nocheck");
      expect(headers.has("Content-Type")).toBe(false);
      expect(headers.has("Authorization")).toBe(false);
      expect(init?.credentials).toBeUndefined();

      const form = init?.body as FormData;
      expect([...form.keys()]).toEqual(["file", "minorEdit", "comment"]);
      const file = form.get("file") as File;
      expect(file.name).toBe("report.pdf");
      expect(file.type).toBe("application/pdf");
      expect(file.size).toBe(body.size);
      expect(form.get("minorEdit")).toBe("false");
      expect(form.get("comment")).toBe("Überarbeitet – 東京");
      return jsonResponse({ results: [v1Attachment()] });
    });

    const attachment = await writer.create({
      pageId: "123",
      filename: "report.pdf",
      body,
      mimeType: "application/pdf",
      comment: "Überarbeitet – 東京",
      minorEdit: false,
    });

    expect(postCount).toBe(1);
    expect(attachment.id).toBe("att-1");
    expect(attachment.url).toBe(
      "https://example.atlassian.net/wiki/spaces/DOCSY/pages/123?preview=/123/att-1",
    );
  });

  test("defaults minorEdit to true and wraps only the Uint8Array view", async () => {
    const backing = new Uint8Array([0, 1, 2, 3, 4]);
    const body = backing.subarray(2, 4);
    const writer = createPageAttachmentWriterV1(async (_path, init) => {
      const form = init?.body as FormData;
      expect(form.get("minorEdit")).toBe("true");
      const file = form.get("file") as File;
      expect(file.size).toBe(2);
      expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([2, 3]);
      return jsonResponse(v1Attachment({
        version: {
          number: 4,
          when: "2026-07-30T12:00:00.000Z",
          message: "new version",
        },
      }));
    });

    const attachment = await writer.updateData({
      pageId: "123",
      attachmentId: "att/1",
      filename: "report.pdf",
      body,
      mimeType: "application/pdf",
    });

    expect(attachment.version).toBe(4);
    expect(attachment.comment).toBe("generated");
  });

  test("uses the injected normal-browser request without assuming global fetch", async () => {
    const originalFetch = globalThis.fetch;
    let commonInit: RequestInit | undefined;
    globalThis.fetch = (() => {
      throw new Error("global fetch must not be used by the writer");
    }) as unknown as typeof fetch;
    try {
      const sameOriginRequest: ConfluenceProductRequestV1 = async (_path, init) => {
        commonInit = init;
        const hostInit = { ...init, credentials: "include" as const };
        expect(hostInit.credentials).toBe("include");
        return jsonResponse({ results: [] });
      };
      await createPageAttachmentWriterV1(sameOriginRequest).findByFilename({
        pageId: "123",
        filename: "report.pdf",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(new Headers(commonInit?.headers).has("Authorization")).toBe(false);
    expect(commonInit?.credentials).toBeUndefined();
  });

  test("accepts a Forge-shaped requestConfluence function without a Forge import", async () => {
    const paths: string[] = [];
    const requestConfluence = async (
      path: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      paths.push(path);
      return jsonResponse({ results: [] });
    };

    await createPageAttachmentWriterV1(requestConfluence).findByFilename({
      pageId: "123",
      filename: "forge.pdf",
    });

    expect(paths[0]).toStartWith("/wiki/api/v2/pages/123/attachments?");
  });

  test("uses an adapter-relative path when pathPrefix is empty", async () => {
    let observed = "";
    const writer = createPageAttachmentWriterV1(
      async (path) => {
        observed = path;
        return jsonResponse({ results: [] });
      },
      { pathPrefix: "" },
    );
    await writer.findByFilename({ pageId: "123", filename: "report.pdf" });
    expect(observed).toStartWith("/api/v2/pages/123/attachments?");
  });

  test("reports an existing preflight match without posting or updating", async () => {
    let calls = 0;
    const writer = createPageAttachmentWriterV1(async () => {
      calls++;
      return jsonResponse({
        results: [v1Attachment()],
      });
    });

    const error = expectDeliveryError(
      await rejected(writer.create({
        pageId: "123",
        filename: "report.pdf",
        body: new Blob(["pdf"]),
        mimeType: "application/pdf",
      })),
      "name-conflict",
    );
    expect(calls).toBe(1);
    expect(error.operation).toBe("create");
    expect(error.requestMayHaveSucceeded).toBe(false);
    expect(error.requerySuggested).toBe(true);
  });

  test.each([
    [409, { message: "Conflict" }],
    [400, { message: "Cannot add a new attachment with the same file name" }],
  ])("classifies a %i create race and never retries", async (status, payload) => {
    let getCount = 0;
    let postCount = 0;
    const writer = createPageAttachmentWriterV1(async (_path, init) => {
      if (init?.method === "GET") {
        getCount++;
        return jsonResponse({ results: [] });
      }
      postCount++;
      return jsonResponse(payload, { status });
    });

    const error = expectDeliveryError(
      await rejected(writer.create({
        pageId: "123",
        filename: "report.pdf",
        body: new Blob(["pdf"]),
        mimeType: "application/pdf",
      })),
      "name-conflict",
    );
    expect(getCount).toBe(1);
    expect(postCount).toBe(1);
    expect(error.status).toBe(status);
    expect(error.requerySuggested).toBe(true);
    expect(error.requestMayHaveSucceeded).toBe(false);
  });

  test.each([
    [403, "forbidden"],
    [404, "not-found"],
    [429, "rate-limited"],
    [413, "too-large"],
  ] as const)("maps HTTP %i to %s", async (status, kind) => {
    const writer = createPageAttachmentWriterV1(async () =>
      jsonResponse({ message: "safe diagnostic" }, {
        status,
        headers: {
          "Content-Type": "application/json",
          ...(status === 429 ? { "Retry-After": "2" } : {}),
        },
      })
    );

    const error = expectDeliveryError(
      await rejected(
        writer.findByFilename({ pageId: "123", filename: "report.pdf" }),
      ),
      kind,
    );
    expect(error.status).toBe(status);
    expect(error.diagnostic).toBe("safe diagnostic");
    expect(error.retryAfterMs).toBe(status === 429 ? 2_000 : undefined);
  });

  test("classifies a product-reported oversized response", async () => {
    const writer = createPageAttachmentWriterV1(async () =>
      jsonResponse({ message: "Attachment exceeds the maximum file size" }, {
        status: 400,
      })
    );
    expectDeliveryError(
      await rejected(
        writer.findByFilename({ pageId: "123", filename: "report.pdf" }),
      ),
      "too-large",
    );
  });

  test("surfaces a create transport failure as ambiguous and does not retry", async () => {
    let postCount = 0;
    const writer = createPageAttachmentWriterV1(async (_path, init) => {
      if (init?.method === "GET") return jsonResponse({ results: [] });
      postCount++;
      throw new TypeError("connection closed after request write");
    });

    const error = expectDeliveryError(
      await rejected(writer.create({
        pageId: "123",
        filename: "report.pdf",
        body: new Blob(["pdf"]),
        mimeType: "application/pdf",
      })),
      "transport",
    );
    expect(postCount).toBe(1);
    expect(error.operation).toBe("create");
    expect(error.requestMayHaveSucceeded).toBe(true);
    expect(error.requerySuggested).toBe(true);
    expect("body" in error).toBe(false);
    expect("headers" in error).toBe(false);
  });

  test("does not retry an ambiguous 500 create response", async () => {
    let postCount = 0;
    const writer = createPageAttachmentWriterV1(async (_path, init) => {
      if (init?.method === "GET") return jsonResponse({ results: [] });
      postCount++;
      return jsonResponse({ message: "server failed" }, { status: 500 });
    });

    const error = expectDeliveryError(
      await rejected(writer.create({
        pageId: "123",
        filename: "report.pdf",
        body: new Blob(["pdf"]),
        mimeType: "application/pdf",
      })),
      "transport",
    );
    expect(postCount).toBe(1);
    expect(error.requestMayHaveSucceeded).toBe(true);
    expect(error.requerySuggested).toBe(true);
  });

  test("rejects malformed and structurally invalid successful responses", async () => {
    const malformed = createPageAttachmentWriterV1(async () =>
      new Response("{not-json", { status: 200 })
    );
    expectDeliveryError(
      await rejected(
        malformed.findByFilename({ pageId: "123", filename: "report.pdf" }),
      ),
      "invalid-response",
    );

    const missingResults = createPageAttachmentWriterV1(async () =>
      jsonResponse({ value: [] })
    );
    expectDeliveryError(
      await rejected(
        missingResults.findByFilename({
          pageId: "123",
          filename: "report.pdf",
        }),
      ),
      "invalid-response",
    );

    const emptyCreate = createPageAttachmentWriterV1(async (_path, init) =>
      init?.method === "GET"
        ? jsonResponse({ results: [] })
        : jsonResponse({ results: [] })
    );
    const createError = expectDeliveryError(
      await rejected(emptyCreate.create({
        pageId: "123",
        filename: "report.pdf",
        body: new Blob(["pdf"]),
        mimeType: "application/pdf",
      })),
      "invalid-response",
    );
    expect(createError.requestMayHaveSucceeded).toBe(true);
    expect(createError.requerySuggested).toBe(true);

    const missingIdentity = createPageAttachmentWriterV1(async (_path, init) =>
      init?.method === "GET"
        ? jsonResponse({ results: [] })
        : jsonResponse({ results: [{ title: "report.pdf" }] })
    );
    expectDeliveryError(
      await rejected(missingIdentity.create({
        pageId: "123",
        filename: "report.pdf",
        body: new Blob(["pdf"]),
        mimeType: "application/pdf",
      })),
      "invalid-response",
    );
  });
});
