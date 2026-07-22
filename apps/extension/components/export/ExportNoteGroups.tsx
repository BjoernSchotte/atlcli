import type { ExportNote, ExportNoteCode } from "@atlcli/confluence/browser";
import {
  Accessibility,
  AlertTriangle,
  Blocks,
  FileWarning,
  Info,
  LayoutTemplate,
  Link2,
} from "lucide-react";
import React from "react";
import { useT } from "../../utils/i18n/context.js";
import type { MessageKey } from "../../utils/i18n/messages.js";
import { cn } from "../ui/utils.js";

export type ExportNoteCategory =
  | "content"
  | "links"
  | "accessibility"
  | "dynamic"
  | "layout"
  | "information";

interface NoteCodeGroup {
  code: string;
  notes: ExportNote[];
  warningCount: number;
}

export interface ExportNoteGroup {
  category: ExportNoteCategory;
  notes: ExportNote[];
  warningCount: number;
  codes: NoteCodeGroup[];
}

const CATEGORY_ORDER: readonly ExportNoteCategory[] = [
  "content",
  "links",
  "accessibility",
  "dynamic",
  "layout",
  "information",
];

const CONTENT_CODES = new Set<ExportNoteCode>([
  "image-unresolved",
  "inline-image-skipped",
  "page-unreadable",
  "subtree-unreadable",
  "page-ambiguous-404",
  "page-version-changed",
  "unsupported-child-type",
  "empty-include-result",
  "asset-budget-exceeded",
  "space-homepage-missing",
  "image-skipped",
  "image-embed-failed",
  "logo-skipped",
  "logo-embed-failed",
]);

const ACCESSIBILITY_CODES = new Set<ExportNoteCode>([
  "image-missing-alt",
  "pdf-image-alt-fallback",
  "pdf-language-missing",
  "pdf-table-cell-contrast-low",
]);

const INFORMATION_CODES = new Set<ExportNoteCode>([
  "label-filtered",
  "root-filter-bypassed",
  "folder-position-unknown",
  "perf-timing",
  "template-default-used",
  "browser-harness",
]);

const DYNAMIC_CONTEXT_CODES = new Set<ExportNoteCode>([
  "space-fetch-failed",
  "space-unavailable",
  "user-fetch-failed",
  "user-unavailable",
  "owner-fetch-failed",
  "owner-unavailable",
  "homepage-fetch-failed",
  "homepage-unavailable",
  "pdf-mention-resolution-failed",
]);

const NOTE_LABEL_KEYS: Partial<Record<ExportNoteCode, MessageKey>> = {
  "image-embed-failed": "report.note.imageEmbedFailed",
  "image-missing-alt": "report.note.imageMissingAlt",
  "pdf-image-alt-fallback": "report.note.imageAltFallback",
  "pdf-link-unresolved": "report.note.linkUnresolved",
  "unsafe-link-skipped": "report.note.linkUnsafe",
  "folder-position-unknown": "report.note.folderOrder",
  "macro-degraded": "report.note.macroDegraded",
  "macro-rendered-via": "report.note.macroRendered",
  "macro-skipped-by-config": "report.note.macroSkipped",
  "pdf-diagram-failed": "report.note.diagramFailed",
  "pdf-diagram-unsupported": "report.note.diagramUnsupported",
  "diagram-render-failed": "report.note.diagramFailed",
  "diagram-unsupported": "report.note.diagramUnsupported",
  "unsupported-child-type": "report.note.unsupportedChild",
};

const CATEGORY_META: Record<
  ExportNoteCategory,
  { labelKey: MessageKey; descriptionKey: MessageKey; icon: typeof Info }
> = {
  content: {
    labelKey: "report.category.content",
    descriptionKey: "report.category.contentHelp",
    icon: FileWarning,
  },
  links: {
    labelKey: "report.category.links",
    descriptionKey: "report.category.linksHelp",
    icon: Link2,
  },
  accessibility: {
    labelKey: "report.category.accessibility",
    descriptionKey: "report.category.accessibilityHelp",
    icon: Accessibility,
  },
  dynamic: {
    labelKey: "report.category.dynamic",
    descriptionKey: "report.category.dynamicHelp",
    icon: Blocks,
  },
  layout: {
    labelKey: "report.category.layout",
    descriptionKey: "report.category.layoutHelp",
    icon: LayoutTemplate,
  },
  information: {
    labelKey: "report.category.information",
    descriptionKey: "report.category.informationHelp",
    icon: Info,
  },
};

/**
 * Classify by the stable note code, never by localized engine prose. Unknown
 * future codes remain visible under "Information" until the registry is
 * deliberately extended.
 */
export function classifyExportNote(code: string): ExportNoteCategory {
  if (code === "unsafe-link-skipped" || code === "pdf-link-unresolved" || code.startsWith("link-")) {
    return "links";
  }
  if (ACCESSIBILITY_CODES.has(code as ExportNoteCode)) return "accessibility";
  if (CONTENT_CODES.has(code as ExportNoteCode)) return "content";
  if (
    DYNAMIC_CONTEXT_CODES.has(code as ExportNoteCode) ||
    code.startsWith("macro-") ||
    code.startsWith("datasource-") ||
    code.startsWith("includepage-") ||
    code.includes("placeholder") ||
    code.startsWith("mention-") ||
    code === "unknown-macro" ||
    code === "auth-error" ||
    code === "remote-error"
  ) {
    return "dynamic";
  }
  if (INFORMATION_CODES.has(code as ExportNoteCode)) return "information";
  if (
    code.startsWith("diagram-") ||
    code.startsWith("pdf-diagram-") ||
    code.startsWith("table-") ||
    code.startsWith("orientation-") ||
    code.startsWith("pagebreak-") ||
    code.startsWith("caption-") ||
    code.startsWith("scroll-") ||
    code.startsWith("styleref-") ||
    code.startsWith("code-") ||
    code.startsWith("list-") ||
    code.startsWith("numbering-") ||
    code === "heading-depth-clamped" ||
    code === "pdf-unknown-block"
  ) {
    return "layout";
  }
  return "information";
}

