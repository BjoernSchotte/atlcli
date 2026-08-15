/**
 * Settings screen (spec 010 Phase 0).
 *
 * Only one preference for now — the UI language — which is precisely why i18n
 * had to exist from the first component rather than be retrofitted: the
 * language selector is a *requirement* of the design, not a nice-to-have, and
 * retrofitting would have touched every component.
 */
import React, { useEffect, useState } from "react";
import type { ScreenProps } from "../../utils/screens/registry.js";
import { useI18n } from "../../utils/i18n/context.js";
import { isLocale, LOCALES } from "../../utils/i18n/messages.js";
import { hasCapability } from "../../utils/ports/host.js";
import type { ShortcutAssignmentV1 } from "../../utils/ports/action-palette.js";
import { useAppSettings } from "../app/settings-context.js";
import { Alert } from "../ui/alert.js";
import { Card, CardContent } from "../ui/card.js";
import { Button } from "../ui/button.js";
import {
  CheckboxField,
  FieldHelp,
  Input,
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
  const research = ports.research;
  const [apiKey, setApiKey] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [rememberApiKey, setRememberApiKey] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [shortcut, setShortcut] = useState<ShortcutAssignmentV1 | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!ports.shortcut) {
      setShortcut(null);
      return () => { cancelled = true; };
    }
    void ports.shortcut.getAssignment()
      .then((assignment) => { if (!cancelled) setShortcut(assignment); })
      .catch(() => {
        if (!cancelled) setShortcut({ commandId: "action-palette", status: "unbound", value: null });
      });
    return () => { cancelled = true; };
  }, [ports.shortcut]);

  useEffect(() => {
    let cancelled = false;
    if (!research) {
      setHasApiKey(false);
      return () => { cancelled = true; };
    }
    void Promise.all([
      research.hasApiKey(),
      research.getApiKeyPersistence?.() ?? Promise.resolve("session" as const),
    ])
      .then(([present, persistence]) => {
        if (!cancelled) {
          setHasApiKey(present);
          setRememberApiKey(persistence === "device");
        }
      })
      .catch(() => {
        if (!cancelled) setHasApiKey(false);
      });
    return () => { cancelled = true; };
  }, [research]);

  async function storeApiKey(): Promise<void> {
    const candidate = apiKey.trim();
    if (!research || !candidate) return;
    setAiError(null);
    try {
      await research.setApiKey(candidate, {
        persistence: rememberApiKey ? "device" : "session",
      });
      setApiKey("");
      setHasApiKey(true);
    } catch (value) {
      setAiError(value instanceof Error ? value.message : t("settings.ai.saveFailed"));
    }
  }

  async function updateApiKeyPersistence(remember: boolean): Promise<void> {
    if (!research) return;
    const previous = rememberApiKey;
    setRememberApiKey(remember);
    setAiError(null);
    if (!hasApiKey || !research.setApiKeyPersistence) return;
    try {
      await research.setApiKeyPersistence(remember ? "device" : "session");
    } catch (value) {
      setRememberApiKey(previous);
      setAiError(value instanceof Error ? value.message : t("settings.ai.saveFailed"));
    }
  }

  async function forgetApiKey(): Promise<void> {
    if (!research) return;
    setAiError(null);
    try {
      await research.clearApiKey();
      setApiKey("");
      setHasApiKey(false);
    } catch (value) {
      setAiError(value instanceof Error ? value.message : t("settings.ai.saveFailed"));
    }
  }
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

      {ports.shortcut && (
        <Card data-testid="settings-shortcut">
          <CardContent className="flex flex-col gap-1.5 p-3">
            <p className="m-0 text-sm font-medium">{t("settings.shortcut.title")}</p>
            <div className="flex items-center justify-between gap-3">
              <p className="m-0 text-xs text-muted-foreground">
                {shortcut?.status === "assigned"
                  ? t("settings.shortcut.assigned")
                  : t("settings.shortcut.unbound")}
              </p>
              <kbd
                className="rounded border border-border bg-muted px-2 py-1 text-xs font-semibold"
                data-testid="settings-shortcut-value"
              >
                {shortcut?.value ?? t("settings.shortcut.none")}
              </kbd>
            </div>
            <FieldHelp>{t("settings.shortcut.help")}</FieldHelp>
            <div>
              <Button
                size="sm"
                variant="outline"
                data-testid="settings-shortcut-open"
                onClick={() => {
                  setFailed(false);
                  void ports.shortcut?.openSettings().catch(() => setFailed(true));
                }}
              >
                {t("settings.shortcut.open")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card data-testid="settings-ai">
        <CardContent className="flex flex-col gap-1.5 p-3">
          <p className="m-0 text-sm font-medium">{t("settings.ai.title")}</p>
          <p className="m-0 text-xs text-muted-foreground">{t("settings.ai.provider.anthropic")}</p>
          <Label htmlFor="settings-ai-key">{t("research.key")}</Label>
          <Input
            id="settings-ai-key"
            data-testid="settings-ai-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            placeholder={t("research.key.placeholder")}
            onChange={(event) => setApiKey(event.target.value)}
            disabled={!research}
          />
          <FieldHelp>
            {!research
              ? t("settings.ai.unavailable")
              : hasApiKey
                ? t(
                    rememberApiKey
                      ? "settings.ai.keyStoredDevice"
                      : "settings.ai.keyStoredSession",
                  )
                : apiKey.trim()
                  ? t("research.key.pending")
                  : t("research.key.missing")}
          </FieldHelp>
          {research && (
            <CheckboxField
              data-testid="settings-ai-remember-key"
              checked={rememberApiKey}
              label={t("settings.ai.rememberDevice")}
              help={t("settings.ai.rememberDeviceHelp")}
              onChange={(event) => void updateApiKeyPersistence(event.target.checked)}
            />
          )}
          {(apiKey.trim() || hasApiKey) && research && (
            <div className="flex gap-2">
              {apiKey.trim() && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void storeApiKey()}
                  data-testid="settings-ai-store-key"
                >
                  {t("research.key.store")}
                </Button>
              )}
              {hasApiKey && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void forgetApiKey()}
                  data-testid="settings-ai-forget-key"
                >
                  {t("research.key.forget")}
                </Button>
              )}
            </div>
          )}
          <FieldHelp>{t("settings.ai.futureLocal")}</FieldHelp>
          {aiError && (
            <Alert role="alert" tone="danger" data-testid="settings-ai-error">
              {aiError}
            </Alert>
          )}
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
