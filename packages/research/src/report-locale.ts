import type { ResearchReportLanguageV1 } from "./contracts.js";

export interface ResearchReportCopyV1 {
  question: string;
  executiveSummary: string;
  sources: string;
  limitations: string;
  run: string;
  sourceLabel: string;
  focus: string;
  none: string;
  model: string;
  confluenceProvider: string;
  complete: string;
  yes: string;
  no: string;
  duration: string;
  calls: string;
  items: string;
  inputTokens: string;
  outputTokens: string;
  warnings: string;
  evidenceCoverage: string;
  reconciliationDecisions: string;
  sourceAccessAuthority: string;
  wholeScope: string;
  exactEntity: string;
}

const ENGLISH: ResearchReportCopyV1 = {
  question: "Question",
  executiveSummary: "Executive summary",
  sources: "Sources",
  limitations: "Limitations",
  run: "Run",
  sourceLabel: "Sources",
  focus: "Focus",
  none: "_None reported._",
  model: "Model",
  confluenceProvider: "Confluence provider",
  complete: "Complete",
  yes: "yes",
  no: "no",
  duration: "Duration",
  calls: "Calls",
  items: "Items",
  inputTokens: "Input tokens",
  outputTokens: "Output tokens",
  warnings: "Warnings",
  evidenceCoverage: "Evidence coverage",
  reconciliationDecisions: "Reconciliation decisions",
  sourceAccessAuthority: "Source access authority",
  wholeScope: "whole scope",
  exactEntity: "exact entity",
};

const GERMAN: ResearchReportCopyV1 = {
  question: "Frage",
  executiveSummary: "Zusammenfassung",
  sources: "Quellen",
  limitations: "Einschränkungen",
  run: "Laufdaten",
  sourceLabel: "Quellen",
  focus: "Fokus",
  none: "_Keine angegeben._",
  model: "Modell",
  confluenceProvider: "Confluence-Anbieter",
  complete: "Vollständig",
  yes: "ja",
  no: "nein",
  duration: "Laufzeit",
  calls: "Aufrufe",
  items: "Elemente",
  inputTokens: "Eingabe-Token",
  outputTokens: "Ausgabe-Token",
  warnings: "Warnungen",
  evidenceCoverage: "Evidenzabdeckung",
  reconciliationDecisions: "Abgleichentscheidungen",
  sourceAccessAuthority: "Zugriffsbereich der Quellen",
  wholeScope: "vollständiger Bereich",
  exactEntity: "genaues Element",
};

export function researchReportCopyV1(language: ResearchReportLanguageV1 | undefined): ResearchReportCopyV1 {
  return language === "de" ? GERMAN : ENGLISH;
}

/** Translate host-authored limits only; model-authored text remains evidence content. */
export function localizeResearchLimitationV1(
  language: ResearchReportLanguageV1 | undefined,
  limitation: string,
): string {
  if (language !== "de") return limitation;
  const searchIndex = /^(Jira|Confluence) candidate discovery uses its native search index at retrieval time; recently changed or not-yet-indexed records may be absent\.$/.exec(limitation);
  if (searchIndex) {
    return `Die Kandidatensuche in ${searchIndex[1]} verwendet den nativen Suchindex zum Abrufzeitpunkt; kürzlich geänderte oder noch nicht indexierte Datensätze können fehlen.`;
  }
  const detailBoundary = /^(\d+) of (\d+) discovered (Jira|Confluence) candidates were read in detail within the bounded retrieval budget; undetailed candidates were not used as evidence\.$/.exec(limitation);
  if (detailBoundary) {
    return `${detailBoundary[1]} von ${detailBoundary[2]} gefundenen ${detailBoundary[3]}-Kandidaten wurden innerhalb des begrenzten Abrufbudgets detailliert gelesen; nicht detailliert gelesene Kandidaten wurden nicht als Evidenz verwendet.`;
  }
  if (limitation === "Only fields returned by the approved read-only capabilities were evaluated; unavailable fields were not inferred.") {
    return "Es wurden nur Felder der erlaubten, schreibgeschützten Fähigkeiten ausgewertet; nicht verfügbare Felder wurden nicht hergeleitet.";
  }
  if (limitation === "The admitted Jira search returned no items in the approved scope.") {
    return "Die zugelassene Jira-Suche lieferte im genehmigten Bereich keine Elemente.";
  }
  if (limitation === "The admitted Confluence search returned no items in the approved scope.") {
    return "Die zugelassene Confluence-Suche lieferte im genehmigten Bereich keine Elemente.";
  }
  if (limitation === "A selected claim was excluded because its evidence is no longer current.") {
    return "Ein ausgewählter Befund wurde ausgeschlossen, weil seine Evidenz nicht mehr aktuell ist.";
  }
  return limitation;
}

export function localizeResearchSectionTitleV1(
  language: ResearchReportLanguageV1 | undefined,
  title: string,
): string {
  if (language !== "de") return title;
  if (title === "Evidence-backed findings") return "Direkt belegte Befunde";
  if (title === "Additional validated findings") return "Weitere validierte Befunde";
  return title;
}

export function localizeResearchSectionQuestionV1(
  language: ResearchReportLanguageV1 | undefined,
  question: string,
): string {
  if (language !== "de") return question;
  if (question === "What do the currently validated claims establish?") {
    return "Was belegen die derzeit validierten Befunde?";
  }
  if (question === "Which validated claims were not assigned to an outline section?") {
    return "Welche validierten Befunde wurden keinem Gliederungsabschnitt zugeordnet?";
  }
  return question;
}
