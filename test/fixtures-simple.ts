import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Simplified test fixtures that deploy directly without summoner
 * Avoids clone ownership issues for testing
 */

export interface BaalFixture {
  baal: any;
  shares: any;
  loot: any;
  avatar: any;
  multisend: any;
  poster: any;
  deployer: any;
  alice: any;
  bob: any;
  carol: any;
}

export async function deployBaalFixture(): Promise<BaalFixture> {
  const [deployer, alice, bob, carol] = await ethers.getSigners();

  // Deploy tokens directly
  const SharesERC20 = await ethers.getContractFactory("SharesERC20");
  const shares = await SharesERC20.deploy();
  await shares.waitForDeployment();

  const LootERC20 = await ethers.getContractFactory("LootERC20");
  const loot = await LootERC20.deploy();
  await loot.waitForDeployment();

  // Deploy Baal
  const Baal = await ethers.getContractFactory("Baal");
  const baal = await Baal.deploy();
  await baal.waitForDeployment();

  // Deploy MockAvatar (proper IAvatar implementation for testing)
  const MockAvatar = await ethers.getContractFactory("MockAvatar");
  const avatar = await MockAvatar.deploy();
  await avatar.waitForDeployment();

  // Enable Baal as module on avatar
  await avatar.enableModule(await baal.getAddress());

  const Poster = await ethers.getContractFactory("Poster");
  const poster = await Poster.deploy();
  await poster.waitForDeployment();

  const multisend = await Poster.deploy();
  await multisend.waitForDeployment();

  // Transfer ownership of tokens to Baal
  await shares.transferOwnership(await baal.getAddress());
  await loot.transferOwnership(await baal.getAddress());

  // Governance config
  const votingPeriod = 7 * 24 * 60 * 60; // 7 days
  const gracePeriod = 3 * 24 * 60 * 60; // 3 days
  const proposalOffering = ethers.parseEther("0.1");
  const quorumPercent = 2000; // 20%
  const sponsorThreshold = ethers.parseEther("1"); // 1 share
  const minRetentionPercent = 6600; // 66%

  const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256"],
    [
      votingPeriod,
      gracePeriod,
      proposalOffering,
      quorumPercent,
      sponsorThreshold,
      minRetentionPercent,
    ]
  );

  // Initial members
  const initMembers = [deployer.address, alice.address];
  const initShareAmounts = [ethers.parseEther("100"), ethers.parseEther("50")];
  const initLootAmounts = [ethers.parseEther("0"), ethers.parseEther("25")];

  // Encode initialization params with actual addresses
  const initializationParams = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "address",
      "address",
      "address",
      "address",
      "address",
      "bytes",
      "address[]",
      "uint256[]",
      "address[]",
      "uint256[]",
      "uint256[]",
    ],
    [
      await loot.getAddress(),
      await shares.getAddress(),
      await avatar.getAddress(),
      ethers.ZeroAddress, // forwarder
      await multisend.getAddress(),
      governanceConfig,
      [], // no shamans
      [], // no permissions
      initMembers,
      initShareAmounts,
      initLootAmounts,
    ]
  );

  // Initialize Baal
  await baal.setUp(initializationParams);

  return {
    baal,
    shares,
    loot,
    avatar,
    multisend,
    poster,
    deployer,
    alice,
    bob,
    carol,
  };
}

export interface ShamanFixture extends BaalFixture {
  onboarder: any;
  ethOnboarder: any;
  checkInShaman: any;
}

export async function deployShamanFixture(): Promise<ShamanFixture> {
  const base = await deployBaalFixture();

  // Deploy OnboarderShaman
  const OnboarderShaman = await ethers.getContractFactory("OnboarderShaman");
  const onboarder = await OnboarderShaman.deploy(
    await base.baal.getAddress(),
    20000, // 2x multiplier for shares
    0, // no loot
    ethers.parseEther("0.01"), // 0.01 ETH min tribute
    0 // no expiry
  );
  await onboarder.waitForDeployment();

  // Deploy EthOnboarderShaman
  const EthOnboarderShaman = await ethers.getContractFactory(
    "EthOnboarderShaman"
  );
  const ethOnboarder = await EthOnboarderShaman.deploy(
    await base.baal.getAddress(),
    ethers.parseEther("0.1"), // 0.1 ETH per unit
    ethers.parseEther("1"), // 1 share per unit
    0, // no loot
    0 // no expiry
  );
  await ethOnboarder.waitForDeployment();

  // Deploy CheckInShamanV2
  const CheckInShamanV2 = await ethers.getContractFactory("CheckInShamanV2");
  const checkInShaman = await CheckInShamanV2.deploy(
    await base.baal.getAddress(),
    30 * 24 * 60 * 60, // 30 days
    ethers.parseEther("10"), // 10 shares per claim
    0, // no loot
    3 // max 3 missed claims
  );
  await checkInShaman.waitForDeployment();

  return {
    ...base,
    onboarder,
    ethOnboarder,
    checkInShaman,
  };
}

/**
 * Helper to advance time and mine blocks
 */
export async function advanceTime(seconds: number) {
  await time.increase(seconds);
}

/**
 * Helper to get current timestamp
 */
export async function getCurrentTime(): Promise<number> {
  const blockNum = await ethers.provider.getBlockNumber();
  const block = await ethers.provider.getBlock(blockNum);
  return block!.timestamp;
}

/**
 * Helper to encode proposal data
 */
export function encodeProposalData(
  targets: string[],
  values: bigint[],
  datas: string[]
): string {
  // Simple encoding for single action
  if (targets.length === 1) {
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "bytes"],
      [targets[0], values[0], datas[0]]
    );
  }

  // MultiSend encoding for multiple actions
  let encoded = "0x";
  for (let i = 0; i < targets.length; i++) {
    const operation = 0; // Call
    const data = datas[i].slice(2); // Remove 0x
    const dataLength = data.length / 2;

    encoded +=
      operation.toString(16).padStart(2, "0") +
      targets[i].slice(2).padStart(40, "0") +
      values[i].toString(16).padStart(64, "0") +
      dataLength.toString(16).padStart(64, "0") +
      data;
  }

  return encoded;
}
