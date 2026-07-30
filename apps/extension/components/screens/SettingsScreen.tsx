/**
 * Settings screen (spec 010 Phase 0).
 *
 * Only one preference for now — the UI language — which is precisely why i18n
 * had to exist from the first component rather than be retrofitted: the
 * language selector is a *requirement* of the design, not a nice-to-have, and
 * retrofitting would have touched every component.
 */
import React, { useState } from "react";
import type { ScreenProps } from "../../utils/screens/registry.js";
import { useI18n } from "../../utils/i18n/context.js";
import { isLocale, LOCALES } from "../../utils/i18n/messages.js";
import { hasCapability } from "../../utils/ports/host.js";
import { useAppSettings } from "../app/settings-context.js";
import { Alert } from "../ui/alert.js";
import { Card, CardContent } from "../ui/card.js";
import {
  CheckboxField,
  FieldHelp,
  Label,
  Select,
  SectionHeading,
} from "../ui/field.js";

const LOCALE_LABEL_KEYS = {
  en: "settings.language.en",
  de: "settings.language.de",
} as const;

export const SETTINGS_SCREEN_ID = "settings";

export function SettingsScreen({ ports }: ScreenProps): React.JSX.Element {
  const { t } = useI18n();
  const { settings, update } = useAppSettings();
  const [failed, setFailed] = useState(false);
  const canCustomizeConfluence = hasCapability(
    ports.host,
    "confluence-page-customization"
  );

  return (
    <div className="flex flex-col gap-4">
      <SectionHeading>{t("settings.title")}</SectionHeading>

      <Card>
        <CardContent className="flex flex-col gap-1.5 p-3">
          <Label htmlFor="settings-language">{t("settings.language.label")}</Label>
          <Select
            id="settings-language"
            data-testid="settings-language"
            value={settings.locale ?? ""}
            onChange={(event) => {
              const raw = event.target.value;
              setFailed(false);
              void update({ locale: isLocale(raw) ? raw : null }).catch(() => setFailed(true));
            }}
          >
            <option value="">{t("settings.language.system")}</option>
            {LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {t(LOCALE_LABEL_KEYS[locale])}
              </option>
            ))}
          </Select>
          <FieldHelp>{t("settings.language.help")}</FieldHelp>
        </CardContent>
      </Card>

      {canCustomizeConfluence && (
        <Card>
          <CardContent className="flex flex-col gap-1.5 p-3">
            <CheckboxField
              data-testid="settings-hide-rovo"
              label={t("settings.rovo.label")}
              help={t("settings.rovo.help")}
              checked={settings.hideRovoEntrypoints}
              onChange={(event) => {
                setFailed(false);
                void update({ hideRovoEntrypoints: event.target.checked }).catch(() =>
                  setFailed(true)
                );
              }}
            />
          </CardContent>
        </Card>
      )}

      {failed && (
        <Alert role="alert" tone="danger" data-testid="settings-error">
          {t("settings.saveFailed")}
        </Alert>
      )}
    </div>
  );
}
