import { ethers } from "hardhat";
import { expect } from "chai";

/**
 * Tests for DAOShipAndVaultLauncher's interaction with the updated QuaiVaultFactory.
 * Verifies that:
 * - DAOShipAndVaultLauncher constructor requires 3 args (daoShipLauncher, quaiVaultFactory, multisendCallOnly)
 * - launchDAOShipAndVault calls 6-param createWallet with initialModules and initialDelegatecallTargets
 * - The predicted DAOShip address matches the actual deployed DAOShip address (predict-then-create flow)
 * - minExecutionDelay=0 is explicitly passed
 */
describe("DAOShipAndVaultLauncher Factory Integration", function () {
  let deployer: any;
  let mockFactory: any;
  let daoShipLauncher: any;
  let launcher: any;
  let multisendCallOnly: any;

  beforeEach(async function () {
    [deployer] = await ethers.getSigners();

    // Deploy real DAOShipLauncher with singletons
    const SharesERC20 = await ethers.getContractFactory("SharesERC20");
    const sharesSingleton = await SharesERC20.deploy();
    const LootERC20 = await ethers.getContractFactory("LootERC20");
    const lootSingleton = await LootERC20.deploy();
    const DAOShip = await ethers.getContractFactory("DAOShip");
    const baalSingleton = await DAOShip.deploy();

    const BaalLauncher = await ethers.getContractFactory("DAOShipLauncher");
    daoShipLauncher = await BaalLauncher.deploy(
      await baalSingleton.getAddress(),
      await sharesSingleton.getAddress(),
      await lootSingleton.getAddress()
    );

    // Deploy mock factory that records call params
    const MockQuaiVaultFactory = await ethers.getContractFactory("MockQuaiVaultFactory");
    mockFactory = await MockQuaiVaultFactory.deploy();

    // Deploy MultiSendCallOnly
    const MultiSendCallOnly = await ethers.getContractFactory("MultiSendCallOnly");
    multisendCallOnly = await MultiSendCallOnly.deploy();

    // Deploy DAOShipAndVaultLauncher with 3 constructor args
    const BaalAndVaultLauncher = await ethers.getContractFactory("DAOShipAndVaultLauncher");
    launcher = await BaalAndVaultLauncher.deploy(
      await daoShipLauncher.getAddress(),
      await mockFactory.getAddress(),
      await multisendCallOnly.getAddress()
    );
  });

  it("should call 6-param createWallet with initialModules and initialDelegatecallTargets", async function () {
    const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
      [3600, 1800, 0, 2000, ethers.parseEther("1"), 6600, 0]
    );

    const initializationParams = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
      [
        ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress,
        await multisendCallOnly.getAddress(), governanceConfig,
        [], [], [deployer.address], [ethers.parseEther("100")], [ethers.parseEther("0")], [], false, false
      ]
    );

    await launcher.launchDAOShipAndVault(
      initializationParams,
      "Test Shares", "TSHARES",
      "Test Loot", "TLOOT",
      [deployer.address],
      1,    // threshold
      1,    // vault salt
      2,    // shares salt
      3,    // loot salt
      4     // daoShip salt
    );

    // Verify the mock factory recorded 6-param call
    expect(await mockFactory.sixParamCalled()).to.equal(true);
    expect(await mockFactory.lastMinExecutionDelay()).to.equal(0);

    // Verify initialModules contains the predicted DAOShip address
    const predictedDAOShip = (await daoShipLauncher.calculateAddresses(
      await launcher.getAddress(), 2, 3, 4
    ))[0];
    expect(await mockFactory.lastInitialModules(0)).to.equal(predictedDAOShip);

    // Verify initialDelegatecallTargets contains the multisendCallOnly address
    expect(await mockFactory.lastInitialDelegatecallTargets(0)).to.equal(
      await multisendCallOnly.getAddress()
    );
  });

  it("should verify predict-then-create: emitted DAOShip address matches calculateAddresses prediction", async function () {
    const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
      [3600, 1800, 0, 2000, ethers.parseEther("1"), 6600, 0]
    );

    const initializationParams = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
      [
        ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress,
        await multisendCallOnly.getAddress(), governanceConfig,
        [], [], [deployer.address], [ethers.parseEther("100")], [ethers.parseEther("0")], [], false, false
      ]
    );

    // Predict the DAOShip address before summoning
    const sharesSalt = 2;
    const lootSalt = 3;
    const baalSalt = 4;
    const predictedDAOShip = (await daoShipLauncher.calculateAddresses(
      await launcher.getAddress(), sharesSalt, lootSalt, baalSalt
    ))[0];

    const tx = await launcher.launchDAOShipAndVault(
      initializationParams,
      "Test Shares", "TSHARES",
      "Test Loot", "TLOOT",
      [deployer.address],
      1, 42, sharesSalt, lootSalt, baalSalt
    );

    const receipt = await tx.wait();

    // Check event was emitted with correct DAOShip address
    const event = receipt.logs.map((log: any) => {
      try { return launcher.interface.parseLog(log); } catch { return null; }
    }).find((e: any) => e?.name === "LaunchDAOShipAndVault");

    expect(event).to.not.be.null;
    expect(event!.args.daoShip).to.equal(predictedDAOShip);
    expect(event!.args.newVault).to.equal(true);
  });

  it("should emit LaunchDAOShipAndVault with correct vault address", async function () {
    const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
      [3600, 1800, 0, 2000, ethers.parseEther("1"), 6600, 0]
    );

    const initializationParams = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
      [
        ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress,
        await multisendCallOnly.getAddress(), governanceConfig,
        [], [], [deployer.address], [ethers.parseEther("100")], [ethers.parseEther("0")], [], false, false
      ]
    );

    const tx = await launcher.launchDAOShipAndVault(
      initializationParams,
      "Test Shares", "TSHARES",
      "Test Loot", "TLOOT",
      [deployer.address],
      1, 42, 2, 3, 4
    );

    const receipt = await tx.wait();

    // Check event was emitted
    const event = receipt.logs.map((log: any) => {
      try { return launcher.interface.parseLog(log); } catch { return null; }
    }).find((e: any) => e?.name === "LaunchDAOShipAndVault");

    expect(event).to.not.be.null;
    expect(event!.args.newVault).to.equal(true);

    // Verify vault address matches what factory returned
    const factoryVault = await mockFactory.lastWallet();
    expect(event!.args.vault).to.equal(factoryVault);
  });
});
