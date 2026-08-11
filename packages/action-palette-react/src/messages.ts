export const ACTION_PALETTE_MESSAGE_KEYS_V1 = [
  "palette.dialog.label",
  "palette.search.label",
  "palette.search.placeholder",
  "palette.results.count",
  "palette.results.empty.title",
  "palette.results.empty.hint",
  "palette.actions.title",
  "palette.actions.empty",
  "palette.input.title",
  "palette.executing",
  "palette.completed",
  "palette.queued",
  "palette.failed",
  "palette.retry",
  "palette.back",
  "palette.close",
  "palette.cancel",
  "palette.run",
  "palette.open-actions",
  "palette.unavailable",
  "palette.error.required",
  "palette.error.too-short",
  "palette.error.too-long",
  "palette.error.invalid-option",
  "palette.error.boundary.title",
  "palette.error.boundary.message",
] as const;

export type ActionPaletteMessageKeyV1 =
  (typeof ACTION_PALETTE_MESSAGE_KEYS_V1)[number];

export type ActionPaletteMessagesV1 = Readonly<
  Record<ActionPaletteMessageKeyV1, string>
>;

export const ACTION_PALETTE_MESSAGES_EN_V1: ActionPaletteMessagesV1 =
  Object.freeze({
    "palette.dialog.label": "atlcli actions",
    "palette.search.label": "Search actions",
    "palette.search.placeholder": "Search actions…",
    "palette.results.count": "{count} actions available",
    "palette.results.empty.title": "No matching actions",
    "palette.results.empty.hint": "Try a shorter action name or clear the search.",
    "palette.actions.title": "Actions for {action}",
    "palette.actions.empty": "This action has no additional options.",
    "palette.input.title": "Complete {action}",
    "palette.executing": "Running {action}…",
    "palette.completed": "Action completed",
    "palette.queued": "Action queued",
    "palette.failed": "The action could not be completed.",
    "palette.retry": "Try again",
    "palette.back": "Back",
    "palette.close": "Close",
    "palette.cancel": "Cancel",
    "palette.run": "Run",
    "palette.open-actions": "Actions",
    "palette.unavailable": "Unavailable",
    "palette.error.required": "Please complete this field.",
    "palette.error.too-short": "Please enter more detail.",
    "palette.error.too-long": "Please shorten this value.",
    "palette.error.invalid-option": "Please choose an available option.",
    "palette.error.boundary.title": "The action palette stopped responding",
    "palette.error.boundary.message": "Close the palette and open it again.",
  });

export const ACTION_PALETTE_MESSAGES_DE_V1: ActionPaletteMessagesV1 =
  Object.freeze({
    "palette.dialog.label": "atlcli-Aktionen",
    "palette.search.label": "Aktionen durchsuchen",
    "palette.search.placeholder": "Aktionen durchsuchen…",
    "palette.results.count": "{count} Aktionen verfügbar",
    "palette.results.empty.title": "Keine passenden Aktionen",
    "palette.results.empty.hint": "Versuche einen kürzeren Namen oder leere die Suche.",
    "palette.actions.title": "Aktionen für {action}",
    "palette.actions.empty": "Diese Aktion hat keine weiteren Optionen.",
    "palette.input.title": "{action} vervollständigen",
    "palette.executing": "{action} wird ausgeführt…",
    "palette.completed": "Aktion abgeschlossen",
    "palette.queued": "Aktion vorgemerkt",
    "palette.failed": "Die Aktion konnte nicht abgeschlossen werden.",
    "palette.retry": "Erneut versuchen",
    "palette.back": "Zurück",
    "palette.close": "Schließen",
    "palette.cancel": "Abbrechen",
    "palette.run": "Ausführen",
    "palette.open-actions": "Aktionen",
    "palette.unavailable": "Nicht verfügbar",
    "palette.error.required": "Bitte fülle dieses Feld aus.",
    "palette.error.too-short": "Bitte gib mehr Details ein.",
    "palette.error.too-long": "Bitte kürze diesen Wert.",
    "palette.error.invalid-option": "Bitte wähle eine verfügbare Option.",
    "palette.error.boundary.title": "Die Aktionspalette reagiert nicht mehr",
    "palette.error.boundary.message": "Schließe die Palette und öffne sie erneut.",
  });

export function formatActionPaletteMessageV1(
  template: string,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return template.replace(/\{([a-z][a-z0-9-]*)\}/giu, (_match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : "",
  );
}

export function mergeActionPaletteMessagesV1(
  locale: string,
  overrides: Partial<ActionPaletteMessagesV1> = {},
): ActionPaletteMessagesV1 {
  const base = locale.toLowerCase().startsWith("de")
    ? ACTION_PALETTE_MESSAGES_DE_V1
    : ACTION_PALETTE_MESSAGES_EN_V1;
  return Object.freeze({ ...base, ...overrides });
}
