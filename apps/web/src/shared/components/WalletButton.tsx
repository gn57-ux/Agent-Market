export interface WalletButtonProps {
  /** undefined/null means "not connected". */
  address: `0x${string}` | undefined;
  onConnect: () => void;
  onDisconnect: () => void;
  /**
   * Same `light`/`dark` convention `Header.tsx` already establishes for
   * design.md's `navigation` rule ("translucent light or dark surface
   * matching the current section"). Task E review: the homepage hero's
   * wallet capsule previously kept this button light-styled even while
   * sitting on the dark hero, so it read as a mismatched white sticker
   * rather than part of the same surface. Defaults to `light` — every
   * other page this button renders on is on the light canvas.
   */
  variant?: "light" | "dark";
}

function shorten(address: `0x${string}`): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// design.md's primaryButton (light canvas): "blue fill, white label, pill
// shape" for the connect action; once connected, the address chip reads as
// already-active state, so it uses the quieter neutral chip treatment
// instead of repeating the primary-action color. The connect button itself
// stays `action-blue` fill on both variants (design.md doesn't define a
// dark-canvas primary-button color, and blue-on-white already reads clearly
// against either canvas) — only the neutral "already connected" chip needs
// a dark counterpart, since THAT one uses light-canvas-specific neutrals.
export function WalletButton({
  address,
  onConnect,
  onDisconnect,
  variant = "light",
}: WalletButtonProps) {
  if (!address) {
    return (
      <button
        type="button"
        onClick={onConnect}
        className="rounded-control bg-action-blue px-4 py-1.5 text-caption font-medium text-white transition-opacity hover:opacity-90"
      >
        连接钱包
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onDisconnect}
      title={address}
      className={
        variant === "dark"
          ? "rounded-control border border-divider-dark bg-surface-dark-raised px-4 py-1.5 font-mono text-caption text-ink-on-dark transition-colors hover:bg-canvas-dark"
          : "rounded-control border border-divider-light bg-canvas-light px-4 py-1.5 font-mono text-caption text-ink-primary transition-colors hover:bg-canvas-warm"
      }
    >
      {shorten(address)}
    </button>
  );
}
