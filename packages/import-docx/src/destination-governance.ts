/**
 * Destination governance contract for DOCX imports
 * (specs/import-docx/005-destination-governance, Cloud slice).
 *
 * Pure validation and canonicalization: no network, no client types. The
 * imperative shell resolves and proves the policy against the target; this
 * module guarantees a plan is well-formed, edition-shaped, deterministic,
 * and inside the metadata bounds BEFORE any identity is looked up.
 */

export type DestinationPrincipal =
  | { kind: "cloud-account"; accountId: string }
  | { kind: "cloud-group"; groupId: string };

export type DestinationRestrictionPolicy =
  | { mode: "inherit" }
  | { mode: "private" }
  | { mode: "explicit"; viewers: DestinationPrincipal[]; editors: DestinationPrincipal[] };

export interface DestinationGovernance {
  schema: "atlcli.docx-destination-governance/1";
  restriction: DestinationRestrictionPolicy;
  staging: { mode: "none" } | { mode: "private-parent"; title: string };
  labels: string[];
  contentProperties: Array<{ key: string; value: string | number | boolean | null }>;
}

export interface GovernanceInput {
  restriction?: string;
  viewers?: string[];
  editors?: string[];
  labels?: string[];
  /** `key=value` pairs; values parse as JSON scalars, else string. */
  contentProperties?: string[];
  stagingParentTitle?: string;
}

const PRINCIPAL_SYNTAX =
  "principals must be `account:<accountId>` or `group-id:<groupId>` (Cloud)";

/** Parse one explicit principal token; kind is always encoded, never guessed. */
export function parsePrincipal(token: string): DestinationPrincipal {
  const sep = token.indexOf(":");
  if (sep <= 0) throw new Error(`Invalid principal "${token}": ${PRINCIPAL_SYNTAX}.`);
  const kind = token.slice(0, sep);
  const id = token.slice(sep + 1).trim();
  if (!id) throw new Error(`Invalid principal "${token}": empty identifier.`);
  switch (kind) {
    case "account":
      return { kind: "cloud-account", accountId: id };
    case "group-id":
      return { kind: "cloud-group", groupId: id };
    case "user-key":
    case "group":
      throw new Error(
        `Principal "${token}" uses a Data Center kind; this import targets Cloud. ${PRINCIPAL_SYNTAX}.`,
      );
    default:
      throw new Error(`Invalid principal kind "${kind}": ${PRINCIPAL_SYNTAX}.`);
  }
}

export function principalId(p: DestinationPrincipal): string {
  return p.kind === "cloud-account" ? `account:${p.accountId}` : `group-id:${p.groupId}`;
}

const LABEL_RE = /^[^\s,]{1,255}$/;
const PROPERTY_KEY_RE = /^atlcli\.[a-z0-9][a-z0-9._-]{0,120}$/;
const MAX_PROPERTIES = 20;
const MAX_PROPERTY_VALUE_CHARS = 2048;

