export interface WalletButtonProps {
  /** undefined/null means "not connected". */
  address: `0x${string}` | undefined;
  onConnect: () => void;
  onDisconnect: () => void;
}

function shorten(address: `0x${string}`): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletButton({ address, onConnect, onDisconnect }: WalletButtonProps) {
  if (!address) {
    return (
      <button type="button" onClick={onConnect}>
        连接钱包
      </button>
    );
  }
  return (
    <button type="button" onClick={onDisconnect} title={address}>
      {shorten(address)}
    </button>
  );
}
