import {
  MACRO_DEGRADED,
  MACRO_RENDERED_VIA,
  MACRO_SKIPPED_BY_CONFIG,
} from "@atlcli/export-macros";
import React from "react";
import { useT } from "../../utils/i18n/context.js";

export interface MacroOutcomeCounts {
  renderedVia: number;
  degraded: number;
  skippedByConfig: number;
}

/**
 * Count terminal macro outcome notes without interpreting their human message.
 *
 * Some renderers emit more than one terminal note for a macro, so these are
 * deliberately labelled as outcomes in the UI rather than unique macro
 * instances. The stable machine codes are the report contract.
 */
export function summarizeMacroOutcomes(
  notes: readonly { code: string }[]
): MacroOutcomeCounts {
  const counts: MacroOutcomeCounts = {
    renderedVia: 0,
    degraded: 0,
    skippedByConfig: 0,
  };

  for (const note of notes) {
    switch (note.code) {
      case MACRO_RENDERED_VIA:
        counts.renderedVia += 1;
        break;
      case MACRO_DEGRADED:
        counts.degraded += 1;
        break;
      case MACRO_SKIPPED_BY_CONFIG:
        counts.skippedByConfig += 1;
        break;
    }
  }

  return counts;
}

export function MacroOutcomeSummary({
  notes,
}: {
  notes: readonly { code: string }[];
}): React.JSX.Element | null {
  const t = useT();
  const counts = summarizeMacroOutcomes(notes);
  if (counts.renderedVia + counts.degraded + counts.skippedByConfig === 0) {
    return null;
  }

  return (
    <div
      aria-label={t("report.macros.label")}
      className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 border-t border-border/70 pt-1.5 text-[11px] leading-4"
      data-testid="macro-outcome-summary"
    >
      {counts.renderedVia > 0 && (
        <span className="text-success" data-testid="macro-outcome-rendered">
          {t("report.macros.renderedVia", { count: counts.renderedVia })}
        </span>
      )}
      {counts.degraded > 0 && (
        <span className="text-warning" data-testid="macro-outcome-degraded">
          {t("report.macros.degraded", { count: counts.degraded })}
        </span>
      )}
      {counts.skippedByConfig > 0 && (
        <span className="text-muted-foreground" data-testid="macro-outcome-skipped">
          {t("report.macros.skippedByConfig", { count: counts.skippedByConfig })}
        </span>
      )}
    </div>
  );
}
