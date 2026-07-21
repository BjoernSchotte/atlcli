/**
 * Generic renderer over a template-settings schema (spec 010 T5.2).
 *
 * One widget per declared type — `text | boolean | choice | color | number |
 * asset` — and **no per-setting branching**: the form does not know that
 * `watermarkOpacity` is a watermark, only that it is a bounded number. That is
 * what lets the same component render a future template pack's own `settings`
 * map (via `fromManifestSettings`) without an edit.
 *
 * **PDF only for v1, and `readOnly` is how that is honest.** `packages/pdf`
 * threads `settings` through `RunPdfExportInput`; `packages/docx`'s
 * `ExportInput` has no such field. A DOCX template's manifest settings are
 * therefore rendered with `readOnly`, showing the values the template declares
 * *and* saying that they are not applied — instead of an editable form whose
 * values would be silently dropped. See `settings-schema.ts` for why there is
 * no `toDocxSettings`.
 *
 * All state is lifted: the form owns no values, so the screen can persist them
 * to `template-prefs` and hand the same object to `toPdfSettings`.
 */
import React from "react";
import { useT } from "../../utils/i18n/context.js";
import type { MessageKey } from "../../utils/i18n/messages.js";
import { Alert } from "../ui/alert.js";
import { Button } from "../ui/button.js";
import {
  CheckboxField,
  FieldHelp,
  Input,
  Label,
  SectionHeading,
  Select,
} from "../ui/field.js";
import {
  PDF_SETTING_LABEL_KEYS,
  PDF_SETTING_OPTION_LABEL_KEYS,
} from "./pdf-settings.js";
import {
  validateSetting,
  type SettingIssue,
  type SettingIssueReason,
  type SettingSchema,
  type SettingsSchema,
  type SettingValue,
} from "./settings-schema.js";

const ISSUE_KEYS: Record<SettingIssueReason, MessageKey> = {
  "not-a-number": "settingsForm.issue.number",
  "out-of-range": "settingsForm.issue.range",
  "not-a-color": "settingsForm.issue.color",
  "not-an-option": "settingsForm.issue.option",
  "too-long": "settingsForm.issue.tooLong",
  "asset-too-large": "settingsForm.issue.assetTooLarge",
  "asset-unsupported": "settingsForm.issue.assetUnsupported",
};

export interface SettingsFormProps {
  schema: SettingsSchema;
  values: Readonly<Record<string, SettingValue>>;
  onChange: (key: string, value: SettingValue) => void;
  /** Reset every field to its schema default. */
  onReset?: () => void;
  /**
   * Render values but reject edits. This is the DOCX branch: the template
   * declares settings, the engine has nowhere to put them, and pretending
   * otherwise would be the defect.
   */
  readOnly?: boolean;
  /** Issues raised outside the per-field check (an oversized asset upload). */
  extraIssues?: readonly SettingIssue[];
  /** Test/DOM id prefix so two forms can coexist. */
  idPrefix?: string;
  /**
   * Render inside a closed `<details>`.
   *
   * The Level-A schema is fifteen fields; unfolded above the Word panel it
   * would push the second engine below the fold of a 400 px side panel for
   * everyone who never changes a setting. Same progressive-disclosure rule as
   * `ScopeSection`'s Advanced block.
   */
  collapsible?: boolean;
}

function labelFor(t: (key: MessageKey) => string, key: string, schema: SettingSchema): string {
  const messageKey = PDF_SETTING_LABEL_KEYS[key];
  if (messageKey) return t(messageKey);
  return schema.label ?? key;
}

function optionLabelFor(
  t: (key: MessageKey) => string,
  key: string,
  option: { value: string; label?: string }
): string {
  const messageKey = PDF_SETTING_OPTION_LABEL_KEYS[`${key}.${option.value}`];
  if (messageKey) return t(messageKey);
  return option.label ?? option.value;
}

/** Read a file as a `data:` URL so an asset value stays a plain string. */
async function toDataUrl(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return `data:${file.type};base64,${btoa(binary)}`;
}

