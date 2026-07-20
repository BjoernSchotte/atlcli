/**
 * SVG safety policy for the PDF pipeline. The implementation moved to
 * `@atlcli/confluence` (spec 006 G4) so the DOCX and PDF engines share one
 * blocklist and reject the same hostile SVG with the same message; this module
 * re-exports it to keep `prepare.ts` / `settings.ts` import paths stable.
 */
export {
  assertSafeSvg,
  findSvgSafetyViolation,
  SVG_UNSAFE_MESSAGE,
  type SvgSafetyViolation,
} from "@atlcli/confluence";
