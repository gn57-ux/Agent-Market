import { z } from "zod";

// Same lowercase-0x-hex40 shape nonce.store.ts's normalizeAddress enforces
// (agents/schema.ts's own ETH_ADDRESS_SCHEMA doc comment) — each module
// keeps its own copy rather than importing a shared one (established
// convention: auth/schema.ts, agents/schema.ts, tasks/schema.ts each define
// this independently).
const ETH_ADDRESS_SCHEMA = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "不是合法的以太坊地址");

export const grantAdminRoleSchema = z.object({
  address: ETH_ADDRESS_SCHEMA,
});

export const adminAddressParamSchema = z.object({
  address: ETH_ADDRESS_SCHEMA,
});
