import { z } from "zod";

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// N4 real finding (P2, round 2, T-2106): a real Safe can never have the
// zero address as an owner (design.md's own consistency requirement — the
// off-chain roster and the real on-chain Safe owner set must stay in
// sync) — rejecting it here, at the request boundary, is cheaper and more
// honest than letting an unsyncable row into `arbitration_committee_
// members` and discovering the mismatch later.
const memberAddressSchema = z
  .string()
  .regex(ADDRESS_REGEX, "地址必须是合法的以太坊地址")
  .refine((value) => value.toLowerCase() !== ZERO_ADDRESS, "地址不能是零地址");

export const addCommitteeMemberSchema = z.object({
  memberAddress: memberAddressSchema,
});

export const committeeMemberParamsSchema = z.object({
  memberAddress: memberAddressSchema,
});

export const replaceCommitteeMemberSchema = z.object({
  newMemberAddress: memberAddressSchema,
});

export const disputeRecusalParamsSchema = z.object({
  disputeId: z.string().uuid(),
});

export const recordRecusalSchema = z.object({
  memberAddress: memberAddressSchema,
  reason: z.string().min(1).max(5_000),
});
