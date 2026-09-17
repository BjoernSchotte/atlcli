/** Ordinary Chrome exposes chrome.app/csi/loadTimes, without extension APIs. */
export function assertGenericBrowserGlobals(
  globals: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): void {
  for (const name of ["Buffer", "process", "browser"]) {
    if (globals[name] !== undefined) throw new Error(`generic browser imported forbidden global ${name}`);
  }
  const chrome = globals.chrome as Record<string, unknown> | undefined;
  for (const name of ["runtime", "storage", "tabs", "scripting"]) {
    if (chrome?.[name] !== undefined) throw new Error(`generic browser exposes extension API ${name}`);
  }
}
