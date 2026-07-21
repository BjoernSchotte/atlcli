/**
 * Typed message catalogue (spec 010 Phase 0).
 *
 * Deliberately NOT `chrome.i18n`: `_locales/**` + `chrome.i18n.getMessage` is an
 * extension-platform API with no equivalent in a Forge iframe, so every string
 * would have to be re-homed when the same screens are mounted by a second host.
 * A plain dictionary plus a React context ports as-is.
 *
 * `en` is the source of truth: `MessageKey` is derived from it and every other
 * catalogue is typed as a total `Record<MessageKey, string>`, so a missing (or
 * misspelled) German key is a compile error, not a runtime `undefined`. The
 * completeness of that contract is additionally pinned by `tests/i18n.test.ts`
 * because `satisfies` alone would not catch an EXTRA key.
 *
 * Placeholders are `{name}` and are substituted by {@link translate}.
 *
 * Engine-produced strings (docxtemplater render errors, `ExportReport.notes`,
 * spec-011 archive rejections) are deliberately NOT translated here: they are
 * produced by the shared engines, are identical in the CLI, and are quoted
 * verbatim so a support request can be matched against the CLI output.
 */

/** UI languages this app ships. */
export const LOCALES = ["en", "de"] as const;

export type Locale = (typeof LOCALES)[number];

