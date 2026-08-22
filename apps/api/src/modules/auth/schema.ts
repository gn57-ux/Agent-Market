import { z } from "zod";

const ETH_ADDRESS_SCHEMA = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Not a valid Ethereum address");

export const nonceRequestSchema = z.object({
  address: ETH_ADDRESS_SCHEMA,
});

export const verifyRequestSchema = z.object({
  address: ETH_ADDRESS_SCHEMA,
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, "Not a valid hex signature")
    .transform((value) => value as `0x${string}`),
  nonce: z.string().min(1),
});
