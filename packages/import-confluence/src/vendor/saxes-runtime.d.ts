export interface SaxesTagPlain {
  name: string;
  attributes: Readonly<Record<string, string>>;
}

export class SaxesParser {
  constructor(options: { xmlns: false });
  on(event: "opentag", handler: (tag: SaxesTagPlain) => void): this;
  on(event: "closetag", handler: (tag: SaxesTagPlain) => void): this;
  on(event: "text" | "cdata", handler: (text: string) => void): this;
  write(xml: string): this;
  close(): this;
}
