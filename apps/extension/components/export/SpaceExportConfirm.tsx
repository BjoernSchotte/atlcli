/**
 * "212 pages, continue?" — the space-export confirmation (spec 010 T5.1,
 * BASELINE-DESIGN A2).
 *
 * A whole-space export is the one scope whose cost the user cannot estimate
 * from the panel: it may be four pages or four hundred, and the difference is
 * minutes of fetching plus a bundle that can trip the job-store budget. So it
 * is the one scope that asks first.
 *
 * The count is a **nicety, not a gate**. `AppPorts.countScopePages` is
 * optional and may fail (or be aborted); when no number is available the dialog
 * still appears with count-free wording rather than blocking an export the user
 * is entitled to run. Tree and page scopes never reach this component.
 */
import React from "react";
import { useT } from "../../utils/i18n/context.js";
import { Alert, AlertTitle } from "../ui/alert.js";
import { Button } from "../ui/button.js";

export function SpaceExportConfirm({
  spaceKey,
  pageCount,
  counting,
  onConfirm,
  onCancel,
}: {
  spaceKey: string;
  /** `null` when unknown — no host counter, or the count failed. */
  pageCount: number | null;
  /** The count is still in flight. */
  counting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const t = useT();
  return (
    <Alert
      tone="warning"
      role="alertdialog"
      aria-label={t("scope.confirm.title", { spaceKey })}
      data-testid="scope-space-confirm"
    >
      <AlertTitle>{t("scope.confirm.title", { spaceKey })}</AlertTitle>
      <p className="m-0 mt-1" data-testid="scope-space-confirm-count">
        {counting
          ? t("scope.confirm.counting")
          : pageCount === null
            ? t("scope.confirm.unknownCount", { spaceKey })
            : t("scope.confirm.count", { count: pageCount })}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" onClick={onConfirm} data-testid="scope-space-confirm-yes">
          {t("scope.confirm.continue")}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} data-testid="scope-space-confirm-no">
          {t("scope.confirm.cancel")}
        </Button>
      </div>
    </Alert>
  );
}
