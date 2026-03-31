import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { deployNavigatorFixture, deployDAOShipFixture } from "../fixtures";

/** Deploy a DAOShip EIP-1167 minimal-proxy clone so setUp() isn't blocked by the singleton guard */
async function deployDAOShipClone(deployer: any) {
  const DAOShipFactory = await ethers.getContractFactory("DAOShip");
  const daoShipImpl = await DAOShipFactory.deploy();
  await daoShipImpl.waitForDeployment();
  const implAddr = (await daoShipImpl.getAddress()).slice(2).toLowerCase().padStart(40, "0");
  const cloneBytecode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implAddr}5af43d82803e903d91602b57fd5bf3`;
  const cloneFactory = new ethers.ContractFactory([], cloneBytecode, deployer);
  const cloneDeploy = await cloneFactory.deploy();
  await cloneDeploy.waitForDeployment();
  return DAOShipFactory.attach(await cloneDeploy.getAddress()) as any;
}

describe("Navigator Contracts", function () {
  describe("OnboarderNavigator (Multiplier Mode)", function () {
    it("Should deploy with correct parameters", async function () {
      const { daoShip, onboarder } = await loadFixture(deployNavigatorFixture);

      expect(await onboarder.daoShip()).to.equal(await daoShip.getAddress());
      expect(await onboarder.shareMultiplier()).to.equal(20000);
      expect(await onboarder.lootMultiplier()).to.equal(0);
      expect(await onboarder.pricePerUnit()).to.equal(0);
      expect(await onboarder.minTribute()).to.equal(ethers.parseEther("0.01"));
      expect(await onboarder.expiry()).to.equal(0);
      expect(await onboarder.mintCap()).to.equal(0);
      expect(await onboarder.allowlistRoot()).to.equal(ethers.ZeroHash);
    });

    it("Should allow onboarding with sufficient tribute", async function () {
      const { onboarder, shares, alice, daoShip } = await loadFixture(deployNavigatorFixture);

      const tribute = ethers.parseEther("1.0");
      const expectedShares = ethers.parseEther("2.0"); // 2x multiplier

      const tx = await onboarder.connect(alice)["onboard()"]({ value: tribute });

      await expect(tx)
        .to.emit(onboarder, "Onboard")
        .withArgs(await daoShip.getAddress(), alice.address, tribute, expectedShares, 0);

      expect(await shares.balanceOf(alice.address)).to.equal(
        ethers.parseEther("50") + expectedShares
      );

      const avatar = await daoShip.avatar();
      expect(await ethers.provider.getBalance(avatar)).to.equal(tribute);
    });

    it("Should reject insufficient tribute", async function () {
      const { onboarder, alice } = await loadFixture(deployNavigatorFixture);

      await expect(
        onboarder.connect(alice)["onboard()"]({ value: ethers.parseEther("0.005") })
      ).to.be.revertedWithCustomError(onboarder, "InsufficientTribute");
    });

    it("Should work via receive() fallback", async function () {
      const { onboarder, alice } = await loadFixture(deployNavigatorFixture);

      const tx = await alice.sendTransaction({
        to: await onboarder.getAddress(),
        value: ethers.parseEther("1.0"),
      });

      await expect(tx).to.emit(onboarder, "Onboard");
    });

    it("Should handle multiple onboards from same user", async function () {
      const { onboarder, shares, bob } = await loadFixture(deployNavigatorFixture);

      await onboarder.connect(bob)["onboard()"]({ value: ethers.parseEther("1.0") }); // 2 shares
      await onboarder.connect(bob)["onboard()"]({ value: ethers.parseEther("2.0") }); // 4 shares

      expect(await shares.balanceOf(bob.address)).to.equal(ethers.parseEther("6"));
    });
  });

  describe("OnboarderNavigator (Fixed-Price Mode)", function () {
    async function deployFixedPriceOnboarder() {
      const [deployer, alice, bob] = await ethers.getSigners();

      const SharesERC20 = await ethers.getContractFactory("SharesERC20");
      const shares = await SharesERC20.deploy();
      const LootERC20 = await ethers.getContractFactory("LootERC20");
      const loot = await LootERC20.deploy();
      const daoShip = await deployDAOShipClone(deployer);
      const MockAvatar = await ethers.getContractFactory("MockAvatar");
      const avatar = await MockAvatar.deploy();
      await avatar.enableModule(await daoShip.getAddress());
      const MultiSend = await ethers.getContractFactory("MultiSend");
      const multisend = await MultiSend.deploy();
      await shares.transferOwnership(await daoShip.getAddress());
      await loot.transferOwnership(await daoShip.getAddress());

      // Fixed-price mode: 0.1 QUAI per share, no loot
      const OnboarderNavigator = await ethers.getContractFactory("OnboarderNavigator");
      const onboarder = await OnboarderNavigator.deploy(
        await daoShip.getAddress(),
        0, 0,                          // no multipliers
        ethers.parseEther("0.1"),      // pricePerUnit
        ethers.parseEther("1"),        // 1 share per unit
        0,                             // no loot
        0,                             // no minTribute
        0, 0, 0, ethers.ZeroHash     // no expiry, no cap, no perAddressCap, open
      );

      const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
        [7*24*60*60, 3*24*60*60, ethers.parseEther("0.1"), 2000, ethers.parseEther("1"), 6600, 0]
      );

      const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
        [await loot.getAddress(), await shares.getAddress(), await avatar.getAddress(), await multisend.getAddress(), governanceConfig,
         [await onboarder.getAddress()], [2],
         [deployer.address], [ethers.parseEther("100")], [ethers.parseEther("0")], [], false, false]
      );

      await daoShip.setUp(initParams);
      return { daoShip, shares, loot, avatar, onboarder, deployer, alice, bob };
    }

    it("Should mint correct units and refund remainder", async function () {
      const { onboarder, shares, alice } = await loadFixture(deployFixedPriceOnboarder);

      const payment = ethers.parseEther("0.35"); // 3.5 units -> 3 units
      const balanceBefore = await ethers.provider.getBalance(alice.address);

      const tx = await onboarder.connect(alice)["onboard()"]({ value: payment });
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * BigInt(receipt!.gasPrice ?? 0);

      // 3 units * 1 share = 3 shares
      expect(await shares.balanceOf(alice.address)).to.equal(ethers.parseEther("3"));

      // Refund: 0.35 - 0.3 = 0.05 back to alice
      const balanceAfter = await ethers.provider.getBalance(alice.address);
      const cost = ethers.parseEther("0.3");
      expect(balanceAfter).to.equal(balanceBefore - cost - gasUsed);
    });

    it("Should reject payment less than one unit", async function () {
      const { onboarder, alice } = await loadFixture(deployFixedPriceOnboarder);

      await expect(
        onboarder.connect(alice)["onboard()"]({ value: ethers.parseEther("0.05") })
      ).to.be.revertedWithCustomError(onboarder, "InsufficientTribute");
    });
  });

  describe("OnboarderNavigator (Mint Cap)", function () {
    async function deployCappedOnboarder() {
      const [deployer, alice, bob] = await ethers.getSigners();

      const SharesERC20 = await ethers.getContractFactory("SharesERC20");
      const shares = await SharesERC20.deploy();
      const LootERC20 = await ethers.getContractFactory("LootERC20");
      const loot = await LootERC20.deploy();
      const daoShip = await deployDAOShipClone(deployer);
      const MockAvatar = await ethers.getContractFactory("MockAvatar");
      const avatar = await MockAvatar.deploy();
      await avatar.enableModule(await daoShip.getAddress());
      const MultiSend = await ethers.getContractFactory("MultiSend");
      const multisend = await MultiSend.deploy();
      await shares.transferOwnership(await daoShip.getAddress());
      await loot.transferOwnership(await daoShip.getAddress());

      // Multiplier mode with 10 share cap
      const OnboarderNavigator = await ethers.getContractFactory("OnboarderNavigator");
      const onboarder = await OnboarderNavigator.deploy(
        await daoShip.getAddress(),
        10000, 0, 0, 0, 0,            // 1x multiplier, no fixed-price
        ethers.parseEther("0.01"),     // minTribute
        0,                             // no expiry
        ethers.parseEther("10"),       // mintCap = 10 shares
        0,                             // perAddressCap (unlimited)
        ethers.ZeroHash
      );

      const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
        [7*24*60*60, 3*24*60*60, ethers.parseEther("0.1"), 2000, ethers.parseEther("1"), 6600, 0]
      );

      const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
        [await loot.getAddress(), await shares.getAddress(), await avatar.getAddress(), await multisend.getAddress(), governanceConfig,
         [await onboarder.getAddress()], [2],
         [deployer.address], [ethers.parseEther("100")], [ethers.parseEther("0")], [], false, false]
      );

      await daoShip.setUp(initParams);
      return { daoShip, shares, onboarder, deployer, alice, bob };
    }

    it("Should enforce mint cap", async function () {
      const { onboarder, alice } = await loadFixture(deployCappedOnboarder);

      // Mint 8 shares (under cap)
      await onboarder.connect(alice)["onboard()"]({ value: ethers.parseEther("8") });
      expect(await onboarder.totalMinted()).to.equal(ethers.parseEther("8"));

      // Try to mint 5 more (would exceed 10 cap)
      await expect(
        onboarder.connect(alice)["onboard()"]({ value: ethers.parseEther("5") })
      ).to.be.revertedWithCustomError(onboarder, "MintCapExceeded");

      // Mint exactly 2 more (hits cap exactly)
      await onboarder.connect(alice)["onboard()"]({ value: ethers.parseEther("2") });
      expect(await onboarder.totalMinted()).to.equal(ethers.parseEther("10"));
    });
  });

  describe("OnboarderNavigator (Pause)", function () {
    // Gap 10: pause/unpause require GOVERNOR navigator permission (bit 4) or avatar.
    // Set up a local fixture where deployer is registered as GOVERNOR navigator (4).
    // setNavigators is daoShipOnly (msg.sender == DAOShip), so we impersonate DAOShip itself.
    async function deployShamanWithGovernorFixture() {
      const base = await deployNavigatorFixture();
      const { daoShip, deployer } = base;
      // daoShipOnly: impersonate DAOShip address directly
      const daoShipAddr = await daoShip.getAddress();
      await ethers.provider.send("hardhat_setBalance", [daoShipAddr, "0x1000000000000000000"]);
      const daoShipSigner = await ethers.getImpersonatedSigner(daoShipAddr);
      await daoShip.connect(daoShipSigner).setNavigators([deployer.address], [4]);
      return base;
    }

    it("Should allow GOVERNOR navigator to pause", async function () {
      const { onboarder, deployer } = await loadFixture(deployShamanWithGovernorFixture);

      await onboarder.connect(deployer).pause();
      expect(await onboarder.paused()).to.be.true;

      await expect(
        onboarder.connect(deployer)["onboard()"]({ value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(onboarder, "IsPaused");
    });

    it("Should reject pause from non-shareholder", async function () {
      const { onboarder, carol } = await loadFixture(deployNavigatorFixture);

      await expect(
        onboarder.connect(carol).pause()
      ).to.be.revertedWithCustomError(onboarder, "NotAuthorized");
    });
  });

  describe("OnboarderNavigator (Expiry)", function () {
    it("Should reject onboarding after expiry", async function () {
      const [deployer, alice] = await ethers.getSigners();
      const currentTime = await time.latest();
      const expiryTime = currentTime + 7 * 24 * 60 * 60;

      const SharesERC20 = await ethers.getContractFactory("SharesERC20");
      const shares = await SharesERC20.deploy();
      const LootERC20 = await ethers.getContractFactory("LootERC20");
      const loot = await LootERC20.deploy();
      const daoShip = await deployDAOShipClone(deployer);
      const MockAvatar = await ethers.getContractFactory("MockAvatar");
      const avatar = await MockAvatar.deploy();
      await avatar.enableModule(await daoShip.getAddress());
      const MultiSend = await ethers.getContractFactory("MultiSend");
      const multisend = await MultiSend.deploy();
      await shares.transferOwnership(await daoShip.getAddress());
      await loot.transferOwnership(await daoShip.getAddress());

      const OnboarderNavigator = await ethers.getContractFactory("OnboarderNavigator");
      const onboarder = await OnboarderNavigator.deploy(
        await daoShip.getAddress(),
        10000, 0, 0, 0, 0,
        ethers.parseEther("0.01"),
        expiryTime, 0, 0, ethers.ZeroHash
      );

      const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
        [7*24*60*60, 3*24*60*60, ethers.parseEther("0.1"), 2000, ethers.parseEther("1"), 6600, 0]
      );

      const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
        [await loot.getAddress(), await shares.getAddress(), await avatar.getAddress(), await multisend.getAddress(), governanceConfig,
         [await onboarder.getAddress()], [2],
         [deployer.address], [ethers.parseEther("100")], [ethers.parseEther("0")], [], false, false]
      );

      await daoShip.setUp(initParams);

      // Works before expiry
      await onboarder.connect(alice)["onboard()"]({ value: ethers.parseEther("1") });

      // Advance past expiry
      await time.increase(8 * 24 * 60 * 60);

      await expect(
        onboarder.connect(alice)["onboard()"]({ value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(onboarder, "Expired");
    });
  });

  describe("ERC20TributeNavigator", function () {
    async function deployERC20TributeFixture() {
      const [deployer, alice, bob] = await ethers.getSigners();

      const SharesERC20 = await ethers.getContractFactory("SharesERC20");
      const shares = await SharesERC20.deploy();
      const LootERC20 = await ethers.getContractFactory("LootERC20");
      const loot = await LootERC20.deploy();
      const daoShip = await deployDAOShipClone(deployer);
      const MockAvatar = await ethers.getContractFactory("MockAvatar");
      const avatar = await MockAvatar.deploy();
      await avatar.enableModule(await daoShip.getAddress());
      const MultiSend = await ethers.getContractFactory("MultiSend");
      const multisend = await MultiSend.deploy();
      await shares.transferOwnership(await daoShip.getAddress());
      await loot.transferOwnership(await daoShip.getAddress());

      // Deploy a mock ERC20 as tribute token
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const tributeToken = await MockERC20.deploy("Mock USDC", "USDC");
      await tributeToken.mint(alice.address, ethers.parseEther("10000"));
      await tributeToken.mint(bob.address, ethers.parseEther("10000"));

      // Deploy ERC20TributeNavigator: 100 tokens per share, no loot
      const ERC20TributeNavigator = await ethers.getContractFactory("ERC20TributeNavigator");
      const tributeNavigator = await ERC20TributeNavigator.deploy(
        await daoShip.getAddress(),
        await tributeToken.getAddress(),
        ethers.parseEther("100"),  // pricePerShare (100 tokens per share)
        0,                         // pricePerLoot (no loot)
        0,                         // no expiry
        0,                         // no mint cap
        0,                         // perAddressCap (unlimited)
        ethers.ZeroHash            // open allowlist
      );

      const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
        [7*24*60*60, 3*24*60*60, ethers.parseEther("0.1"), 2000, ethers.parseEther("1"), 6600, 0]
      );

      const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
        [await loot.getAddress(), await shares.getAddress(), await avatar.getAddress(), await multisend.getAddress(), governanceConfig,
         [await tributeNavigator.getAddress()], [2],
         [deployer.address], [ethers.parseEther("100")], [ethers.parseEther("0")], [], false, false]
      );

      await daoShip.setUp(initParams);
      return { daoShip, shares, loot, avatar, tributeToken, tributeNavigator, deployer, alice, bob };
    }

    it("Should deploy with correct parameters", async function () {
      const { daoShip, tributeToken, tributeNavigator } = await loadFixture(deployERC20TributeFixture);

      expect(await tributeNavigator.daoShip()).to.equal(await daoShip.getAddress());
      expect(await tributeNavigator.tributeToken()).to.equal(await tributeToken.getAddress());
      expect(await tributeNavigator.pricePerShare()).to.equal(ethers.parseEther("100"));
      expect(await tributeNavigator.pricePerLoot()).to.equal(0);
    });

    it("Should mint shares for ERC20 tribute", async function () {
      const { shares, avatar, tributeToken, tributeNavigator, alice, daoShip } =
        await loadFixture(deployERC20TributeFixture);

      // Gap 9: onboard() params are raw wei — pass 5e18 for 5 whole shares.
      // Tribute = (5e18 * 100e18) / 1e18 = 500e18 tokens.
      await tributeToken.connect(alice).approve(await tributeNavigator.getAddress(), ethers.parseEther("500"));

      const tx = await tributeNavigator.connect(alice)["onboard(uint256,uint256)"](
        ethers.parseEther("5"), // 5 whole shares in raw wei
        0
      );

      await expect(tx)
        .to.emit(tributeNavigator, "Onboard")
        .withArgs(await daoShip.getAddress(), alice.address, ethers.parseEther("500"), ethers.parseEther("5"), 0);

      // Alice gets 5 shares (5e18 in 18-decimal)
      expect(await shares.balanceOf(alice.address)).to.equal(ethers.parseEther("5"));

      // Tribute goes to avatar
      const avatarAddr = await daoShip.avatar();
      expect(await tributeToken.balanceOf(avatarAddr)).to.equal(ethers.parseEther("500"));
    });

    it("Should reject onboard with zero amounts", async function () {
      const { tributeNavigator, alice } = await loadFixture(deployERC20TributeFixture);

      await expect(
        tributeNavigator.connect(alice)["onboard(uint256,uint256)"](0, 0)
      ).to.be.revertedWithCustomError(tributeNavigator, "InsufficientAmount");
    });

    it("Should reject without sufficient approval", async function () {
      const { tributeNavigator, alice } = await loadFixture(deployERC20TributeFixture);

      // No approval
      await expect(
        tributeNavigator.connect(alice)["onboard(uint256,uint256)"](1, 0)
      ).to.be.reverted;
    });

    it("Should enforce mint cap", async function () {
      const [deployer, alice] = await ethers.getSigners();

      const SharesERC20 = await ethers.getContractFactory("SharesERC20");
      const shares = await SharesERC20.deploy();
      const LootERC20 = await ethers.getContractFactory("LootERC20");
      const loot = await LootERC20.deploy();
      const daoShip = await deployDAOShipClone(deployer);
      const MockAvatar = await ethers.getContractFactory("MockAvatar");
      const avatar = await MockAvatar.deploy();
      await avatar.enableModule(await daoShip.getAddress());
      const MultiSend = await ethers.getContractFactory("MultiSend");
      const multisend = await MultiSend.deploy();
      await shares.transferOwnership(await daoShip.getAddress());
      await loot.transferOwnership(await daoShip.getAddress());

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const tributeToken = await MockERC20.deploy("Mock", "MCK");
      await tributeToken.mint(alice.address, ethers.parseEther("100000"));

      // Cap at 10 whole shares (mintCap is in raw wei — Gap 9)
      const ERC20TributeNavigator = await ethers.getContractFactory("ERC20TributeNavigator");
      const tributeNavigator = await ERC20TributeNavigator.deploy(
        await daoShip.getAddress(), await tributeToken.getAddress(),
        ethers.parseEther("100"), 0, 0, ethers.parseEther("10"), 0, ethers.ZeroHash
      );

      const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
        [7*24*60*60, 3*24*60*60, ethers.parseEther("0.1"), 2000, ethers.parseEther("1"), 6600, 0]
      );

      const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
        [await loot.getAddress(), await shares.getAddress(), await avatar.getAddress(), await multisend.getAddress(), governanceConfig,
         [await tributeNavigator.getAddress()], [2],
         [deployer.address], [ethers.parseEther("100")], [ethers.parseEther("0")], [], false, false]
      );

      await daoShip.setUp(initParams);

      await tributeToken.connect(alice).approve(await tributeNavigator.getAddress(), ethers.parseEther("100000"));

      // Gap 9: params are raw wei — 8e18 = 8 whole shares
      await tributeNavigator.connect(alice)["onboard(uint256,uint256)"](ethers.parseEther("8"), 0);

      // Try 5 more (8e18 + 5e18 = 13e18 > 10e18 cap)
      await expect(
        tributeNavigator.connect(alice)["onboard(uint256,uint256)"](ethers.parseEther("5"), 0)
      ).to.be.revertedWithCustomError(tributeNavigator, "MintCapExceeded");

      // Buy exactly 2 more (8e18 + 2e18 = 10e18, hits cap exactly)
      await tributeNavigator.connect(alice)["onboard(uint256,uint256)"](ethers.parseEther("2"), 0);
    });

    // ─── Gap 9: fractional purchases ───────────────────────────────────────
    it("Gap 9: Should allow fractional share purchase (0.5 shares = 5e17 wei)", async function () {
      const { shares, tributeToken, tributeNavigator, alice, daoShip } =
        await loadFixture(deployERC20TributeFixture);

      // 0.5 shares = 5e17 wei
      // tribute = (5e17 * 100e18) / 1e18 = 50e18 = 50 tokens
      await tributeToken.connect(alice).approve(await tributeNavigator.getAddress(), ethers.parseEther("50"));

      const tx = await tributeNavigator.connect(alice)["onboard(uint256,uint256)"](
        ethers.parseEther("0.5"), 0
      );

      await expect(tx)
        .to.emit(tributeNavigator, "Onboard")
        .withArgs(await daoShip.getAddress(), alice.address, ethers.parseEther("50"), ethers.parseEther("0.5"), 0);

      expect(await shares.balanceOf(alice.address)).to.equal(ethers.parseEther("0.5"));
      expect(await tributeToken.balanceOf(await daoShip.avatar())).to.equal(ethers.parseEther("50"));
    });

    it("Gap 9: Should revert with InsufficientAmount when amounts are zero", async function () {
      const { tributeNavigator, alice } = await loadFixture(deployERC20TributeFixture);

      await expect(
        tributeNavigator.connect(alice)["onboard(uint256,uint256)"](0, 0)
      ).to.be.revertedWithCustomError(tributeNavigator, "InsufficientAmount");
    });

    it("Should mint loot for ERC20 tribute (pricePerLoot, no shares)", async function () {
      const [deployer, alice] = await ethers.getSigners();

      const SharesERC20 = await ethers.getContractFactory("SharesERC20");
      const shares = await SharesERC20.deploy();
      const LootERC20 = await ethers.getContractFactory("LootERC20");
      const loot = await LootERC20.deploy();
      const daoShip = await deployDAOShipClone(deployer);
      const MockAvatar = await ethers.getContractFactory("MockAvatar");
      const avatar = await MockAvatar.deploy();
      await avatar.enableModule(await daoShip.getAddress());
      const MultiSend = await ethers.getContractFactory("MultiSend");
      const multisend = await MultiSend.deploy();
      await shares.transferOwnership(await daoShip.getAddress());
      await loot.transferOwnership(await daoShip.getAddress());

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const tributeToken = await MockERC20.deploy("Mock USDC", "USDC");
      await tributeToken.mint(alice.address, ethers.parseEther("1000"));

      // Loot-only navigator: 50 tokens per loot, pricePerShare=0
      const ERC20TributeNavigator = await ethers.getContractFactory("ERC20TributeNavigator");
      const tributeNavigator = await ERC20TributeNavigator.deploy(
        await daoShip.getAddress(),
        await tributeToken.getAddress(),
        0,                         // pricePerShare=0 (shares not offered)
        ethers.parseEther("50"),   // pricePerLoot: 50 tokens per loot
        0, 0, 0, ethers.ZeroHash
      );

      const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
        [7*24*60*60, 3*24*60*60, ethers.parseEther("0.1"), 2000, ethers.parseEther("1"), 6600, 0]
      );
      const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
        [await loot.getAddress(), await shares.getAddress(), await avatar.getAddress(), await multisend.getAddress(), governanceConfig,
         [await tributeNavigator.getAddress()], [2],
         [deployer.address], [ethers.parseEther("100")], [ethers.parseEther("0")], [], false, false]
      );
      await daoShip.setUp(initParams);

      // 3 loot = 3e18 wei → tribute = (3e18 * 50e18) / 1e18 = 150e18 tokens
      await tributeToken.connect(alice).approve(await tributeNavigator.getAddress(), ethers.parseEther("150"));

      const tx = await tributeNavigator.connect(alice)["onboard(uint256,uint256)"](0, ethers.parseEther("3"));
      await expect(tx)
        .to.emit(tributeNavigator, "Onboard")
        .withArgs(await daoShip.getAddress(), alice.address, ethers.parseEther("150"), 0, ethers.parseEther("3"));

      expect(await loot.balanceOf(alice.address)).to.equal(ethers.parseEther("3"));
      expect(await shares.balanceOf(alice.address)).to.equal(0n);
      expect(await tributeToken.balanceOf(await daoShip.avatar())).to.equal(ethers.parseEther("150"));
    });

    it("Should mint both shares and loot in one onboard call", async function () {
      const [deployer, alice] = await ethers.getSigners();

      const SharesERC20 = await ethers.getContractFactory("SharesERC20");
      const shares = await SharesERC20.deploy();
      const LootERC20 = await ethers.getContractFactory("LootERC20");
      const loot = await LootERC20.deploy();
      const daoShip = await deployDAOShipClone(deployer);
      const MockAvatar = await ethers.getContractFactory("MockAvatar");
      const avatar = await MockAvatar.deploy();
      await avatar.enableModule(await daoShip.getAddress());
      const MultiSend = await ethers.getContractFactory("MultiSend");
      const multisend = await MultiSend.deploy();
      await shares.transferOwnership(await daoShip.getAddress());
      await loot.transferOwnership(await daoShip.getAddress());

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const tributeToken = await MockERC20.deploy("Mock USDC", "USDC");
      await tributeToken.mint(alice.address, ethers.parseEther("1000"));

      // Dual navigator: 100 tokens per share, 50 tokens per loot
      const ERC20TributeNavigator = await ethers.getContractFactory("ERC20TributeNavigator");
      const tributeNavigator = await ERC20TributeNavigator.deploy(
        await daoShip.getAddress(),
        await tributeToken.getAddress(),
        ethers.parseEther("100"), // pricePerShare
        ethers.parseEther("50"),  // pricePerLoot
        0, 0, 0, ethers.ZeroHash
      );

      const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
        [7*24*60*60, 3*24*60*60, ethers.parseEther("0.1"), 2000, ethers.parseEther("1"), 6600, 0]
      );
      const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
        [await loot.getAddress(), await shares.getAddress(), await avatar.getAddress(), await multisend.getAddress(), governanceConfig,
         [await tributeNavigator.getAddress()], [2],
         [deployer.address], [ethers.parseEther("100")], [ethers.parseEther("0")], [], false, false]
      );
      await daoShip.setUp(initParams);

      // 2 shares + 4 loot
      // shares tribute = (2e18 * 100e18) / 1e18 = 200e18
      // loot tribute   = (4e18 *  50e18) / 1e18 = 200e18
      // total tribute  = 400e18
      await tributeToken.connect(alice).approve(await tributeNavigator.getAddress(), ethers.parseEther("400"));

      const tx = await tributeNavigator.connect(alice)["onboard(uint256,uint256)"](
        ethers.parseEther("2"), ethers.parseEther("4")
      );
      await expect(tx)
        .to.emit(tributeNavigator, "Onboard")
        .withArgs(await daoShip.getAddress(), alice.address, ethers.parseEther("400"), ethers.parseEther("2"), ethers.parseEther("4"));

      expect(await shares.balanceOf(alice.address)).to.equal(ethers.parseEther("2"));
      expect(await loot.balanceOf(alice.address)).to.equal(ethers.parseEther("4"));
      expect(await tributeToken.balanceOf(await daoShip.avatar())).to.equal(ethers.parseEther("400"));
    });

    it("Should reject onboarding after expiry", async function () {
      const [deployer, alice] = await ethers.getSigners();
      const currentTime = await time.latest();
      const expiryTime = currentTime + 7 * 24 * 60 * 60;

      const SharesERC20 = await ethers.getContractFactory("SharesERC20");
      const shares = await SharesERC20.deploy();
      const LootERC20 = await ethers.getContractFactory("LootERC20");
      const loot = await LootERC20.deploy();
      const daoShip = await deployDAOShipClone(deployer);
      const MockAvatar = await ethers.getContractFactory("MockAvatar");
      const avatar = await MockAvatar.deploy();
      await avatar.enableModule(await daoShip.getAddress());
      const MultiSend = await ethers.getContractFactory("MultiSend");
      const multisend = await MultiSend.deploy();
      await shares.transferOwnership(await daoShip.getAddress());
      await loot.transferOwnership(await daoShip.getAddress());

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const tributeToken = await MockERC20.deploy("Mock USDC", "USDC");
      await tributeToken.mint(alice.address, ethers.parseEther("10000"));

      const ERC20TributeNavigator = await ethers.getContractFactory("ERC20TributeNavigator");
      const tributeNavigator = await ERC20TributeNavigator.deploy(
        await daoShip.getAddress(),
        await tributeToken.getAddress(),
        ethers.parseEther("100"),
        0,
        expiryTime, // expiry set
        0,
        0,          // perAddressCap (unlimited)
        ethers.ZeroHash
      );

      const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
        [7*24*60*60, 3*24*60*60, ethers.parseEther("0.1"), 2000, ethers.parseEther("1"), 6600, 0]
      );
      const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
        [await loot.getAddress(), await shares.getAddress(), await avatar.getAddress(), await multisend.getAddress(), governanceConfig,
         [await tributeNavigator.getAddress()], [2],
         [deployer.address], [ethers.parseEther("100")], [ethers.parseEther("0")], [], false, false]
      );
      await daoShip.setUp(initParams);

      // Works before expiry
      await tributeToken.connect(alice).approve(await tributeNavigator.getAddress(), ethers.parseEther("10000"));
      await tributeNavigator.connect(alice)["onboard(uint256,uint256)"](ethers.parseEther("1"), 0);

      // Advance past expiry
      await time.increase(8 * 24 * 60 * 60);

      await expect(
        tributeNavigator.connect(alice)["onboard(uint256,uint256)"](ethers.parseEther("1"), 0)
      ).to.be.revertedWithCustomError(tributeNavigator, "Expired");
    });

    // ─── Gap 10: ERC20TributeNavigator pause/unpause governance ───────────────────
    it("Gap 10: Should allow avatar to pause ERC20TributeNavigator", async function () {
      const { tributeNavigator, daoShip } = await loadFixture(deployERC20TributeFixture);
      const avatarAddr = await daoShip.avatar();
      await ethers.provider.send("hardhat_setBalance", [avatarAddr, "0x1000000000000000000"]);
      const avatarSigner = await ethers.getImpersonatedSigner(avatarAddr);

      await tributeNavigator.connect(avatarSigner).pause();
      expect(await tributeNavigator.paused()).to.be.true;
    });

    it("Gap 10: Should allow avatar to unpause ERC20TributeNavigator", async function () {
      const { tributeNavigator, daoShip } = await loadFixture(deployERC20TributeFixture);
      const avatarAddr = await daoShip.avatar();
      await ethers.provider.send("hardhat_setBalance", [avatarAddr, "0x1000000000000000000"]);
      const avatarSigner = await ethers.getImpersonatedSigner(avatarAddr);

      await tributeNavigator.connect(avatarSigner).pause();
      await tributeNavigator.connect(avatarSigner).unpause();
      expect(await tributeNavigator.paused()).to.be.false;
    });

    it("Gap 10: Should reject pause from non-governor (regular member)", async function () {
      const { tributeNavigator, alice } = await loadFixture(deployERC20TributeFixture);
      // alice has no shares in this fixture — no navigator permission
      await expect(
        tributeNavigator.connect(alice).pause()
      ).to.be.revertedWithCustomError(tributeNavigator, "NotAuthorized");
    });

    it("Gap 10: Should allow GOVERNOR navigator to pause and unpause ERC20TributeNavigator", async function () {
      const { tributeNavigator, daoShip, deployer } = await loadFixture(deployERC20TributeFixture);

      // Grant deployer GOVERNOR navigator permission (4) via DAOShip impersonation
      const daoShipAddr = await daoShip.getAddress();
      await ethers.provider.send("hardhat_setBalance", [daoShipAddr, "0x1000000000000000000"]);
      const daoShipSigner = await ethers.getImpersonatedSigner(daoShipAddr);
      await daoShip.connect(daoShipSigner).setNavigators([deployer.address], [4]);

      await tributeNavigator.connect(deployer).pause();
      expect(await tributeNavigator.paused()).to.be.true;

      await tributeNavigator.connect(deployer).unpause();
      expect(await tributeNavigator.paused()).to.be.false;
    });

    it("Gap 10: Should revert onboard when paused", async function () {
      const { tributeNavigator, daoShip, alice, tributeToken } = await loadFixture(deployERC20TributeFixture);

      // Pause via avatar
      const avatarAddr = await daoShip.avatar();
      await ethers.provider.send("hardhat_setBalance", [avatarAddr, "0x1000000000000000000"]);
      const avatarSigner = await ethers.getImpersonatedSigner(avatarAddr);
      await tributeNavigator.connect(avatarSigner).pause();

      await tributeToken.connect(alice).approve(await tributeNavigator.getAddress(), ethers.parseEther("500"));
      await expect(
        tributeNavigator.connect(alice)["onboard(uint256,uint256)"](ethers.parseEther("1"), 0)
      ).to.be.revertedWithCustomError(tributeNavigator, "IsPaused");
    });
  });

  // ─── Gap 10: pause/unpause require GOVERNOR navigator or avatar ───────────────
  describe("Gap 10: Pause/unpause governance model", function () {
    it("Should allow avatar to pause", async function () {
      const { onboarder, daoShip } = await loadFixture(deployNavigatorFixture);
      const avatarAddr = await daoShip.avatar();
      await ethers.provider.send("hardhat_setBalance", [avatarAddr, "0x1000000000000000000"]);
      const avatarSigner = await ethers.getImpersonatedSigner(avatarAddr);

      await onboarder.connect(avatarSigner).pause();
      expect(await onboarder.paused()).to.be.true;
    });

    it("Should allow avatar to unpause", async function () {
      const { onboarder, daoShip } = await loadFixture(deployNavigatorFixture);
      const avatarAddr = await daoShip.avatar();
      await ethers.provider.send("hardhat_setBalance", [avatarAddr, "0x1000000000000000000"]);
      const avatarSigner = await ethers.getImpersonatedSigner(avatarAddr);

      await onboarder.connect(avatarSigner).pause();
      await onboarder.connect(avatarSigner).unpause();
      expect(await onboarder.paused()).to.be.false;
    });

    it("Should reject pause from a regular shareholder (not GOVERNOR navigator)", async function () {
      // deployer has 100 shares but no navigator permission — should be rejected
      const { onboarder, deployer } = await loadFixture(deployNavigatorFixture);

      await expect(
        onboarder.connect(deployer).pause()
      ).to.be.revertedWithCustomError(onboarder, "NotAuthorized");
    });

    it("Should allow GOVERNOR navigator to pause and unpause symmetrically", async function () {
      const { onboarder, daoShip, deployer } = await loadFixture(deployNavigatorFixture);

      const daoShipAddr = await daoShip.getAddress();
      await ethers.provider.send("hardhat_setBalance", [daoShipAddr, "0x1000000000000000000"]);
      const daoShipSigner = await ethers.getImpersonatedSigner(daoShipAddr);
      await daoShip.connect(daoShipSigner).setNavigators([deployer.address], [4]);

      await onboarder.connect(deployer).pause();
      expect(await onboarder.paused()).to.be.true;

      await onboarder.connect(deployer).unpause();
      expect(await onboarder.paused()).to.be.false;
    });
  });

  // ─── burnShares sponsorThreshold guard (tested from navigator perspective) ──
  describe("MANAGER navigator burnShares sponsorThreshold guard", function () {
    it("Should prevent MANAGER from burning shares below sponsorThreshold", async function () {
      // deployNavigatorFixture: deployer=100 shares, alice=50 shares, total=150, threshold=1 share
      // onboarder has MANAGER permission (2)
      // We need a scenario where burning would violate the guard.
      // The guard fires when: totalSupply < sponsorThreshold + totalToBurn
      // With threshold=1 and supply=150, a normal burn of 1 share is fine (149 >= 1+1? no, 150>=1+1=2 yes).
      // To hit the guard, we need threshold == supply. Re-deploy with matching values.
      const [deployer, alice, bob] = await ethers.getSigners();

      const SharesERC20 = await ethers.getContractFactory("SharesERC20");
      const shares = await SharesERC20.deploy();
      const LootERC20 = await ethers.getContractFactory("LootERC20");
      const loot = await LootERC20.deploy();
      const DAOShipFactory = await ethers.getContractFactory("DAOShip");
      const daoShipImpl = await DAOShipFactory.deploy();
      await daoShipImpl.waitForDeployment();
      const implAddr = (await daoShipImpl.getAddress()).slice(2).toLowerCase().padStart(40, "0");
      const cloneBytecode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implAddr}5af43d82803e903d91602b57fd5bf3`;
      const cloneFactory = new ethers.ContractFactory([], cloneBytecode, deployer);
      const cloneDeploy = await cloneFactory.deploy();
      await cloneDeploy.waitForDeployment();
      const daoShip = DAOShipFactory.attach(await cloneDeploy.getAddress()) as any;

      const MockAvatar = await ethers.getContractFactory("MockAvatar");
      const avatar = await MockAvatar.deploy();
      await avatar.enableModule(await daoShip.getAddress());
      const MultiSend = await ethers.getContractFactory("MultiSend");
      const multisend = await MultiSend.deploy();
      await shares.transferOwnership(await daoShip.getAddress());
      await loot.transferOwnership(await daoShip.getAddress());

      // sponsorThreshold = totalSupply = 100 shares; alice acts as MANAGER navigator
      const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
        [3600, 60, 0, 0, ethers.parseEther("100"), 0, 0]
      );
      const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
        [
          await loot.getAddress(), await shares.getAddress(), await avatar.getAddress(),
          await multisend.getAddress(), governanceConfig,
          [alice.address], [2], // alice is MANAGER navigator
          [deployer.address], [ethers.parseEther("100")], [0n], [], false, false
        ]
      );
      await daoShip.setUp(initParams);

      // alice is MANAGER — burnShares guard should block burning 1 share
      // totalSupply(100) < sponsorThreshold(100) + burn(1) = 101 → revert
      await expect(
        daoShip.connect(alice).burnShares([deployer.address], [ethers.parseEther("1")])
      ).to.be.revertedWithCustomError(daoShip, "BurnBreachesSponsorThreshold");
    });

    it("Should allow MANAGER to burn shares when supply remains above sponsorThreshold", async function () {
      // totalSupply=100 shares, sponsorThreshold=50 shares, burn 10 → 90 >= 50 OK
      const [deployer, alice] = await ethers.getSigners();

      const SharesERC20 = await ethers.getContractFactory("SharesERC20");
      const shares = await SharesERC20.deploy();
      const LootERC20 = await ethers.getContractFactory("LootERC20");
      const loot = await LootERC20.deploy();
      const DAOShipFactory = await ethers.getContractFactory("DAOShip");
      const daoShipImpl = await DAOShipFactory.deploy();
      await daoShipImpl.waitForDeployment();
      const implAddr = (await daoShipImpl.getAddress()).slice(2).toLowerCase().padStart(40, "0");
      const cloneBytecode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implAddr}5af43d82803e903d91602b57fd5bf3`;
      const cloneFactory = new ethers.ContractFactory([], cloneBytecode, deployer);
      const cloneDeploy = await cloneFactory.deploy();
      await cloneDeploy.waitForDeployment();
      const daoShip = DAOShipFactory.attach(await cloneDeploy.getAddress()) as any;

      const MockAvatar = await ethers.getContractFactory("MockAvatar");
      const avatar = await MockAvatar.deploy();
      await avatar.enableModule(await daoShip.getAddress());
      const MultiSend = await ethers.getContractFactory("MultiSend");
      const multisend = await MultiSend.deploy();
      await shares.transferOwnership(await daoShip.getAddress());
      await loot.transferOwnership(await daoShip.getAddress());

      const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
        [3600, 60, 0, 0, ethers.parseEther("50"), 0, 0]
      );
      const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
        [
          await loot.getAddress(), await shares.getAddress(), await avatar.getAddress(),
          await multisend.getAddress(), governanceConfig,
          [alice.address], [2], // alice is MANAGER navigator
          [deployer.address], [ethers.parseEther("100")], [0n], [], false, false
        ]
      );
      await daoShip.setUp(initParams);

      const supplyBefore = await shares.totalSupply();
      // 100 >= 50 + 10 = 60 → allowed
      await expect(
        daoShip.connect(alice).burnShares([deployer.address], [ethers.parseEther("10")])
      ).to.not.be.reverted;

      expect(await shares.totalSupply()).to.equal(supplyBefore - ethers.parseEther("10"));
    });
  });

  // ==========================================================================
  // OnboarderNavigator Merkle Allowlist
  // ==========================================================================
  describe("OnboarderNavigator Merkle Allowlist", function () {
    /**
     * Build a Merkle tree for a 2-leaf allowlist.
     * Uses OZ StandardMerkleTree compatible double-hash leaves:
     *   leaf = keccak256(bytes.concat(keccak256(abi.encode(address))))
     * For a 2-leaf tree, the root is hash(sorted(leafA, leafB)).
     * Proof for leafA is [leafB] and vice versa.
     */
    function buildMerkleTree(addresses: string[]) {
      const leaves = addresses.map(addr =>
        ethers.keccak256(ethers.concat([
          ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address"], [addr]))
        ]))
      );

      // Sort leaves for consistent root
      const sorted = [...leaves].sort((a, b) => {
        const aBn = BigInt(a);
        const bBn = BigInt(b);
        return aBn < bBn ? -1 : aBn > bBn ? 1 : 0;
      });

      // Root = keccak256(sorted[0] ++ sorted[1])
      const root = ethers.keccak256(
        ethers.solidityPacked(["bytes32", "bytes32"], [sorted[0], sorted[1]])
      );

      // Proof for each leaf is the other leaf
      const proofs: { [addr: string]: string[] } = {};
      for (let i = 0; i < addresses.length; i++) {
        const myLeaf = leaves[i];
        const otherLeaf = leaves[1 - i]; // only works for 2-leaf tree
        proofs[addresses[i]] = [otherLeaf];
      }

      return { root, leaves, proofs };
    }

    async function deployMerkleAllowlistFixture() {
      const [deployer, alice, bob, carol] = await ethers.getSigners();

      const SharesERC20 = await ethers.getContractFactory("SharesERC20");
      const shares = await SharesERC20.deploy();
      const LootERC20 = await ethers.getContractFactory("LootERC20");
      const loot = await LootERC20.deploy();
      const daoShip = await deployDAOShipClone(deployer);
      const MockAvatar = await ethers.getContractFactory("MockAvatar");
      const avatar = await MockAvatar.deploy();
      await avatar.enableModule(await daoShip.getAddress());
      const MultiSend = await ethers.getContractFactory("MultiSend");
      const multisend = await MultiSend.deploy();
      await shares.transferOwnership(await daoShip.getAddress());
      await loot.transferOwnership(await daoShip.getAddress());

      // Build Merkle tree for alice and bob
      const { root, proofs } = buildMerkleTree([alice.address, bob.address]);

      // Deploy OnboarderNavigator with Merkle allowlist
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
        root    // allowlistRoot
      );

      const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
        [7*24*60*60, 3*24*60*60, ethers.parseEther("0.1"), 2000, ethers.parseEther("1"), 6600, 0]
      );

      const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
        [await loot.getAddress(), await shares.getAddress(), await avatar.getAddress(), await multisend.getAddress(), governanceConfig,
         [await onboarder.getAddress()], [2],
         [deployer.address, alice.address], [ethers.parseEther("100"), ethers.parseEther("50")], [ethers.parseEther("0"), ethers.parseEther("25")],
         [], false, false]
      );

      await daoShip.setUp(initParams);

      return { daoShip, shares, loot, avatar, onboarder, deployer, alice, bob, carol, proofs, root };
    }

    it("alice onboards with valid proof — succeeds", async function () {
      const { shares, onboarder, alice, proofs } = await loadFixture(deployMerkleAllowlistFixture);

      const aliceSharesBefore = await shares.balanceOf(alice.address);

      await onboarder.connect(alice)["onboard(bytes32[])"](proofs[alice.address], {
        value: ethers.parseEther("0.1"),
      });

      // 0.1 ETH * 20000/10000 = 0.2e18 shares
      const aliceSharesAfter = await shares.balanceOf(alice.address);
      expect(aliceSharesAfter - aliceSharesBefore).to.equal(ethers.parseEther("0.2"));
    });

    it("carol onboards with invalid proof — reverts NotAllowlisted", async function () {
      const { onboarder, carol } = await loadFixture(deployMerkleAllowlistFixture);

      // Carol is not in the allowlist — provide a bogus proof
      await expect(
        onboarder.connect(carol)["onboard(bytes32[])"](
          [ethers.keccak256(ethers.toUtf8Bytes("bogus"))],
          { value: ethers.parseEther("0.1") }
        )
      ).to.be.revertedWithCustomError(onboarder, "NotAllowlisted");
    });

    it("bob onboards without proof (empty array) — reverts NotAllowlisted", async function () {
      const { onboarder, bob } = await loadFixture(deployMerkleAllowlistFixture);

      // Bob is in the allowlist but provides no proof
      await expect(
        onboarder.connect(bob)["onboard(bytes32[])"]([], { value: ethers.parseEther("0.1") })
      ).to.be.revertedWithCustomError(onboarder, "NotAllowlisted");
    });

    it("bob onboards with valid proof — succeeds", async function () {
      const { shares, onboarder, bob, proofs } = await loadFixture(deployMerkleAllowlistFixture);

      const bobSharesBefore = await shares.balanceOf(bob.address);

      await onboarder.connect(bob)["onboard(bytes32[])"](proofs[bob.address], {
        value: ethers.parseEther("0.5"),
      });

      // 0.5 ETH * 20000/10000 = 1e18 shares
      const bobSharesAfter = await shares.balanceOf(bob.address);
      expect(bobSharesAfter - bobSharesBefore).to.equal(ethers.parseEther("1"));
    });
  });

  // ==========================================================================
  // navigatorType constant
  // ==========================================================================
  describe("navigatorType constant", function () {
    it("OnboarderNavigator should return correct navigatorType", async function () {
      const { onboarder } = await loadFixture(deployNavigatorFixture);
      expect(await onboarder.navigatorType()).to.equal("OnboarderNavigator");
    });

    it("ERC20TributeNavigator should return correct navigatorType", async function () {
      const { daoShip } = await loadFixture(deployDAOShipFixture);

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const token = await MockERC20.deploy("Test", "TT");

      const ERC20TributeNavigator = await ethers.getContractFactory("ERC20TributeNavigator");
      const navigator = await ERC20TributeNavigator.deploy(
        await daoShip.getAddress(),
        await token.getAddress(),
        ethers.parseEther("1"), 0, 0, 0, 0, ethers.ZeroHash
      );

      expect(await navigator.navigatorType()).to.equal("ERC20TributeNavigator");
    });
  });

  describe("ERC20TributeNavigator (Permit)", function () {
    // Helper: sign an ERC-2612 permit
    async function signPermit(
      token: any,
      owner: any,
      spender: string,
      value: bigint,
      deadline: number
    ) {
      const name = await token.name();
      const nonce = await token.nonces(owner.address);
      const chainId = (await owner.provider.getNetwork()).chainId;

      const domain = {
        name,
        version: "1",
        chainId,
        verifyingContract: await token.getAddress(),
      };

      const types = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };

      const message = { owner: owner.address, spender, value, nonce, deadline };
      const signature = await owner.signTypedData(domain, types, message);
      const { v, r, s } = ethers.Signature.from(signature);
      return { v, r, s, deadline };
    }

    async function deployPermitFixture() {
      const [deployer, alice, bob] = await ethers.getSigners();

      const SharesERC20 = await ethers.getContractFactory("SharesERC20");
      const shares = await SharesERC20.deploy();
      const LootERC20 = await ethers.getContractFactory("LootERC20");
      const loot = await LootERC20.deploy();
      const daoShip = await deployDAOShipClone(deployer);
      const MockAvatar = await ethers.getContractFactory("MockAvatar");
      const avatar = await MockAvatar.deploy();
      await avatar.enableModule(await daoShip.getAddress());
      const MultiSend = await ethers.getContractFactory("MultiSend");
      const multisend = await MultiSend.deploy();
      await shares.transferOwnership(await daoShip.getAddress());
      await loot.transferOwnership(await daoShip.getAddress());

      // Deploy MockERC20Permit as tribute token
      const MockERC20Permit = await ethers.getContractFactory("MockERC20Permit");
      const tributeToken = await MockERC20Permit.deploy("Mock USDC", "USDC");
      await tributeToken.mint(alice.address, ethers.parseEther("10000"));
      await tributeToken.mint(bob.address, ethers.parseEther("10000"));

      // Deploy ERC20TributeNavigator: 100 tokens per share
      const ERC20TributeNavigator = await ethers.getContractFactory("ERC20TributeNavigator");
      const tributeNavigator = await ERC20TributeNavigator.deploy(
        await daoShip.getAddress(),
        await tributeToken.getAddress(),
        ethers.parseEther("100"),  // pricePerShare
        0,                         // pricePerLoot
        0, 0, 0,                   // no expiry, no caps
        ethers.ZeroHash            // open
      );

      const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
        [7*24*60*60, 3*24*60*60, ethers.parseEther("0.1"), 2000, ethers.parseEther("1"), 6600, 0]
      );

      const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
        [await loot.getAddress(), await shares.getAddress(), await avatar.getAddress(), await multisend.getAddress(), governanceConfig,
         [await tributeNavigator.getAddress()], [2],
         [deployer.address], [ethers.parseEther("100")], [ethers.parseEther("0")], [], false, false]
      );

      await daoShip.setUp(initParams);
      return { daoShip, shares, loot, avatar, tributeToken, tributeNavigator, deployer, alice, bob };
    }

    it("Should onboard with valid permit signature (single tx)", async function () {
      const { shares, avatar, tributeToken, tributeNavigator, alice, daoShip } =
        await loadFixture(deployPermitFixture);

      const sharesToMint = ethers.parseEther("5");
      const tributeAmount = ethers.parseEther("500"); // 5 * 100
      const deadline = (await time.latest()) + 3600;

      const { v, r, s } = await signPermit(
        tributeToken, alice, await tributeNavigator.getAddress(), tributeAmount, deadline
      );

      // No approve() needed — permit handles it
      const tx = await tributeNavigator.connect(alice).onboardWithPermit(
        sharesToMint, 0, [], deadline, v, r, s
      );

      await expect(tx)
        .to.emit(tributeNavigator, "Onboard")
        .withArgs(await daoShip.getAddress(), alice.address, tributeAmount, sharesToMint, 0);

      expect(await shares.balanceOf(alice.address)).to.equal(sharesToMint);
      expect(await tributeToken.balanceOf(await daoShip.avatar())).to.equal(tributeAmount);
    });

    it("Should survive permit front-run (try/catch absorbs stale nonce)", async function () {
      const { tributeToken, tributeNavigator, alice, bob, shares } =
        await loadFixture(deployPermitFixture);

      const sharesToMint = ethers.parseEther("5");
      const tributeAmount = ethers.parseEther("500");
      const navigatorAddr = await tributeNavigator.getAddress();
      const deadline = (await time.latest()) + 3600;

      const { v, r, s } = await signPermit(
        tributeToken, alice, navigatorAddr, tributeAmount, deadline
      );

      // Bob front-runs: submits the permit on-chain, consuming alice's nonce
      await tributeToken.connect(bob).permit(
        alice.address, navigatorAddr, tributeAmount, deadline, v, r, s
      );

      // Alice's onboardWithPermit should still succeed — permit fails in try/catch,
      // but the allowance was already set by Bob's front-run
      const tx = await tributeNavigator.connect(alice).onboardWithPermit(
        sharesToMint, 0, [], deadline, v, r, s
      );

      await expect(tx).to.emit(tributeNavigator, "Onboard");
      expect(await shares.balanceOf(alice.address)).to.equal(sharesToMint);
    });

    it("Should succeed on retry when permit already consumed but approval exists", async function () {
      const { tributeToken, tributeNavigator, alice, shares } =
        await loadFixture(deployPermitFixture);

      const sharesToMint = ethers.parseEther("5");
      const tributeAmount = ethers.parseEther("500");
      const navigatorAddr = await tributeNavigator.getAddress();
      const deadline = (await time.latest()) + 3600;

      const { v, r, s } = await signPermit(
        tributeToken, alice, navigatorAddr, tributeAmount, deadline
      );

      // Alice submits the permit directly (consuming nonce)
      await tributeToken.connect(alice).permit(
        alice.address, navigatorAddr, tributeAmount, deadline, v, r, s
      );

      // Retry: onboardWithPermit with stale signature — permit fails, falls through to allowance
      const tx = await tributeNavigator.connect(alice).onboardWithPermit(
        sharesToMint, 0, [], deadline, v, r, s
      );

      await expect(tx).to.emit(tributeNavigator, "Onboard");
      expect(await shares.balanceOf(alice.address)).to.equal(sharesToMint);
    });

    it("Should revert when permit fails and no prior approval exists", async function () {
      const { tributeToken, tributeNavigator, alice } =
        await loadFixture(deployPermitFixture);

      // Sign permit with wrong value — permit will fail, no fallback allowance
      const deadline = (await time.latest()) + 3600;
      const { v, r, s } = await signPermit(
        tributeToken, alice, await tributeNavigator.getAddress(), 1n, deadline // wrong amount
      );

      // permit fails (sets allowance to 1, but transfer needs 500e18) — safeTransferFrom reverts
      await expect(
        tributeNavigator.connect(alice).onboardWithPermit(
          ethers.parseEther("5"), 0, [], deadline, v, r, s
        )
      ).to.be.reverted;
    });

    it("Should revert with expired permit deadline and no prior approval", async function () {
      const { tributeToken, tributeNavigator, alice } =
        await loadFixture(deployPermitFixture);

      const deadline = (await time.latest()) - 1; // already expired
      const { v, r, s } = await signPermit(
        tributeToken, alice, await tributeNavigator.getAddress(), ethers.parseEther("500"), deadline
      );

      // permit fails (expired), no allowance, safeTransferFrom reverts
      await expect(
        tributeNavigator.connect(alice).onboardWithPermit(
          ethers.parseEther("5"), 0, [], deadline, v, r, s
        )
      ).to.be.reverted;
    });

    it("Should work with non-permit token when prior approval exists", async function () {
      const { shares, daoShip } = await loadFixture(deployPermitFixture);
      const [deployer, alice] = await ethers.getSigners();

      // Deploy a navigator with a standard MockERC20 (no permit support)
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const plainToken = await MockERC20.deploy("Plain Token", "PLAIN");
      await plainToken.mint(alice.address, ethers.parseEther("10000"));

      const daoShip2 = await deployDAOShipClone(deployer);
      const SharesERC20 = await ethers.getContractFactory("SharesERC20");
      const shares2 = await SharesERC20.deploy();
      const LootERC20 = await ethers.getContractFactory("LootERC20");
      const loot2 = await LootERC20.deploy();
      const MockAvatar = await ethers.getContractFactory("MockAvatar");
      const avatar2 = await MockAvatar.deploy();
      await avatar2.enableModule(await daoShip2.getAddress());
      const MultiSend = await ethers.getContractFactory("MultiSend");
      const multisend2 = await MultiSend.deploy();
      await shares2.transferOwnership(await daoShip2.getAddress());
      await loot2.transferOwnership(await daoShip2.getAddress());

      const ERC20TributeNavigator = await ethers.getContractFactory("ERC20TributeNavigator");
      const nav = await ERC20TributeNavigator.deploy(
        await daoShip2.getAddress(), await plainToken.getAddress(),
        ethers.parseEther("100"), 0, 0, 0, 0, ethers.ZeroHash
      );

      const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
        [7*24*60*60, 3*24*60*60, ethers.parseEther("0.1"), 2000, ethers.parseEther("1"), 6600, 0]
      );
      const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
        [await loot2.getAddress(), await shares2.getAddress(), await avatar2.getAddress(), await multisend2.getAddress(), governanceConfig,
         [await nav.getAddress()], [2],
         [deployer.address], [ethers.parseEther("100")], [ethers.parseEther("0")], [], false, false]
      );
      await daoShip2.setUp(initParams);

      // Approve manually, then call onboardWithPermit with garbage signature
      await plainToken.connect(alice).approve(await nav.getAddress(), ethers.parseEther("500"));

      // permit call will fail on non-permit token — try/catch absorbs, uses existing approval
      const tx = await nav.connect(alice).onboardWithPermit(
        ethers.parseEther("5"), 0, [],
        0, 0, ethers.ZeroHash, ethers.ZeroHash // garbage permit params
      );

      await expect(tx).to.emit(nav, "Onboard");
      expect(await shares2.balanceOf(alice.address)).to.equal(ethers.parseEther("5"));
    });

    it("Standard onboard(uint256,uint256) still works after refactor", async function () {
      const { shares, tributeToken, tributeNavigator, alice } =
        await loadFixture(deployPermitFixture);

      await tributeToken.connect(alice).approve(
        await tributeNavigator.getAddress(), ethers.parseEther("500")
      );

      await tributeNavigator.connect(alice)["onboard(uint256,uint256)"](
        ethers.parseEther("5"), 0
      );

      expect(await shares.balanceOf(alice.address)).to.equal(ethers.parseEther("5"));
    });

    it("Standard onboard(uint256,uint256,bytes32[]) still works after refactor", async function () {
      const { shares, tributeToken, tributeNavigator, alice } =
        await loadFixture(deployPermitFixture);

      await tributeToken.connect(alice).approve(
        await tributeNavigator.getAddress(), ethers.parseEther("500")
      );

      await tributeNavigator.connect(alice)["onboard(uint256,uint256,bytes32[])"](
        ethers.parseEther("5"), 0, []
      );

      expect(await shares.balanceOf(alice.address)).to.equal(ethers.parseEther("5"));
    });
  });
});
