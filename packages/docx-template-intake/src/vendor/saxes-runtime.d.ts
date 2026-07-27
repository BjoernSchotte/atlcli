export interface SaxesAttributeNS {
  local: string;
  value: string;
}

export interface SaxesTagNS {
  local: string;
  attributes: Readonly<Record<string, SaxesAttributeNS>>;
}

export class SaxesParser {
  constructor(options: { xmlns: true });
  on(event: "doctype", handler: (doctype: string) => void): this;
  on(event: "opentag", handler: (tag: SaxesTagNS) => void): this;
  on(event: "closetag", handler: () => void): this;
  on(event: "error", handler: (error: Error) => void): this;
  write(xml: string): this;
  close(): this;
}
