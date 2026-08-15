/**
 * Form primitives. The language selector is a native `<select>` on purpose: it
 * is keyboard- and screen-reader-correct for free, renders as the platform
 * control in a 400 px panel, and needs no popover library (see `button.tsx` on
 * why Phase 0 avoids Radix).
 */
import React from "react";
import { cn } from "./utils.js";

export function Label({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>): React.JSX.Element {
  return <label className={cn("text-xs font-medium", className)} {...props} />;
}

export function Select({
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <select
      className={cn(
        "h-11 w-full rounded-md border bg-background px-2.5 text-sm text-foreground",
        className
      )}
      {...props}
    />
  );
}

export function FieldHelp({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  return <p className={cn("m-0 text-xs text-muted-foreground", className)} {...props} />;
}

export function Input({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <input
      className={cn(
        "h-11 w-full rounded-md border bg-background px-2.5 text-sm text-foreground",
        "placeholder:text-muted-foreground disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}

/**
 * A native checkbox with its label as one row.
 *
 * Native rather than a styled `<div role="checkbox">`: keyboard- and
 * screen-reader-correct for free, and it keeps the panel free of a focus-trap
 * dependency (see `button.tsx` on why Radix is not here).
 */
export function CheckboxField({
  label,
  help,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: React.ReactNode;
  help?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <label className="flex items-start gap-2 text-xs font-medium">
        <input type="checkbox" className="mt-0.5 size-3.5 shrink-0 accent-primary" {...props} />
        <span>{label}</span>
      </label>
      {help === undefined ? null : <FieldHelp className="pl-[1.375rem]">{help}</FieldHelp>}
    </div>
  );
}

/** A native radio with its label as one row. */
export function RadioField({
  label,
  help,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: React.ReactNode;
  help?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <label
        className={cn(
          "flex items-start gap-2 text-xs font-medium",
          props.disabled ? "opacity-50" : undefined
        )}
      >
        <input type="radio" className="mt-0.5 size-3.5 shrink-0 accent-primary" {...props} />
        <span>{label}</span>
      </label>
      {help === undefined ? null : <FieldHelp className="pl-[1.375rem]">{help}</FieldHelp>}
    </div>
  );
}

/** Small inline label, e.g. the Global/Space scope badge in the library list. */
export function Badge({
  className,
  tone = "muted",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  tone?: "muted" | "accent";
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide",
        tone === "accent" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

export function SectionHeading({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>): React.JSX.Element {
  return (
    <h2
      className={cn(
        "m-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}
