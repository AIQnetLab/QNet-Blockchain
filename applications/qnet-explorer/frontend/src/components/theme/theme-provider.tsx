"use client"

import type * as React from "react"

// Simplified theme provider without external dependencies
export function ThemeProvider({
  children,
  ...props
}: {
  children: React.ReactNode;
  attribute?: string;
  defaultTheme?: string;
  enableSystem?: boolean;
  disableTransitionOnChange?: boolean;
}) {
  return <div className="theme-provider" {...props}>{children}</div>
}
