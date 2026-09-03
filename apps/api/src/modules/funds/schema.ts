import { z } from "zod";

// Same lowercase-0x-hex40 shape nonce.store.ts's normalizeAddress enforces
// (each module keeps its own copy — established convention, see agents/
// schema.ts's own ETH_ADDRESS_SCHEMA doc comment).
const ETH_ADDRESS_SCHEMA = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "不是合法的以太坊地址");

export const requesterAddressParamSchema = z.object({
  address: ETH_ADDRESS_SCHEMA,
});

export const agentIdParamSchema = z.object({
  agentId: z.string().uuid("agentId 必须是合法的 UUID"),
});
