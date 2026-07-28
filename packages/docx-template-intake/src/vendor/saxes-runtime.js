// Keep the published runtime behind a local type boundary. saxes 6.0.0's
// generic declaration constraints do not typecheck with this repository's
// TypeScript version, while its runtime API remains stable and intentionally
// narrow here.
export { SaxesParser } from "saxes";
