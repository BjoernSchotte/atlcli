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
        "h-8 w-full rounded-md border bg-background px-2 text-sm text-foreground",
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

export function SectionHeading({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>): React.JSX.Element {
  return (
    <h2
      className={cn(
        "m-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}
