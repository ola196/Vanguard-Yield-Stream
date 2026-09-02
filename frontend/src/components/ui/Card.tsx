import React from "react";

interface CardProps {
  children: React.ReactNode;
  className?: string;
  glow?: boolean;
}

export function Card({ children, className = "", glow = false }: CardProps) {
  return (
    <div
      className={`bg-slate-900/80 backdrop-blur-sm border border-slate-800 rounded-2xl ${
        glow ? "glow-cyan" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`px-6 py-5 border-b border-slate-800 ${className}`}>
      {children}
    </div>
  );
}

export function CardBody({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`px-6 py-5 ${className}`}>{children}</div>;
}
