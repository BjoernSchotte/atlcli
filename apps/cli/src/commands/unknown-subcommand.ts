import { ERROR_CODES, fail, output, type OutputOptions } from "@atlcli/core";

/**
 * The default branch of a command group: the help for a bare group, else a
 * usage error (exit 1) naming the unknown subcommand, so a typo in a script
 * does not look like success (#300).
 */
export function unknownSubcommand(sub: string | undefined, help: string, opts: OutputOptions): void {
  if (!sub) {
    output(help, opts);
    return;
  }
  if (!opts.json) output(help, opts);
  fail(opts, 1, ERROR_CODES.USAGE, `Unknown subcommand: ${sub}`, { subcommand: sub });
}
