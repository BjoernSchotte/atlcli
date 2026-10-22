/**
 * The agent skill under `skills/atlcli/`, embedded in the CLI build.
 *
 * Text imports inline each file's content into the bundle and into compiled
 * binaries, so `atlcli skill` prints the copy built from the same source as the
 * binary and never reads the repository at run time. A file added to
 * `skills/atlcli/` needs an import and an entry here;
 * `skill-files.test.ts` fails until it has both.
 */
import skillMd from "../../../skills/atlcli/SKILL.md" with { type: "text" };
import authAndConfig from "../../../skills/atlcli/references/auth-and-config.md" with { type: "text" };
import confluenceAudit from "../../../skills/atlcli/references/confluence-audit.md" with { type: "text" };
import confluenceDocsSync from "../../../skills/atlcli/references/confluence-docs-sync.md" with { type: "text" };
import confluenceExport from "../../../skills/atlcli/references/confluence-export.md" with { type: "text" };
import confluenceImport from "../../../skills/atlcli/references/confluence-import.md" with { type: "text" };
import confluencePages from "../../../skills/atlcli/references/confluence-pages.md" with { type: "text" };
import confluencePdf from "../../../skills/atlcli/references/confluence-pdf.md" with { type: "text" };
import confluencePublish from "../../../skills/atlcli/references/confluence-publish.md" with { type: "text" };
import confluenceTemplates from "../../../skills/atlcli/references/confluence-templates.md" with { type: "text" };
import confluenceVfs from "../../../skills/atlcli/references/confluence-vfs.md" with { type: "text" };
import digest from "../../../skills/atlcli/references/digest.md" with { type: "text" };
import invocation from "../../../skills/atlcli/references/invocation.md" with { type: "text" };
import jiraAgile from "../../../skills/atlcli/references/jira-agile.md" with { type: "text" };
import jiraBulkAndAdmin from "../../../skills/atlcli/references/jira-bulk-and-admin.md" with { type: "text" };
import jiraIssues from "../../../skills/atlcli/references/jira-issues.md" with { type: "text" };
import jiraSearch from "../../../skills/atlcli/references/jira-search.md" with { type: "text" };
import pluginsAndLocalTools from "../../../skills/atlcli/references/plugins-and-local-tools.md" with { type: "text" };
import safety from "../../../skills/atlcli/references/safety.md" with { type: "text" };

export interface SkillFile {
  /** Path relative to the skill directory, with `/` separators. */
  path: string;
  content: string;
}

/** `SKILL.md` first, then the references sorted by path. */
export const SKILL_FILES: readonly SkillFile[] = [
  { path: "SKILL.md", content: skillMd },
  { path: "references/auth-and-config.md", content: authAndConfig },
  { path: "references/confluence-audit.md", content: confluenceAudit },
  { path: "references/confluence-docs-sync.md", content: confluenceDocsSync },
  { path: "references/confluence-export.md", content: confluenceExport },
  { path: "references/confluence-import.md", content: confluenceImport },
  { path: "references/confluence-pages.md", content: confluencePages },
  { path: "references/confluence-pdf.md", content: confluencePdf },
  { path: "references/confluence-publish.md", content: confluencePublish },
  { path: "references/confluence-templates.md", content: confluenceTemplates },
  { path: "references/confluence-vfs.md", content: confluenceVfs },
  { path: "references/digest.md", content: digest },
  { path: "references/invocation.md", content: invocation },
  { path: "references/jira-agile.md", content: jiraAgile },
  { path: "references/jira-bulk-and-admin.md", content: jiraBulkAndAdmin },
  { path: "references/jira-issues.md", content: jiraIssues },
  { path: "references/jira-search.md", content: jiraSearch },
  { path: "references/plugins-and-local-tools.md", content: pluginsAndLocalTools },
  { path: "references/safety.md", content: safety },
];

/**
 * Resolves a link from the skill to the file it names, so every link works as
 * the argument of `atlcli skill <path>` exactly as written.
 *
 * `SKILL.md` links `references/safety.md`, and a reference links its sibling
 * as `safety.md`; the second form is tried under `references/`. That fallback
 * is unambiguous because `SKILL.md` is the only file at the skill root and the
 * reference names are unique, which `scripts/skill-links.test.ts` enforces.
 * A `#anchor` names a section within the file and is dropped.
 */
export function findSkillFile(link: string): SkillFile | undefined {
  const [path = ""] = link.split("#", 1);
  return (
    SKILL_FILES.find((file) => file.path === path) ??
    SKILL_FILES.find((file) => file.path === `references/${path}`)
  );
}
