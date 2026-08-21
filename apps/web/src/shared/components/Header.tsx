import type { ReactNode } from "react";

export interface HeaderProps {
  children?: ReactNode;
}

/** Minimal global navigation: wordmark + a slot for nav links / wallet button. */
export function Header({ children }: HeaderProps) {
  return (
    <header>
      <strong>Agent Market</strong>
      <nav>{children}</nav>
    </header>
  );
}