function parsePrincipals(tokens: string[], role: string, errors: string[]): DestinationPrincipal[] {
  const out: DestinationPrincipal[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    try {
      const p = parsePrincipal(token);
      const id = principalId(p);
      if (seen.has(id)) {
        errors.push(`Duplicate ${role} principal ${id}.`);
        continue;
      }
      seen.add(id);
      out.push(p);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  // Deterministic order: plans with the same principals digest identically.
  return out.sort((a, b) => principalId(a).localeCompare(principalId(b)));
}

/**
 * Validate and canonicalize governance input. Returns every violation at
 * once — a reviewer fixes one list, not one error per run.
 */
export function buildGovernance(input: GovernanceInput): {
  governance: DestinationGovernance;
  errors: string[];
} {
  const errors: string[] = [];

  const mode = input.restriction ?? "inherit";
  let restriction: DestinationRestrictionPolicy;
  if (mode === "inherit" || mode === "private") {
    restriction = { mode };
    if ((input.viewers?.length ?? 0) > 0 || (input.editors?.length ?? 0) > 0) {
      errors.push(`--viewer/--editor require --restriction explicit (got "${mode}").`);
    }
  } else if (mode === "explicit") {
    const viewers = parsePrincipals(input.viewers ?? [], "viewer", errors);
    const editors = parsePrincipals(input.editors ?? [], "editor", errors);
    if (viewers.length === 0) {
      errors.push("--restriction explicit requires at least one --viewer.");
    }
    restriction = { mode: "explicit", viewers, editors };
  } else {
    errors.push(`Unknown restriction mode "${mode}" (inherit|private|explicit).`);
    restriction = { mode: "inherit" };
  }

  const labels: string[] = [];
  for (const raw of input.labels ?? []) {
    const label = raw.trim().toLowerCase();
    if (!LABEL_RE.test(label)) {
      errors.push(`Invalid label "${raw}": no spaces/commas, 1-255 characters.`);
      continue;
    }
    if (!labels.includes(label)) labels.push(label);
  }
  labels.sort();

  const contentProperties: DestinationGovernance["contentProperties"] = [];
  const propKeys = new Set<string>();
  for (const pair of input.contentProperties ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      errors.push(`Invalid content property "${pair}": expected key=value.`);
      continue;
    }
    const key = pair.slice(0, eq).trim();
    const rawValue = pair.slice(eq + 1);
    if (!PROPERTY_KEY_RE.test(key)) {
      errors.push(
        `Invalid property key "${key}": must match the atlcli.* namespace (lowercase letters, digits, ., _, -).`,
      );
      continue;
    }
    if (propKeys.has(key)) {
      errors.push(`Duplicate property key "${key}".`);
      continue;
    }
    if (rawValue.length > MAX_PROPERTY_VALUE_CHARS) {
      errors.push(`Property "${key}" value exceeds ${MAX_PROPERTY_VALUE_CHARS} characters.`);
      continue;
    }
    propKeys.add(key);
    let value: string | number | boolean | null = rawValue;
    if (rawValue === "true") value = true;
    else if (rawValue === "false") value = false;
    else if (rawValue === "null") value = null;
    else if (rawValue !== "" && !Number.isNaN(Number(rawValue)) && rawValue.trim() !== "") {
      value = Number(rawValue);
    }
    contentProperties.push({ key, value });
  }
  if (contentProperties.length > MAX_PROPERTIES) {
    errors.push(`At most ${MAX_PROPERTIES} content properties are allowed.`);
  }
  contentProperties.sort((a, b) => a.key.localeCompare(b.key));

  let staging: DestinationGovernance["staging"] = { mode: "none" };
  if (input.stagingParentTitle !== undefined) {
    const title = input.stagingParentTitle.trim();
    if (!title) errors.push("--staging-parent requires a non-empty title.");
    else staging = { mode: "private-parent", title };
  }

  return {
    governance: {
      schema: "atlcli.docx-destination-governance/1",
      restriction,
      staging,
      labels,
      contentProperties,
    },
    errors,
  };
}

/** True when the governance requires any target mutation beyond page create. */
export function governanceHasEffects(g: DestinationGovernance): boolean {
  return (
    g.restriction.mode !== "inherit" ||
    g.staging.mode !== "none" ||
    g.labels.length > 0 ||
    g.contentProperties.length > 0
  );
}

/** Human preview lines, including the mandatory attachment-visibility caveat. */
export function renderGovernanceSummary(g: DestinationGovernance): string[] {
  const lines: string[] = [];
  switch (g.restriction.mode) {
    case "inherit":
      lines.push("Visibility: inherited from the space/parent (no page restriction).");
      break;
    case "private":
      lines.push("Visibility: PRIVATE — view/edit restricted to the importing user.");
      break;
    case "explicit":
      lines.push(
        `Visibility: EXPLICIT — viewers [${g.restriction.viewers.map(principalId).join(", ")}]` +
          (g.restriction.editors.length > 0
            ? `, editors [${g.restriction.editors.map(principalId).join(", ")}]`
            : ", editors: importing user only"),
      );
      break;
  }
  if (g.staging.mode === "private-parent") {
    lines.push(`Staging: private import-owned parent "${g.staging.title}" (restricted to the importing user).`);
  }
  if (g.labels.length > 0) lines.push(`Labels: ${g.labels.join(", ")}`);
  if (g.contentProperties.length > 0) {
    lines.push(`Properties: ${g.contentProperties.map((p) => `${p.key}=${JSON.stringify(p.value)}`).join(", ")}`);
  }
  if (g.restriction.mode !== "inherit") {
    lines.push(
      "Note: attachment downloads follow page visibility; anyone who can view the page can download its attachments.",
    );
  }
  return lines;
}
