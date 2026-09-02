import React from "react";

type BadgeVariant = "active" | "completed" | "cancelled" | "pending" | "testnet";

interface BadgeProps {
  variant: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  active:
    "bg-emerald-950 text-emerald-400 border-emerald-800",
  completed:
    "bg-slate-800 text-slate-400 border-slate-700",
  cancelled:
    "bg-red-950 text-red-400 border-red-900",
  pending:
    "bg-amber-950 text-amber-400 border-amber-900",
  testnet:
    "bg-cyan-950 text-cyan-400 border-cyan-800",
};

export function Badge({ variant, children, className = "" }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-mono font-medium border ${variantStyles[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
