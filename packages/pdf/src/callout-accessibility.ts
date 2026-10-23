function typstString(value: string): string {
  return JSON.stringify(value).replace(/\u2028/gu, "\\u{2028}").replace(/\u2029/gu, "\\u{2029}");
}

/** P1 candidate 1: visible content that is excluded from the PDF structure tree. */
export function decorativeCalloutIcon(contentExpression: string): string {
  // `other` is the PDF 1.7-compatible artifact kind. Typst 0.15 (the pinned
  // compiler) also has the more specific `layout`; `other` keeps the output stable.
  return `pdf.artifact(kind: "other", ${contentExpression})`;
}

/** P1 candidate 2: visible content represented to assistive technology by one label. */
export function labelledCalloutIcon(contentExpression: string, label: string): string {
  return `figure(${contentExpression}, alt: ${typstString(label)}, outlined: false)`;
}
