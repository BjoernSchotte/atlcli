import type {
  ResearchActivityCodeV1,
  ResearchOneShotEventV1,
} from "@atlcli/research/node";

type Locale = "de" | "en";

const TITLES: Record<ResearchActivityCodeV1, Record<Locale, string>> = {
  strategy: { en: "Selecting the smallest suitable approach", de: "Das kleinste passende Vorgehen wird ausgewählt" },
  "direct-read": { en: "Reading the referenced item", de: "Das referenzierte Element wird gelesen" },
  search: { en: "Searching the approved scope", de: "Im freigegebenen Umfang wird gesucht" },
  "source-selection": { en: "Selecting relevant results", de: "Relevante Treffer werden ausgewählt" },
  "child-work": { en: "Running a focused analysis", de: "Ein fokussierter Analyseschritt läuft" },
  critique: { en: "Checking evidence and draft independently", de: "Belege und Entwurf werden unabhängig geprüft" },
  repair: { en: "Repairing a confirmed answer gap", de: "Eine bestätigte Antwortlücke wird behoben" },
  synthesis: { en: "Writing the supported answer", de: "Die belegte Antwort wird formuliert" },
  gap: { en: "Assessing remaining evidence gaps", de: "Verbleibende Beleglücken werden bewertet" },
  hitl: { en: "Waiting for your decision", de: "Kiteweave wartet auf deine Entscheidung" },
  steering: { en: "Applying your steering message", de: "Deine Nachsteuerung wird angewendet" },
  stop: { en: "Stopping the active work safely", de: "Die laufende Arbeit wird sicher beendet" },
  continuation: { en: "Resuming the saved turn", de: "Der gespeicherte Turn wird fortgesetzt" },
  completion: { en: "Publishing the validated answer", de: "Die validierte Antwort wird bereitgestellt" },
  "model-assessing": { en: "Comparing the question with available evidence", de: "Frage und verfügbare Belege werden abgeglichen" },
  "answer-drafting": { en: "Preparing the answer draft", de: "Der Antwortentwurf wird vorbereitet" },
  "next-step-ready": { en: "The next evidence step is ready", de: "Der nächste Belegschritt steht fest" },
  "answer-draft-ready": { en: "The answer draft is ready for validation", de: "Der Antwortentwurf ist zur Prüfung bereit" },
  "bounded-workflow-running": { en: "Running the selected reading and validation steps", de: "Die ausgewählten Lese- und Prüfschritte laufen" },
  "bounded-workflow-complete": { en: "The reading and validation step is complete", de: "Der Lese- und Prüfschritt ist abgeschlossen" },
  "bounded-workflow-failed": { en: "The reading or validation step failed", de: "Der Lese- oder Prüfschritt ist fehlgeschlagen" },
};

export function formatCliChatActivityV1(
  event: Extract<ResearchOneShotEventV1, { kind: "activity" }>,
  locale: Locale,
): string {
  const marker = event.status === "started" ? "◇" : event.status === "completed" ? "✓" : "!";
  return `${marker} ${TITLES[event.code][locale]}`;
}

export function formatCliChatCapabilityDetailV1(
  event: Extract<ResearchOneShotEventV1, { kind: "capability" }>,
  locale: Locale,
): string | undefined {
  if (event.status === "failed") {
    return locale === "de" ? "Ein freigegebener Lesezugriff ist fehlgeschlagen." : "An approved read failed.";
  }
  if (event.status !== "completed") return undefined;
  const count = event.itemCount ?? 0;
  if (event.toolId === "wiki.search" || event.toolId === "wiki.space.search") {
    return locale === "de"
      ? `${count} Confluence-Treffer gefunden.`
      : `Found ${count} Confluence result${count === 1 ? "" : "s"}.`;
  }
  if (event.toolId === "jira.issue.search" || event.toolId === "jira.project.search") {
    return locale === "de"
      ? `${count} Jira-Treffer gefunden.`
      : `Found ${count} Jira result${count === 1 ? "" : "s"}.`;
  }
  if (event.toolId === "wiki.page.get") {
    return locale === "de" ? "Die Confluence-Seite wurde gelesen." : "The Confluence page was read.";
  }
  if (event.toolId === "jira.issue.get") {
    return locale === "de" ? "Der Jira-Vorgang wurde gelesen." : "The Jira issue was read.";
  }
  if (event.toolId === "atlassian.bound.read" || event.toolId === "atlassian.bound.section.read") {
    return locale === "de" ? "Der mitgegebene Kontext wurde gelesen." : "The attached context was read.";
  }
  return undefined;
}
