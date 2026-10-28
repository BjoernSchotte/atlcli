/**
 * Research interruption cards (sidebar redesign, 2026-10).
 *
 * The five durable review surfaces — scope expansion, scope-plan, deep-run
 * clarifications, plan replacement and scope clarification — extracted
 * verbatim from `ResearchScreen.tsx`. Presentation only: every decision is a
 * callback the screen owns, and the free-text/selection drafts stay screen
 * state so a card re-render never loses an answer in progress.
 */
import React, { type Dispatch, type SetStateAction } from "react";
import type {
  ResearchSessionClarificationReviewV1,
  ResearchSessionPlanReviewV1,
  ResearchSessionScopeClarificationReviewV1,
  ResearchSessionScopeReviewV1,
} from "@atlcli/research";
import { useT } from "../../utils/i18n/context.js";
import { Button } from "../ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card.js";
import { Label, Select } from "../ui/field.js";
import {
  MICROS_PER_USD,
  clarificationAnswerKey,
  clarificationDecisionKey,
  scopeClarificationSelectionKey,
  type ResearchInteractionMode,
} from "./model.js";

/** Scope keys as the screen displays them (personal spaces get a label). */
export type DisplayScopeKeys = (
  keys: readonly string[],
  product: "jira" | "confluence",
) => string;

export interface ResearchReviewCardsProps {
  displayScopeKeys: DisplayScopeKeys;
  interactionMode: ResearchInteractionMode;
  running: boolean;
  scopeReviews: readonly ResearchSessionScopeReviewV1[];
  scopeReviewActionId: string | null;
  decideScopeReview: (
    review: ResearchSessionScopeReviewV1,
    proposal: ResearchSessionScopeReviewV1["turn"]["expansionProposals"][number],
    decision: "approve" | "reject",
  ) => Promise<void>;
  scopePlanReviews: readonly ResearchSessionScopeReviewV1[];
  scopePlanReviewActionId: string | null;
  approveScopePlanReview: (review: ResearchSessionScopeReviewV1) => Promise<void>;
  clarificationReviews: readonly ResearchSessionClarificationReviewV1[];
  clarificationActionId: string | null;
  clarificationAnswers: Record<string, string>;
  setClarificationAnswers: Dispatch<SetStateAction<Record<string, string>>>;
  clarificationDecisions: Record<string, "accepted" | "rejected" | "">;
  setClarificationDecisions: Dispatch<SetStateAction<Record<string, "accepted" | "rejected" | "">>>;
  resolveClarificationReview: (review: ResearchSessionClarificationReviewV1) => Promise<void>;
  continueClarificationReview: (review: ResearchSessionClarificationReviewV1) => Promise<void>;
  planReviews: readonly ResearchSessionPlanReviewV1[];
  planReviewActionId: string | null;
  planRevisionInstructions: Record<string, string>;
  setPlanRevisionInstructions: Dispatch<SetStateAction<Record<string, string>>>;
  approvePlanReview: (review: ResearchSessionPlanReviewV1) => Promise<void>;
  rejectPlanReview: (review: ResearchSessionPlanReviewV1) => Promise<void>;
}

