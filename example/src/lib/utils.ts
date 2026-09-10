import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/** What every shadcn component expects to find at `@/lib/utils`. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
