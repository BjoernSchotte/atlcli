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

  "scope.title": "What to export",
  "scope.kind.page": "Current page",
  "scope.kind.tree": "Page + children",
  "scope.kind.space": "Entire space",
  "scope.kind.spaceUnavailable": "This page reports no space, so a whole-space export is not possible here.",
  "scope.depth.label": "Levels below this page",
  "scope.includeRoot.label": "Include this page itself",
  "scope.advanced": "Advanced",
  "scope.labels.include": "Only pages with these labels",
  "scope.labels.includeHelp": "A page is kept when it has any one of them. Empty means every page.",
  "scope.labels.exclude": "Skip pages with these labels",
  "scope.labels.excludeHelp": "A page is skipped when it has any one of them.",
  "scope.labels.placeholder": "internal, draft",
  "scope.labels.remove": "Remove label {label}",
  "scope.excludeMode.label": "What an excluded page takes with it",
  "scope.excludeMode.pruneSubtree": "The page and its children",
  "scope.excludeMode.pruneSubtreeHelp": "Excluded pages take their children with them, even when the children carry no label.",
  "scope.excludeMode.pageOnly": "Only the page itself",
  "scope.excludeMode.pageOnlyHelp": "Children of an excluded page are still exported.",
  "scope.macros.label": "Resolve dynamic macros (contacts Jira/Confluence)",
  "scope.macros.onHelp": "Jira issues and rendered macro content are fetched while exporting.",
  "scope.macros.offHelp": "Off: nothing is fetched, dynamic macros become placeholders, and the export is deterministic.",
  "scope.confirm.title": "Export the whole space {spaceKey}?",
  "scope.confirm.counting": "Counting pages…",
  "scope.confirm.count": "{count} pages, continue?",
  "scope.confirm.unknownCount": "Every page in {spaceKey} will be exported. This can take a while.",
  "scope.confirm.continue": "Continue",
  "scope.confirm.cancel": "Cancel",

  "export.progress": "Page {fetched}/{total}: {title}",

  "settingsForm.title": "Document settings",
  "settingsForm.readOnly": "This template declares settings, but the Word engine cannot apply them yet — shown for information only.",
  "settingsForm.empty": "This template declares no settings.",
  "settingsForm.reset": "Reset to defaults",
  "settingsForm.assetPresent": "File selected",
  "settingsForm.assetClear": "Remove",
  "settingsForm.issue.number": "Enter a number.",
  "settingsForm.issue.range": "That value is outside the allowed range.",
  "settingsForm.issue.color": "Enter a colour like #4B57A3.",
  "settingsForm.issue.option": "Choose one of the offered values.",
  "settingsForm.issue.tooLong": "That text is too long.",
  "settingsForm.issue.assetTooLarge": "That file is too large.",
  "settingsForm.issue.assetUnsupported": "Use a PNG or an SVG.",

  "pdf.settings.page": "Page size",
  "pdf.settings.page.a4": "A4",
  "pdf.settings.page.letter": "Letter",
  "pdf.settings.orientation": "Orientation",
  "pdf.settings.orientation.portrait": "Portrait",
  "pdf.settings.orientation.landscape": "Landscape",
  "pdf.settings.cover": "Cover page",
  "pdf.settings.outline": "Table of contents",
  "pdf.settings.headerText": "Header text",
  "pdf.settings.footerText": "Footer text",
  "pdf.settings.organizationName": "Organisation",
  "pdf.settings.accentColor": "Accent colour",
  "pdf.settings.logo": "Logo (PNG or SVG)",
  "pdf.settings.logoAlt": "Logo alt text",
  "pdf.settings.watermarkText": "Watermark text",
  "pdf.settings.watermarkColor": "Watermark colour",
  "pdf.settings.watermarkOpacity": "Watermark opacity",
  "pdf.settings.watermarkAngle": "Watermark angle",
  "pdf.settings.watermarkSize": "Watermark size",

  "templates.title": "Word templates",
  "templates.docxOnly": "Word templates only. PDF uses the built-in atlcli document design.",
  "templates.manage": "Manage templates",
  "templates.loading": "Loading templates…",
  "templates.empty": "No templates yet. Upload a .docx to get started.",
  "templates.active": "Active",
  "templates.setActive": "Use this one",
  "templates.assignToSpace": "Use in {spaceKey}",
  "templates.assignNeedsSpace": "Open a page in a space to assign a template to it.",
  "templates.check": "Check",
  "templates.checking": "Checking…",
  "templates.scope.global": "Global",
  "templates.scope.space": "{spaceKey}",
  "templates.error.list": "The template library could not be read: {message}",

  // Consumed by `components/screens/JobsScreen.tsx` (T5.6). The copy is
  // deliberately careful about what "background" means: an MV3 export survives
  // navigation, a closed panel and a service-worker restart — it does not
  // survive closing the browser, and CONFCLOUD-83694's server-side durability
  // is not something this extension can offer.
  "jobs.title": "Exports",
  "jobs.empty": "No exports yet.",
  "jobs.untitled": "Untitled export",
  "jobs.cancel": "Cancel",
  "jobs.download": "Download",
  "jobs.dismiss": "Dismiss",
  "jobs.durability": "Exports keep running while you browse and survive closing this panel — but not closing the browser.",
  "jobs.status.queued": "Queued",
  "jobs.status.compiling": "Compiling…",
  "jobs.status.progress": "Page {done}/{total}",
  "jobs.status.complete": "Ready",
  "jobs.status.failed": "Failed",
  "jobs.status.cancelled": "Cancelled",
  "jobs.age.justNow": "just now",
  "jobs.age.minutes": "{minutes} min ago",
  "jobs.age.hours": "{hours} h ago",

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
  "preview.goToPage": "Go to page {page}",
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

  "scope.title": "Was exportiert wird",
  "scope.kind.page": "Aktuelle Seite",
  "scope.kind.tree": "Seite + Unterseiten",
  "scope.kind.space": "Ganzer Space",
  "scope.kind.spaceUnavailable": "Diese Seite meldet keinen Space, ein Export des ganzen Space ist hier nicht möglich.",
  "scope.depth.label": "Ebenen unterhalb dieser Seite",
  "scope.includeRoot.label": "Diese Seite selbst mit exportieren",
  "scope.advanced": "Erweitert",
  "scope.labels.include": "Nur Seiten mit diesen Labels",
  "scope.labels.includeHelp": "Eine Seite bleibt, wenn sie eines davon hat. Leer heißt: alle Seiten.",
  "scope.labels.exclude": "Seiten mit diesen Labels überspringen",
  "scope.labels.excludeHelp": "Eine Seite wird übersprungen, wenn sie eines davon hat.",
  "scope.labels.placeholder": "intern, entwurf",
  "scope.labels.remove": "Label {label} entfernen",
  "scope.excludeMode.label": "Was eine ausgeschlossene Seite mitnimmt",
  "scope.excludeMode.pruneSubtree": "Die Seite und ihre Unterseiten",
  "scope.excludeMode.pruneSubtreeHelp": "Ausgeschlossene Seiten nehmen ihre Unterseiten mit, auch wenn diese kein Label tragen.",
  "scope.excludeMode.pageOnly": "Nur die Seite selbst",
  "scope.excludeMode.pageOnlyHelp": "Unterseiten einer ausgeschlossenen Seite werden trotzdem exportiert.",
  "scope.macros.label": "Dynamische Makros auflösen (fragt Jira/Confluence an)",
  "scope.macros.onHelp": "Jira-Vorgänge und gerenderte Makro-Inhalte werden beim Export geladen.",
  "scope.macros.offHelp": "Aus: nichts wird geladen, dynamische Makros werden zu Platzhaltern, der Export ist reproduzierbar.",
  "scope.confirm.title": "Den ganzen Space {spaceKey} exportieren?",
  "scope.confirm.counting": "Seiten werden gezählt…",
  "scope.confirm.count": "{count} Seiten, fortfahren?",
  "scope.confirm.unknownCount": "Jede Seite in {spaceKey} wird exportiert. Das kann dauern.",
  "scope.confirm.continue": "Fortfahren",
  "scope.confirm.cancel": "Abbrechen",

  "export.progress": "Seite {fetched}/{total}: {title}",

  "settingsForm.title": "Dokumenteinstellungen",
  "settingsForm.readOnly": "Diese Vorlage deklariert Einstellungen, die Word-Engine kann sie aber noch nicht anwenden — nur zur Information.",
  "settingsForm.empty": "Diese Vorlage deklariert keine Einstellungen.",
  "settingsForm.reset": "Auf Standard zurücksetzen",
  "settingsForm.assetPresent": "Datei ausgewählt",
  "settingsForm.assetClear": "Entfernen",
  "settingsForm.issue.number": "Bitte eine Zahl eingeben.",
  "settingsForm.issue.range": "Dieser Wert liegt außerhalb des erlaubten Bereichs.",
  "settingsForm.issue.color": "Bitte eine Farbe wie #4B57A3 eingeben.",
  "settingsForm.issue.option": "Bitte einen der angebotenen Werte wählen.",
  "settingsForm.issue.tooLong": "Dieser Text ist zu lang.",
  "settingsForm.issue.assetTooLarge": "Diese Datei ist zu groß.",
  "settingsForm.issue.assetUnsupported": "Bitte ein PNG oder ein SVG verwenden.",

  "pdf.settings.page": "Seitenformat",
  "pdf.settings.page.a4": "A4",
  "pdf.settings.page.letter": "Letter",
  "pdf.settings.orientation": "Ausrichtung",
  "pdf.settings.orientation.portrait": "Hochformat",
  "pdf.settings.orientation.landscape": "Querformat",
  "pdf.settings.cover": "Titelseite",
  "pdf.settings.outline": "Inhaltsverzeichnis",
  "pdf.settings.headerText": "Kopfzeilentext",
  "pdf.settings.footerText": "Fußzeilentext",
  "pdf.settings.organizationName": "Organisation",
  "pdf.settings.accentColor": "Akzentfarbe",
  "pdf.settings.logo": "Logo (PNG oder SVG)",
  "pdf.settings.logoAlt": "Alternativtext zum Logo",
  "pdf.settings.watermarkText": "Wasserzeichen-Text",
  "pdf.settings.watermarkColor": "Wasserzeichen-Farbe",
  "pdf.settings.watermarkOpacity": "Wasserzeichen-Deckkraft",
  "pdf.settings.watermarkAngle": "Wasserzeichen-Winkel",
  "pdf.settings.watermarkSize": "Wasserzeichen-Größe",

  "templates.title": "Word-Vorlagen",
  "templates.docxOnly": "Nur Word-Vorlagen. PDF nutzt das eingebaute atlcli-Dokumentdesign.",
  "templates.manage": "Vorlagen verwalten",
  "templates.loading": "Vorlagen werden geladen…",
  "templates.empty": "Noch keine Vorlagen. Lade eine .docx hoch, um zu starten.",
  "templates.active": "Aktiv",
  "templates.setActive": "Diese verwenden",
  "templates.assignToSpace": "In {spaceKey} verwenden",
  "templates.assignNeedsSpace": "Öffne eine Seite in einem Space, um ihm eine Vorlage zuzuweisen.",
  "templates.check": "Prüfen",
  "templates.checking": "Wird geprüft…",
  "templates.scope.global": "Global",
  "templates.scope.space": "{spaceKey}",
  "templates.error.list": "Die Vorlagen-Bibliothek konnte nicht gelesen werden: {message}",

  "jobs.title": "Exporte",
  "jobs.empty": "Noch keine Exporte.",
  "jobs.untitled": "Export ohne Titel",
  "jobs.cancel": "Abbrechen",
  "jobs.download": "Herunterladen",
  "jobs.dismiss": "Ausblenden",
  "jobs.durability": "Exporte laufen weiter, während du browst, und überstehen das Schließen dieses Panels — aber nicht das Schließen des Browsers.",
  "jobs.status.queued": "In der Warteschlange",
  "jobs.status.compiling": "Wird kompiliert…",
  "jobs.status.progress": "Seite {done}/{total}",
  "jobs.status.complete": "Fertig",
  "jobs.status.failed": "Fehlgeschlagen",
  "jobs.status.cancelled": "Abgebrochen",
  "jobs.age.justNow": "gerade eben",
  "jobs.age.minutes": "vor {minutes} Min.",
  "jobs.age.hours": "vor {hours} Std.",

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
  "preview.goToPage": "Zu Seite {page}",
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
