interface ErrorLike {
  code?: unknown;
  message?: unknown;
  shortMessage?: unknown;
}

function asErrorLike(error: unknown): ErrorLike | undefined {
  return typeof error === "object" && error !== null ? error : undefined;
}

/** Converts wallet/RPC implementation details at the UI boundary. */
export function toUserFacingError(error: unknown, fallback: string): string {
  const errorLike = asErrorLike(error);
  const code = errorLike?.code;
  const rawMessage =
    typeof errorLike?.shortMessage === "string"
      ? errorLike.shortMessage
      : typeof errorLike?.message === "string"
        ? errorLike.message
        : typeof error === "string"
          ? error
          : "";

  if (code === 4001 || /user rejected|user denied|request rejected/i.test(rawMessage)) {
    return "你已取消钱包操作，可以重新尝试。";
  }
  if (/insufficient funds|network fee|gas required exceeds/i.test(rawMessage)) {
    return "当前账户的测试 ETH 不足，无法支付网络费。";
  }
  if (/failed to fetch|network error|rpc|timeout|timed out/i.test(rawMessage)) {
    return "网络暂时不可用，请检查本地链连接后重试。";
  }
  return rawMessage || fallback;
}
