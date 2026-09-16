/**
 * Argument parsing for the `grep` and `find` overrides (WP6.3, WP6.4).
 *
 * Kept separate from the commands so the parsing is testable without a shell,
 * and so a flag the override does not understand is *visibly* passed through
 * rather than quietly dropped.
 */

export interface ParsedGrep {
  pattern: string | undefined;
  patterns: string[];
  patternFiles: string[];
  paths: string[];
  pathIndices: number[];
  recursive: boolean;
  filesWithMatches: boolean;
  lineNumbers: boolean;
  ignoreCase: boolean;
  extendedRegex: boolean;
  fixedString: boolean;
  wordMatch: boolean;
  quiet: boolean;
  invertMatch: boolean;
  include: string | undefined;
  includes: string[];
  excludes: string[];
  excludeDirs: string[];
  /** Unknown options or missing/invalid option arguments: validate before IO. */
  hasUnsupportedOptions: boolean;
  /** Equivalent arguments in spellings supported by the installed just-bash. */
  normalizedArgs: string[];
  normalizedPathIndices: number[];
  passthrough: string[];
  noCql: boolean;
}

const LONG_FLAGS: Record<string, string> = {
  recursive: "r", "dereference-recursive": "R", "files-with-matches": "l",
  "files-without-match": "L", "line-number": "n", "ignore-case": "i",
  "extended-regexp": "E", "perl-regexp": "P", "fixed-strings": "F",
  "word-regexp": "w", "line-regexp": "x", quiet: "q", silent: "q",
  "invert-match": "v", count: "c", "only-matching": "o", "no-filename": "h",
};
const LONG_VALUES: Record<string, string> = {
  regexp: "e", file: "f", "max-count": "m", "after-context": "A",
  "before-context": "B", context: "C", include: "include", exclude: "exclude",
  "exclude-dir": "exclude-dir",
};

export function parseGrepArgs(args: string[]): ParsedGrep {
  const parsed: ParsedGrep = {
    pattern: undefined, patterns: [], patternFiles: [], paths: [], pathIndices: [],
    recursive: false, filesWithMatches: false, lineNumbers: false, ignoreCase: false,
    extendedRegex: false, fixedString: false, wordMatch: false, quiet: false,
    invertMatch: false, include: undefined, includes: [], excludes: [], excludeDirs: [],
    hasUnsupportedOptions: false, normalizedArgs: [], normalizedPathIndices: [],
    passthrough: [], noCql: false,
  };
  const operands: Array<{ value: string; index: number }> = [];
  let optionsEnded = false;
  const flag = (letter: string): void => {
    switch (letter) {
      case "r": case "R": parsed.recursive = true; break;
      case "l": parsed.filesWithMatches = true; break;
      case "n": parsed.lineNumbers = true; break;
      case "i": parsed.ignoreCase = true; break;
      case "E": parsed.extendedRegex = true; break;
      case "F": parsed.fixedString = true; break;
      case "w": parsed.wordMatch = true; break;
      case "q": parsed.quiet = true; break;
      case "v": parsed.invertMatch = true; break;
      case "L": case "x": case "P": case "c": case "o": case "h": break;
      default: parsed.hasUnsupportedOptions = true;
    }
    parsed.normalizedArgs.push(`-${letter}`);
  };
  const value = (option: string, argument: string | undefined): void => {
    if (argument === undefined) { parsed.hasUnsupportedOptions = true; return; }
    if (option === "e") { parsed.patterns.push(argument); return; }
    if (option === "f") parsed.patternFiles.push(argument);
    if (option === "include") { parsed.includes.push(argument); parsed.include = argument; }
    if (option === "exclude") parsed.excludes.push(argument);
    if (option === "exclude-dir") parsed.excludeDirs.push(argument);
    if ("mABC".includes(option) && !/^\d+$/.test(argument)) parsed.hasUnsupportedOptions = true;
    if (option.length > 1) parsed.normalizedArgs.push(`--${option}=${argument}`);
    else parsed.normalizedArgs.push(`-${option}`, argument);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!optionsEnded && arg === "--") { optionsEnded = true; continue; }
    if (optionsEnded || arg === "-" || !arg.startsWith("-")) {
      operands.push({ value: arg, index: i }); continue;
    }
    if (arg === "--no-cql") { parsed.noCql = true; continue; }
    if (arg.startsWith("--")) {
      const equal = arg.indexOf("=");
      const name = arg.slice(2, equal < 0 ? undefined : equal);
      const option = LONG_VALUES[name];
      if (option) {
        const argument = equal < 0 ? args[++i] : arg.slice(equal + 1);
        value(option, argument);
        parsed.passthrough.push(arg);
        if (equal < 0 && argument !== undefined) parsed.passthrough.push(argument);
      } else if (LONG_FLAGS[name] && equal < 0) flag(LONG_FLAGS[name]!);
      else {
        parsed.hasUnsupportedOptions = true;
        parsed.passthrough.push(arg);
        parsed.normalizedArgs.push(arg);
      }
      continue;
    }
    let forwarded = false;
    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j]!;
      if ("efmABC".includes(letter)) {
        const attached = arg.slice(j + 1);
        const argument = attached || args[++i];
        value(letter, argument);
        parsed.passthrough.push(arg);
        if (!attached && argument !== undefined) parsed.passthrough.push(argument);
        forwarded = true;
        break;
      }
      flag(letter);
    }
    if (!forwarded && /[^rRlnwiEF]/.test(arg.slice(1))) parsed.passthrough.push(arg);
  }
  if (parsed.patterns.length === 0 && parsed.patternFiles.length === 0) {
    const positional = operands.shift();
    if (positional) parsed.patterns.push(positional.value);
    else parsed.hasUnsupportedOptions = true;
  }
  parsed.pattern = parsed.patterns[0];
  // just-bash currently retains only the last -e; newline alternatives preserve OR.
  if (parsed.patterns.length) parsed.normalizedArgs.push("-e", parsed.patterns.join("\n"));
  parsed.normalizedArgs.push("--");
  for (const operand of operands) {
    parsed.paths.push(operand.value);
    parsed.pathIndices.push(operand.index);
    parsed.normalizedPathIndices.push(parsed.normalizedArgs.length);
    parsed.normalizedArgs.push(operand.value);
  }
  return parsed;
}

/** Match just-bash's grep globs, not shell/minimatch globs (notably [!x]). */
function matchesGrepGlob(name: string, pattern: string): boolean | undefined {
  if ((pattern.startsWith('"') && pattern.endsWith('"')) ||
      (pattern.startsWith("'") && pattern.endsWith("'"))) pattern = pattern.slice(1, -1);
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") regex += ".*";
    else if (char === "?") regex += ".";
    else if (char === "[") {
      let end = i + 1;
      while (end < pattern.length && pattern[end] !== "]") end++;
      regex += pattern.slice(i, end + 1);
      i = end;
    } else regex += /[.+^${}()|\\]/.test(char) ? `\\${char}` : char;
  }
  try { return new RegExp(`${regex}$`).test(name); }
  catch { return undefined; } // Let grep report invalid globs; never exclude uncertain files.
}

export function matchesGrepFile(parsed: ParsedGrep, path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return !parsed.excludes.some((pattern) => matchesGrepGlob(name, pattern) === true) &&
    (parsed.includes.length === 0 || parsed.includes.some((pattern) => matchesGrepGlob(name, pattern) !== false));
}

export function skipsGrepDirectory(parsed: ParsedGrep, name: string): boolean {
  return parsed.excludeDirs.some((pattern) => matchesGrepGlob(name, pattern) === true);
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
