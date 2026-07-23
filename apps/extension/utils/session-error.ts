/**
 * Pure classification for failures from an Atlassian browser session.
 *
 * Keep this module free of client/UI imports: the side panel and the offscreen
 * job runtime must agree on authentication loss without pulling either
 * surface's implementation into the other bundle.
 */
export type AtlassianSessionErrorKind =
  | "not-logged-in"
  | "access-denied"
  | "network"
  | "unknown";

export function classifyAtlassianSessionError(
  error: unknown,
): AtlassianSessionErrorKind {
  const message = error instanceof Error ? error.message : String(error);

  if (
    /non-json|login page|authentication redirect|opaqueredirect|session not logged in/i.test(
      message,
    )
  ) {
    return "not-logged-in";
  }

  const status = message.match(/Confluence API(?: v2)? error \((\d{3})\)/);
  if (status) {
    const code = Number(status[1]);
    if (code === 401 || (code >= 300 && code < 400)) {
      return "not-logged-in";
    }
    if (code === 403 || code === 404) return "access-denied";
    return "unknown";
  }

  if (error instanceof TypeError) return "network";
  if (/failed to fetch|networkerror|load failed|fetch failed/i.test(message)) {
    return "network";
  }
  return "unknown";
}