const en = {
  "app.title": "atlcli",
  "app.version": "v{version}",

  "nav.sections": "Sections",
  "nav.openSection": "Open {label}",

  "screen.export.label": "Export",
  "screen.export.description": "Export the current Confluence page to PDF or Word.",
  "screen.preview.label": "Preview",
  "screen.preview.description": "See the PDF before you download it.",
  "screen.templates.label": "Template sets",
  "screen.templates.description": "Named template sets with global and space scope.",
  "screen.activity.label": "Activity",
  "screen.activity.description": "Running and finished export jobs.",
  "screen.settings.label": "Settings",
  "screen.settings.description": "Language and app preferences.",
  "screen.about.label": "About",
  "screen.about.description": "Version and licence information.",

  "screen.unmet.page": "Open a Confluence page to use this section.",
  "screen.unmet.capability.pdfExport": "This app cannot produce PDFs.",
  "screen.unmet.capability.docxExport": "This app cannot produce Word documents.",
  "screen.unmet.capability.docxTemplateStore": "This app cannot store Word templates.",
  "screen.unmet.capability.templateLibrary": "Template sets are not available in this app yet.",
  "screen.unmet.capability.durableJobs": "Background jobs are not available in this app yet.",
  "screen.unmet.capability.pdfPreview": "PDF preview is not available in this app yet.",
  "screen.unmet.capability.settingsPersistence": "This app cannot store preferences.",
  "screen.unavailable.title": "Not available here",

  "page.idle": "No Atlassian page detected. Open a Confluence page to export it.",
  "page.unsupported": "Detected {entity}. Nothing to export here yet — open a Confluence page or blog post.",
  "page.loading": "Loading page…",
  "page.retry": "Retry",
  "page.reload": "Reload",
  "page.error.notLoggedIn": "You don't appear to be logged in to this Atlassian site.",
  "page.error.accessDenied": "You don't have access to this page (or it was deleted).",
  "page.error.network": "Network error reaching Confluence.",
  "page.error.unknown": "Something went wrong loading this page.",
  "page.error.loginHint": "Log in to {host} in this tab, then retry.",
  "page.meta.space": "Space",
  "page.meta.version": "Version",
  "page.meta.modified": "Modified",
  "page.meta.words": "Words",
  "page.meta.attachments": "Attachments",
  "page.attachments.summary": "Attachments ({count})",

  "entity.confluence.space": "Confluence space {spaceKey}",
  "entity.confluence.content": "Confluence content",
  "entity.jira.issue": "Jira issue {issueKey}",
  "entity.jira.board": "Jira board {projectKey}",

  "pdf.title": "PDF export",
  "pdf.builtIn": "Uses the built-in atlcli document design. No template upload required.",
  "pdf.export": "Export to PDF",
  "pdf.cancel": "Cancel",
  "pdf.needsPage": "Open a Confluence page to export.",
  "pdf.phase.preparing": "Preparing content…",
  "pdf.phase.fetching": "Fetching attachments…",
  "pdf.phase.queued": "Queued for PDF compiler…",
  "pdf.phase.compiling": "Compiling PDF…",
  "pdf.phase.validating": "Validating PDF…",
  "pdf.phase.downloading": "Downloading…",
  "pdf.cancelled": "PDF export was cancelled.",
  "pdf.report.summary": "{images} image(s) · {diagrams} diagram(s)",
  "pdf.report.timings": "Prepare {prepare} · Compile {compile} · Download {emit}",
  "pdf.report.timingsLabel": "PDF export timing breakdown",
  "pdf.report.notes": "{count} note(s)",

  "preview.title": "PDF preview",
  "preview.generate": "Generate preview",
  "preview.refresh": "Refresh preview",
  "preview.auto": "Update automatically",
  "preview.autoHelp": "Recompiles shortly after you change a setting. Off by default, so exporting never waits for a preview.",
  "preview.needsPage": "Open a Confluence page to preview it.",
  "preview.compiling": "Compiling preview…",
  "preview.empty": "No preview yet.",
  "preview.publishedOnly": "Previews show the last published version of the page — not unsaved editor changes.",
  // "chapters", never "pages": the compiled page count only exists after the
  // compile, and one source page can become many PDF pages.
  "preview.scope.full": "Preview — whole document",
  "preview.scope.truncated": "Preview — first {included} of {total} chapters",
  "preview.truncatedDownloadHint": "A shortened preview cannot be downloaded. Download compiles the whole document.",
  "preview.page": "Page {current} of {total}",
  "preview.previousPage": "Previous page",
  "preview.nextPage": "Next page",
  "preview.zoomIn": "Zoom in",
  "preview.zoomOut": "Zoom out",
  "preview.fitWidth": "Fit width",
  "preview.openLarge": "Open large preview",
  "preview.failed": "The preview could not be compiled: {message}",
  "preview.diagnostics": "Compiler diagnostics ({count})",

  "docx.title": "Word template",
  "docx.upload": "Upload .docx template",
  "docx.scanning": "Scanning…",
  "docx.replace": "Replace",
  "docx.delete": "Delete",
  "docx.export": "Export to Word",
  "docx.exporting": "Exporting…",
  "docx.needsPage": "Open a page to export.",
  "docx.error.notDocx": "Please choose a .docx file.",
  "docx.error.tooLarge": "Template exceeds the {limit} MB limit.",
  "docx.error.notZip": "That file isn't a valid .docx (not a zip).",
  "docx.error.notWord": "That zip isn't a Word document.",
  "docx.error.engineTooLarge": "That template is too large.",
  "docx.error.read": "Could not read the template: {message}",
  "docx.error.render": "The Word template could not be rendered{details}. Check the template for stray control characters.",
  "docx.error.exportFailed": "Export failed: {message}",
  "docx.error.storedUnreadable": "The stored template could not be read. Please upload it again.",
  "docx.scan.none": "No Scroll placeholders detected.",
  "docx.scan.supported": "Supported",
  "docx.scan.willBeEmpty": "Will be empty",
  "docx.scan.notSupported": "Not supported",
  "docx.scan.contentFound": "Content insertion point: ✓ found ($scroll.content)",
  "docx.scan.contentMissing": "No $scroll.content found — the page body will be appended before the final section break.",
  "docx.report.title": "Export complete",
  "docx.report.resolved": "{count} placeholder(s) resolved",
  "docx.report.unsupported": "{count} unsupported: {names}",
  "docx.report.embeddedImages": "{count} image(s) embedded",
  "docx.report.renderedDiagrams": "{count} diagram(s) rendered",
  "docx.report.skippedImages": "{count} image(s) skipped (see notes)",
  "docx.report.duration": "{ms} ms",
  "docx.report.warnings": "Warnings ({count})",
  "docx.report.notes": "Notes ({count})",

  "settings.title": "Settings",
  "settings.language.label": "Language",
  "settings.language.help": "Applies to this app only. Exported documents keep the page's own language.",
  "settings.language.system": "Follow browser language",
  "settings.language.en": "English",
  "settings.language.de": "Deutsch",
  "settings.saveFailed": "Preferences could not be saved.",

  "about.title": "About",
  "about.host": "Host",
  "about.capabilities": "Capabilities",
  "about.licence": "Apache-2.0. Exports run entirely in this browser.",

  "placeholder.comingSoon": "Coming soon",
  "placeholder.templates": "Named template sets with global and space scope will live here.",
  "placeholder.activity": "Running and finished export jobs will be listed here.",
} as const;

