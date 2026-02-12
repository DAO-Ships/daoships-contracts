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

  const MultiSend = await ethers.getContractFactory("MultiSend");
  const multisend = await MultiSend.deploy();
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
      "address[]",
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
      [], // no initial guild tokens
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
  const [deployer, alice, bob, carol] = await ethers.getSigners();

  const SharesERC20 = await ethers.getContractFactory("SharesERC20");
  const shares = await SharesERC20.deploy();
  const LootERC20 = await ethers.getContractFactory("LootERC20");
  const loot = await LootERC20.deploy();
  const Baal = await ethers.getContractFactory("Baal");
  const baal = await Baal.deploy();
  const MockAvatar = await ethers.getContractFactory("MockAvatar");
  const avatar = await MockAvatar.deploy();
  await avatar.enableModule(await baal.getAddress());
  const Poster = await ethers.getContractFactory("Poster");
  const poster = await Poster.deploy();
  const MultiSend = await ethers.getContractFactory("MultiSend");
  const multisend = await MultiSend.deploy();
  await shares.transferOwnership(await baal.getAddress());
  await loot.transferOwnership(await baal.getAddress());

  // Deploy shamans
  const OnboarderShaman = await ethers.getContractFactory("OnboarderShaman");
  const onboarder = await OnboarderShaman.deploy(await baal.getAddress(), 20000, 0, ethers.parseEther("0.01"), 0);
  const EthOnboarderShaman = await ethers.getContractFactory("EthOnboarderShaman");
  const ethOnboarder = await EthOnboarderShaman.deploy(await baal.getAddress(), ethers.parseEther("0.1"), ethers.parseEther("1"), 0, 0);
  const CheckInShamanV2 = await ethers.getContractFactory("CheckInShamanV2");
  const checkInShaman = await CheckInShamanV2.deploy(await baal.getAddress(), 30*24*60*60, ethers.parseEther("10"), 0, 3);

  const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256"],
    [7*24*60*60, 3*24*60*60, ethers.parseEther("0.1"), 2000, ethers.parseEther("1"), 6600]
  );

  const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]"],
    [await loot.getAddress(), await shares.getAddress(), await avatar.getAddress(), ethers.ZeroAddress, await multisend.getAddress(), governanceConfig,
     [await onboarder.getAddress(), await ethOnboarder.getAddress(), await checkInShaman.getAddress()], [2, 2, 2],
     [deployer.address, alice.address], [ethers.parseEther("100"), ethers.parseEther("50")], [ethers.parseEther("0"), ethers.parseEther("25")],
     []] // no initial guild tokens
  );

  await baal.setUp(initParams);

  return { baal, shares, loot, avatar, multisend, poster, deployer, alice, bob, carol, onboarder, ethOnboarder, checkInShaman };
}

/**
 * Helper to set shamans via proposal
 */
export async function setShamansViaProposal(
  baal: any,
  proposer: any,
  shamanAddresses: string[],
  permissions: number[]
) {
  // Encode proposal data
  const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "bytes"],
    [
      await baal.getAddress(),
      0,
      baal.interface.encodeFunctionData("setShamans", [
        shamanAddresses,
        permissions,
      ]),
    ]
  );

  // Submit proposal
  const offering = await baal.proposalOffering();
  const submitTx = await baal.connect(proposer).submitProposal(
    proposalData,
    0,
    0,
    "Set Shamans",
    { value: offering }
  );
  await submitTx.wait();

  // Get the proposal ID from the proposalCount
  const proposalId = await baal.proposalCount();

  // Vote and process
  const voteTx = await baal.connect(proposer).submitVote(proposalId, true);
  await voteTx.wait();

  await time.increase(11 * 24 * 60 * 60); // 11 days

  const processTx = await baal.processProposal(proposalId, proposalData);
  await processTx.wait();
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
 * Helper to encode proposal data for MultiSend
 *
 * Returns encoded calldata for MultiSend.multiSend(bytes transactions)
 * Format: [multiSend selector][ABI-encoded bytes containing packed transactions]
 *
 * Packed transactions format: [operation][to][value][dataLength][data]...
 */
export function encodeProposalData(
  targets: string[],
  values: bigint[],
  datas: string[]
): string {
  // Pack transactions in MultiSend format
  let packed = "0x";
  for (let i = 0; i < targets.length; i++) {
    const operation = 0; // Call
    const dataBytes = datas[i] === "0x" ? "" : datas[i].slice(2);
    const dataLength = dataBytes.length / 2;

    packed +=
      operation.toString(16).padStart(2, "0") +
      targets[i].slice(2).padStart(40, "0") +
      values[i].toString(16).padStart(64, "0") +
      dataLength.toString(16).padStart(64, "0") +
      dataBytes;
  }

  // Encode as multiSend(bytes transactions) calldata
  const multiSendInterface = new ethers.Interface(["function multiSend(bytes transactions)"]);
  return multiSendInterface.encodeFunctionData("multiSend", [packed]);
}
