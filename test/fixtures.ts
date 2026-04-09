import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Create EIP-1167 minimal proxy clone bytecode for a given implementation address
 */
function cloneBytecodeFor(implAddress: string): string {
  const padded = implAddress.slice(2).toLowerCase().padStart(40, "0");
  return `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${padded}5af43d82803e903d91602b57fd5bf3`;
}

/**
 * Deploy an EIP-1167 clone of a given implementation and return the clone contract
 */
async function deployClone(impl: any, factory: any, signer: any): Promise<any> {
  const bytecode = cloneBytecodeFor(await impl.getAddress());
  const cloneFactory = new ethers.ContractFactory([], bytecode, signer);
  const cloneRaw = await cloneFactory.deploy();
  await cloneRaw.waitForDeployment();
  return factory.attach(await cloneRaw.getAddress());
}

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

  // Deploy token singletons (bricked by constructor) and create clones
  const SharesERC20 = await ethers.getContractFactory("SharesERC20");
  const sharesImpl = await SharesERC20.deploy();
  await sharesImpl.waitForDeployment();
  const shares = await deployClone(sharesImpl, SharesERC20, deployer);

  const LootERC20 = await ethers.getContractFactory("LootERC20");
  const lootImpl = await LootERC20.deploy();
  await lootImpl.waitForDeployment();
  const loot = await deployClone(lootImpl, LootERC20, deployer);

  // Deploy DAOShip singleton (constructor sets avatar=0xdead to block singleton init)
  const DAOShipFactory = await ethers.getContractFactory("DAOShip");
  const daoShipImpl = await DAOShipFactory.deploy();
  await daoShipImpl.waitForDeployment();

  // Create EIP-1167 minimal proxy clone (clone has zeroed storage, passes setUp guard)
  const daoShip = await deployClone(daoShipImpl, DAOShipFactory, deployer);

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

  // Initialize token clones with DAOShip as owner
  await shares.initialize(await daoShip.getAddress(), "DAOShip Shares", "SHARES");
  await loot.initialize(await daoShip.getAddress(), "DAOShip Loot", "LOOT");

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
  const sharesImpl = await SharesERC20.deploy();
  const shares = await deployClone(sharesImpl, SharesERC20, deployer);
  const LootERC20 = await ethers.getContractFactory("LootERC20");
  const lootImpl = await LootERC20.deploy();
  const loot = await deployClone(lootImpl, LootERC20, deployer);
  const DAOShipFactory2 = await ethers.getContractFactory("DAOShip");
  const daoShipImpl2 = await DAOShipFactory2.deploy();
  await daoShipImpl2.waitForDeployment();
  const daoShip = await deployClone(daoShipImpl2, DAOShipFactory2, deployer);
  const MockAvatar = await ethers.getContractFactory("MockAvatar");
  const avatar = await MockAvatar.deploy();
  await avatar.enableModule(await daoShip.getAddress());
  const Poster = await ethers.getContractFactory("Poster");
  const poster = await Poster.deploy();
  const MultiSend = await ethers.getContractFactory("MultiSend");
  const multisend = await MultiSend.deploy();
  const MultiSendCallOnly = await ethers.getContractFactory("MultiSendCallOnly");
  const multisendCallOnly = await MultiSendCallOnly.deploy();
  await shares.initialize(await daoShip.getAddress(), "DAOShip Shares", "SHARES");
  await loot.initialize(await daoShip.getAddress(), "DAOShip Loot", "LOOT");

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
    ethers.ZeroHash, // allowlistRoot (open)
    "Test Onboarder", // name
    "Test navigator"  // description
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
