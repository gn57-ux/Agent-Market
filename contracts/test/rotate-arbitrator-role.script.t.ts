import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { TaskEscrow, YDToken } from "../typechain-types";
import { deployRealSafe } from "./helpers/safe";
import { rotateArbitratorRole } from "../scripts/rotate-arbitrator-role";

/**
 * No `chai-as-promised` dependency in this project — a plain try/catch is
 * this repo's own way of asserting a real async rejection with a specific
 * message (there is no existing precedent for asserting on a plain JS
 * `throw`, only on contract reverts via hardhat-chai-matchers, which does
 * not apply here since this rejection never reaches the chain).
 */
async function expectRejection(promise: Promise<unknown>, messagePattern: RegExp): Promise<void> {
  try {
    await promise;
    expect.fail("expected the promise to reject, but it resolved");
  } catch (error) {
    expect(String(error)).to.match(messagePattern);
  }
}

/**
 * Feature 21 (arbitration-committee), T-2104. N4 real finding (P1, round
 * 2): the CLI script's own `ROTATION_MODE`/bytecode guard (added in
 * response to "轮换前验证新仲裁地址可用") had no test exercising the real
 * script entrypoint against a real network — `rotate-arbitrator-role
 * .unit.test.ts` only covers the pure address-normalization helper.
 * These tests call the REAL exported `rotateArbitratorRole()` (reading
 * real env vars, hitting the real local Hardhat network) end to end.
 */
describe("rotateArbitratorRole script entrypoint (T-2104, N4 P1 round-2 fix)", () => {
  let admin: HardhatEthersSigner;
  let oldArbitrator: HardhatEthersSigner;
  let safeOwner1: HardhatEthersSigner;
  let safeOwner2: HardhatEthersSigner;
  let safeOwner3: HardhatEthersSigner;
  let escrow: TaskEscrow;
  let token: YDToken;
  let escrowAddress: string;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "TASK_ESCROW_ADDRESS",
    "NEW_ARBITRATOR_ADDRESS",
    "OLD_ARBITRATOR_ADDRESS",
    "ROTATION_MODE",
  ];

  before(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  });

  after(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  beforeEach(async () => {
    [admin, oldArbitrator, safeOwner1, safeOwner2, safeOwner3] = await ethers.getSigners();

    const tokenFactory = await ethers.getContractFactory("YDToken", admin);
    token = await tokenFactory.deploy(admin.address, ethers.parseUnits("1000000", 18));
    await token.waitForDeployment();

    const escrowFactory = await ethers.getContractFactory("TaskEscrow", admin);
    escrow = await escrowFactory.deploy(
      await token.getAddress(),
      admin.address,
      259200,
      oldArbitrator.address,
    );
    await escrow.waitForDeployment();
    escrowAddress = await escrow.getAddress();

    for (const key of ENV_KEYS) delete process.env[key];
    process.env.TASK_ESCROW_ADDRESS = escrowAddress;
    process.env.OLD_ARBITRATOR_ADDRESS = oldArbitrator.address;
  });

  it("ROTATION_MODE=forward with a real deployed Safe succeeds end to end", async () => {
    const safe = await deployRealSafe(
      [safeOwner1.address, safeOwner2.address, safeOwner3.address],
      2,
    );
    process.env.NEW_ARBITRATOR_ADDRESS = await safe.getAddress();
    process.env.ROTATION_MODE = "forward";

    await rotateArbitratorRole();

    const arbitratorRole = await escrow.ARBITRATOR_ROLE();
    expect(await escrow.hasRole(arbitratorRole, await safe.getAddress())).to.equal(true);
    expect(await escrow.hasRole(arbitratorRole, oldArbitrator.address)).to.equal(false);
  });

  it("ROTATION_MODE=forward rejects a plain EOA target (no on-chain bytecode) — real state is unchanged", async () => {
    const [, , , , , notASafe] = await ethers.getSigners();
    process.env.NEW_ARBITRATOR_ADDRESS = notASafe.address;
    process.env.ROTATION_MODE = "forward";

    await expectRejection(rotateArbitratorRole(), /real deployed contract/);

    const arbitratorRole = await escrow.ARBITRATOR_ROLE();
    expect(await escrow.hasRole(arbitratorRole, oldArbitrator.address)).to.equal(true);
    expect(await escrow.hasRole(arbitratorRole, notASafe.address)).to.equal(false);
  });

  it("ROTATION_MODE=rollback rejects a real contract target (has on-chain bytecode)", async () => {
    const safe = await deployRealSafe(
      [safeOwner1.address, safeOwner2.address, safeOwner3.address],
      2,
    );
    process.env.NEW_ARBITRATOR_ADDRESS = await safe.getAddress();
    process.env.ROTATION_MODE = "rollback";

    await expectRejection(rotateArbitratorRole(), /real EOA/);
  });

  it("rejects an unset or invalid ROTATION_MODE", async () => {
    const [, , , , , someEoa] = await ethers.getSigners();
    process.env.NEW_ARBITRATOR_ADDRESS = someEoa.address;
    process.env.ROTATION_MODE = "sideways";

    await expectRejection(rotateArbitratorRole(), /ROTATION_MODE must be set/);
  });
});
