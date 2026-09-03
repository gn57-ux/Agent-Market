import { resolveChainConfig } from "@agent-market/domain";
import { createPublicClient, http } from "viem";
import { deriveOnChainTaskId } from "../tasks/onchain-task-id.js";
import type { OfficeTaskRow } from "./repository.js";
import type { OfficeSnapshot } from "./schema.js";

type FundsSnapshot = OfficeSnapshot["funds"];

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
const ESCROW_TASK_ABI = [
  {
    type: "function",
    name: "getTask",
    stateMutability: "view",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "taskId", type: "bytes32" },
          { name: "requester", type: "address" },
          { name: "agent", type: "address" },
          { name: "token", type: "address" },
          { name: "budget", type: "uint256" },
          { name: "stake", type: "uint256" },
          { name: "deliveryDeadline", type: "uint64" },
          { name: "submittedAt", type: "uint64" },
          { name: "reviewDeadline", type: "uint64" },
          { name: "resultHash", type: "bytes32" },
          { name: "disputeEvidenceHash", type: "bytes32" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
  },
] as const;

export interface OfficeFundsReader {
  read(
    address: `0x${string}`,
    published: readonly OfficeTaskRow[],
    accepted: readonly OfficeTaskRow[],
  ): Promise<FundsSnapshot>;
}

const LOCKED_STATUSES = new Set(["OPEN", "ACCEPTED", "SUBMITTED", "DISPUTED"]);
const STAKED_STATUSES = new Set(["ACCEPTED", "SUBMITTED", "DISPUTED"]);
const PENDING_STATUSES = new Set(["SUBMITTED", "DISPUTED"]);

export function createOfficeFundsReader(env: NodeJS.ProcessEnv = process.env): OfficeFundsReader {
  return {
    async read(address, published, accepted) {
      let config: ReturnType<typeof resolveChainConfig>;
      try {
        config = resolveChainConfig(env);
      } catch {
        return { kind: "unavailable", reason: "CHAIN_CONFIG_INVALID" };
      }
      const rpcUrl = env.BACKEND_RPC_URL;
      if (!rpcUrl) return { kind: "unavailable", reason: "CHAIN_CONFIG_INVALID" };
      try {
        const client = createPublicClient({ transport: http(rpcUrl) });
        const activeAccepted = accepted.filter((task) => STAKED_STATUSES.has(task.status));
        const [walletBalance, observedBlockNumber, chainTasks] = await Promise.all([
          client.readContract({
            address: config.addresses.ydToken,
            abi: ERC20_BALANCE_ABI,
            functionName: "balanceOf",
            args: [address],
          }),
          client.getBlockNumber(),
          Promise.all(
            activeAccepted.map((task) =>
              client.readContract({
                address: config.addresses.taskEscrow,
                abi: ESCROW_TASK_ABI,
                functionName: "getTask",
                args: [deriveOnChainTaskId(task.id)],
              }),
            ),
          ),
        ]);
        const lockedBudget = published
          .filter((task) => LOCKED_STATUSES.has(task.status))
          .reduce((sum, task) => sum + BigInt(task.budget), 0n);
        const agentStake = chainTasks.reduce((sum, task) => sum + task.stake, 0n);
        const pendingSettlement = activeAccepted.reduce(
          (sum, task, index) =>
            PENDING_STATUSES.has(task.status)
              ? sum + BigInt(task.budget) + (chainTasks[index]?.stake ?? 0n)
              : sum,
          0n,
        );
        return {
          kind: "available",
          tokenSymbol: "YD",
          decimals: 18,
          walletBalance: walletBalance.toString(),
          lockedBudget: lockedBudget.toString(),
          agentStake: agentStake.toString(),
          pendingSettlement: pendingSettlement.toString(),
          observedBlockNumber: observedBlockNumber.toString(),
        };
      } catch {
        return { kind: "unavailable", reason: "RPC_UNAVAILABLE" };
      }
    },
  };
}
