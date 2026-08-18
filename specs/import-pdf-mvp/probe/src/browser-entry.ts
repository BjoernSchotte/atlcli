declare global {
  interface Window {
    runPdfiumProbe(): Promise<unknown>;
    cancelPdfiumProbe(): Promise<{ elapsedMs: number; terminated: boolean }>;
  }
}

function worker(): Worker {
  return new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "atlcli-pdfium-probe" });
}

window.runPdfiumProbe = async () => {
  const response = await fetch("./simple-untagged.pdf", { credentials: "same-origin" });
  const bytes = await response.arrayBuffer();
  const instance = worker();
  try {
    return await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("browser probe timed out")), 5_000);
      instance.onmessage = (event) => {
        window.clearTimeout(timeout);
        if (event.data?.ok) resolve(event.data.result);
        else reject(new Error(event.data?.error ?? "browser worker failed"));
      };
      instance.onerror = (event) => {
        window.clearTimeout(timeout);
        reject(new Error(event.message));
      };
      instance.postMessage(bytes, [bytes]);
    });
  } finally {
    instance.terminate();
  }
};

window.cancelPdfiumProbe = async () => {
  const response = await fetch("./heading-rich-100.pdf", { credentials: "same-origin" });
  const bytes = await response.arrayBuffer();
  const instance = worker();
  const started = performance.now();
  instance.postMessage(bytes, [bytes]);
  await new Promise((resolve) => window.setTimeout(resolve, 5));
  instance.terminate();
  return { elapsedMs: Math.round((performance.now() - started) * 1000) / 1000, terminated: true };
};
