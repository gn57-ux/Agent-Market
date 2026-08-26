import { resolveChainConfig } from "@agent-market/domain";
import { buildApp } from "./app.js";
import { createChainRpcClient } from "./modules/chain/rpc.client.js";
import { verifySignerMatchesContract } from "./modules/dispatch/permit.service.js";

const app = buildApp();
const port = Number(process.env.API_PORT ?? 3001);

/**
 * Startup gate (Feature 7 sync, T-709, P1): confirms
 * `ACCEPTANCE_PERMIT_SIGNER_KEY` actually matches the deployed `TaskEscrow`
 * contract's `authorizedSigner()` before this process starts accepting
 * traffic — see `permit.service.ts`'s `verifySignerMatchesContract` doc
 * comment for why. A missing
 * `BACKEND_RPC_URL`/`TASK_ESCROW_ADDRESS`/`ACCEPTANCE_PERMIT_SIGNER_KEY`
 * surfaces here too, via the existing clear errors `createChainRpcClient`/
 * `resolveChainConfig`/`loadSignerAccount` already throw — this function
 * doesn't reimplement that env-validation, it only adds the "do the two
 * addresses actually match" check on top once everything required is
 * present.
 */
async function verifyStartupSignerConfig(): Promise<void> {
  const { addresses } = resolveChainConfig(process.env);
  const rpc = createChainRpcClient();
  await verifySignerMatchesContract(rpc, addresses.taskEscrow);
}

async function start(): Promise<void> {
  await verifyStartupSignerConfig();
  await app.listen({ port, host: "0.0.0.0" });
}

// Same failure-exit path for both the signer check and listen() failing —
// no new failure-handling mechanism invented for this new startup step.
start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