/** Every message key the app may ask for. */
export type MessageKey = keyof typeof en;

/** A complete catalogue for one locale. */
export type MessageCatalog = Record<MessageKey, string>;

const de: MessageCatalog = {
  "app.title": "atlcli",
  "app.version": "v{version}",

  "nav.sections": "Bereiche",
  "nav.openSection": "{label} öffnen",

  "screen.export.label": "Export",
  "screen.export.description": "Die aktuelle Confluence-Seite als PDF oder Word exportieren.",
  "screen.preview.label": "Vorschau",
  "screen.preview.description": "Das PDF ansehen, bevor du es herunterlädst.",
  "screen.templates.label": "Template-Sets",
  "screen.templates.description": "Benannte Template-Sets mit globalem und Space-Geltungsbereich.",
  "screen.activity.label": "Aktivitäten",
  "screen.activity.description": "Laufende und abgeschlossene Export-Jobs.",
  "screen.settings.label": "Einstellungen",
  "screen.settings.description": "Sprache und App-Einstellungen.",
  "screen.about.label": "Über",
  "screen.about.description": "Version und Lizenzinformationen.",

  "screen.unmet.page": "Öffne eine Confluence-Seite, um diesen Bereich zu nutzen.",
  "screen.unmet.capability.pdfExport": "Diese App kann keine PDFs erzeugen.",
  "screen.unmet.capability.docxExport": "Diese App kann keine Word-Dokumente erzeugen.",
  "screen.unmet.capability.docxTemplateStore": "Diese App kann keine Word-Vorlagen speichern.",
  "screen.unmet.capability.templateLibrary": "Template-Sets gibt es in dieser App noch nicht.",
  "screen.unmet.capability.durableJobs": "Hintergrund-Jobs gibt es in dieser App noch nicht.",
  "screen.unmet.capability.pdfPreview": "Die PDF-Vorschau gibt es in dieser App noch nicht.",
  "screen.unmet.capability.settingsPersistence": "Diese App kann keine Einstellungen speichern.",
  "screen.unavailable.title": "Hier nicht verfügbar",

  "page.idle": "Keine Atlassian-Seite erkannt. Öffne eine Confluence-Seite, um sie zu exportieren.",
  "page.unsupported": "{entity} erkannt. Hier gibt es noch nichts zu exportieren — öffne eine Confluence-Seite oder einen Blogpost.",
  "page.loading": "Seite wird geladen…",
  "page.retry": "Erneut versuchen",
  "page.reload": "Neu laden",
  "page.error.notLoggedIn": "Du scheinst an dieser Atlassian-Site nicht angemeldet zu sein.",
  "page.error.accessDenied": "Du hast keinen Zugriff auf diese Seite (oder sie wurde gelöscht).",
  "page.error.network": "Netzwerkfehler beim Zugriff auf Confluence.",
  "page.error.unknown": "Beim Laden dieser Seite ist etwas schiefgegangen.",
  "page.error.loginHint": "Melde dich in diesem Tab bei {host} an und versuche es erneut.",
  "page.meta.space": "Space",
  "page.meta.version": "Version",
  "page.meta.modified": "Geändert",
  "page.meta.words": "Wörter",
  "page.meta.attachments": "Anhänge",
  "page.attachments.summary": "Anhänge ({count})",

  "entity.confluence.space": "Confluence-Space {spaceKey}",
  "entity.confluence.content": "Confluence-Inhalt",
  "entity.jira.issue": "Jira-Vorgang {issueKey}",
  "entity.jira.board": "Jira-Board {projectKey}",

  "pdf.title": "PDF-Export",
  "pdf.builtIn": "Nutzt das eingebaute atlcli-Dokumentdesign. Kein Template-Upload nötig.",
  "pdf.export": "Als PDF exportieren",
  "pdf.cancel": "Abbrechen",
  "pdf.needsPage": "Öffne eine Confluence-Seite, um zu exportieren.",
  "pdf.phase.preparing": "Inhalt wird vorbereitet…",
  "pdf.phase.fetching": "Anhänge werden geladen…",
  "pdf.phase.queued": "Wartet auf den PDF-Compiler…",
  "pdf.phase.compiling": "PDF wird kompiliert…",
  "pdf.phase.validating": "PDF wird geprüft…",
  "pdf.phase.downloading": "Wird heruntergeladen…",
  "pdf.cancelled": "Der PDF-Export wurde abgebrochen.",
  "pdf.report.summary": "{images} Bild(er) · {diagrams} Diagramm(e)",
  "pdf.report.timings": "Vorbereiten {prepare} · Kompilieren {compile} · Download {emit}",
  "pdf.report.timingsLabel": "Zeitaufteilung des PDF-Exports",
  "pdf.report.notes": "{count} Hinweis(e)",

  "preview.title": "PDF-Vorschau",
  "preview.generate": "Vorschau erzeugen",
  "preview.refresh": "Vorschau aktualisieren",
  "preview.auto": "Automatisch aktualisieren",
  "preview.autoHelp": "Kompiliert kurz nach einer Einstellungsänderung neu. Standardmäßig aus, damit ein Export nie auf eine Vorschau wartet.",
  "preview.needsPage": "Öffne eine Confluence-Seite, um sie in der Vorschau zu sehen.",
  "preview.compiling": "Vorschau wird kompiliert…",
  "preview.empty": "Noch keine Vorschau.",
  "preview.publishedOnly": "Die Vorschau zeigt die zuletzt veröffentlichte Version der Seite — keine ungespeicherten Änderungen im Editor.",
  "preview.scope.full": "Vorschau — vollständiges Dokument",
  "preview.scope.truncated": "Vorschau — erste {included} von {total} Kapiteln",
  "preview.truncatedDownloadHint": "Eine gekürzte Vorschau kann nicht heruntergeladen werden. Der Download kompiliert das vollständige Dokument.",
  "preview.page": "Seite {current} von {total}",
  "preview.previousPage": "Vorherige Seite",
  "preview.nextPage": "Nächste Seite",
  "preview.zoomIn": "Vergrößern",
  "preview.zoomOut": "Verkleinern",
  "preview.fitWidth": "Breite anpassen",
  "preview.openLarge": "Große Vorschau öffnen",
  "preview.failed": "Die Vorschau konnte nicht kompiliert werden: {message}",
  "preview.diagnostics": "Compiler-Meldungen ({count})",

  "docx.title": "Word-Vorlage",
  "docx.upload": ".docx-Vorlage hochladen",
  "docx.scanning": "Wird geprüft…",
  "docx.replace": "Ersetzen",
  "docx.delete": "Löschen",
  "docx.export": "Als Word exportieren",
  "docx.exporting": "Wird exportiert…",
  "docx.needsPage": "Öffne eine Seite, um zu exportieren.",
  "docx.error.notDocx": "Bitte wähle eine .docx-Datei.",
  "docx.error.tooLarge": "Die Vorlage überschreitet das Limit von {limit} MB.",
  "docx.error.notZip": "Diese Datei ist keine gültige .docx (kein ZIP).",
  "docx.error.notWord": "Dieses ZIP ist kein Word-Dokument.",
  "docx.error.engineTooLarge": "Diese Vorlage ist zu groß.",
  "docx.error.read": "Die Vorlage konnte nicht gelesen werden: {message}",
  "docx.error.render": "Die Word-Vorlage konnte nicht gerendert werden{details}. Prüfe die Vorlage auf verirrte Steuerzeichen.",
  "docx.error.exportFailed": "Export fehlgeschlagen: {message}",
  "docx.error.storedUnreadable": "Die gespeicherte Vorlage konnte nicht gelesen werden. Bitte lade sie erneut hoch.",
  "docx.scan.none": "Keine Scroll-Platzhalter gefunden.",
  "docx.scan.supported": "Unterstützt",
  "docx.scan.willBeEmpty": "Bleibt leer",
  "docx.scan.notSupported": "Nicht unterstützt",
  "docx.scan.contentFound": "Einfügepunkt für den Inhalt: ✓ gefunden ($scroll.content)",
  "docx.scan.contentMissing": "Kein $scroll.content gefunden — der Seiteninhalt wird vor dem letzten Abschnittswechsel angehängt.",
  "docx.report.title": "Export abgeschlossen",
  "docx.report.resolved": "{count} Platzhalter aufgelöst",
  "docx.report.unsupported": "{count} nicht unterstützt: {names}",
  "docx.report.embeddedImages": "{count} Bild(er) eingebettet",
  "docx.report.renderedDiagrams": "{count} Diagramm(e) gerendert",
  "docx.report.skippedImages": "{count} Bild(er) übersprungen (siehe Hinweise)",
  "docx.report.duration": "{ms} ms",
  "docx.report.warnings": "Warnungen ({count})",
  "docx.report.notes": "Hinweise ({count})",

  "settings.title": "Einstellungen",
  "settings.language.label": "Sprache",
  "settings.language.help": "Gilt nur für diese App. Exportierte Dokumente behalten die Sprache der Seite.",
  "settings.language.system": "Browsersprache folgen",
  "settings.language.en": "English",
  "settings.language.de": "Deutsch",
  "settings.saveFailed": "Die Einstellungen konnten nicht gespeichert werden.",

  "about.title": "Über",
  "about.host": "Host",
  "about.capabilities": "Fähigkeiten",
  "about.licence": "Apache-2.0. Exporte laufen vollständig in diesem Browser.",

  "placeholder.comingSoon": "Kommt bald",
  "placeholder.templates": "Hier entstehen benannte Template-Sets mit globalem und Space-Geltungsbereich.",
  "placeholder.activity": "Hier werden laufende und abgeschlossene Export-Jobs aufgelistet.",
};

