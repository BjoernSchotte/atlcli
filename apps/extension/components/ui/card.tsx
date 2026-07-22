import React from "react";
import { cn } from "./utils.js";

type DivProps = React.HTMLAttributes<HTMLDivElement>;

export function Card({ className, ...props }: DivProps): React.JSX.Element {
  return (
    <div
      className={cn("rounded-lg border bg-card text-card-foreground", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: DivProps): React.JSX.Element {
  return <div className={cn("flex flex-col gap-1 p-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: DivProps): React.JSX.Element {
  return <div className={cn("text-sm font-semibold leading-tight", className)} {...props} />;
}

export function CardDescription({ className, ...props }: DivProps): React.JSX.Element {
  return <div className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: DivProps): React.JSX.Element {
  return <div className={cn("p-3 pt-0", className)} {...props} />;
}

export function CardFooter({ className, ...props }: DivProps): React.JSX.Element {
  return <div className={cn("flex items-center gap-2 p-3 pt-0", className)} {...props} />;
}
