import { describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
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
