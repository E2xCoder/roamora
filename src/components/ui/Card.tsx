import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  selected?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
}

const PADDING_CLASSES = {
  none: "",
  sm: "p-4",
  md: "p-5",
  lg: "p-6",
};

export default function Card({
  interactive = false,
  selected = false,
  padding = "md",
  className,
  ...props
}: CardProps) {
  return (
    <div
      className={cn(
        "rounded-3xl border bg-card transition-all",
        selected ? "border-primary shadow-[var(--shadow-md)] bg-primary-light" : "border-card-border",
        interactive && !selected && "hover:border-primary/30 hover:shadow-[var(--shadow-sm)] cursor-pointer",
        PADDING_CLASSES[padding],
        className
      )}
      {...props}
    />
  );
}
