import nodePath from "node:path";

/**
 * Whether `target` is `root` itself or lies inside it.
 *
 * `relative()` across Windows drives returns an absolute path (`C:\tmp\x`), not
 * one starting with `..`, so a prefix test alone reads another drive as inside.
 */
export function isPathInside(
  root: string,
  target: string,
  path: Pick<typeof nodePath, "relative" | "resolve" | "isAbsolute"> = nodePath,
): boolean {
  const relativePath = path.relative(path.resolve(root), path.resolve(target));
  return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}
