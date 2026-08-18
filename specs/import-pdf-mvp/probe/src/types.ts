export interface Rect {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

export interface TextCharacter {
  index: number;
  unicode: number;
  value: string;
  box: Rect | null;
  fontSize: number;
  angle: number;
  mcid: number;
}

export interface StructureAttribute {
  name: string;
  type: number;
  value: boolean | number | string | StructureAttribute[] | null;
}

export interface StructureNode {
  type: string;
  alt: string;
  title: string;
  mcids: number[];
  childMcids: number[];
  attributes: StructureAttribute[];
  children: StructureNode[];
}

export interface PageFacts {
  index: number;
  width: number;
  height: number;
  rotation: number;
  text: string;
  characters: TextCharacter[];
  structures: StructureNode[];
  objectTypeCounts: Record<string, number>;
  images: Array<{ mcid: number; bounds: Rect | null; width: number; height: number; decodedBytes: number }>;
  annotations: Array<{ subtype: number; rect: Rect | null; actionType: number | null; uri: string | null }>;
  render: { width: number; height: number; sha256: string; bytes: number };
  kind: "digital" | "image-only" | "mixed" | "blank";
}

export interface PdfFacts {
  engine: "pdfium" | "pdfjs";
  engineVersion: string;
  inputSha256: string;
  inputBytes: number;
  pageCount: number;
  tagged: boolean;
  encrypted: boolean;
  classification: "tagged" | "digital-untagged" | "scan" | "mixed" | "blank" | "encrypted" | "rejected";
  pages: PageFacts[];
  outlines: Array<{ title: string; pageIndex: number | null }>;
  javascriptActionCount: number;
  attachmentCount: number;
  namedDestinationCount: number;
  loadError: number | null;
  timingsMs: Record<string, number>;
  memory: { wasmInitialBytes: number; wasmPeakBytes: number; wasmFinalBytes: number } | null;
}
