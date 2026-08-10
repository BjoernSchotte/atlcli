const mermaidUnavailable = {
  initialize(): void {
    // Streamdown's Mermaid component is replaced by the adjacent plain-text
    // fallback, so initialization is intentionally inert in the MV3 host.
  },
  async render(): Promise<never> {
    throw new Error("Mermaid rendering is unavailable in the browser extension.");
  },
};

export default mermaidUnavailable;
