export interface WalletButtonProps {
  /** undefined/null means "not connected". */
  address: `0x${string}` | undefined;
  onConnect: () => void;
  onDisconnect: () => void;
}

function shorten(address: `0x${string}`): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// design.md's primaryButton (light canvas): "blue fill, white label, pill
// shape" for the connect action; once connected, the address chip reads as
// already-active state, so it uses the quieter neutral chip treatment
// instead of repeating the primary-action color.
export function WalletButton({ address, onConnect, onDisconnect }: WalletButtonProps) {
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
      className="rounded-control border border-divider-light bg-canvas-light px-4 py-1.5 font-mono text-caption text-ink-primary transition-colors hover:bg-canvas-warm"
    >
      {shorten(address)}
    </button>
  );
}