export function SettingsForm({
  schema,
  values,
  onChange,
  onReset,
  readOnly,
  extraIssues,
  idPrefix = "settings",
  collapsible,
}: SettingsFormProps): React.JSX.Element {
  const t = useT();
  const entries = Object.entries(schema);
  const extraByKey = new Map((extraIssues ?? []).map((issue) => [issue.key, issue]));

  const body = (
    <>
      {readOnly && (
        <Alert tone="muted" data-testid={`${idPrefix}-readonly`}>
          {t("settingsForm.readOnly")}
        </Alert>
      )}

      {entries.length === 0 ? (
        <FieldHelp data-testid={`${idPrefix}-empty`}>{t("settingsForm.empty")}</FieldHelp>
      ) : (
        entries.map(([key, setting]) => {
          const id = `${idPrefix}-${key}`;
          const value = values[key] ?? null;
          const issue = extraByKey.get(key) ?? validateSetting(key, setting, value);
          const label = labelFor(t, key, setting);

          return (
            <div key={key} className="flex flex-col gap-1" data-testid={`${id}-field`}>
              {setting.type === "boolean" ? (
                <CheckboxField
                  data-testid={id}
                  label={label}
                  checked={value === true}
                  disabled={readOnly}
                  onChange={(event) => onChange(key, event.target.checked)}
                />
              ) : (
                <>
                  <Label htmlFor={id}>{label}</Label>
                  {setting.type === "choice" ? (
                    <Select
                      id={id}
                      data-testid={id}
                      value={typeof value === "string" ? value : ""}
                      disabled={readOnly}
                      onChange={(event) => onChange(key, event.target.value)}
                    >
                      {(setting.options ?? []).map((option) => (
                        <option key={option.value} value={option.value}>
                          {optionLabelFor(t, key, option)}
                        </option>
                      ))}
                    </Select>
                  ) : setting.type === "number" ? (
                    <Input
                      id={id}
                      data-testid={id}
                      type="number"
                      inputMode="decimal"
                      value={typeof value === "number" ? String(value) : ""}
                      min={setting.min}
                      max={setting.max}
                      step={setting.step}
                      disabled={readOnly}
                      onChange={(event) => {
                        const raw = event.target.value;
                        // An empty box is "unset" (null), not NaN — and a
                        // non-numeric string keeps its own shape so
                        // `validateSetting` can call it out rather than the
                        // value silently becoming NaN in storage.
                        onChange(key, raw === "" ? null : Number.isNaN(Number(raw)) ? raw : Number(raw));
                      }}
                    />
                  ) : setting.type === "color" ? (
                    <div className="flex items-center gap-2">
                      <Input
                        id={id}
                        data-testid={id}
                        type="text"
                        value={typeof value === "string" ? value : ""}
                        placeholder="#4B57A3"
                        disabled={readOnly}
                        onChange={(event) => onChange(key, event.target.value)}
                      />
                      <input
                        type="color"
                        aria-label={label}
                        data-testid={`${id}-picker`}
                        value={
                          typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
                            ? value
                            : "#000000"
                        }
                        disabled={readOnly}
                        onChange={(event) => onChange(key, event.target.value)}
                        className="h-8 w-10 shrink-0 rounded-md border bg-background"
                      />
                    </div>
                  ) : setting.type === "asset" ? (
                    <div className="flex flex-col gap-1">
                      <input
                        id={id}
                        data-testid={id}
                        type="file"
                        accept={setting.accept}
                        disabled={readOnly}
                        className="text-xs"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.target.value = "";
                          if (!file) return;
                          void toDataUrl(file).then((dataUrl) => onChange(key, dataUrl));
                        }}
                      />
                      {typeof value === "string" && value !== "" && (
                        <div className="flex items-center gap-2">
                          <FieldHelp data-testid={`${id}-present`}>
                            {t("settingsForm.assetPresent")}
                          </FieldHelp>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={readOnly}
                            data-testid={`${id}-clear`}
                            onClick={() => onChange(key, "")}
                          >
                            {t("settingsForm.assetClear")}
                          </Button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <Input
                      id={id}
                      data-testid={id}
                      type="text"
                      value={typeof value === "string" ? value : ""}
                      disabled={readOnly}
                      onChange={(event) => onChange(key, event.target.value)}
                    />
                  )}
                </>
              )}

              {issue && (
                <p
                  role="alert"
                  data-testid={`${id}-issue`}
                  className="m-0 text-xs text-destructive"
                >
                  {t(ISSUE_KEYS[issue.reason])}
                </p>
              )}
            </div>
          );
        })
      )}

      {onReset && !readOnly && entries.length > 0 && (
        <div>
          <Button size="sm" variant="outline" onClick={onReset} data-testid={`${idPrefix}-reset`}>
            {t("settingsForm.reset")}
          </Button>
        </div>
      )}
    </>
  );

  if (collapsible) {
    return (
      <details data-testid={`${idPrefix}-form`} className="rounded-md border px-2 py-1.5">
        <summary className="cursor-pointer text-xs font-medium">
          {t("settingsForm.title")}
        </summary>
        <div className="mt-2 flex flex-col gap-2.5">{body}</div>
      </details>
    );
  }

  return (
    <section data-testid={`${idPrefix}-form`} className="flex flex-col gap-2.5">
      <SectionHeading>{t("settingsForm.title")}</SectionHeading>
      {body}
    </section>
  );
}
