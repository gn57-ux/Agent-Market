// 真实故障复现（不用 mock）：一位真实用户在浏览器里点击"领取测试 YD"，
// MetaMask 把交易模拟成必然 revert（"网络费不可用"），根因是 deployContracts
// 部署了 YDFaucet 却从未把 YDToken 的 owner 转给它——YDFaucet.claim() 内部调用
// 的 YDToken.mint() 是 onlyOwner，部署方（而不是 faucet）仍然是 owner，导致
// *任何* 账户的 claim() 都会 revert，不是某个账户特有的问题。这个测试对
// deployContracts 部署出的真实合约发起一笔真实 claim() 交易，直接复现并锁定
// 这个修复——不读取/断言 owner() 这类实现细节，只断言产品真正关心的行为：
// 一个从未领取过的账户能不能真的拿到 YD。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createWalletClient, http, getAddress } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { deployContracts } from "./deploy-contracts.mjs";
import { makePublicClient } from "./chain-fingerprint.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadArtifact(name) {
  return JSON.parse(
    readFileSync(path.join(REPO_ROOT, `contracts/artifacts/src/${name}.sol/${name}.json`), "utf8"),
  );
}

function startHardhat(port) {
  return spawn("npx", ["hardhat", "node", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: path.join(REPO_ROOT, "contracts"),
    stdio: "ignore",
  });
}

async function waitForRpc(rpcUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const client = makePublicClient(31337, rpcUrl);
      await client.getChainId();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(`等待 ${rpcUrl} 就绪超时`);
}

function stopHardhat(child) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(resolve, 3000);
  });
}

test("deployContracts 部署的 YDFaucet 真的能给一个全新账户 mint YD——复现并锁定 owner 未转移的真实事故", async (t) => {
  const port = 18647;
  const proc = startHardhat(port);
  t.after(() => stopHardhat(proc));

  const rpcUrl = `http://127.0.0.1:${port}`;
  await waitForRpc(rpcUrl);

  const deployed = await deployContracts(31337, rpcUrl);
  assert.notEqual(
    deployed.deployer.toLowerCase(),
    deployed.contracts.ydFaucet.address.toLowerCase(),
    "前提条件：部署方地址和 faucet 合约地址必须不同，否则下面的 owner 转移这一步没有意义",
  );

  // 真实用户视角：一个从未与这条链交互过、不是部署方的账户，真实提交
  // claim() 交易——不读取 owner() 这类实现细节，只关心这笔真实交易会不会
  // revert，以及余额是否真的按 claimAmount 增加。
  const claimer = mnemonicToAccount("test test test test test test test test test test test junk", {
    addressIndex: 1,
  });
  assert.notEqual(
    claimer.address.toLowerCase(),
    deployed.deployer.toLowerCase(),
    "前提条件：领取者账户必须不是部署方账户，否则测不出真实用户会遇到的场景",
  );

  const chain = {
    id: 31337,
    name: "local",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  const publicClient = makePublicClient(31337, rpcUrl);
  const claimerWallet = createWalletClient({ account: claimer, chain, transport: http(rpcUrl) });

  const tokenAbi = loadArtifact("YDToken").abi;
  const faucetAbi = loadArtifact("YDFaucet").abi;
  const tokenAddress = getAddress(deployed.contracts.ydToken.address);
  const faucetAddress = getAddress(deployed.contracts.ydFaucet.address);

  const balanceBefore = await publicClient.readContract({
    address: tokenAddress,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [claimer.address],
  });
  assert.equal(balanceBefore, 0n, "前提条件：这个账户此前从未领取过测试币");

  const claimTxHash = await claimerWallet.writeContract({
    address: faucetAddress,
    abi: faucetAbi,
    functionName: "claim",
    args: [],
  });
  const claimReceipt = await publicClient.waitForTransactionReceipt({ hash: claimTxHash });
  assert.equal(
    claimReceipt.status,
    "success",
    "真实 claim() 交易必须成功——之前的事故是它对任何账户都会 revert",
  );

  const balanceAfter = await publicClient.readContract({
    address: tokenAddress,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [claimer.address],
  });
  assert.equal(
    balanceAfter,
    100n * 10n ** 18n,
    "领取后余额必须真实增加 claimAmount（100 YD，deploy-contracts.mjs 的 FAUCET_CLAIM_AMOUNT）",
  );
});
