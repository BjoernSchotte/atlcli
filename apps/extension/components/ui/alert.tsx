import React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils.js";

export const alertVariants = cva("rounded-md border px-3 py-2 text-xs", {
  variants: {
    tone: {
      muted: "bg-muted text-muted-foreground border-transparent",
      info: "bg-accent text-accent-foreground border-transparent",
      success: "border-transparent bg-success/15 text-foreground",
      warning: "border-transparent bg-warning/20 text-foreground",
      danger: "border-transparent bg-destructive/15 text-foreground",
    },
  },
  defaultVariants: { tone: "muted" },
});

export type AlertProps = React.HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof alertVariants>;

export function Alert({ className, tone, ...props }: AlertProps): React.JSX.Element {
  return <div className={cn(alertVariants({ tone }), className)} {...props} />;
}

export function AlertTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn("font-semibold", className)} {...props} />;
}
