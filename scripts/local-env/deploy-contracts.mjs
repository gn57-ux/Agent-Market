// 唯一拥有"如何部署这三个合约"这条知识的地方——start.mjs 和任何测试都只调用
// 这里，不各自重新拼装部署顺序/参数，避免出现"部署脚本 A 用的参数和部署脚本
// B 不一样"这种以前发生过的分裂。
import { createWalletClient, http, toHex, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { makePublicClient, runtimeCodeHashAt } from "./chain-fingerprint.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Hardhat Network 内置的确定性账户 #0——项目其余真实 e2e 测试（如
// full-lifecycle.hardhat.e2e.test.ts）已经在用同一把公开、无实际价值的测试
// 私钥，这里延续同一约定而不是发明新的。
export const DEPLOYER_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const REVIEW_WINDOW_SECONDS = 72 * 60 * 60;
const YD_INITIAL_SUPPLY = 1_000_000n * 10n ** 18n;
const FAUCET_CLAIM_AMOUNT = 100n * 10n ** 18n;
const FAUCET_COOLDOWN_SECONDS = 60n;

function loadArtifact(name) {
  const artifactPath = path.join(
    REPO_ROOT,
    "contracts",
    "artifacts",
    "src",
    `${name}.sol`,
    `${name}.json`,
  );
  return JSON.parse(readFileSync(artifactPath, "utf8"));
}

/** 部署 YDToken → TaskEscrow → YDFaucet，返回写入清单所需的完整记录
 * （地址、部署区块、部署交易哈希、运行时字节码哈希），以及 TaskEscrow 特有
 * 的 authorizedSigner/arbitrator/reviewWindow。调用方负责把返回值原样写进
 * manifest.mjs 的 schema。 */
export async function deployContracts(chainId, rpcUrl) {
  const account = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
  const chain = {
    id: chainId,
    name: "local",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const publicClient = makePublicClient(chainId, rpcUrl);

  async function deployOne(artifact, args) {
    const hash = await walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress) {
      throw new Error(`部署交易失败：${hash}`);
    }
    const runtimeCodeHash = await runtimeCodeHashAt(publicClient, receipt.contractAddress);
    return {
      address: receipt.contractAddress,
      deployBlock: Number(receipt.blockNumber),
      deployTxHash: hash,
      runtimeCodeHash,
    };
  }

  const ydToken = await deployOne(loadArtifact("YDToken"), [account.address, YD_INITIAL_SUPPLY]);
  const taskEscrow = await deployOne(loadArtifact("TaskEscrow"), [
    ydToken.address,
    account.address,
    REVIEW_WINDOW_SECONDS,
    account.address,
  ]);
  const ydFaucet = await deployOne(loadArtifact("YDFaucet"), [
    ydToken.address,
    FAUCET_CLAIM_AMOUNT,
    FAUCET_COOLDOWN_SECONDS,
  ]);

  // Task E manual verification: YDFaucet.claim() calls YDToken.mint(), which
  // is onlyOwner (YDToken.sol's own doc comment: "Owner-mintable so that
  // YDFaucet ... can distribute test tokens") — but the faucet only ever
  // gets that right if ownership is actually handed to it after deployment.
  // Without this transfer, EVERY claim() reverts for EVERY account (not
  // just one particular wallet) — the deployer is still the owner, and the
  // faucet has none of its own privileges. Real symptom this produces: a
  // real browser's MetaMask shows the claim transaction as unsimulatable
  // ("网络费不可用") since it would revert for anyone who submits it.
  const transferOwnershipTxHash = await walletClient.writeContract({
    address: ydToken.address,
    abi: loadArtifact("YDToken").abi,
    functionName: "transferOwnership",
    args: [ydFaucet.address],
    account,
  });
  const transferOwnershipReceipt = await publicClient.waitForTransactionReceipt({
    hash: transferOwnershipTxHash,
  });
  if (transferOwnershipReceipt.status !== "success") {
    throw new Error(`YDToken ownership 转移给 YDFaucet 失败：${transferOwnershipTxHash}`);
  }

  // 唯一区分"这条链"与"任何其他重放了同一份确定性部署脚本的独立链"的标记：
  // 一笔携带真随机 UUID 的自转账交易。chainId、三个合约地址、甚至这笔标记
  // 交易之前的每一笔部署交易的哈希，都已经实测证明在两条独立链上可以完全
  // 相同（Hardhat 的默认账户+nonce+字节码全部确定性）——只有这里的
  // `randomUUID()` 是真正的、Node 密码学安全随机数，不可能巧合相同。
  const markerHex = toHex(stringToBytes(randomUUID()));
  const markerTxHash = await walletClient.sendTransaction({
    account,
    to: account.address,
    value: 0n,
    data: markerHex,
  });
  const markerReceipt = await publicClient.waitForTransactionReceipt({ hash: markerTxHash });
  if (markerReceipt.status !== "success") {
    throw new Error(`标记交易失败：${markerTxHash}`);
  }

  return {
    deployer: account.address,
    contracts: {
      ydToken,
      taskEscrow: {
        ...taskEscrow,
        authorizedSigner: account.address,
        arbitrator: account.address,
        reviewWindowSeconds: REVIEW_WINDOW_SECONDS,
      },
      ydFaucet,
    },
    chainMarker: { txHash: markerTxHash, markerHex },
  };
}
