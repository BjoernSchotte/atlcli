import { sanitizeLinkHref } from "@atlcli/confluence/research";
import {
  RESEARCH_REPORT_SCHEMA_V1,
  ResearchContractError,
  normalizeResearchScopeV1,
  type AtlassianRelationshipV1,
  type ResearchFindingV1,
  type ResearchReportLanguageV1,
  type ResearchReportV1,
  type ResearchRunSummaryV1,
  type ResearchScopeV1,
  type ResearchSourceReferenceV1,
} from "./contracts.js";
import {
  localizeResearchSectionQuestionV1,
  localizeResearchSectionTitleV1,
  researchReportCopyV1,
} from "./report-locale.js";

function assertString(value: unknown, label: string, maximum = 100_000): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new ResearchContractError("invalid-report", `${label} is missing or invalid.`);
  }
}

function assertStringArray(
  value: unknown,
  label: string,
  maximumItems = 1_000
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximumItems ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new ResearchContractError("invalid-report", `${label} is invalid.`);
  }
}

function assertOptionalString(value: unknown, label: string, maximum: number): void {
  if (value !== undefined) assertString(value, label, maximum);
}

function safeSourceHref(source: ResearchSourceReferenceV1, siteOrigin: string): string {
  const safe = sanitizeLinkHref(source.url);
  if (!safe.safe || !safe.href.startsWith("https://")) {
    throw new ResearchContractError("invalid-report", "Source URL is unsafe.");
  }
  const parsed = new URL(safe.href);
  if (parsed.origin !== siteOrigin) {
    throw new ResearchContractError(
      "invalid-report",
      "Source URL is outside the research site."
    );
  }
  return parsed.href;
}

function assertSource(
  value: unknown,
  scope: ResearchScopeV1
): asserts value is ResearchSourceReferenceV1 {
  if (typeof value !== "object" || value === null) {
    throw new ResearchContractError("invalid-report", "A report source is invalid.");
  }
  const source = value as Partial<ResearchSourceReferenceV1>;
  assertString(source.id, "Source id", 200);
  assertString(source.title, "Source title", 2_000);
  assertString(source.url, "Source URL", 8_000);
  if (source.product !== "jira" && source.product !== "confluence") {
    throw new ResearchContractError("invalid-report", "Source product is invalid.");
  }
  safeSourceHref(source as ResearchSourceReferenceV1, scope.siteOrigin);
  assertOptionalString(source.excerpt, "Source excerpt", 12_000);
  assertOptionalString(source.updatedAt, "Source updated date", 100);
  if (source.product === "jira") {
    assertString(source.issueKey, "Source Jira key", 100);
    assertString(source.projectKey, "Source Jira project", 100);
    if (
      !scope.jiraProjectKeys.includes(source.projectKey) ||
      !source.issueKey.startsWith(`${source.projectKey}-`)
    ) {
      throw new ResearchContractError("invalid-report", "Jira source is outside the run scope.");
    }
  } else {
    assertString(source.contentId, "Source Confluence content id", 200);
    assertString(source.spaceKey, "Source Confluence space", 255);
    if (!scope.confluenceSpaceKeys.includes(source.spaceKey)) {
      throw new ResearchContractError(
        "invalid-report",
        "Confluence source is outside the run scope."
      );
    }
  }
}

function assertFinding(value: unknown): asserts value is ResearchFindingV1 {
  if (typeof value !== "object" || value === null) {
    throw new ResearchContractError("invalid-report", "A report finding is invalid.");
  }
  const finding = value as Partial<ResearchFindingV1>;
  assertString(finding.id, "Finding id", 200);
  assertString(finding.summary, "Finding summary", 4_000);
  if (finding.classification !== "fact" && finding.classification !== "inference") {
    throw new ResearchContractError("invalid-report", "Finding classification is invalid.");
  }
  assertStringArray(finding.sourceIds, "Finding sources", 100);
  if (finding.sourceIds.length === 0) {
    throw new ResearchContractError("invalid-report", "Every finding requires a source.");
  }
}

