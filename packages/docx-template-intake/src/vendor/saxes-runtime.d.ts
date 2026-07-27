export interface SaxesAttributeNS {
  local: string;
  prefix: string;
  uri: string;
  value: string;
}

export interface SaxesTagNS {
  local: string;
  prefix: string;
  uri: string;
  ns: Readonly<Record<string, string>>;
  attributes: Readonly<Record<string, SaxesAttributeNS>>;
}

export class SaxesParser {
  constructor(options: { xmlns: true });
  on(event: "doctype", handler: (doctype: string) => void): this;
  on(event: "opentag", handler: (tag: SaxesTagNS) => void): this;
  on(event: "closetag", handler: (tag: SaxesTagNS) => void): this;
  on(event: "text", handler: (text: string) => void): this;
  on(event: "error", handler: (error: Error) => void): this;
  write(xml: string): this;
  close(): this;
}
