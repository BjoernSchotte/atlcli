import React, { useMemo, useState } from "react";
import { ArrowRight, ClipboardList } from "lucide-react";
import type { ExportJobEventV1, ExportJobState } from "@atlcli/export-jobs";
import type {
  ScreenDefinition,
  ScreenProps,
} from "../../utils/screens/registry.js";
import type {
  ExportActivityDetail,
  ExportActivityJob,
} from "../../utils/jobs/store.js";
import { useDurableJobs } from "../../utils/jobs/context.js";
import { jobAgeMinutes } from "../../utils/jobs/model.js";
import { useT, type I18n } from "../../utils/i18n/context.js";
import { Alert } from "../ui/alert.js";
import { Button } from "../ui/button.js";
import {
  CheckboxField,
  Label,
  SectionHeading,
  Select,
} from "../ui/field.js";

export const JOBS_SCREEN_ID = "activity";

type StatusFilter =
  | "all"
  | "active"
  | "succeeded"
  | "failed"
  | "cancelled";
type FormatFilter = "all" | "pdf" | "docx";
type TimeFilter = "all" | "day" | "week";

const ACTIVE_STATES: ReadonlySet<ExportJobState> = new Set([
  "queued",
  "running",
  "waiting",
  "cancelling",
]);

/** Origin of the page the host is currently showing, or `null`. */
export function siteOriginOf(page: ScreenProps["page"]): string | null {
  const url =
    page.status === "loaded" ||
    page.status === "loading" ||
    page.status === "error"
      ? page.ref.url
      : page.status === "unsupported"
        ? page.url
        : null;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function statusLabel(t: I18n["t"], job: ExportActivityJob): string {
  if (job.state === "succeeded") return t("jobs.status.complete");
  if (job.state === "failed" || job.state === "interrupted") {
    return t("jobs.status.failed");
  }
  if (job.state === "cancelled") return t("jobs.status.cancelled");
  if (job.state === "waiting") {
    return t("jobs.status.waiting", {
      reason: job.waiting?.reason ?? "host",
    });
  }
  if (job.state === "cancelling") return t("jobs.status.cancelling");
  if (
    job.progress &&
    job.progress.total !== null &&
    job.progress.total > 0
  ) {
    return t("jobs.status.progress", {
      done: String(job.progress.done),
      total: String(job.progress.total),
    });
  }
  return job.state === "running"
    ? job.stage
      ? `${job.stage}…`
      : t("jobs.status.compiling")
    : t("jobs.status.queued");
}

function ageLabel(t: I18n["t"], createdAt: number, now: number): string {
  const minutes = jobAgeMinutes(createdAt, now);
  if (minutes < 1) return t("jobs.age.justNow");
  if (minutes < 60) {
    return t("jobs.age.minutes", { minutes: String(minutes) });
  }
  return t("jobs.age.hours", {
    hours: String(Math.floor(minutes / 60)),
  });
}

function elapsedSeconds(job: ExportActivityJob, now: number): number {
  const start = job.startedAt ?? job.createdAt;
  return Math.max(0, Math.round(((job.finishedAt ?? now) - start) / 1_000));
}

function replayActionKey(relation: "retry" | "rerun", jobId: string): string {
  const uuid = globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `extension:${relation}:${jobId}:${uuid}`;
}

function EventLine({ event }: { event: ExportJobEventV1 }): React.JSX.Element {
  let text: string;
  switch (event.kind) {
    case "state":
      text = `${event.from} → ${event.to}`;
      break;
    case "stage":
      text = `Stage: ${event.stage}`;
      break;
    case "progress":
      text = `${event.progress.stage}: ${event.progress.done}/${event.progress.total ?? "?"}`;
      break;
    case "retry":
      text = `Retry: ${event.code}`;
      break;
    case "issue":
      text = `${event.level}: ${event.code}`;
      break;
    case "recovery":
      text = `Recovery lease ${event.leaseEpoch}`;
      break;
    case "artifact":
      text = `Artifact: ${event.artifact.filename}`;
      break;
  }
  return (
    <li className="flex justify-between gap-2 text-xs">
      <span>{text}</span>
      <time className="shrink-0 text-muted-foreground">
        {new Date(event.at).toLocaleTimeString()}
      </time>
    </li>
  );
}

function metric(
  value: number | null,
  unavailable: string,
): string {
  return value === null ? unavailable : String(value);
}

function JobDetail({
  detail,
  onClose,
}: {
  detail: ExportActivityDetail;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT();
  const { job } = detail;
  const unavailable = t("jobs.detail.unavailable");
  return (
    <section
      className="flex flex-col gap-3 rounded-md border bg-background p-3"
      aria-labelledby="activity-detail-title"
      data-testid="job-detail"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 id="activity-detail-title" className="m-0 text-sm font-semibold">
            {t("jobs.detail.title")}
          </h2>
          <p className="m-0 text-xs text-muted-foreground">
            {job.format.toUpperCase()} · {job.displayName}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          data-testid="job-detail-close"
        >
          {t("jobs.detail.close")}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <span className="text-muted-foreground">Renderer</span>
        <span>{detail.request.renderer ?? unavailable}</span>
        <span className="text-muted-foreground">Template</span>
        <span>{detail.request.template ?? unavailable}</span>
        <span className="text-muted-foreground">Fingerprint</span>
        <code className="break-all text-[11px]">
          {detail.request.fingerprint ?? unavailable}
        </code>
      </div>
      {detail.request.availability === "expired" && (
        <Alert tone="warning" data-testid="job-request-expired">
          {t("jobs.detail.requestExpired")}
        </Alert>
      )}
      {detail.request.availability === "unsupported" && (
        <Alert tone="warning">{t("jobs.detail.unsupported")}</Alert>
      )}

      <div>
        <h3 className="mb-1 mt-0 text-xs font-semibold">
          {t("jobs.detail.timeline")}
        </h3>
        {detail.events.length === 0 ? (
          <p className="m-0 text-xs text-muted-foreground">
            {t("jobs.detail.noEvents")}
          </p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-1 p-0">
            {detail.events.map((event) => (
              <EventLine key={`${event.seq}:${event.kind}`} event={event} />
            ))}
          </ol>
        )}
      </div>

      <div>
        <h3 className="mb-1 mt-0 text-xs font-semibold">
          {t("jobs.detail.statistics")}
        </h3>
        {job.stats === null ? (
          <p className="m-0 text-xs text-muted-foreground">{unavailable}</p>
        ) : (
          <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Pages fetched</dt>
            <dd className="m-0">{job.stats.pages.fetched}</dd>
            <dt className="text-muted-foreground">Assets embedded</dt>
            <dd className="m-0">{job.stats.assets.embedded}</dd>
            <dt className="text-muted-foreground">Diagrams rendered</dt>
            <dd className="m-0">{job.stats.diagrams.rendered}</dd>
            <dt className="text-muted-foreground">Macros unresolved</dt>
            <dd className="m-0">{job.stats.macros.unresolved}</dd>
            <dt className="text-muted-foreground">Spool peak bytes</dt>
            <dd className="m-0" data-testid="job-metric-spool">
              {metric(job.stats.storage.spoolPeakBytes, unavailable)}
            </dd>
            <dt className="text-muted-foreground">Heap peak bytes</dt>
            <dd className="m-0" data-testid="job-metric-heap">
              {metric(job.stats.memory.heapPeakBytes, unavailable)}
            </dd>
          </dl>
        )}
      </div>

      <div>
        <h3 className="mb-1 mt-0 text-xs font-semibold">
          {t("jobs.detail.report")}
        </h3>
        {detail.report.availability === "expired" && (
          <Alert tone="warning" data-testid="job-report-expired">
            {t("jobs.detail.reportExpired")}
          </Alert>
        )}
        {detail.report.availability === "not-produced" && (
          <p className="m-0 text-xs text-muted-foreground">
            {t("jobs.detail.reportMissing")}
          </p>
        )}
        {detail.report.availability === "unsupported" && (
          <p className="m-0 text-xs text-muted-foreground">
            {t("jobs.detail.unsupported")}
          </p>
        )}
        {detail.report.facts.length > 0 && (
          <dl className="my-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {detail.report.facts.map((fact) => (
              <React.Fragment key={fact.label}>
                <dt className="text-muted-foreground">{fact.label}</dt>
                <dd className="m-0">{fact.value}</dd>
              </React.Fragment>
            ))}
          </dl>
        )}
        {detail.report.issues.length === 0 ? (
          <p className="m-0 text-xs text-muted-foreground">
            {t("jobs.detail.noIssues")}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {detail.report.issues.map((issue, index) => (
              <li
                key={`${issue.code}:${index}`}
                className="rounded border p-2 text-xs"
              >
                <strong>{issue.level}: {issue.code}</strong>
                <span className="block">{issue.message}</span>
                {issue.source && (
                  <span className="block text-muted-foreground">
                    {issue.source}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {job.reportSummary && (
          <p className="mb-0 mt-2 text-xs text-muted-foreground">
            {job.reportSummary.completeness} · {job.reportSummary.issues.info} info ·{" "}
            {job.reportSummary.issues.warning} warning ·{" "}
            {job.reportSummary.issues.error} error
          </p>
        )}
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer font-medium">
          {t("jobs.detail.diagnostics")}
        </summary>
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">Job</dt>
          <dd className="m-0 break-all">{job.id}</dd>
          <dt className="text-muted-foreground">Attempt</dt>
          <dd className="m-0">{job.attempt}</dd>
          <dt className="text-muted-foreground">Recoveries</dt>
          <dd className="m-0">{job.recoveryCount}</dd>
          <dt className="text-muted-foreground">Stage</dt>
          <dd className="m-0">{job.stage ?? unavailable}</dd>
          <dt className="text-muted-foreground">Artifact SHA-256</dt>
          <dd className="m-0 break-all">
            {job.artifact?.sha256 ?? unavailable}
          </dd>
        </dl>
      </details>
    </section>
  );
}

function JobRow({
  job,
  now,
  onCancel,
  onDownload,
  onDismiss,
  onRetry,
  onRerun,
  onResume,
  onAcknowledge,
  onView,
}: {
  job: ExportActivityJob;
  now: number;
  onCancel: (route: string) => void;
  onDownload: (route: string) => void;
  onDismiss: (route: string) => void;
  onRetry: (route: string, actionKey: string) => void;
  onRerun: (route: string, actionKey: string) => void;
  onResume: (route: string) => void;
  onAcknowledge: (route: string) => void;
  onView: (route: string) => void;
}): React.JSX.Element {
  const t = useT();
  const progress = job.progress;
  return (
    <li
      className="flex flex-col gap-2 border-b py-3 last:border-b-0"
      data-testid="job-row"
      data-job-id={job.key}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium">
          {job.displayName || t("jobs.untitled")}
        </span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold">
          {job.format.toUpperCase()}
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>{job.siteOrigin ?? job.sourceLabel}</span>
        {job.profileLabel && <span>{job.profileLabel}</span>}
        <span data-testid="job-scope">{job.scopeKind}</span>
        <time>{ageLabel(t, job.createdAt, now)}</time>
      </div>
      <div aria-live="polite" className="text-xs" data-testid="job-status">
        {statusLabel(t, job)}
      </div>
      {progress && progress.total !== null && progress.total > 0 && (
        <progress
          className="h-1.5 w-full"
          max={progress.total}
          value={progress.done}
          aria-label={statusLabel(t, job)}
          data-testid="job-progress"
        />
      )}
      {(job.queueProjection?.kind === "estimated" ||
        job.queueProjection?.kind === "exact") && (
        <span
          className="text-xs text-muted-foreground"
          data-testid="job-queue-position"
        >
          {t(
            job.queueProjection.kind === "exact"
              ? "jobs.queue.exact"
              : "jobs.queue.estimated",
            { position: String(job.queueProjection.position) },
          )}
        </span>
      )}
      <div className="flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span>{t("jobs.meta.elapsed", {
          seconds: String(elapsedSeconds(job, now)),
        })}</span>
        <span>{t("jobs.meta.warnings", {
          count: String(job.stats?.warnings ?? job.reportSummary?.issues.warning ?? 0),
        })}</span>
        <span>{t("jobs.meta.retries", {
          count: String(job.stats?.retries.total ?? 0),
        })}</span>
        <span>{t("jobs.meta.recoveries", {
          count: String(job.recoveryCount),
        })}</span>
        {job.artifact && (
          <span>{t("jobs.meta.bytes", {
            bytes: String(job.artifact.byteLength),
          })}</span>
        )}
      </div>
      {job.error && !job.actions.cancel && (
        <p className="m-0 text-xs text-destructive" data-testid="job-error">
          {job.error.stage ? `${job.error.stage}: ` : ""}
          {job.error.message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onView(job.key)}
          data-testid="job-detail-open"
        >
          {t("jobs.detail")}
        </Button>
        {job.actions.cancel && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onCancel(job.key)}
            data-testid="job-cancel"
          >
            {t("jobs.cancel")}
          </Button>
        )}
        {job.actions.resume && (
          <Button
            size="sm"
            onClick={() => onResume(job.key)}
            data-testid="job-resume"
          >
            {t("jobs.resume")}
          </Button>
        )}
        {job.actions.retry && (
          <Button
            size="sm"
            onClick={() =>
              onRetry(job.key, replayActionKey("retry", job.id))}
            data-testid="job-retry"
          >
            {t("jobs.retry")}
          </Button>
        )}
        {job.actions.rerun && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onRerun(job.key, replayActionKey("rerun", job.id))}
            data-testid="job-rerun"
          >
            {t("jobs.rerun")}
          </Button>
        )}
        {job.actions.download && (
          <Button
            size="sm"
            onClick={() => onDownload(job.key)}
            data-testid="job-download"
          >
            {t("jobs.download")}
          </Button>
        )}
        {job.actions.acknowledge && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onAcknowledge(job.key)}
            data-testid="job-acknowledge"
          >
            {t("jobs.acknowledge")}
          </Button>
        )}
        {job.actions.dismiss && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDismiss(job.key)}
            data-testid="job-dismiss"
          >
            {t("jobs.dismiss")}
          </Button>
        )}
      </div>
    </li>
  );
}

