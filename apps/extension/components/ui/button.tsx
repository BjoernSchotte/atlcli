/**
 * shadcn/ui-shaped button, written against the CSS-variable theme.
 *
 * Deliberately no Radix dependency: nothing shipped in Phase 0 needs a portal,
 * a focus trap or roving focus, and `check-output-build.ts`'s
 * `DYNAMIC_CODE_RES` scan is a static text scan over the built bundle — the
 * fewer third-party runtime chunks in `.output/chrome-mv3`, the fewer chances
 * to have to argue for an exemption. Add Radix when a screen actually needs a
 * dialog or a listbox, and verify the gate then (Architecture point 8).
 */
import React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils.js";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium " +
    "transition-colors disabled:pointer-events-none disabled:opacity-50 " +
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:opacity-90",
        secondary: "bg-secondary text-secondary-foreground hover:opacity-90",
        outline: "border bg-background text-foreground hover:bg-accent hover:text-accent-foreground",
        ghost: "text-foreground hover:bg-accent hover:text-accent-foreground",
        destructive: "bg-destructive text-destructive-foreground hover:opacity-90",
        link: "text-foreground underline underline-offset-4 hover:opacity-80",
      },
      size: {
        default: "h-8 px-3 py-1",
        sm: "h-7 rounded-md px-2 text-xs",
        lg: "h-9 px-4",
        icon: "size-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type, ...props }: ButtonProps): React.JSX.Element {
  return (
    <button
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