export function ResearchReviewCards({
  displayScopeKeys,
  interactionMode,
  running,
  scopeReviews,
  scopeReviewActionId,
  decideScopeReview,
  scopePlanReviews,
  scopePlanReviewActionId,
  approveScopePlanReview,
  clarificationReviews,
  clarificationActionId,
  clarificationAnswers,
  setClarificationAnswers,
  clarificationDecisions,
  setClarificationDecisions,
  resolveClarificationReview,
  continueClarificationReview,
  planReviews,
  planReviewActionId,
  planRevisionInstructions,
  setPlanRevisionInstructions,
  approvePlanReview,
  rejectPlanReview,
}: ResearchReviewCardsProps): React.JSX.Element {
  const t = useT();
  return (
    <>
{scopeReviews.length > 0 && (
  <Card data-testid="research-scope-reviews">
    <CardHeader>
      <CardTitle>{t("research.scopeReview.title")}</CardTitle>
    </CardHeader>
    <CardContent className="flex flex-col gap-3">
      {scopeReviews.flatMap((review, reviewIndex) => review.turn.expansionProposals
        .filter((proposal) => proposal.status === "proposed")
        .map((proposal, proposalIndex) => {
          const candidate = review.turn.candidates.find(
            (entry) => entry.id === proposal.candidateId,
          );
          const actionId = `${review.sessionId}:${proposal.id}`;
          const deciding = scopeReviewActionId === actionId;
          return (
            <div
              key={proposal.id}
              className="rounded-md border p-2 text-xs"
              data-testid={`research-scope-review-${reviewIndex}-${proposalIndex}`}
            >
              <p className="m-0 font-medium">
                {candidate
                  ? t("research.scopeReview.candidate", {
                    product: candidate.product,
                    scope: candidate.key ?? candidate.name,
                  })
                  : t("research.scopeReview.unknownCandidate")}
              </p>
              <p className="mb-0 mt-1 text-muted-foreground">
                {t("research.scopeReview.kind", { kind: proposal.expansionKind })}
              </p>
              <p className="mb-0 mt-1 text-muted-foreground">{proposal.reason}</p>
              <p className="mb-0 mt-1 text-muted-foreground">
                {t("research.scopeReview.revision", {
                  brief: String(review.turn.briefRevision),
                  graph: String(review.turn.graphRevision),
                })}
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  disabled={running || scopeReviewActionId !== null}
                  data-testid={`research-scope-review-approve-${reviewIndex}-${proposalIndex}`}
                  onClick={() => void decideScopeReview(review, proposal, "approve")}
                >
                  {deciding ? t("research.scopeReview.deciding") : t("research.scopeReview.approve")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={running || scopeReviewActionId !== null}
                  data-testid={`research-scope-review-reject-${reviewIndex}-${proposalIndex}`}
                  onClick={() => void decideScopeReview(review, proposal, "reject")}
                >
                  {t("research.scopeReview.reject")}
                </Button>
              </div>
            </div>
          );
        }))}
    </CardContent>
  </Card>
)}

{scopePlanReviews.length > 0 && (
  <Card data-testid="research-scope-plan-reviews">
    <CardHeader>
      <CardTitle>{t("research.scopePlanReview.title")}</CardTitle>
    </CardHeader>
    <CardContent className="flex flex-col gap-3">
      {scopePlanReviews.flatMap((review, reviewIndex) => {
        const scopeRevision = review.turn.scopeRevisions.find((revision) =>
          revision.state === "proposed" &&
          revision.proposedGraphRevision === review.turn.graphRevision,
        );
        if (!scopeRevision) return [];
        const deciding = scopePlanReviewActionId === review.sessionId;
        return [(
          <div
            key={review.sessionId}
            className="rounded-md border p-2 text-xs"
            data-testid={`research-scope-plan-review-${reviewIndex}`}
          >
            <p className="m-0 font-medium">
              {t("research.scopePlanReview.value", {
                brief: String(review.turn.briefRevision),
                graph: String(review.turn.graphRevision),
              })}
            </p>
            <p className="mb-0 mt-1 text-muted-foreground">
              {t("research.scopePlanReview.scope", {
                scopes: review.turn.bindings
                  .filter((binding) => binding.authority === "approved")
                  .map((binding) => binding.key ?? binding.name)
                  .join(", ") || "—",
              })}
            </p>
            {scopeRevision.planDiff?.addedRoleIds.length ? (
              <p className="mb-0 mt-1 text-muted-foreground">
                {t("research.scopePlanReview.roles", {
                  roles: scopeRevision.planDiff.addedRoleIds.join(", "),
                })}
              </p>
            ) : null}
            {scopeRevision.planDiff?.addedCapabilityIds.length ? (
              <p className="mb-0 mt-1 text-muted-foreground">
                {t("research.scopePlanReview.capabilities", {
                  capabilities: scopeRevision.planDiff.addedCapabilityIds.join(", "),
                })}
              </p>
            ) : null}
            <p className="mb-0 mt-1 text-muted-foreground">
              {t("research.scopePlanReview.noRetrieval")}
            </p>
            <Button
              className="mt-2"
              size="sm"
              disabled={running || scopePlanReviewActionId !== null}
              data-testid={`research-scope-plan-review-approve-${reviewIndex}`}
              onClick={() => void approveScopePlanReview(review)}
            >
              {deciding
                ? t("research.scopePlanReview.deciding")
                : t("research.scopePlanReview.approve")}
            </Button>
          </div>
        )];
      })}
    </CardContent>
  </Card>
)}

{interactionMode === "deep" && clarificationReviews.length > 0 && (
  <Card data-testid="research-clarification-reviews">
    <CardHeader>
      <CardTitle>{t("research.clarificationReview.title")}</CardTitle>
    </CardHeader>
    <CardContent className="flex flex-col gap-3">
      {clarificationReviews.map((review, index) => {
        const deciding = clarificationActionId === `${review.sessionId}:${review.revision}`;
        const answersReady = review.stage !== "answer_required" || review.turn.questions.every(
          (question) => (clarificationAnswers[clarificationAnswerKey(review, question.id)] ?? "").trim(),
        );
        const decisionsReady = review.stage !== "answer_required" || review.turn.assumptions.every(
          (assumption) => {
            const decision = clarificationDecisions[clarificationDecisionKey(review, assumption.id)];
            return decision === "accepted" || decision === "rejected";
          },
        );
        return (
          <div
            key={review.sessionId}
            className="rounded-md border p-2 text-xs"
            data-testid={`research-clarification-review-${index}`}
          >
            <p className="m-0 font-medium">
              {t("research.clarificationReview.value", {
                brief: String(review.turn.briefRevision),
              })}
            </p>
            <p className="mb-0 mt-1 text-muted-foreground">
              {t("research.clarificationReview.scope", {
                jira: displayScopeKeys(review.turn.scope.jiraProjectKeys, "jira"),
                confluence: displayScopeKeys(review.turn.scope.confluenceSpaceKeys, "confluence"),
              })}
            </p>
            {review.stage === "answer_required" ? (
              <div className="mt-2 flex flex-col gap-3">
                {review.turn.questions.map((question) => {
                  const key = clarificationAnswerKey(review, question.id);
                  return (
                    <div key={question.id} className="flex flex-col gap-1">
                      <Label htmlFor={`research-clarification-answer-${index}-${question.id}`}>
                        {question.prompt}
                      </Label>
                      <textarea
                        id={`research-clarification-answer-${index}-${question.id}`}
                        data-testid={`research-clarification-answer-${index}-${question.id}`}
                        className="min-h-20 w-full resize-y rounded-md border bg-background px-2.5 py-2 text-sm text-foreground"
                        value={clarificationAnswers[key] ?? ""}
                        maxLength={2_000}
                        disabled={running || deciding}
                        onChange={(event) => setClarificationAnswers((current) => ({
                          ...current,
                          [key]: event.target.value,
                        }))}
                      />
                    </div>
                  );
                })}
                {review.turn.assumptions.map((assumption) => {
                  const key = clarificationDecisionKey(review, assumption.id);
                  return (
                    <div key={assumption.id} className="flex flex-col gap-1">
                      <Label htmlFor={`research-clarification-assumption-${index}-${assumption.id}`}>
                        {assumption.text}
                      </Label>
                      <Select
                        id={`research-clarification-assumption-${index}-${assumption.id}`}
                        data-testid={`research-clarification-assumption-${index}-${assumption.id}`}
                        value={clarificationDecisions[key] ?? ""}
                        disabled={running || deciding}
                        onChange={(event) => setClarificationDecisions((current) => ({
                          ...current,
                          [key]: event.target.value as "accepted" | "rejected" | "",
                        }))}
                      >
                        <option value="">{t("research.clarificationReview.decisionPlaceholder")}</option>
                        <option value="accepted">{t("research.clarificationReview.accept")}</option>
                        <option value="rejected">{t("research.clarificationReview.reject")}</option>
                      </Select>
                    </div>
                  );
                })}
                <p className="mb-0 text-muted-foreground">
                  {t("research.clarificationReview.noRetrieval")}
                </p>
                <Button
                  size="sm"
                  disabled={running || deciding || !answersReady || !decisionsReady}
                  data-testid={`research-clarification-resolve-${index}`}
                  onClick={() => void resolveClarificationReview(review)}
                >
                  {deciding
                    ? t("research.clarificationReview.deciding")
                    : t("research.clarificationReview.resolve")}
                </Button>
              </div>
            ) : (
              <div className="mt-2 flex flex-col gap-2">
                <p className="mb-0 text-muted-foreground">
                  {t("research.clarificationReview.planRequired")}
                </p>
                <Button
                  size="sm"
                  disabled={running || deciding}
                  data-testid={`research-clarification-continue-${index}`}
                  onClick={() => void continueClarificationReview(review)}
                >
                  {deciding
                    ? t("research.clarificationReview.deciding")
                    : t("research.clarificationReview.continue")}
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </CardContent>
  </Card>
)}

{interactionMode === "deep" && planReviews.length > 0 && (
  <Card data-testid="research-plan-reviews">
    <CardHeader>
      <CardTitle>{t("research.planReview.title")}</CardTitle>
    </CardHeader>
    <CardContent className="flex flex-col gap-3">
      {planReviews.map((review, index) => {
        const deciding = planReviewActionId === review.sessionId;
        const timeWindow = review.turn.timeWindow;
        const bindings = review.turn.scopeBindings?.map((binding) => [
          `${binding.product}/${binding.entityKind}`,
          binding.key ?? binding.name,
          `(${binding.authority}, ${binding.source})`,
        ].join(" ")).join(", ") ?? "—";
        const coverageTargets = review.turn.coverageTargets?.map((target) =>
          `${target.id} [${target.sourceClasses.join("/")}; ≥${target.minimumDistinctSources}]`,
        ).join(", ") ?? "—";
        const replanEnvelope = review.turn.replanEnvelope;
        return (
          <div
            key={review.sessionId}
            className="rounded-md border p-2 text-xs"
            data-testid={`research-plan-review-${index}`}
          >
            <p className="m-0 font-medium">
              {t("research.planReview.value", {
                effort: review.turn.resolvedEffort,
                brief: String(review.turn.briefRevision),
                graph: String(review.turn.graphRevision),
              })}
            </p>
            <p className="mb-0 mt-1 text-muted-foreground">
              {t("research.planReview.roles", {
                roles: review.turn.selectedRoleIds.join(", "),
              })}
            </p>
            <p className="mb-0 mt-1 text-muted-foreground">
              {t("research.planReview.scope", {
                jira: displayScopeKeys(review.turn.scope.jiraProjectKeys, "jira"),
                confluence: displayScopeKeys(review.turn.scope.confluenceSpaceKeys, "confluence"),
              })}
            </p>
            {timeWindow && (
              <p className="mb-0 mt-1 text-muted-foreground" data-testid={`research-plan-review-time-window-${index}`}>
                {t("research.planReview.timeWindow", {
                  from: timeWindow.from ?? "—",
                  to: timeWindow.to ?? "—",
                })}
              </p>
            )}
            {review.turn.scopeBindings && (
              <p className="mb-0 mt-1 text-muted-foreground" data-testid={`research-plan-review-bindings-${index}`}>
                {t("research.planReview.bindings", { bindings })}
              </p>
            )}
            {review.turn.coverageTargets && (
              <p className="mb-0 mt-1 text-muted-foreground" data-testid={`research-plan-review-coverage-${index}`}>
                {t("research.planReview.coverage", { targets: coverageTargets })}
              </p>
            )}
            {replanEnvelope && (
              <p className="mb-0 mt-1 text-muted-foreground" data-testid={`research-plan-review-replan-envelope-${index}`}>
                {t("research.planReview.replanEnvelope", {
                  roles: replanEnvelope.optionalRoleIds.join(", ") || "—",
                  capabilities: replanEnvelope.allowedCapabilityIds.join(", ") || "—",
                  parallel: String(replanEnvelope.maxParallelNodes),
                  waves: String(replanEnvelope.maxResearchWaves),
                  reconciliationWaves: String(replanEnvelope.maxReconciliationWaves),
                })}
              </p>
            )}
            <p className="mb-0 mt-1 text-muted-foreground" data-testid={`research-plan-review-budget-${index}`}>
              {t("research.planReview.budget", {
                ptc: String(review.turn.budget.maxPtcCalls),
                http: String(review.turn.budget.maxHttpCalls),
                modelCalls: String(review.turn.budget.maxModelCalls ?? "—"),
                tokens: String(
                  review.turn.budget.maxTotalModelInputTokens + review.turn.budget.maxTotalModelOutputTokens,
                ),
                cost: `$${(review.turn.budget.maxModelCostMicros / MICROS_PER_USD).toFixed(2)}`,
                minutes: String(Math.ceil(review.turn.budget.maxRunMs / 60_000)),
              })}
            </p>
            <p className="mb-0 mt-1 text-muted-foreground">
              {t("research.planReview.noRetrieval")}
            </p>
            <Label className="mt-2 block" htmlFor={`research-plan-review-correction-${index}`}>
              {t("research.planReview.correction")}
            </Label>
            <textarea
              id={`research-plan-review-correction-${index}`}
              className="mt-1 w-full rounded-md border bg-background p-2 text-xs"
              rows={3}
              maxLength={2_000}
              disabled={running || planReviewActionId !== null}
              data-testid={`research-plan-review-correction-${index}`}
              placeholder={t("research.planReview.correctionPlaceholder")}
              value={planRevisionInstructions[review.sessionId] ?? ""}
              onChange={(event) => setPlanRevisionInstructions((current) => ({
                ...current,
                [review.sessionId]: event.target.value,
              }))}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={running || planReviewActionId !== null}
                data-testid={`research-plan-review-approve-${index}`}
                onClick={() => void approvePlanReview(review)}
              >
                {deciding ? t("research.planReview.deciding") : t("research.planReview.approve")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={running || planReviewActionId !== null ||
                  !(planRevisionInstructions[review.sessionId]?.trim())}
                data-testid={`research-plan-review-revise-${index}`}
                onClick={() => void rejectPlanReview(review)}
              >
                {deciding ? t("research.planReview.deciding") : t("research.planReview.revise")}
              </Button>
            </div>
          </div>
        );
      })}
    </CardContent>
  </Card>
)}

    </>
  );
}

export interface ResearchScopeClarificationCardsProps {
  displayScopeKeys: DisplayScopeKeys;
  running: boolean;
  scopeClarificationReviews: readonly ResearchSessionScopeClarificationReviewV1[];
  scopeClarificationActionId: string | null;
  scopeClarificationSelections: Record<string, string>;
  setScopeClarificationSelections: Dispatch<SetStateAction<Record<string, string>>>;
  resolveScopeClarificationReview: (review: ResearchSessionScopeClarificationReviewV1) => Promise<void>;
  continueScopeClarificationReview: (review: ResearchSessionScopeClarificationReviewV1) => Promise<void>;
}

export function ResearchScopeClarificationCards({
  displayScopeKeys,
  running,
  scopeClarificationReviews,
  scopeClarificationActionId,
  scopeClarificationSelections,
  setScopeClarificationSelections,
  resolveScopeClarificationReview,
  continueScopeClarificationReview,
}: ResearchScopeClarificationCardsProps): React.JSX.Element {
  const t = useT();
  return (
    <>
{scopeClarificationReviews.length > 0 && (
  <Card data-testid="research-scope-clarification-reviews">
    <CardHeader>
      <CardTitle>{t("research.scopeClarification")}</CardTitle>
    </CardHeader>
    <CardContent className="flex flex-col gap-3">
      {scopeClarificationReviews.map((review, index) => {
        const actionId = scopeClarificationSelectionKey(review);
        const deciding = scopeClarificationActionId === actionId;
        const selectedCandidateId = scopeClarificationSelections[actionId] ?? "";
        return (
          <div
            key={review.sessionId}
            className="rounded-md border p-2 text-xs"
            data-testid={`research-scope-clarification-review-${index}`}
          >
            <p className="m-0 text-muted-foreground">
              {t("research.scopeClarification.value", {
                reason: review.clarification.reason,
              })}
            </p>
            {review.stage === "choice_required" && review.clarification.candidates.length > 0 && (
              <div className="mt-2 flex flex-col gap-2">
                <Label htmlFor={`research-scope-clarification-picker-${index}`}>
                  {t("research.scopeClarification.choose")}
                </Label>
                <Select
                  id={`research-scope-clarification-picker-${index}`}
                  data-testid={`research-scope-clarification-picker-${index}`}
                  value={selectedCandidateId}
                  disabled={running || deciding}
                  onChange={(event) => setScopeClarificationSelections((current) => ({
                    ...current,
                    [actionId]: event.target.value,
                  }))}
                >
                  <option value="">{t("research.scopeClarification.placeholder")}</option>
                  {review.clarification.candidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.product}: {candidate.name}
                      {candidate.key ? ` (${candidate.key})` : ""}
                      {candidate.status === "archived" ? " — archived" : ""}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  disabled={running || deciding || !selectedCandidateId}
                  data-testid={`research-scope-clarification-resolve-${index}`}
                  onClick={() => void resolveScopeClarificationReview(review)}
                >
                  {deciding
                    ? t("research.clarificationReview.deciding")
                    : t("research.scopeClarification.continue")}
                </Button>
              </div>
            )}
            {review.stage !== "choice_required" && (
              <div className="mt-2 flex flex-col gap-2">
                <p className="mb-0 text-muted-foreground">
                  {t("research.clarificationReview.noRetrieval")}
                </p>
                <Button
                  size="sm"
                  disabled={running || deciding}
                  data-testid={`research-scope-clarification-continue-${index}`}
                  onClick={() => void continueScopeClarificationReview(review)}
                >
                  {deciding
                    ? t("research.clarificationReview.deciding")
                    : t("research.scopeClarification.continue")}
                </Button>
              </div>
            )}
            <ul className="mb-0 mt-2 pl-5 text-muted-foreground">
              {review.clarification.rerunGuidance.map((guidance) => (
                <li key={guidance}>{guidance}</li>
              ))}
            </ul>
          </div>
        );
      })}
    </CardContent>
  </Card>
)}

    </>
  );
}
