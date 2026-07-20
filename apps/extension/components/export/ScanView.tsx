/**
 * DOCX template placeholder scan (presentational).
 *
 * Moved here from `entrypoints/sidepanel/TemplateSection.tsx` in spec 010
 * Phase 0; the old path re-exports it so `tests/docx/scan-view.test.tsx` keeps
 * passing unchanged.
 *
 * Two behaviours are load-bearing and must survive any restyling:
 *  - the group header states the OUTCOME ("Will be empty (4)") while each row
 *    states its OWN reason, because `classifyPlaceholder` puts genuinely
 *    different causes (a Cloud-impossible DC username, an unmodelled field, a
 *    third-party app macro) in the same bucket;
 *  - `$scroll.content` is surfaced explicitly even though it is excluded from
 *    the placeholder list — a user read its absence as "the anchor is missing"
 *    (spec 004 E2E finding).
 */
import React from "react";
import type { ScanResult } from "@atlcli/docx/scan";
import { useT } from "../../utils/i18n/context.js";
import type { MessageKey } from "../../utils/i18n/messages.js";
import { cn } from "../ui/utils.js";

export function ScanView({ scan }: { scan: ScanResult }): React.JSX.Element {
  const t = useT();
  const { supported, unsupported, never, hasContentPlaceholder } = scan;
  return (
    <div data-testid="template-scan" className="mt-2 text-xs">
      {supported.length === 0 && unsupported.length === 0 && never.length === 0 && (
        <p className="m-0 text-muted-foreground">{t("docx.scan.none")}</p>
      )}
      <ScanGroup icon="✓" className="text-success" labelKey="docx.scan.supported" hits={supported} />
      <ScanGroup icon="⚠" className="text-warning" labelKey="docx.scan.willBeEmpty" hits={unsupported} />
      <ScanGroup icon="✗" className="text-destructive" labelKey="docx.scan.notSupported" hits={never} />
      <div
        data-testid="content-insertion-point"
        className={cn("mt-1.5", hasContentPlaceholder ? "text-success" : "text-muted-foreground")}
      >
        {hasContentPlaceholder ? t("docx.scan.contentFound") : t("docx.scan.contentMissing")}
      </div>
    </div>
  );
}

function ScanGroup({
  icon,
  className,
  labelKey,
  hits,
}: {
  icon: string;
  className: string;
  labelKey: MessageKey;
  hits: ScanResult["supported"];
}): React.JSX.Element | null {
  const t = useT();
  if (hits.length === 0) return null;
  return (
    <div className="mb-1.5">
      <div className={cn("font-semibold", className)}>
        {icon} {t(labelKey)} ({hits.length})
      </div>
      <ul className="m-0 mt-0.5 list-disc pl-4">
        {hits.map((hit) => (
          <li key={hit.base}>
            <code>{hit.base}</code>
            {hit.count > 1 ? ` ×${hit.count}` : ""}
            {hit.reason ? <span className="text-muted-foreground"> — {hit.reason}</span> : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
