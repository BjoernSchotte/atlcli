import { ERROR_CODES, fail, type OutputOptions, type RenderResult } from "@atlcli/core";

/**
 * After a template render: fail when a declared variable has no valid value
 * (required and not given, or of the wrong type), and warn about variables the
 * content uses without declaring them, which render empty (#298).
 */
export function checkTemplateRender(result: RenderResult, opts: OutputOptions): void {
  if (result.missingVariables.length > 0) {
    const names = result.missingVariables;
    fail(
      opts,
      1,
      ERROR_CODES.USAGE,
      `Missing or invalid template variables: ${names.join(", ")}. Pass them with ${names.map((n) => `--var ${n}=…`).join(" ")}, or use --interactive.`,
      { missingVariables: names }
    );
  }
  for (const name of result.undeclaredVariables) {
    process.stderr.write(`Warning: the template uses {{${name}}}, which is not declared or given; it renders empty.\n`);
  }
}
