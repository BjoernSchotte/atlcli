export interface ResearchCandidateRankingInputV1 {
  entityRef: string;
  sourceId: string;
  title: string;
  excerpt?: string;
}

export interface ResearchRankedCandidateV1 {
  entityRef: string;
  sourceId: string;
  rank: number;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "by", "for", "from", "how", "in",
  "is", "it", "of", "on", "or", "that", "the", "this", "to", "what", "which",
  "with", "about", "auf", "aus", "bei", "das", "dem", "den", "der", "des", "die",
  "ein", "eine", "einer", "eines", "für", "im", "in", "ist", "mit", "nach", "oder",
  "über", "und", "von", "was", "welche", "wie", "zu", "zum", "zur",
]);

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function questionTerms(question: string): string[] {
  return [...new Set(
    normalized(question)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length >= 3 && !STOP_WORDS.has(term)),
  )];
}

function quotedPhrases(question: string): string[] {
  return [...new Set(
    [...question.matchAll(/[“"]([^”"]+)[”"]/g)]
      .map((match) => normalized(match[1] ?? "").trim())
      .filter((phrase) => phrase.length >= 3),
  )];
}

function scoreCandidate(
  candidate: ResearchCandidateRankingInputV1,
  terms: readonly string[],
  phrases: readonly string[],
): number {
  const title = normalized(candidate.title);
  const excerpt = normalized(candidate.excerpt ?? "");
  let score = 0;
  for (const [index, phrase] of phrases.entries()) {
    const weight = phrases.length - index;
    if (title.includes(phrase)) score += 100 * weight;
    else if (excerpt.includes(phrase)) score += 40 * weight;
  }
  for (const term of terms) {
    if (title.includes(term)) score += 12;
    else if (excerpt.includes(term)) score += 4;
  }
  return score;
}

/**
 * Deterministically ranks host-retained search summaries for a bound question.
 * It deliberately returns references only: detailed bodies remain inaccessible
 * until the broker admits a ranked opaque reference.
 */
export function rankResearchCandidatesV1(input: {
  question: string;
  candidates: readonly ResearchCandidateRankingInputV1[];
}): ResearchRankedCandidateV1[] {
  const terms = questionTerms(input.question);
  const phrases = quotedPhrases(input.question);
  return input.candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, terms, phrases) }))
    .sort((left, right) =>
      right.score - left.score ||
      (left.candidate.sourceId < right.candidate.sourceId ? -1 : left.candidate.sourceId > right.candidate.sourceId ? 1 : 0) ||
      (left.candidate.entityRef < right.candidate.entityRef ? -1 : left.candidate.entityRef > right.candidate.entityRef ? 1 : 0),
    )
    .map(({ candidate }, index) => ({
      entityRef: candidate.entityRef,
      sourceId: candidate.sourceId,
      rank: index + 1,
    }));
}
