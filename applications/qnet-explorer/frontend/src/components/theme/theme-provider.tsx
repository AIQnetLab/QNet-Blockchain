"use client"

import * as React from "react"
import { useEffect } from "react"

// Production theme provider with proper prop handling
export function ThemeProvider({
  children,
  attribute,
  defaultTheme,
  enableSystem,
  disableTransitionOnChange,
  ...remainingProps
}: {
  children: React.ReactNode;
  attribute?: string;
  defaultTheme?: string;
  enableSystem?: boolean;
  disableTransitionOnChange?: boolean;
}) {
  // Extract theme props to prevent them from being passed to DOM
  const themeConfig = {
    attribute: attribute || 'data-theme',
    defaultTheme: defaultTheme || 'system',
    enableSystem: enableSystem !== false,
    disableTransitionOnChange: disableTransitionOnChange || false
  };

  // Apply theme configuration to document
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute(themeConfig.attribute, themeConfig.defaultTheme);
    }
  }, [themeConfig.attribute, themeConfig.defaultTheme]);

  // Only pass safe props to DOM element
  return (
    <div 
      className="theme-provider"
      data-theme-provider="true"
      {...remainingProps}
    >
      {children}
    </div>
  );
}