export interface JobsListProps {
  jobs: readonly ExportActivityJob[];
  error?: string | null;
  now?: number;
  onCancel: (route: string) => void;
  onDownload: (route: string) => void;
  onDismiss: (route: string) => void;
  onRetry: (route: string, actionKey: string) => void;
  onRerun: (route: string, actionKey: string) => void;
  onResume: (route: string) => void;
  onAcknowledge: (route: string) => void;
  onView: (route: string) => void;
}

export function JobsList({
  jobs,
  error = null,
  now = Date.now(),
  ...actions
}: JobsListProps): React.JSX.Element | null {
  const t = useT();
  if (jobs.length === 0 && !error) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="jobs-list">
      <SectionHeading>{t("jobs.title")}</SectionHeading>
      {error && (
        <Alert role="alert" tone="danger" data-testid="jobs-error">
          {error}
        </Alert>
      )}
      <ul className="m-0 flex list-none flex-col p-0">
        {jobs.map((job) => (
          <JobRow
            key={job.key}
            job={job}
            now={now}
            {...actions}
          />
        ))}
      </ul>
      <p className="m-0 text-xs text-muted-foreground" data-testid="jobs-durability">
        {t("jobs.durability")}
      </p>
    </section>
  );
}

function filterJobs(
  jobs: readonly ExportActivityJob[],
  format: FormatFilter,
  status: StatusFilter,
  time: TimeFilter,
  now: number,
): ExportActivityJob[] {
  const createdAfter =
    time === "day"
      ? now - 24 * 60 * 60 * 1_000
      : time === "week"
        ? now - 7 * 24 * 60 * 60 * 1_000
        : undefined;
  return jobs.filter((job) => {
    if (format !== "all" && job.format !== format) return false;
    if (createdAfter !== undefined && job.createdAt <= createdAfter) return false;
    if (status === "active") return ACTIVE_STATES.has(job.state);
    if (status === "succeeded") return job.state === "succeeded";
    if (status === "failed") {
      return job.state === "failed" || job.state === "interrupted";
    }
    if (status === "cancelled") return job.state === "cancelled";
    return true;
  });
}

