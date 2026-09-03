import { ethers, network } from "hardhat";

const INITIAL_SUPPLY = ethers.parseUnits("1000000", 18);
const FAUCET_CLAIM_AMOUNT = ethers.parseUnits("1000", 18);
const FAUCET_COOLDOWN_SECONDS = 24 * 60 * 60;
const REVIEW_WINDOW_SECONDS = 72 * 60 * 60;

async function deployLocalContracts(): Promise<void> {
  if (network.name !== "localhost") {
    throw new Error(`Local deployment refuses network ${network.name}; expected localhost.`);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("Hardhat did not provide a local deployer account.");

  const tokenFactory = await ethers.getContractFactory("YDToken", deployer);
  const token = await tokenFactory.deploy(deployer.address, INITIAL_SUPPLY);
  await token.waitForDeployment();

  const faucetFactory = await ethers.getContractFactory("YDFaucet", deployer);
  const faucet = await faucetFactory.deploy(
    await token.getAddress(),
    FAUCET_CLAIM_AMOUNT,
    FAUCET_COOLDOWN_SECONDS,
  );
  await faucet.waitForDeployment();

  const escrowFactory = await ethers.getContractFactory("TaskEscrow", deployer);
  const escrow = await escrowFactory.deploy(
    await token.getAddress(),
    deployer.address,
    REVIEW_WINDOW_SECONDS,
    deployer.address,
  );
  await escrow.waitForDeployment();

  await (await token.transferOwnership(await faucet.getAddress())).wait();

  console.log("Local Agent Market contracts deployed.");
  console.log(`TASK_ESCROW_ADDRESS=${await escrow.getAddress()}`);
  console.log(`YD_TOKEN_ADDRESS=${await token.getAddress()}`);
  console.log(`YD_FAUCET_ADDRESS=${await faucet.getAddress()}`);
  console.log(`AUTHORIZED_SIGNER_ADDRESS=${deployer.address}`);
}

deployLocalContracts().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
