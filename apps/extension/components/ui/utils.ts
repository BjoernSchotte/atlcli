import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn's class combiner: conditional classes + last-wins Tailwind merging. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
