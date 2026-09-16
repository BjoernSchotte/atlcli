/**
 * Argument parsing for the `grep` and `find` overrides (WP6.3, WP6.4).
 *
 * Kept separate from the commands so the parsing is testable without a shell,
 * and so a flag the override does not understand is *visibly* passed through
 * rather than quietly dropped.
 */

export interface ParsedGrep {
  pattern: string | undefined;
  paths: string[];
  recursive: boolean;
  filesWithMatches: boolean;
  lineNumbers: boolean;
  ignoreCase: boolean;
  extendedRegex: boolean;
  fixedString: boolean;
  /** `-w`: the caller asserts the pattern is a whole word. */
  wordMatch: boolean;
  include: string | undefined;
  /** Flags this parser did not recognise, forwarded verbatim. */
  passthrough: string[];
  /** True when the caller disabled the shortcut explicitly. */
  noCql: boolean;
}

const TAKES_VALUE = new Set(["--include", "--exclude", "-m", "-A", "-B", "-C", "-e", "-f"]);

export function parseGrepArgs(args: string[]): ParsedGrep {
  const parsed: ParsedGrep = {
    pattern: undefined,
    paths: [],
    recursive: false,
    filesWithMatches: false,
    lineNumbers: false,
    ignoreCase: false,
    extendedRegex: false,
    fixedString: false,
    wordMatch: false,
    include: undefined,
    passthrough: [],
    noCql: false,
  };
  let patternTaken = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === "--no-cql") {
      parsed.noCql = true;
      continue;
    }
    if (arg === "--include" || arg.startsWith("--include=")) {
      parsed.include = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i];
      parsed.passthrough.push(arg);
      if (!arg.includes("=") && parsed.include !== undefined) parsed.passthrough.push(parsed.include);
      continue;
    }
    if (arg.startsWith("--")) {
      parsed.passthrough.push(arg);
      if (TAKES_VALUE.has(arg) && args[i + 1] !== undefined) parsed.passthrough.push(args[++i]!);
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      if (TAKES_VALUE.has(arg)) {
        parsed.passthrough.push(arg);
        if (args[i + 1] !== undefined) parsed.passthrough.push(args[++i]!);
        continue;
      }
      // A bundle such as -rn: every letter is its own flag.
      let recognised = true;
      for (const letter of arg.slice(1)) {
        switch (letter) {
          case "r":
          case "R":
            parsed.recursive = true;
            break;
          case "l":
            parsed.filesWithMatches = true;
            break;
          case "n":
            parsed.lineNumbers = true;
            break;
          case "i":
            parsed.ignoreCase = true;
            break;
          case "E":
            parsed.extendedRegex = true;
            break;
          case "F":
            parsed.fixedString = true;
            break;
          case "w":
            parsed.wordMatch = true;
            break;
          default:
            recognised = false;
            break;
        }
      }
      if (!recognised) parsed.passthrough.push(arg);
      continue;
    }

    if (!patternTaken) {
      parsed.pattern = arg;
      patternTaken = true;
    } else {
      parsed.paths.push(arg);
    }
  }

  return parsed;
}

export interface ParsedFind {
  paths: string[];
  name: string | undefined;
  iname: string | undefined;
  pathPattern: string | undefined;
  type: "f" | "d" | undefined;
  /** True when a predicate this override cannot answer from the index appears. */
  hasUnsupportedPredicate: boolean;
  /** `-newer`, `-mtime` and `-newermt`, which go through CQL lastmodified. */
  timePredicate: { kind: "mtime" | "newermt" | "newer"; value: string } | undefined;
}

const TIME_PREDICATES = new Set(["-mtime", "-newermt", "-newer"]);
const INDEX_PREDICATES = new Set([
  "-name",
  "-iname",
  "-path",
  "-type",
  "-print",
  "-maxdepth",
  "-mindepth",
]);

export function parseFindArgs(args: string[]): ParsedFind {
  const parsed: ParsedFind = {
    paths: [],
    name: undefined,
    iname: undefined,
    pathPattern: undefined,
    type: undefined,
    hasUnsupportedPredicate: false,
    timePredicate: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) {
      if (parsed.name === undefined && parsed.type === undefined) parsed.paths.push(arg);
      continue;
    }
    if (TIME_PREDICATES.has(arg)) {
      parsed.timePredicate = {
        kind: arg.slice(1) as "mtime" | "newermt" | "newer",
        value: args[++i] ?? "",
      };
      continue;
    }
    switch (arg) {
      case "-name":
        parsed.name = args[++i];
        break;
      case "-iname":
        parsed.iname = args[++i];
        break;
      case "-path":
        parsed.pathPattern = args[++i];
        break;
      case "-type": {
        const value = args[++i];
        parsed.type = value === "f" || value === "d" ? value : undefined;
        if (parsed.type === undefined) parsed.hasUnsupportedPredicate = true;
        break;
      }
      default:
        if (!INDEX_PREDICATES.has(arg)) parsed.hasUnsupportedPredicate = true;
        break;
    }
  }

  return parsed;
}
