/**
 * The detected-page card and the detection status states.
 *
 * The "Markdown preview (debug)" dump that used to sit under this card
 * (`App.tsx:311-329`) is gone: it printed the whole converted document into the
 * 400 px panel to prove the converter ran, which is covered by
 * `packages/confluence`'s own tests. Its eventual home is a Labs screen, not
 * the export surface.
 */
import React from "react";
import type { AtlassianEntity } from "@atlcli/core";
import type { PanelState } from "../../utils/panel-state.js";
import type { ReadErrorKind } from "../../utils/read-path.js";
import { useT } from "../../utils/i18n/context.js";
import type { MessageKey } from "../../utils/i18n/messages.js";
import { Alert } from "../ui/alert.js";
import { Button } from "../ui/button.js";
import { Card, CardContent } from "../ui/card.js";
import { formatBytes } from "./format.js";

const ERROR_KEYS: Record<ReadErrorKind, MessageKey> = {
  "not-logged-in": "page.error.notLoggedIn",
  "access-denied": "page.error.accessDenied",
  network: "page.error.network",
  unknown: "page.error.unknown",
};

/** Host of a URL, for the "log in to <site>" hint. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function PageSummary({
  state,
  onRetry,
}: {
  state: PanelState;
  onRetry: () => void;
}): React.JSX.Element {
  const t = useT();

  switch (state.status) {
    case "idle":
      return (
        <Alert data-testid="state-idle" tone="muted">
          {t("page.idle")}
        </Alert>
      );

    case "unsupported":
      return (
        <Alert data-testid="state-unsupported" tone="muted">
          {t("page.unsupported", { entity: describeEntity(t, state.entity) })}
        </Alert>
      );

    case "loading":
      return (
        <Alert data-testid="state-loading" tone="info">
          {t("page.loading")}
        </Alert>
      );

    case "error":
      return (
        <Alert data-testid="state-error" tone="danger">
          <p className="m-0 mb-2" data-testid={`error-${state.kind}`}>
            {t(ERROR_KEYS[state.kind])}
            {state.kind === "not-logged-in" && (
              <> {t("page.error.loginHint", { host: hostOf(state.ref.url) })}</>
            )}
          </p>
          <Button size="sm" variant="outline" onClick={onRetry} data-testid="retry">
            {t("page.retry")}
          </Button>
        </Alert>
      );

    case "loaded":
      return <LoadedPageCard state={state} onRetry={onRetry} />;
  }
}

function LoadedPageCard({
  state,
  onRetry,
}: {
  state: Extract<PanelState, { status: "loaded" }>;
  onRetry: () => void;
}): React.JSX.Element {
  const t = useT();
  const { details, wordCount, attachments } = state.page;
  const author = details.modifiedBy?.displayName;
  const modified = details.modified ? new Date(details.modified).toLocaleString() : undefined;

  return (
    <Card data-testid="state-loaded">
      <CardContent className="p-3">
        <h2 className="m-0 mb-1.5 text-sm font-semibold" data-testid="loaded-title">
          {details.title}
        </h2>

        <dl className="m-0 mb-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <Meta label={t("page.meta.space")} value={details.spaceKey ?? "—"} testId="loaded-space" />
          <Meta
            label={t("page.meta.version")}
            value={details.version != null ? `v${details.version}` : "—"}
            testId="loaded-version"
          />
          {modified && (
            <Meta
              label={t("page.meta.modified")}
              value={author ? `${modified} · ${author}` : modified}
              testId="loaded-modified"
            />
          )}
          <Meta label={t("page.meta.words")} value={String(wordCount)} testId="loaded-wordcount" />
          <Meta
            label={t("page.meta.attachments")}
            value={String(attachments.length)}
            testId="loaded-attachment-count"
          />
        </dl>

        {attachments.length > 0 && (
          <details className="mb-2 text-xs">
            <summary className="cursor-pointer">
              {t("page.attachments.summary", { count: attachments.length })}
            </summary>
            <ul className="m-0 mt-1.5 list-disc pl-4" data-testid="attachment-list">
              {attachments.map((attachment) => (
                <li key={attachment.link || attachment.name}>
                  {attachment.name}{" "}
                  <span className="text-muted-foreground">
                    ({attachment.mediaType}
                    {attachment.size ? `, ${formatBytes(attachment.size)}` : ""})
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}

        <Button size="sm" variant="outline" onClick={onRetry} data-testid="reload">
          {t("page.reload")}
        </Button>
      </CardContent>
    </Card>
  );
}

function Meta({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}): React.JSX.Element {
  return (
    <>
      <dt className="font-semibold">{label}</dt>
      <dd className="m-0" data-testid={testId}>
        {value}
      </dd>
    </>
  );
}

/** A one-line human label for a detected-but-not-exportable entity. */
function describeEntity(
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
  entity: AtlassianEntity
): string {
  switch (entity.product) {
    case "confluence":
      return entity.type === "space"
        ? t("entity.confluence.space", { spaceKey: entity.spaceKey })
        : t("entity.confluence.content");
    case "jira":
      return entity.type === "issue"
        ? t("entity.jira.issue", { issueKey: entity.issueKey })
        : t("entity.jira.board", { projectKey: entity.projectKey });
  }
}