/** All shipped catalogues, keyed by locale. */
export const CATALOGS: Record<Locale, MessageCatalog> = { en, de };

/** The locale used when nothing else resolves, and the source of `MessageKey`. */
export const FALLBACK_LOCALE: Locale = "en";

/** Type guard for a supported locale tag. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Pick the best supported locale for a list of BCP-47 candidates.
 *
 * Matches the primary subtag only (`de-AT` → `de`), which is all this app
 * distinguishes; unknown candidates are skipped rather than failing, so a
 * caller can pass `[stored, navigator.language, ...navigator.languages]`
 * straight through.
 */
export function resolveLocale(candidates: readonly (string | null | undefined)[]): Locale {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const primary = candidate.split("-")[0]?.toLowerCase();
    if (isLocale(primary)) return primary;
  }
  return FALLBACK_LOCALE;
}

/** Values substitutable into a `{placeholder}`. */
export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * Resolve one message.
 *
 * Falls back to `en` for a locale that somehow lacks the key (defensive — the
 * type system already forbids it) and finally to the key itself, so a missing
 * translation degrades to something greppable instead of "undefined".
 * Unmatched `{placeholders}` are left verbatim for the same reason.
 */
export function translate(
  locale: Locale,
  key: MessageKey,
  params?: MessageParams
): string {
  const template = CATALOGS[locale]?.[key] ?? CATALOGS[FALLBACK_LOCALE][key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
