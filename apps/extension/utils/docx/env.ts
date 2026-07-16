/**
 * Browser implementations of the `@atlcli/docx` export-env interfaces
 * (spec 006 Task 3). The engine is isomorphic; these thin adapters are the
 * extension's imperative shell: template bytes come from the IndexedDB store,
 * asset bytes ride the user's Atlassian session cookies, and the finished
 * document leaves through a browser download. No engine code touches
 * `chrome.*` / DOM — it all lives here, next to the host that owns it.
 */
import type { AssetFetcher, AssetRef, OutputSink, TemplateSource } from "@atlcli/docx/browser";
import { getTemplate } from "./template-store.js";

/**
 * {@link TemplateSource} over the panel's IndexedDB template store. The id is
 * the store slot (the panel uses the single `"current"` slot). Rejects when
 * nothing is stored — the caller (panel) gates Export on a loaded template,
 * so this firing means the template was deleted underneath the panel.
 */
export function idbTemplateSource(factory?: IDBFactory): TemplateSource {
  return {
    async getBytes(id: string): Promise<Uint8Array> {
      const stored = await getTemplate(id, factory);
      if (!stored) throw new Error(`No template stored under id "${id}". Upload a template first.`);
      return new Uint8Array(stored.bytes);
    },
  };
}

/**
 * {@link AssetFetcher} over the page's own session: attachment downloads are
 * plain GETs that succeed because the browser attaches the Atlassian cookies
 * (`credentials: "include"`). Unused in v1 (image embedding is deferred to
 * spec 005) but wired now so the seam is real, not aspirational.
 */
export function sessionAssetFetcher(fetchFn: typeof fetch = fetch): AssetFetcher {
  return {
    async fetch(ref: AssetRef): Promise<Uint8Array> {
      const res = await fetchFn(ref.url, { credentials: "include" });
      if (!res.ok) {
        throw new Error(`Asset fetch failed (${res.status}) for ${ref.filename ?? ref.url}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/**
 * {@link OutputSink} that hands the bytes to the browser as a `.docx`
 * download via a temporary object URL on an invisible anchor.
 */
export function downloadOutputSink(doc: Document = document): OutputSink {
  return {
    async emit(name: string, bytes: Uint8Array): Promise<void> {
      const blob = new Blob([bytes as BlobPart], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      const url = URL.createObjectURL(blob);
      const a = doc.createElement("a");
      a.href = url;
      a.download = name;
      doc.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
}
