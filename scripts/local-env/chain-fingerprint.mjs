// 识别"是不是同一条链"的唯一归属。
//
// 真实测得、且比最初设想更深的一个事实（本文件第一版曾经假设 genesis block
// 哈希天然唯一，用真实的两条独立 Hardhat 链验证后证明是错的）：两条完全独立
// 起的本地 Hardhat 链，只要跑同一份确定性部署脚本（同一把测试账户、同样的
// nonce 序列、同样的字节码、同样的构造参数），不仅 chainId 和 CREATE 合约
// 地址会逐字节相同，genesis block 哈希、部署交易哈希、乃至部署交易所在区块
// 的哈希和时间戳（Hardhat 按秒取整，两次快速连续部署很容易落在同一秒）都会
// 完全相同——因为这些全部是"确定性脚本在确定性起始状态上重放"的确定性函数，
// 没有任何一项携带真正的随机性。
//
// 真正能区分两条独立链的，只有一样东西：一次包含真随机数据的标记交易。
// `deployContracts` 部署完三个合约后，额外发送一笔自转账交易，`data` 字段
// 是 `crypto.randomUUID()` 生成的真随机值——两条独立链各自独立生成这个值，
// 不可能巧合相同。`verifyFingerprint` 直接向目标 RPC 查询"是否存在这个交易
// 哈希"：如果查不到，说明这根本不是同一条链（这个哈希的存在性本身就是证据，
// 不需要额外解释为什么）。运行时字节码哈希和 authorizedSigner 仍然保留作为
// 第二层防御（能查出"这条链虽然是同一条但合约被改过"这类更细的问题）。

import { createPublicClient, http, keccak256 } from "viem";

export function makeChain(chainId, rpcUrl) {
  return {
    id: chainId,
    name: "local",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

export function makePublicClient(chainId, rpcUrl) {
  return createPublicClient({ chain: makeChain(chainId, rpcUrl), transport: http(rpcUrl) });
}

const TASK_ESCROW_AUTHORIZED_SIGNER_ABI = [
  {
    type: "function",
    name: "authorizedSigner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
];

/** 只读取 chainId + authorizedSigner——不再包含任何"确定性重放也会相同"的
 * 字段（genesis hash 曾经在这里，真实测得两条独立链完全相同后已移除）。真正
 * 唯一的标记交易由 `deployContracts` 生成并写入清单，这里不重复生成。 */
export async function captureFingerprint(publicClient, { taskEscrowAddress }) {
  const chainId = await publicClient.getChainId();
  const authorizedSigner = await publicClient.readContract({
    address: taskEscrowAddress,
    abi: TASK_ESCROW_AUTHORIZED_SIGNER_ABI,
    functionName: "authorizedSigner",
  });
  return { chainId, authorizedSigner };
}

export async function runtimeCodeHashAt(publicClient, address) {
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") {
    throw new ChainFingerprintMismatchError(
      `地址 ${address} 上没有合约字节码（期望是本清单部署的合约之一）。`,
    );
  }
  return keccak256(code);
}

export class ChainFingerprintMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "ChainFingerprintMismatchError";
  }
}

/** 核心 fail-fast 校验：给定一份清单和一个真实 RPC 端点，重新采集指纹并逐项
 * 比对。任何一项不一致都抛出 `ChainFingerprintMismatchError`，绝不返回"大概
 *率一致"这种模糊结果——调用方（API 启动自检 / status.mjs）必须让不一致直接
 * 中断启动或在 status 中明确标红，不允许静默继续。 */
export async function verifyFingerprint(manifest) {
  const publicClient = makePublicClient(manifest.chain.chainId, manifest.chain.rpcUrl);

  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== manifest.chain.chainId) {
    throw new ChainFingerprintMismatchError(
      `chainId 不一致：清单记录 ${manifest.chain.chainId}，RPC ${manifest.chain.rpcUrl} 实际返回 ${liveChainId}。`,
    );
  }

  // 唯一的可靠判据：清单记录的标记交易（部署时发送的、data 携带真随机
  // UUID 的自转账交易）在这条 RPC 上必须真实存在。两条独立链即使重放同一份
  // 确定性部署脚本也不会产生这笔交易——它的随机 data 只在真正跑过这次部署
  // 的那条链上才存在。查不到本身就是"这不是同一条链"的证据，不需要间接推理。
  let markerTx;
  try {
    markerTx = await publicClient.getTransaction({ hash: manifest.chainMarker.txHash });
  } catch {
    markerTx = null;
  }
  if (!markerTx) {
    throw new ChainFingerprintMismatchError(
      `标记交易 ${manifest.chainMarker.txHash} 在 RPC ${manifest.chain.rpcUrl} 上不存在。` +
        " 这条链不是清单记录的那条链——即使 chainId 和合约地址完全相同（本地 Hardhat 用相同部署脚本必然如此），也不能当作同一条链继续。",
    );
  }
  if (markerTx.input !== manifest.chainMarker.markerHex) {
    throw new ChainFingerprintMismatchError(
      `标记交易 ${manifest.chainMarker.txHash} 存在，但 data 字段不一致：清单记录 ${manifest.chainMarker.markerHex}，链上实际 ${markerTx.input}。`,
    );
  }

  for (const [name, record] of Object.entries(manifest.contracts)) {
    const liveHash = await runtimeCodeHashAt(publicClient, record.address);
    if (liveHash !== record.runtimeCodeHash) {
      throw new ChainFingerprintMismatchError(
        `合约 ${name}（${record.address}）运行时字节码哈希不一致：清单记录 ${record.runtimeCodeHash}，链上实际 ${liveHash}。`,
      );
    }
    // 部署区块处该地址必须已有代码——证明清单记录的 deployBlock 真实对应这条
    // 链的历史，而不是从另一条链的清单复制过来的巧合数字。
    const codeAtDeployBlock = await publicClient.getCode({
      address: record.address,
      blockNumber: BigInt(record.deployBlock),
    });
    if (!codeAtDeployBlock || codeAtDeployBlock === "0x") {
      throw new ChainFingerprintMismatchError(
        `合约 ${name} 在清单记录的部署区块 ${record.deployBlock} 处没有代码——这条链的历史与清单不匹配。`,
      );
    }
  }

  const liveAuthorizedSigner = await publicClient.readContract({
    address: manifest.contracts.taskEscrow.address,
    abi: TASK_ESCROW_AUTHORIZED_SIGNER_ABI,
    functionName: "authorizedSigner",
  });
  if (
    liveAuthorizedSigner.toLowerCase() !==
    manifest.contracts.taskEscrow.authorizedSigner.toLowerCase()
  ) {
    throw new ChainFingerprintMismatchError(
      `TaskEscrow.authorizedSigner 不一致：清单记录 ${manifest.contracts.taskEscrow.authorizedSigner}，链上实际 ${liveAuthorizedSigner}。`,
    );
  }

  return true;
}