export function groupExportNotes(notes: readonly ExportNote[]): ExportNoteGroup[] {
  const byCategory = new Map<ExportNoteCategory, ExportNote[]>();
  for (const note of notes) {
    const category = classifyExportNote(note.code);
    const bucket = byCategory.get(category) ?? [];
    bucket.push(note);
    byCategory.set(category, bucket);
  }

  return CATEGORY_ORDER.flatMap((category) => {
    const categoryNotes = byCategory.get(category);
    if (!categoryNotes?.length) return [];

    const byCode = new Map<string, ExportNote[]>();
    for (const note of categoryNotes) {
      const bucket = byCode.get(note.code) ?? [];
      bucket.push(note);
      byCode.set(note.code, bucket);
    }

    return [{
      category,
      notes: categoryNotes,
      warningCount: categoryNotes.filter((note) => note.level === "warning").length,
      codes: [...byCode.entries()].map(([code, codeNotes]) => ({
        code,
        notes: codeNotes,
        warningCount: codeNotes.filter((note) => note.level === "warning").length,
      })),
    }];
  });
}

function noteLabelKey(code: string): MessageKey {
  return NOTE_LABEL_KEYS[code as ExportNoteCode] ?? "report.note.other";
}

function NoteMessages({ group }: { group: NoteCodeGroup }): React.JSX.Element {
  const t = useT();
  const messages = (
    <ul className="m-0 mt-1.5 grid list-disc gap-1 pl-4 text-[11px] leading-4 text-muted-foreground">
      {group.notes.map((note, index) => (
        <li key={`${note.code}-${index}`}>
          {note.message}
          {note.source?.pageTitle && (
            <span className="ml-1 text-foreground/70">— {note.source.pageTitle}</span>
          )}
        </li>
      ))}
    </ul>
  );

  if (group.notes.length === 1) {
    return <div className="px-2.5 pb-2">{messages}</div>;
  }

  return (
    <details className="group/messages px-2.5 pb-2">
      <summary className="cursor-pointer list-none text-[11px] font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        {t("report.messages.show", { count: group.notes.length })}
      </summary>
      {messages}
    </details>
  );
}

export function ExportNoteGroups({ notes }: { notes: readonly ExportNote[] }): React.JSX.Element | null {
  const t = useT();
  if (notes.length === 0) return null;

  const groups = groupExportNotes(notes);
  const warningCount = notes.filter((note) => note.level === "warning").length;
  const infoCount = notes.length - warningCount;
  let firstWarningOpened = false;

  return (
    <section aria-label={t("report.protocol.title")} className="mt-2 border-t border-border/70 pt-2">
      <div className="flex items-start gap-2">
        {warningCount > 0 ? (
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />
        ) : (
          <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0">
          <div className="font-semibold">
            {warningCount > 0
              ? t("report.protocol.review", { count: warningCount })
              : t("report.protocol.clean")}
          </div>
          {infoCount > 0 && (
            <div className="text-[11px] leading-4 text-muted-foreground">
              {t("report.protocol.additional", { count: infoCount })}
            </div>
          )}
        </div>
      </div>

      <div className="mt-2 divide-y divide-border/70 overflow-hidden rounded-md border bg-background">
        {groups.map((group) => {
          const meta = CATEGORY_META[group.category];
          const Icon = meta.icon;
          const shouldOpen = group.warningCount > 0 && !firstWarningOpened;
          if (shouldOpen) firstWarningOpened = true;

          return (
            <details
              className="group/category"
              data-testid={`report-category-${group.category}`}
              key={group.category}
              open={shouldOpen}
            >
              <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-2.5 py-2 hover:bg-muted/60 [&::-webkit-details-marker]:hidden">
                <Icon
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 shrink-0",
                    group.warningCount > 0 ? "text-warning" : "text-muted-foreground"
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium leading-4">{t(meta.labelKey)}</span>
                  <span className="block text-[10px] leading-3.5 text-muted-foreground">
                    {t(meta.descriptionKey)}
                  </span>
                </span>
                <span
                  aria-label={t("report.category.count", { count: group.notes.length })}
                  className="min-w-5 rounded-full bg-muted px-1.5 py-0.5 text-center text-[10px] font-semibold tabular-nums text-muted-foreground"
                >
                  {group.notes.length}
                </span>
              </summary>

              <div className="border-t border-border/60 bg-muted/25 px-2 py-1.5">
                {group.codes.map((codeGroup) => (
                  <div className="border-b border-border/50 last:border-0" key={codeGroup.code}>
                    <div className="flex items-baseline gap-2 px-2.5 py-2">
                      <span className="min-w-0 flex-1 font-medium leading-4">
                        {t(noteLabelKey(codeGroup.code))}
                      </span>
                      <code className="max-w-32 truncate text-[9px] text-muted-foreground" title={codeGroup.code}>
                        {codeGroup.code}
                      </code>
                      {codeGroup.notes.length > 1 && (
                        <span className="text-[10px] font-semibold tabular-nums text-muted-foreground">
                          ×{codeGroup.notes.length}
                        </span>
                      )}
                    </div>
                    <NoteMessages group={codeGroup} />
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