function boundList(
  jobs: ReturnType<typeof useDurableJobs>,
  filtered: readonly ExportActivityJob[],
  now?: number,
): React.JSX.Element | null {
  return (
    <JobsList
      jobs={filtered}
      error={jobs.error}
      {...(now === undefined ? {} : { now })}
      onCancel={jobs.cancel}
      onDownload={jobs.download}
      onDismiss={jobs.dismiss}
      onRetry={jobs.retry}
      onRerun={jobs.rerun}
      onResume={jobs.resume}
      onAcknowledge={jobs.acknowledge}
      onView={jobs.viewDetail}
    />
  );
}

/** Compact list for the Export screen; the full monitor lives on Activity. */
export function JobsSection({
  siteOrigin,
  now,
}: {
  siteOrigin: string | null;
  now?: number;
}): React.JSX.Element | null {
  const jobs = useDurableJobs(siteOrigin);
  const list = boundList(jobs, jobs.jobs, now);
  if (!list && !jobs.detail) return null;
  return (
    <>
      {list}
      {jobs.detail && (
        <JobDetail detail={jobs.detail} onClose={jobs.closeDetail} />
      )}
    </>
  );
}

export function JobsScreen({ page, navigate }: ScreenProps): React.JSX.Element {
  const t = useT();
  const siteOrigin = siteOriginOf(page);
  const [allSites, setAllSites] = useState(siteOrigin === null);
  const [format, setFormat] = useState<FormatFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [time, setTime] = useState<TimeFilter>("all");
  const jobs = useDurableJobs(allSites ? null : siteOrigin);
  const now = Date.now();
  const filtered = useMemo(
    () => filterJobs(jobs.jobs, format, status, time, now),
    [jobs.jobs, format, status, time, now],
  );
  const empty = filtered.length === 0 && !jobs.error;
  const noJobs = jobs.jobs.length === 0 && !jobs.error;
  const pulseControl = (
    <CheckboxField
      checked={jobs.pulseEnabled}
      onChange={(event) => jobs.setPulseEnabled(event.target.checked)}
      label={t("jobs.pulse.label")}
      help={t("jobs.pulse.help")}
      data-testid="jobs-pulse-enabled"
    />
  );

  if (noJobs && jobs.loaded) {
    return (
      <div className="flex flex-col gap-4" data-testid="activity-screen">
        <div
          className="grid min-h-[320px] content-start gap-3 px-2 py-10"
          data-testid="jobs-empty"
        >
          <span className="text-xs font-extrabold uppercase tracking-[0.1em] text-primary">
            {t("jobs.title")}
          </span>
          <h1 className="m-0 font-serif text-2xl font-semibold tracking-[-0.035em]">
            {t("jobs.empty")}
          </h1>
          <p className="m-0 max-w-[34ch] text-sm leading-relaxed text-muted-foreground">
            {t("jobs.emptyDetail")}
          </p>
          <Button
            className="w-fit"
            variant="outline"
            onClick={() => navigate("export")}
            data-testid="jobs-empty-action"
          >
            {t("jobs.emptyAction")}
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
        {pulseControl}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="activity-screen">
      <div
        className="grid grid-cols-2 gap-2 rounded-md border p-2"
        data-testid="jobs-filters"
      >
        <Label>
          {t("jobs.filter.site")}
          <Select
            value={allSites ? "all" : "current"}
            onChange={(event) => setAllSites(event.target.value === "all")}
            data-testid="jobs-filter-site"
          >
            <option value="current" disabled={siteOrigin === null}>
              {t("jobs.filter.currentSite")}
            </option>
            <option value="all">{t("jobs.filter.allSites")}</option>
          </Select>
        </Label>
        <Label>
          {t("jobs.filter.format")}
          <Select
            value={format}
            onChange={(event) => setFormat(event.target.value as FormatFilter)}
            data-testid="jobs-filter-format"
          >
            <option value="all">{t("jobs.filter.all")}</option>
            <option value="pdf">PDF</option>
            <option value="docx">DOCX</option>
          </Select>
        </Label>
        <Label>
          {t("jobs.filter.status")}
          <Select
            value={status}
            onChange={(event) => setStatus(event.target.value as StatusFilter)}
            data-testid="jobs-filter-status"
          >
            <option value="all">{t("jobs.filter.all")}</option>
            <option value="active">{t("jobs.filter.active")}</option>
            <option value="succeeded">{t("jobs.filter.success")}</option>
            <option value="failed">{t("jobs.filter.failure")}</option>
            <option value="cancelled">{t("jobs.filter.cancelled")}</option>
          </Select>
        </Label>
        <Label>
          {t("jobs.filter.time")}
          <Select
            value={time}
            onChange={(event) => setTime(event.target.value as TimeFilter)}
            data-testid="jobs-filter-time"
          >
            <option value="all">{t("jobs.filter.all")}</option>
            <option value="day">{t("jobs.filter.day")}</option>
            <option value="week">{t("jobs.filter.week")}</option>
          </Select>
        </Label>
      </div>
      {pulseControl}

      {boundList(jobs, filtered, now)}
      {empty && jobs.loaded && (
        <p className="m-0 text-xs text-muted-foreground" data-testid="jobs-empty">
          {t("jobs.empty")}
        </p>
      )}
      {jobs.detailLoading && (
        <p className="m-0 text-xs text-muted-foreground" role="status">
          {t("jobs.detail.loading")}
        </p>
      )}
      {jobs.detail && (
        <JobDetail detail={jobs.detail} onClose={jobs.closeDetail} />
      )}
    </div>
  );
}

export const jobsScreenDefinition: ScreenDefinition = {
  id: JOBS_SCREEN_ID,
  labelKey: "screen.activity.label",
  descriptionKey: "screen.activity.description",
  icon: ClipboardList,
  component: JobsScreen,
  requirements: [{ kind: "capability", capability: "durable-jobs" }],
  order: 30,
  navigation: "primary",
};
