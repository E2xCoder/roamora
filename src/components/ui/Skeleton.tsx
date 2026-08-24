import { cn } from "@/lib/cn";

/** Loading placeholder — used instead of a blank card while real data is in flight. */
export default function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-2xl", className)} aria-hidden="true" />;
}
