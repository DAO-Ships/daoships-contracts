import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Test fixtures for Baal DAO testing
 * Provides reusable deployment and setup functions
 */

export interface BaalFixture {
  baal: any;
  shares: any;
  loot: any;
  avatar: any;
  multisend: any;
  poster: any;
  baalSummoner: any;
  deployer: any;
  alice: any;
  bob: any;
  carol: any;
}

export async function deployBaalFixture(): Promise<BaalFixture> {
  const [deployer, alice, bob, carol] = await ethers.getSigners();

  // Deploy token singletons
  const SharesERC20 = await ethers.getContractFactory("SharesERC20");
  const sharesSingleton = await SharesERC20.deploy();
  await sharesSingleton.waitForDeployment();

  const LootERC20 = await ethers.getContractFactory("LootERC20");
  const lootSingleton = await LootERC20.deploy();
  await lootSingleton.waitForDeployment();

  // Deploy Baal singleton
  const Baal = await ethers.getContractFactory("Baal");
  const baalSingleton = await Baal.deploy();
  await baalSingleton.waitForDeployment();

  // Deploy BaalSummoner
  const BaalSummoner = await ethers.getContractFactory("BaalSummoner");
  const baalSummoner = await BaalSummoner.deploy(
    await baalSingleton.getAddress(),
    await sharesSingleton.getAddress(),
    await lootSingleton.getAddress()
  );
  await baalSummoner.waitForDeployment();

  // Deploy mock avatar (using Poster as a simple contract)
  const Poster = await ethers.getContractFactory("Poster");
  const avatar = await Poster.deploy();
  await avatar.waitForDeployment();

  // Deploy Poster for metadata
  const poster = await Poster.deploy();
  await poster.waitForDeployment();

  // Deploy mock multisend (using Poster as placeholder)
  const multisend = await Poster.deploy();
  await multisend.waitForDeployment();

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

  // Encode initialization params
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
      ethers.ZeroAddress, // lootToken (replaced by summoner)
      ethers.ZeroAddress, // sharesToken (replaced by summoner)
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

  // Summon Baal with three separate salts
  const sharesSalt = ethers.solidityPackedKeccak256(["string"], ["TEST_SHARES"]);
  const lootSalt = ethers.solidityPackedKeccak256(["string"], ["TEST_LOOT"]);
  const baalSalt = ethers.solidityPackedKeccak256(["string"], ["TEST_BAAL"]);

  const tx = await baalSummoner.summonBaal(initializationParams, [], "Test Shares", "TSHARES", "Test Loot", "TLOOT", sharesSalt, lootSalt, baalSalt);
  await tx.wait();

  // Get deployed addresses
  const [baalAddress, sharesAddress, lootAddress] =
    await baalSummoner.calculateAddresses(deployer.address, sharesSalt, lootSalt, baalSalt);

  const baal = Baal.attach(baalAddress);
  const shares = SharesERC20.attach(sharesAddress);
  const loot = LootERC20.attach(lootAddress);

  return {
    baal,
    shares,
    loot,
    avatar,
    multisend,
    poster,
    baalSummoner,
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

  // Set shamans on Baal (via proposal would be proper, but direct for testing)
  const MANAGER = 2;
  const shamans = [
    await onboarder.getAddress(),
    await ethOnboarder.getAddress(),
    await checkInShaman.getAddress(),
  ];
  const permissions = [MANAGER, MANAGER, MANAGER];

  // This would normally be done via proposal, but for testing we use the deployer's control
  // In production, setShamans is baalOnly and requires a passed proposal
  // For now, we'll set shamans after the fact if needed in individual tests

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
