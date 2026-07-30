interface MatchOptions {
  nocase?: boolean;
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character)
    ? `\\${character}`
    : character;
}

function globSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    const next = pattern[index + 1];
    if (character === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) {
        source += "\\[";
      } else {
        source += pattern.slice(index, end + 1);
        index = end;
      }
    } else if (character === "{") {
      const end = pattern.indexOf("}", index + 1);
      if (end === -1) {
        source += "\\{";
      } else {
        const variants = pattern
          .slice(index + 1, end)
          .split(",")
          .map((value) => value.split("").map(escapeRegex).join(""));
        source += `(?:${variants.join("|")})`;
        index = end;
      }
    } else {
      source += escapeRegex(character);
    }
  }
  return source;
}

export function isMatch(
  value: string,
  pattern: string | string[],
  options: MatchOptions = {}
): boolean {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some((candidate) =>
    new RegExp(`^${globSource(candidate)}$`, options.nocase ? "i" : "").test(
      value
    )
  );
}

function micromatch(
  values: string[],
  pattern: string | string[],
  options?: MatchOptions
): string[] {
  return values.filter((value) => isMatch(value, pattern, options));
}

micromatch.isMatch = isMatch;

export default micromatch;