function assertRelationship(value: unknown): asserts value is AtlassianRelationshipV1 {
  if (typeof value !== "object" || value === null) {
    throw new ResearchContractError("invalid-report", "A report relationship is invalid.");
  }
  const relationship = value as Partial<AtlassianRelationshipV1>;
  assertString(relationship.id, "Relationship id", 200);
  assertString(relationship.jiraIssueKey, "Relationship Jira key", 100);
  assertString(relationship.confluenceContentId, "Relationship content id", 200);
  assertString(relationship.summary, "Relationship summary", 4_000);
  if (
    relationship.classification !== "verified" &&
    relationship.classification !== "hypothesis"
  ) {
    throw new ResearchContractError(
      "invalid-report",
      "Relationship classification is invalid."
    );
  }
  assertStringArray(relationship.sourceIds, "Relationship sources", 100);
  if (relationship.sourceIds.length === 0) {
    throw new ResearchContractError(
      "invalid-report",
      "Every relationship requires a source."
    );
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ResearchContractError("invalid-report", `${label} is invalid.`);
  }
}

function assertRun(value: unknown): asserts value is ResearchRunSummaryV1 {
  if (typeof value !== "object" || value === null) {
    throw new ResearchContractError("invalid-report", "Run diagnostics are missing.");
  }
  const run = value as Partial<ResearchRunSummaryV1>;
  assertString(run.model, "Run model", 500);
  assertString(run.startedAt, "Run start", 100);
  assertString(run.completedAt, "Run completion", 100);
  if (run.wikiProvider !== "rest" && run.wikiProvider !== "agg") {
    throw new ResearchContractError("invalid-report", "Run provider is invalid.");
  }
  if (typeof run.complete !== "boolean") {
    throw new ResearchContractError("invalid-report", "Run completeness is invalid.");
  }
  assertNonNegativeInteger(run.durationMs, "Run duration");
  if (typeof run.counts !== "object" || run.counts === null) {
    throw new ResearchContractError("invalid-report", "Run counts are invalid.");
  }
  assertNonNegativeInteger(run.counts.ptcCalls, "PTC call count");
  assertNonNegativeInteger(run.counts.httpCalls, "HTTP call count");
  assertNonNegativeInteger(run.counts.jiraItems, "Jira item count");
  assertNonNegativeInteger(run.counts.confluenceItems, "Confluence item count");
  if (run.usage !== undefined) {
    if (typeof run.usage !== "object" || run.usage === null) {
      throw new ResearchContractError("invalid-report", "Run usage is invalid.");
    }
    if (run.usage.inputTokens !== undefined) {
      assertNonNegativeInteger(run.usage.inputTokens, "Input token count");
    }
    if (run.usage.outputTokens !== undefined) {
      assertNonNegativeInteger(run.usage.outputTokens, "Output token count");
    }
  }
  assertStringArray(run.warnings, "Run warnings", 100);
}

export function assertResearchReportV1(value: unknown): asserts value is ResearchReportV1 {
  if (typeof value !== "object" || value === null) {
    throw new ResearchContractError("invalid-report", "The research report is invalid.");
  }
  const report = value as Partial<ResearchReportV1>;
  if (report.schema !== RESEARCH_REPORT_SCHEMA_V1) {
    throw new ResearchContractError("invalid-report", "Unsupported research report schema.");
  }
  assertString(report.title, "Report title", 2_000);
  assertString(report.question, "Report question", 2_000);
  const scope = normalizeResearchScopeV1(report.scope);
  assertString(report.executiveSummary, "Executive summary", 12_000);
  assertString(report.markdown, "Report Markdown");
  assertStringArray(report.limitations, "Report limitations", 100);
  if (!Array.isArray(report.sources) || report.sources.length > 500) {
    throw new ResearchContractError("invalid-report", "Report sources are invalid.");
  }
  report.sources.forEach((source) => assertSource(source, scope));
  const sourceIds = new Set(report.sources.map((source) => source.id));
  const sourcesById = new Map(report.sources.map((source) => [source.id, source]));
  if (sourceIds.size !== report.sources.length) {
    throw new ResearchContractError("invalid-report", "Report source ids must be unique.");
  }
  if (!Array.isArray(report.findings) || report.findings.length > 200) {
    throw new ResearchContractError("invalid-report", "Report findings are invalid.");
  }
  report.findings.forEach(assertFinding);
  if (new Set(report.findings.map((finding) => finding.id)).size !== report.findings.length) {
    throw new ResearchContractError("invalid-report", "Report finding ids must be unique.");
  }
  if (!Array.isArray(report.relationships) || report.relationships.length > 200) {
    throw new ResearchContractError("invalid-report", "Report relationships are invalid.");
  }
  report.relationships.forEach(assertRelationship);
  if (
    new Set(report.relationships.map((relationship) => relationship.id)).size !==
    report.relationships.length
  ) {
    throw new ResearchContractError(
      "invalid-report",
      "Report relationship ids must be unique."
    );
  }
  for (const reference of [
    ...report.findings.flatMap((finding) => finding.sourceIds),
    ...report.relationships.flatMap((relationship) => relationship.sourceIds),
  ]) {
    if (!sourceIds.has(reference)) {
      throw new ResearchContractError(
        "invalid-report",
        `The report references an unknown source: ${reference}`
      );
    }
  }
  for (const relationship of report.relationships) {
    if (relationship.classification !== "verified") continue;
    const evidence = relationship.sourceIds.map((sourceId) => sourcesById.get(sourceId)!);
    if (
      !evidence.some(
        (source) =>
          source.product === "jira" && source.issueKey === relationship.jiraIssueKey
      ) ||
      !evidence.some(
        (source) =>
          source.product === "confluence" &&
          source.contentId === relationship.confluenceContentId
      )
    ) {
      throw new ResearchContractError(
        "invalid-report",
        "A verified relationship requires matching Jira and Confluence evidence."
      );
    }
  }
  assertRun(report.run);
}

