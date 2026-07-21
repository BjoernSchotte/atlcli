/**
 * The re-attach UI for background exports (spec 010 T5.6).
 *
 * What it is for: a tree or space export takes minutes, and the workflow
 * CONFCLOUD-83694 describes — "start it, navigate away, come back, find it" — is
 * only real if there is somewhere to come back to. That is this screen. It reads
 * the durable records on mount, so re-attaching after a page navigation, a panel
 * close or a service-worker restart is the same code path as the steady state.
 *
 * ## No jobs, no UI
 *
 * {@link JobsList} renders `null` when the list is empty. Roughly nine exports
 * in ten are a single page that finishes in seconds and is never listed at all,
 * and those users must not be handed a permanently empty panel section. The
 * screen wrapper adds one muted sentence so the nav entry is not a blank page —
 * the list itself stays absent.
 *
 * ## Copy honesty
 *
 * `jobs.durability` states plainly what "background" means here: navigation,
 * panel close and extension restart are survived; **closing the browser is not**.
 * There is no server side to this and no wording may imply one.
 */
import React from "react";
import { ClipboardList } from "lucide-react";
import type { ScreenDefinition, ScreenProps } from "../../utils/screens/registry.js";
import type { DurableJob } from "../../utils/jobs/store.js";
import { useDurableJobs } from "../../utils/jobs/context.js";
import { jobAgeMinutes } from "../../utils/jobs/model.js";
import { useT, type I18n } from "../../utils/i18n/context.js";
import { Alert } from "../ui/alert.js";
import { Button } from "../ui/button.js";
import { SectionHeading } from "../ui/field.js";

export const JOBS_SCREEN_ID = "activity";

/** Origin of the page the host is currently showing, or `null`. */
export function siteOriginOf(page: ScreenProps["page"]): string | null {
  const url =
    page.status === "loaded" || page.status === "loading" || page.status === "error"
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

function statusLabel(t: I18n["t"], job: DurableJob): string {
  if (job.status === "complete") return t("jobs.status.complete");
  if (job.status === "failed") return t("jobs.status.failed");
  if (job.status === "cancelled") return t("jobs.status.cancelled");
  if (job.progress && job.progress.total > 0) {
    return t("jobs.status.progress", {
      done: String(job.progress.done),
      total: String(job.progress.total),
    });
  }
  return job.status === "compiling" ? t("jobs.status.compiling") : t("jobs.status.queued");
}

function ageLabel(t: I18n["t"], job: DurableJob, now: number): string {
  const minutes = jobAgeMinutes(job.createdAt, now);
  if (minutes < 1) return t("jobs.age.justNow");
  if (minutes < 60) return t("jobs.age.minutes", { minutes: String(minutes) });
  return t("jobs.age.hours", { hours: String(Math.floor(minutes / 60)) });
}

function JobRow({
  job,
  now,
  onCancel,
  onDownload,
  onDismiss,
}: {
  job: DurableJob;
  now: number;
  onCancel: (id: string) => void;
  onDownload: (id: string) => void;
  onDismiss: (id: string) => void;
}): React.JSX.Element {
  const t = useT();
  return (
    <li className="flex flex-col gap-1 border-b py-2 last:border-b-0" data-testid="job-row" data-job-id={job.id}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium">{job.title ?? t("jobs.untitled")}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{ageLabel(t, job, now)}</span>
      </div>
      <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
        {job.scopeLabel && <span data-testid="job-scope">{job.scopeLabel}</span>}
        <span data-testid="job-status">{statusLabel(t, job)}</span>
      </div>
      {job.error && !job.running && (
        <p className="m-0 text-xs text-destructive" data-testid="job-error">
          {job.error}
        </p>
      )}
      <div className="flex items-center gap-2">
        {job.running && (
          <Button variant="outline" onClick={() => onCancel(job.id)} data-testid="job-cancel">
            {t("jobs.cancel")}
          </Button>
        )}
        {job.collectable && (
          <Button onClick={() => onDownload(job.id)} data-testid="job-download">
            {t("jobs.download")}
          </Button>
        )}
        {!job.running && (
          <Button variant="outline" onClick={() => onDismiss(job.id)} data-testid="job-dismiss">
            {t("jobs.dismiss")}
          </Button>
        )}
      </div>
    </li>
  );
}

export interface JobsListProps {
  jobs: readonly DurableJob[];
  error?: string | null;
  now?: number;
  onCancel: (id: string) => void;
  onDownload: (id: string) => void;
  onDismiss: (id: string) => void;
}

/**
 * The list itself — **`null` when there is nothing to show**.
 *
 * Presentational and stateless, so the same markup serves the screen and (later)
 * an embedded section on the Export screen, without either growing a
 * permanently empty block for the single-page case.
 */
export function JobsList({
  jobs,
  error = null,
  now = Date.now(),
  onCancel,
  onDownload,
  onDismiss,
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
            key={job.id}
            job={job}
            now={now}
            onCancel={onCancel}
            onDownload={onDownload}
            onDismiss={onDismiss}
          />
        ))}
      </ul>
      <p className="m-0 text-xs text-muted-foreground" data-testid="jobs-durability">
        {t("jobs.durability")}
      </p>
    </section>
  );
}

/** The list bound to the durable records for one site. Renders nothing when empty. */
export function JobsSection({
  siteOrigin,
  now,
}: {
  siteOrigin: string | null;
  now?: number;
}): React.JSX.Element | null {
  const { jobs, error, cancel, dismiss, download } = useDurableJobs(siteOrigin);
  return (
    <JobsList
      jobs={jobs}
      error={error}
      {...(now === undefined ? {} : { now })}
      onCancel={cancel}
      onDownload={download}
      onDismiss={dismiss}
    />
  );
}

export function JobsScreen({ page }: ScreenProps): React.JSX.Element {
  const t = useT();
  const siteOrigin = siteOriginOf(page);
  const { jobs, error, loaded, cancel, dismiss, download } = useDurableJobs(siteOrigin);
  const empty = jobs.length === 0 && !error;
  return (
    // `data-testid` is the screen-mounted contract the registry/portability
    // tests assert against; it replaced the Phase 0 placeholder's identical id
    // when this screen took over the Activity route.
    <div className="flex flex-col gap-4" data-testid="activity-screen">
      <JobsList
        jobs={jobs}
        error={error}
        onCancel={cancel}
        onDownload={download}
        onDismiss={dismiss}
      />
      {empty && loaded && (
        <p className="m-0 text-xs text-muted-foreground" data-testid="jobs-empty">
          {t("jobs.empty")}
        </p>
      )}
    </div>
  );
}

/**
 * Ready to be dropped into `defaultScreens`.
 *
 * The `durable-jobs` requirement was declared by the Phase 0 registry before any
 * host advertised it, which is precisely how a screen is meant to arrive: the
 * entry becomes available the moment `createChromePorts` lists the capability —
 * no shell change, no navigation code.
 */
export const jobsScreenDefinition: ScreenDefinition = {
  id: JOBS_SCREEN_ID,
  labelKey: "screen.activity.label",
  descriptionKey: "screen.activity.description",
  icon: ClipboardList,
  component: JobsScreen,
  requirements: [{ kind: "capability", capability: "durable-jobs" }],
  order: 30,
};
