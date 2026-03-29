import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Simplified test fixtures that deploy directly without launcher
 * Avoids clone ownership issues for testing
 */

export interface DAOShipFixture {
  daoShip: any;
  shares: any;
  loot: any;
  avatar: any;
  multisend: any;
  multisendCallOnly: any;
  poster: any;
  deployer: any;
  alice: any;
  bob: any;
  carol: any;
}

export async function deployDAOShipFixture(): Promise<DAOShipFixture> {
  const [deployer, alice, bob, carol] = await ethers.getSigners();

  // Deploy tokens directly
  const SharesERC20 = await ethers.getContractFactory("SharesERC20");
  const shares = await SharesERC20.deploy();
  await shares.waitForDeployment();

  const LootERC20 = await ethers.getContractFactory("LootERC20");
  const loot = await LootERC20.deploy();
  await loot.waitForDeployment();

  // Deploy DAOShip singleton (constructor sets avatar=0xdead to block singleton init)
  const DAOShipFactory = await ethers.getContractFactory("DAOShip");
  const daoShipImpl = await DAOShipFactory.deploy();
  await daoShipImpl.waitForDeployment();

  // Create EIP-1167 minimal proxy clone (clone has zeroed storage, passes setUp guard)
  const implAddr = (await daoShipImpl.getAddress()).slice(2).toLowerCase().padStart(40, "0");
  const cloneBytecode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implAddr}5af43d82803e903d91602b57fd5bf3`;
  const cloneFactory = new ethers.ContractFactory([], cloneBytecode, deployer);
  const cloneDeployment = await cloneFactory.deploy();
  await cloneDeployment.waitForDeployment();
  const daoShip = DAOShipFactory.attach(await cloneDeployment.getAddress()) as any;

  // Deploy MockAvatar (proper IAvatar implementation for testing)
  const MockAvatar = await ethers.getContractFactory("MockAvatar");
  const avatar = await MockAvatar.deploy();
  await avatar.waitForDeployment();

  // Enable DAOShip clone as module on avatar
  await avatar.enableModule(await daoShip.getAddress());

  const Poster = await ethers.getContractFactory("Poster");
  const poster = await Poster.deploy();
  await poster.waitForDeployment();

  const MultiSend = await ethers.getContractFactory("MultiSend");
  const multisend = await MultiSend.deploy();
  await multisend.waitForDeployment();

  const MultiSendCallOnly = await ethers.getContractFactory("MultiSendCallOnly");
  const multisendCallOnly = await MultiSendCallOnly.deploy();
  await multisendCallOnly.waitForDeployment();

  // Transfer ownership of tokens to DAOShip
  await shares.transferOwnership(await daoShip.getAddress());
  await loot.transferOwnership(await daoShip.getAddress());

  // Governance config
  const votingPeriod = 7 * 24 * 60 * 60; // 7 days
  const gracePeriod = 3 * 24 * 60 * 60; // 3 days
  const proposalOffering = ethers.parseEther("0.1");
  const quorumPercent = 2000; // 20%
  const sponsorThreshold = ethers.parseEther("1"); // 1 share
  const minRetentionPercent = 6600; // 66%

  const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
    [
      votingPeriod,
      gracePeriod,
      proposalOffering,
      quorumPercent,
      sponsorThreshold,
      minRetentionPercent,
      0,
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
      "bytes",
      "address[]",
      "uint256[]",
      "address[]",
      "uint256[]",
      "uint256[]",
      "address[]",
      "bool",
      "bool",
    ],
    [
      await loot.getAddress(),
      await shares.getAddress(),
      await avatar.getAddress(),
      await multisendCallOnly.getAddress(),
      governanceConfig,
      [], // no navigators
      [], // no permissions
      initMembers,
      initShareAmounts,
      initLootAmounts,
      [], // no initial guild tokens
      false, // pauseSharesOnLaunch
      false, // pauseLootOnLaunch
    ]
  );

  // Initialize DAOShip
  await daoShip.setUp(initializationParams);

  return {
    daoShip,
    shares,
    loot,
    avatar,
    multisend,
    multisendCallOnly,
    poster,
    deployer,
    alice,
    bob,
    carol,
  };
}

export interface NavigatorFixture extends DAOShipFixture {
  onboarder: any;
}

export async function deployNavigatorFixture(): Promise<NavigatorFixture> {
  const [deployer, alice, bob, carol] = await ethers.getSigners();

  const SharesERC20 = await ethers.getContractFactory("SharesERC20");
  const shares = await SharesERC20.deploy();
  const LootERC20 = await ethers.getContractFactory("LootERC20");
  const loot = await LootERC20.deploy();
  const DAOShipFactory2 = await ethers.getContractFactory("DAOShip");
  const baalImpl2 = await DAOShipFactory2.deploy();
  await baalImpl2.waitForDeployment();
  const implAddr2 = (await baalImpl2.getAddress()).slice(2).toLowerCase().padStart(40, "0");
  const cloneBytecode2 = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implAddr2}5af43d82803e903d91602b57fd5bf3`;
  const cloneFactory2 = new ethers.ContractFactory([], cloneBytecode2, deployer);
  const cloneDeployment2 = await cloneFactory2.deploy();
  await cloneDeployment2.waitForDeployment();
  const daoShip = DAOShipFactory2.attach(await cloneDeployment2.getAddress()) as any;
  const MockAvatar = await ethers.getContractFactory("MockAvatar");
  const avatar = await MockAvatar.deploy();
  await avatar.enableModule(await daoShip.getAddress());
  const Poster = await ethers.getContractFactory("Poster");
  const poster = await Poster.deploy();
  const MultiSend = await ethers.getContractFactory("MultiSend");
  const multisend = await MultiSend.deploy();
  const MultiSendCallOnly = await ethers.getContractFactory("MultiSendCallOnly");
  const multisendCallOnly = await MultiSendCallOnly.deploy();
  await shares.transferOwnership(await daoShip.getAddress());
  await loot.transferOwnership(await daoShip.getAddress());

  // Deploy OnboarderNavigator (multiplier mode: 2x shares, no loot, 0.01 min, no expiry, no cap, open)
  const OnboarderNavigator = await ethers.getContractFactory("OnboarderNavigator");
  const onboarder = await OnboarderNavigator.deploy(
    await daoShip.getAddress(),
    20000,  // shareMultiplier (2x)
    0,      // lootMultiplier
    0,      // pricePerUnit (0 = multiplier mode)
    0,      // sharesPerUnit
    0,      // lootPerUnit
    ethers.parseEther("0.01"), // minTribute
    0,      // expiry
    0,      // mintCap (unlimited)
    0,      // perAddressCap (unlimited)
    ethers.ZeroHash // allowlistRoot (open)
  );

  const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
    [7*24*60*60, 3*24*60*60, ethers.parseEther("0.1"), 2000, ethers.parseEther("1"), 6600, 0]
  );

  const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
    [await loot.getAddress(), await shares.getAddress(), await avatar.getAddress(), await multisendCallOnly.getAddress(), governanceConfig,
     [await onboarder.getAddress()], [2],
     [deployer.address, alice.address], [ethers.parseEther("100"), ethers.parseEther("50")], [ethers.parseEther("0"), ethers.parseEther("25")],
     [], false, false]
  );

  await daoShip.setUp(initParams);

  return { daoShip, shares, loot, avatar, multisend, multisendCallOnly, poster, deployer, alice, bob, carol, onboarder };
}

/**
 * Helper to set navigators via proposal
 */
export async function setNavigatorsViaProposal(
  daoShip: any,
  proposer: any,
  navigatorAddresses: string[],
  permissions: number[]
) {
  // Encode proposal data
  const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "bytes"],
    [
      await daoShip.getAddress(),
      0,
      daoShip.interface.encodeFunctionData("setNavigators", [
        navigatorAddresses,
        permissions,
      ]),
    ]
  );

  // Submit proposal (proposer is assumed to be a self-sponsor with shares >= sponsorThreshold)
  const submitTx = await daoShip.connect(proposer).submitProposal(
    proposalData,
    0,
    "Set Navigators"
  );
  await submitTx.wait();

  // Get the proposal ID from the proposalCount
  const proposalId = await daoShip.proposalCount();

  // Vote and process
  const voteTx = await daoShip.connect(proposer).submitVote(proposalId, true);
  await voteTx.wait();

  await time.increase(11 * 24 * 60 * 60); // 11 days

  const processTx = await daoShip.processProposal(proposalId, proposalData);
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
