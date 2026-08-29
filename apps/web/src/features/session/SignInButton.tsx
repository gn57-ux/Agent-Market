import { useSession } from "./SessionProvider.js";

export interface SignInButtonProps {
  /** Same `light`/`dark` convention `Header`/`WalletButton` already
   * establish for design.md's `navigation` rule ("translucent light or dark
   * surface matching the current section"). Task E review: this button kept
   * light-canvas text/border colors even inside the homepage hero's dark
   * wallet capsule, reading as a mismatched light sticker on the black hero
   * rather than part of the same surface. Defaults to `light` — every other
   * page this renders on (Agent create/edit/activate/deactivate) is on the
   * light canvas. */
  variant?: "light" | "dark";
}

/** Shared login affordance for every page that needs a session (Agent
 * create/edit/activate/deactivate) — one place deciding what "signed in" /
 * "signing in" / "error" look like, rather than each page re-implementing
 * this small state machine's rendering. */
export function SignInButton({ variant = "light" }: SignInButtonProps = {}) {
  const session = useSession();
  const isDark = variant === "dark";
  const textClass = isDark ? "text-ink-muted-on-dark" : "text-ink-secondary";

  if (session.status === "signed_in") {
    return (
      <span className="flex flex-wrap items-center gap-2 text-caption">
        <span className={`font-mono ${textClass}`}>已登录：{session.address}</span>
        <button
          type="button"
          onClick={() => {
            // logout() now rejects (rather than always clearing local
            // state) when the server-side revocation itself fails — caught
            // here so that failure surfaces as session.errorMessage instead
            // of an unhandled rejection; status stays "signed_in" in that
            // case (SessionProvider's doc comment), so the error still
            // needs to render on this same branch.
            session.logout().catch(() => undefined);
          }}
          className={
            isDark
              ? `rounded-control border border-divider-dark px-3 py-1 ${textClass} transition-colors hover:border-warning hover:text-warning`
              : `rounded-control border border-divider-light px-3 py-1 ${textClass} transition-colors hover:border-warning hover:text-warning`
          }
        >
          登出
        </button>
        {session.errorMessage && (
          <span role="alert" className="text-warning">
            {" "}
            {session.errorMessage}
          </span>
        )}
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2 text-caption">
      <button
        type="button"
        onClick={() => void session.login()}
        disabled={session.status === "signing_in"}
        className="rounded-control bg-ink-primary px-4 py-1.5 font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {session.status === "signing_in" ? "登录中…" : "登录（签名验证钱包身份）"}
      </button>
      {session.status === "error" && session.errorMessage && (
        <span role="alert" className="text-warning">
          {" "}
          {session.errorMessage}
        </span>
      )}
    </span>
  );
}