function markdownText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]<>])/g, "\\$1")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownTextFragment(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]<>])/g, "\\$1")
    .replace(/\s+/g, " ");
}

function linkedMarkdownText(
  value: string,
  sources: Map<string, ResearchSourceReferenceV1>,
  siteOrigin: string
): string {
  const tokens = new Map<string, ResearchSourceReferenceV1>();
  for (const source of sources.values()) {
    tokens.set(source.id, source);
    if (source.issueKey) tokens.set(source.issueKey, source);
  }
  const pattern = [...tokens.keys()]
    .sort((left, right) => right.length - left.length)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (!pattern) return markdownText(value);
  const linkKnownTokens = (fragment: string): string => fragment
    .split(new RegExp(`(${pattern})`, "g"))
    .filter(Boolean)
    .map((part) => {
      const source = tokens.get(part);
      return source
        ? `[${markdownText(source.issueKey ?? source.title)}](${safeSourceHref(source, siteOrigin)})`
        : markdownTextFragment(part);
    })
    .join("");
  return value
    // A model may repeat a canonical source URL in prose. Keep the URL as one
    // plain fragment so an issue-key token inside `/browse/KEY-1` cannot turn
    // into a nested Markdown link.
    .split(/(https?:\/\/[^\s<>]+)/g)
    .filter(Boolean)
    .map((part) => /^https?:\/\//.test(part) ? markdownTextFragment(part) : linkKnownTokens(part))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function linkedMarkdownParagraph(
  value: string,
  sources: Map<string, ResearchSourceReferenceV1>,
  siteOrigin: string
): string {
  return value
    .split(/\n{2,}/)
    .map((paragraph) => linkedMarkdownText(paragraph, sources, siteOrigin))
    .filter(Boolean)
    .join("\n\n");
}

function sourceLinks(
  sourceIds: readonly string[],
  sources: Map<string, ResearchSourceReferenceV1>,
  siteOrigin: string
): string {
  return sourceIds
    .map((id) => {
      const source = sources.get(id);
      if (!source) {
        throw new ResearchContractError("invalid-report", `Unknown report source: ${id}`);
      }
      return `[${markdownText(source.title)}](${safeSourceHref(source, siteOrigin)})`;
    })
    .join(", ");
}

function renderFindings(
  title: string,
  findings: readonly ResearchFindingV1[],
  sources: Map<string, ResearchSourceReferenceV1>,
  siteOrigin: string,
  language?: ResearchReportLanguageV1,
): string[] {
  const copy = researchReportCopyV1(language);
  const lines = [`## ${title}`, ""];
  if (findings.length === 0) return [...lines, copy.none, ""];
  for (const [index, finding] of findings.entries()) {
    lines.push(
      `### ${index + 1}. ${linkedMarkdownText(finding.summary, sources, siteOrigin)}`,
      ""
    );
    if (finding.detail) {
      lines.push(linkedMarkdownParagraph(finding.detail, sources, siteOrigin), "");
    }
    lines.push(`${copy.sourceLabel}: ${sourceLinks(finding.sourceIds, sources, siteOrigin)}`, "");
  }
  return lines;
}

/**
 * Render host-selected finding groups through the same escaping, source-link,
 * and tenant-origin checks used by the legacy V1 report projection.  This is
 * deliberately structured input rather than a model-authored Markdown hook.
 */
export function renderResearchFindingSectionsMarkdown(
  sections: readonly {
    title: string;
    question?: string;
    findings: readonly ResearchFindingV1[];
  }[],
  sources: readonly ResearchSourceReferenceV1[],
  siteOrigin: string,
  language?: ResearchReportLanguageV1,
): string[] {
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  return sections.flatMap((section) => {
    const title = localizeResearchSectionTitleV1(language, section.title);
    const lines = renderFindings(title, section.findings, sourcesById, siteOrigin, language);
    if (!section.question) return lines;
    return [
      `## ${markdownText(title)}`,
      "",
      `> ${researchReportCopyV1(language).focus}: ${markdownText(localizeResearchSectionQuestionV1(language, section.question))}`,
      "",
      ...lines.slice(2),
    ];
  });
}

function renderResearchReportTail(
  input: Pick<ResearchReportV1, "limitations" | "sources" | "run">,
  sources: Map<string, ResearchSourceReferenceV1>,
  siteOrigin: string,
  language?: ResearchReportLanguageV1,
): string[] {
  const copy = researchReportCopyV1(language);
  const detailedJiraSources = input.sources.filter((source) => source.product === "jira").length;
  const detailedConfluenceSources = input.sources.filter((source) => source.product === "confluence").length;
  return [
    `## ${copy.limitations}`,
    "",
    ...(input.limitations.length > 0
      ? input.limitations.map(
          (limitation) => `- ${linkedMarkdownText(limitation, sources, siteOrigin)}`
        )
      : [copy.none]),
    "",
    `## ${copy.sources}`,
    "",
    ...input.sources.map((source, index) => {
      const identifier = source.issueKey ?? source.contentId ?? source.id;
      return `${index + 1}. [${markdownText(source.title)}](${safeSourceHref(
        source,
        siteOrigin
      )}) — ${markdownText(source.product)} \`${markdownText(identifier)}\``;
    }),
    "",
    `## ${copy.run}`,
    "",
    `- ${copy.model}: \`${markdownText(input.run.model)}\``,
    `- ${copy.confluenceProvider}: \`${input.run.wikiProvider}\``,
    `- ${copy.complete}: ${input.run.complete ? copy.yes : copy.no}`,
    `- ${copy.duration}: ${input.run.durationMs} ms`,
    `- ${copy.calls}: ${input.run.counts.ptcCalls} PTC / ${input.run.counts.httpCalls} HTTP`,
    `- ${copy.items}: ${input.run.counts.jiraItems} Jira / ${input.run.counts.confluenceItems} Confluence`,
    `- ${copy.detailedSources}: ${detailedJiraSources} Jira / ${detailedConfluenceSources} Confluence`,
    ...(input.run.usage?.inputTokens !== undefined
      ? [`- ${copy.inputTokens}: ${input.run.usage.inputTokens}`]
      : []),
    ...(input.run.usage?.outputTokens !== undefined
      ? [`- ${copy.outputTokens}: ${input.run.usage.outputTokens}`]
      : []),
    ...(input.run.warnings.length > 0
      ? ["", `### ${copy.warnings}`, "", ...input.run.warnings.map((warning) => `- ${markdownText(warning)}`)]
      : []),
    "",
  ];
}

/**
 * Structured Markdown projection for reports whose findings are arranged by
 * a host-approved outline.  It shares the legacy renderer's escaping and
 * source-origin checks, but does not accept arbitrary Markdown.
 */
export function renderResearchReportWithFindingSectionsMarkdown(
  input: Pick<
    ResearchReportV1,
    "title" | "question" | "scope" | "executiveSummary" | "limitations" | "sources" | "run"
  > & {
    sections: readonly {
      title: string;
      question?: string;
      findings: readonly ResearchFindingV1[];
    }[];
    /**
     * Host-authored status sections rendered after findings and before report
     * limitations. Text is escaped here so this renderer never accepts raw
     * Markdown from a caller.
     */
    additionalSections?: readonly {
      title: string;
      paragraphs: readonly string[];
    }[];
    language?: ResearchReportLanguageV1;
  },
): string {
  const copy = researchReportCopyV1(input.language);
  const sources = new Map(input.sources.map((source) => [source.id, source]));
  return [
    `# ${markdownText(input.title)}`,
    "",
    `> ${copy.question}: ${markdownText(input.question)}`,
    "",
    `## ${copy.executiveSummary}`,
    "",
    linkedMarkdownParagraph(input.executiveSummary, sources, input.scope.siteOrigin),
    "",
    ...renderResearchFindingSectionsMarkdown(input.sections, input.sources, input.scope.siteOrigin, input.language),
    ...(input.additionalSections ?? []).flatMap((section) => [
      `## ${markdownText(section.title)}`,
      "",
      ...section.paragraphs.map((paragraph) => markdownText(paragraph)),
      "",
    ]),
    ...renderResearchReportTail(input, sources, input.scope.siteOrigin, input.language),
  ].join("\n");
}

function renderRelationships(
  title: string,
  relationships: readonly AtlassianRelationshipV1[],
  sources: Map<string, ResearchSourceReferenceV1>,
  siteOrigin: string
): string[] {
  const lines = [`## ${title}`, ""];
  if (relationships.length === 0) return [...lines, "_None._", ""];
  for (const relationship of relationships) {
    const jiraSource = [...sources.values()].find(
      (source) => source.issueKey === relationship.jiraIssueKey
    );
    const wikiSource = [...sources.values()].find(
      (source) => source.contentId === relationship.confluenceContentId
    );
    if (!jiraSource || !wikiSource) {
      throw new ResearchContractError(
        "invalid-report",
        "Relationship endpoint sources are missing."
      );
    }
    lines.push(
      `- [${markdownText(relationship.jiraIssueKey)}](${safeSourceHref(
        jiraSource,
        siteOrigin
      )}) ↔ [${markdownText(wikiSource.title)}](${safeSourceHref(
        wikiSource,
        siteOrigin
      )}): ${linkedMarkdownText(relationship.summary, sources, siteOrigin)} — Evidence: ${sourceLinks(
        relationship.sourceIds,
        sources,
        siteOrigin
      )}`
    );
  }
  lines.push("");
  return lines;
}

/**
 * Deterministic Markdown projection from validated structured data.
 *
 * Model-authored Markdown is never rendered directly. Callers replace the
 * report's `markdown` field with this exact projection after validation.
 */
export function renderResearchReportMarkdown(
  report: Omit<ResearchReportV1, "markdown"> & { markdown?: string }
): string {
  const sources = new Map(report.sources.map((source) => [source.id, source]));
  const facts = report.findings.filter((finding) => finding.classification === "fact");
  const inferences = report.findings.filter(
    (finding) => finding.classification === "inference"
  );
  const verified = report.relationships.filter(
    (relationship) => relationship.classification === "verified"
  );
  const hypotheses = report.relationships.filter(
    (relationship) => relationship.classification === "hypothesis"
  );

  const lines = [
    `# ${markdownText(report.title)}`,
    "",
    `> Question: ${markdownText(report.question)}`,
    "",
    "## Executive summary",
    "",
    linkedMarkdownParagraph(report.executiveSummary, sources, report.scope.siteOrigin),
    "",
    ...renderFindings("Findings", facts, sources, report.scope.siteOrigin),
    ...renderRelationships(
      "Verified Jira ↔ Confluence relationships",
      verified,
      sources,
      report.scope.siteOrigin
    ),
    ...renderFindings("Inferences", inferences, sources, report.scope.siteOrigin),
    ...renderRelationships(
      "Relationship hypotheses",
      hypotheses,
      sources,
      report.scope.siteOrigin
    ),
    ...renderResearchReportTail(report, sources, report.scope.siteOrigin),
  ];
  return lines.join("\n");
}

export function finalizeResearchReportV1(
  report: Omit<ResearchReportV1, "markdown"> & { markdown?: string }
): ResearchReportV1 {
  const normalized = { ...report, scope: normalizeResearchScopeV1(report.scope) };
  const markdown = renderResearchReportMarkdown(normalized);
  const finalized: ResearchReportV1 = { ...normalized, markdown };
  assertResearchReportV1(finalized);
  return finalized;
}
