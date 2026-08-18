export function taggedHeadingLevel(role: string): 1 | 2 | 3 | 4 | 5 | 6 | null {
  const match = /^H([1-6])$/iu.exec(role.trim());
  if (!match) return null;
  return Number(match[1]) as 1 | 2 | 3 | 4 | 5 | 6;
}

export function headingHierarchyGap(previous: number | null, next: number): boolean {
  return previous !== null && next > previous + 1;
}
