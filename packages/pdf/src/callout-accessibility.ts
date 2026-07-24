function typstString(value: string): string {
  return JSON.stringify(value).replace(/\u2028/gu, "\\u{2028}").replace(/\u2029/gu, "\\u{2029}");
}

/** P1 candidate 1: visible content that is excluded from the PDF structure tree. */
export function decorativeCalloutIcon(contentExpression: string): string {
  // Typst 0.14.2 (the pinned compiler) supports the PDF 1.7-compatible
  // `other` kind. Newer Typst releases also expose the more specific `layout`.
  return `pdf.artifact(kind: "other", ${contentExpression})`;
}

/** P1 candidate 2: visible content represented to assistive technology by one label. */
export function labelledCalloutIcon(contentExpression: string, label: string): string {
  return `figure(${contentExpression}, alt: ${typstString(label)}, outlined: false)`;
}
