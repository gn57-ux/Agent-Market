import { z } from "zod";

const ETH_ADDRESS_SCHEMA = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "不是合法的以太坊地址");

export const nonceRequestSchema = z.object({
  address: ETH_ADDRESS_SCHEMA,
});

export const verifyRequestSchema = z.object({
  address: ETH_ADDRESS_SCHEMA,
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, "不是合法的十六进制签名")
    .transform((value) => value as `0x${string}`),
  nonce: z.string().min(1, "nonce 不能为空"),
});
