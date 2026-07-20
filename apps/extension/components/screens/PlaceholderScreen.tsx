/**
 * Registered-but-empty screens (spec 010 Phase 0).
 *
 * Template sets and Activity exist as registry entries before they have any
 * content on purpose: the registry has to be exercised by more than one real
 * screen, and adding their implementation must then be a change to *these*
 * files only — never to the shell.
 */
import React from "react";
import type { ScreenProps } from "../../utils/screens/registry.js";
import type { MessageKey } from "../../utils/i18n/messages.js";
import { useT } from "../../utils/i18n/context.js";
import { Card, CardContent } from "../ui/card.js";
import { SectionHeading } from "../ui/field.js";

export function createPlaceholderScreen(
  titleKey: MessageKey,
  bodyKey: MessageKey,
  testId: string
): (props: ScreenProps) => React.JSX.Element {
  return function PlaceholderScreen(_props: ScreenProps): React.JSX.Element {
    const t = useT();
    return (
      <div className="flex flex-col gap-3" data-testid={testId}>
        <SectionHeading>{t(titleKey)}</SectionHeading>
        <Card>
          <CardContent className="p-3 text-xs text-muted-foreground">
            <p className="m-0 mb-1 font-semibold text-foreground">
              {t("placeholder.comingSoon")}
            </p>
            <p className="m-0">{t(bodyKey)}</p>
          </CardContent>
        </Card>
      </div>
    );
  };
}
