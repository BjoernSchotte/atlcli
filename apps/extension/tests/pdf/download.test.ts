import { describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { pdfBytesFromUint8Array } from "@atlcli/pdf/browser";
import { downloadBytes, sanitizeDownloadName } from "../../utils/download.js";

describe("downloadBytes", () => {
  it("sanitizes filenames for both export formats", () => {
    expect(sanitizeDownloadName('A: B/C?*', "pdf")).toBe("A- B-C--.pdf");
    expect(sanitizeDownloadName("  ", ".docx")).toBe("Confluence export.docx");
  });

  it("downloads a PDF with its MIME type", async () => {
    const window = new Window();
    const doc = window.document as unknown as Document;
    let clicked: HTMLAnchorElement | null = null;
    doc.body.addEventListener("click", (event) => {
      clicked = event.target as HTMLAnchorElement;
      event.preventDefault();
    });
    await downloadBytes({
      name: "Page.pdf",
      bytes: new Uint8Array([37, 80, 68, 70]),
      mimeType: "application/pdf",
      document: doc,
    });
    const clickedAnchor = clicked as unknown as HTMLAnchorElement;
    expect(clickedAnchor.download).toBe("Page.pdf");
    expect(clickedAnchor.href).toStartWith("blob:");
    expect(doc.body.querySelector("a")).toBeNull();
  });

  /**
   * Spec 010, T5.6. The measured defect was a second full-size copy: this file
   * used to build `new Blob([bytes])` unconditionally, +64.0 MiB for a 64 MiB
   * PDF while the caller's array was still reachable. A handle already owns one
   * Blob and memoizes it, so the download must reuse it rather than make its own.
   */
  describe("PdfBytesHandle (spec 010, T5.6)", () => {
    it("downloads from a handle without building its own copy", async () => {
      const window = new Window();
      const doc = window.document as unknown as Document;
      let clicked: HTMLAnchorElement | null = null;
      doc.body.addEventListener("click", (event) => {
        clicked = event.target as HTMLAnchorElement;
        event.preventDefault();
      });
      const handle = pdfBytesFromUint8Array(new Uint8Array([37, 80, 68, 70]));
      await downloadBytes({
        name: "Handle.pdf",
        bytes: handle,
        mimeType: "application/pdf",
        document: doc,
      });
      const clickedAnchor = clicked as unknown as HTMLAnchorElement;
      expect(clickedAnchor.download).toBe("Handle.pdf");
      expect(clickedAnchor.href).toStartWith("blob:");
    });

    it("reuses the handle's Blob instead of allocating a second one", async () => {
      const window = new Window();
      const doc = window.document as unknown as Document;
      doc.body.addEventListener("click", (event) => event.preventDefault());
      const handle = pdfBytesFromUint8Array(new Uint8Array([37, 80, 68, 70]));
      // Whoever got there first (preview cache, retained job) already paid for
      // the Blob; the download must not pay again.
      const first = await handle.asBlob();
      const urls: unknown[] = [];
      const create = window.URL.createObjectURL.bind(window.URL);
      window.URL.createObjectURL = ((value: unknown) => {
        urls.push(value);
        return create(value as Parameters<typeof create>[0]);
      }) as typeof window.URL.createObjectURL;
      try {
        await downloadBytes({
          name: "Handle.pdf",
          bytes: handle,
          mimeType: "application/pdf",
          document: doc,
        });
      } finally {
        window.URL.createObjectURL = create;
      }
      // The identity check is the assertion: a second Blob would be a second
      // full-size copy of the document.
      expect(urls).toEqual([first]);
      expect(await handle.asBlob()).toBe(first);
    });

    it("still accepts a Uint8Array, because the DOCX engine has no handle", async () => {
      const window = new Window();
      const doc = window.document as unknown as Document;
      let clicked: HTMLAnchorElement | null = null;
      doc.body.addEventListener("click", (event) => {
        clicked = event.target as HTMLAnchorElement;
        event.preventDefault();
      });
      await downloadBytes({
        name: "Page.docx",
        bytes: new Uint8Array([80, 75, 3, 4]),
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        document: doc,
      });
      expect((clicked as unknown as HTMLAnchorElement).download).toBe("Page.docx");
    });
  });

  it("does not click when aborted immediately before the irreversible boundary", async () => {
    const window = new Window();
    const doc = window.document as unknown as Document;
    const controller = new AbortController();
    let clicks = 0;
    doc.body.addEventListener("click", () => { clicks += 1; });
    const append = doc.body.appendChild.bind(doc.body);
    doc.body.appendChild = ((node: Node) => {
      const result = append(node);
      controller.abort();
      return result;
    }) as typeof doc.body.appendChild;
    await expect(downloadBytes({
      name: "Page.pdf",
      bytes: new Uint8Array([37, 80, 68, 70]),
      mimeType: "application/pdf",
      document: doc,
      signal: controller.signal,
    })).rejects.toHaveProperty("name", "AbortError");
    expect(clicks).toBe(0);
    expect(doc.body.querySelector("a")).toBeNull();
  });
});
