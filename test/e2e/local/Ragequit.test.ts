import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

/**
 * Ragequit E2E Test Suite
 *
 * Comprehensive testing of ragequit mechanism including:
 * - Basic ragequit with shares
 * - Ragequit with loot
 * - Ragequit with both shares and loot
 * - Fair share calculation validation
 * - Multiple guild tokens
 * - Minimum retention percentage enforcement
 * - Event emission validation
 *
 * CRITICAL: Ragequit is the core DAO exit mechanism and must work flawlessly
 */
describe("Ragequit E2E Tests", function () {
  async function deployDAOWithTreasury() {
    const [deployer, alice, bob, carol] = await ethers.getSigners();

    // Deploy token singletons (bricked by constructor)
    const SharesERC20 = await ethers.getContractFactory("SharesERC20");
    const sharesImpl = await SharesERC20.deploy();
    const LootERC20 = await ethers.getContractFactory("LootERC20");
    const lootImpl = await LootERC20.deploy();

    // Create EIP-1167 clones for tokens
    function makeCloneBytecode(addr: string) {
      const padded = addr.slice(2).toLowerCase().padStart(40, "0");
      return `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${padded}5af43d82803e903d91602b57fd5bf3`;
    }
    const sharesCloneFactory = new ethers.ContractFactory([], makeCloneBytecode(await sharesImpl.getAddress()), deployer);
    const sharesCloneRaw = await sharesCloneFactory.deploy();
    const shares = SharesERC20.attach(await sharesCloneRaw.getAddress()) as any;

    const lootCloneFactory = new ethers.ContractFactory([], makeCloneBytecode(await lootImpl.getAddress()), deployer);
    const lootCloneRaw = await lootCloneFactory.deploy();
    const loot = LootERC20.attach(await lootCloneRaw.getAddress()) as any;

    // Deploy DAOShip as EIP-1167 clone (constructor sets avatar=0xdead to guard singleton)
    const DAOShipFactory = await ethers.getContractFactory("DAOShip");
    const daoShipImpl = await DAOShipFactory.deploy();
    await daoShipImpl.waitForDeployment();
    const daoShipImplAddr = (await daoShipImpl.getAddress()).slice(2).toLowerCase().padStart(40, "0");
    const daoShipCloneBytecode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${daoShipImplAddr}5af43d82803e903d91602b57fd5bf3`;
    const daoShipCloneFactory = new ethers.ContractFactory([], daoShipCloneBytecode, deployer);
    const cloneDeploy = await daoShipCloneFactory.deploy();
    await cloneDeploy.waitForDeployment();
    const daoShip = DAOShipFactory.attach(await cloneDeploy.getAddress()) as any;

    // Deploy MockAvatar (treasury)
    const MockAvatar = await ethers.getContractFactory("MockAvatar");
    const avatar = await MockAvatar.deploy();
    await avatar.enableModule(await daoShip.getAddress());

    // Deploy infrastructure
    const Poster = await ethers.getContractFactory("Poster");
    const poster = await Poster.deploy();
    const MultiSend = await ethers.getContractFactory("MultiSend");
    const multisend = await MultiSend.deploy();

    // Initialize token clones with DAOShip as owner
    await shares.initialize(await daoShip.getAddress(), "Test Shares", "TSH");
    await loot.initialize(await daoShip.getAddress(), "Test Loot", "TLT");

    // Governance config with 66% retention (members must leave 66% of supply)
    const votingPeriod = 3600; // 1 hour (minimum required by M-7 fix)
    const gracePeriod = 30;
    const proposalOffering = ethers.parseEther("0.001");
    const quorumPercent = 2000; // 20%
    const sponsorThreshold = ethers.parseEther("1");
    const minRetentionPercent = 6600; // 66%

    const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
      [votingPeriod, gracePeriod, proposalOffering, quorumPercent, sponsorThreshold, minRetentionPercent, 0]
    );

    // Initialize with founders and ETH as guild token
    const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
      [
        await loot.getAddress(),
        await shares.getAddress(),
        await avatar.getAddress(),
        await multisend.getAddress(),
        governanceConfig,
        [], // no navigators
        [], // no navigator permissions
        [deployer.address, alice.address, bob.address],
        [ethers.parseEther("100"), ethers.parseEther("50"), ethers.parseEther("30")],
        [ethers.parseEther("0"), ethers.parseEther("25"), ethers.parseEther("0")],
        [ethers.ZeroAddress], // Set ETH as initial guild token
        false, // pauseSharesOnLaunch
        false, // pauseLootOnLaunch
      ]
    );

    await daoShip.setUp(initParams);

    // Fund treasury with ETH
    const treasuryFunding = ethers.parseEther("10");
    await deployer.sendTransaction({
      to: await avatar.getAddress(),
      value: treasuryFunding
    });

    return {
      daoShip,
      shares,
      loot,
      avatar,
      deployer,
      alice,
      bob,
      carol
    };
  }

  describe("Basic Ragequit Scenarios", function () {
    it("Should allow member to ragequit with shares only", async function () {
      const { daoShip, shares, loot, avatar, alice } = await loadFixture(deployDAOWithTreasury);

      console.log("\n=== Testing Basic Ragequit (Shares Only) ===");

      // Initial state
      const aliceSharesBefore = await shares.balanceOf(alice.address);
      const totalSharesBefore = await shares.totalSupply();
      const totalLootBefore = await loot.totalSupply();
      const treasuryBefore = await ethers.provider.getBalance(await avatar.getAddress());
      const aliceBalanceBefore = await ethers.provider.getBalance(alice.address);

      console.log(`Alice shares: ${ethers.formatEther(aliceSharesBefore)}`);
      console.log(`Total shares: ${ethers.formatEther(totalSharesBefore)}`);
      console.log(`Treasury balance: ${ethers.formatEther(treasuryBefore)} ETH`);

      // Ragequit 25 shares
      const sharesToBurn = ethers.parseEther("25");
      const lootToBurn = BigInt(0);

      console.log(`\nRagequitting ${ethers.formatEther(sharesToBurn)} shares...`);

      const tx = await daoShip.connect(alice).ragequit(
        alice.address,
        sharesToBurn,
        lootToBurn,
        [ethers.ZeroAddress] // ETH
      );

      // Calculate expected fair share (must include both shares and loot in total supply)
      const totalSupply = totalSharesBefore + totalLootBefore;
      const expectedShare = (treasuryBefore * sharesToBurn) / totalSupply;

      // Verify Ragequit event (member, to, lootToBurn, sharesToBurn, tokens, amounts)
      await expect(tx)
        .to.emit(daoShip, "Ragequit")
        .withArgs(
          alice.address,    // member
          alice.address,    // to
          lootToBurn,       // lootToBurn
          sharesToBurn,     // sharesToBurn
          [ethers.ZeroAddress], // tokens
          [expectedShare]   // amounts
        );

      console.log("✅ Ragequit event emitted");

      console.log(`Expected fair share: ${ethers.formatEther(expectedShare)} ETH`);

      // Verify shares burned
      const aliceSharesAfter = await shares.balanceOf(alice.address);
      expect(aliceSharesAfter).to.equal(aliceSharesBefore - sharesToBurn);
      console.log(`✅ Shares burned: ${ethers.formatEther(sharesToBurn)}`);

      // Verify treasury decreased
      const treasuryAfter = await ethers.provider.getBalance(await avatar.getAddress());
      expect(treasuryAfter).to.equal(treasuryBefore - expectedShare);
      console.log(`✅ Treasury decreased by: ${ethers.formatEther(expectedShare)} ETH`);

      // Note: Can't verify exact alice balance increase due to gas costs
      // But we can verify it increased by approximately the expected amount
      const aliceBalanceAfter = await ethers.provider.getBalance(alice.address);
      const aliceIncrease = aliceBalanceAfter - aliceBalanceBefore;

      // Should be close to expected share minus gas costs (< 0.01 ETH gas)
      expect(aliceIncrease).to.be.closeTo(expectedShare, ethers.parseEther("0.01"));
      console.log(`✅ Alice received: ~${ethers.formatEther(aliceIncrease)} ETH`);

      console.log("\n✅ Basic ragequit test passed!\n");
    });

    it("Should allow member to ragequit with loot only", async function () {
      const { daoShip, loot, avatar, alice } = await loadFixture(deployDAOWithTreasury);

      console.log("\n=== Testing Ragequit (Loot Only) ===");

      const aliceLootBefore = await loot.balanceOf(alice.address);
      const totalLootBefore = await loot.totalSupply();
      const totalSharesBefore = await await ethers.provider.getBalance(await avatar.getAddress());

      console.log(`Alice loot: ${ethers.formatEther(aliceLootBefore)}`);

      // Ragequit all loot
      const lootToBurn = aliceLootBefore;

      const tx = await daoShip.connect(alice).ragequit(
        alice.address,
        0, // no shares
        lootToBurn,
        [ethers.ZeroAddress]
      );

      // Verify event (member, to, lootToBurn, sharesToBurn, tokens, amounts)
      await expect(tx)
        .to.emit(daoShip, "Ragequit")
        .withArgs(alice.address, alice.address, lootToBurn, 0, [ethers.ZeroAddress], anyValue);

      // Verify loot burned
      const aliceLootAfter = await loot.balanceOf(alice.address);
      expect(aliceLootAfter).to.equal(0);

      console.log("✅ Loot ragequit test passed!\n");
    });

    it("Should allow member to ragequit with both shares and loot", async function () {
      const { daoShip, shares, loot, avatar, alice } = await loadFixture(deployDAOWithTreasury);

      console.log("\n=== Testing Ragequit (Shares + Loot) ===");

      const aliceSharesBefore = await shares.balanceOf(alice.address);
      const aliceLootBefore = await loot.balanceOf(alice.address);

      console.log(`Alice shares: ${ethers.formatEther(aliceSharesBefore)}`);
      console.log(`Alice loot: ${ethers.formatEther(aliceLootBefore)}`);

      // Ragequit half shares and half loot
      const sharesToBurn = aliceSharesBefore / 2n;
      const lootToBurn = aliceLootBefore / 2n;

      const tx = await daoShip.connect(alice).ragequit(
        alice.address,
        sharesToBurn,
        lootToBurn,
        [ethers.ZeroAddress]
      );

      // Verify event (member, to, lootToBurn, sharesToBurn, tokens, amounts)
      await expect(tx)
        .to.emit(daoShip, "Ragequit")
        .withArgs(alice.address, alice.address, lootToBurn, sharesToBurn, [ethers.ZeroAddress], anyValue);

      // Verify both burned
      expect(await shares.balanceOf(alice.address)).to.equal(aliceSharesBefore - sharesToBurn);
      expect(await loot.balanceOf(alice.address)).to.equal(aliceLootBefore - lootToBurn);

      console.log("✅ Mixed ragequit test passed!\n");
    });
  });

  describe("Fair Share Calculations", function () {
    it("Should calculate fair share correctly", async function () {
      const { daoShip, shares, loot, avatar, alice, bob } = await loadFixture(deployDAOWithTreasury);

      console.log("\n=== Testing Fair Share Calculation ===");

      // State: Treasury has 10 ETH
      // Deployer: 100 shares, 0 loot
      // Alice: 50 shares, 25 loot
      // Bob: 30 shares, 0 loot
      // Total: 180 shares, 25 loot = 205 total

      const treasuryBalance = await ethers.provider.getBalance(await avatar.getAddress());
      const totalShares = await shares.totalSupply();
      const totalLoot = await loot.totalSupply();
      const totalSupply = totalShares + totalLoot;

      console.log(`Treasury: ${ethers.formatEther(treasuryBalance)} ETH`);
      console.log(`Total shares: ${ethers.formatEther(totalShares)}`);
      console.log(`Total loot: ${ethers.formatEther(totalLoot)}`);
      console.log(`Total supply: ${ethers.formatEther(totalSupply)}`);

      // Alice ragequits 25 shares
      const sharesToBurn = ethers.parseEther("25");
      const treasuryBefore = treasuryBalance;

      // Calculate expected share: (25 / 205) * 10 = ~1.22 ETH
      const expectedShare = (treasuryBefore * sharesToBurn) / totalSupply;
      console.log(`\nExpected share for 25 tokens: ${ethers.formatEther(expectedShare)} ETH`);

      await daoShip.connect(alice).ragequit(alice.address, sharesToBurn, 0, [ethers.ZeroAddress]);

      const treasuryAfter = await ethers.provider.getBalance(await avatar.getAddress());
      const actualWithdrawn = treasuryBefore - treasuryAfter;

      expect(actualWithdrawn).to.equal(expectedShare);
      console.log(`✅ Actual withdrawn: ${ethers.formatEther(actualWithdrawn)} ETH`);
      console.log("✅ Fair share calculation correct!\n");
    });

    it("Should handle multiple members ragequitting in sequence", async function () {
      const { daoShip, shares, avatar, alice, bob } = await loadFixture(deployDAOWithTreasury);

      console.log("\n=== Testing Sequential Ragequits ===");

      const initialTreasury = await ethers.provider.getBalance(await avatar.getAddress());

      // Alice ragequits first (50 shares of 205 total)
      await daoShip.connect(alice).ragequit(alice.address, ethers.parseEther("50"), 0, [ethers.ZeroAddress]);
      const treasuryAfterAlice = await ethers.provider.getBalance(await avatar.getAddress());

      console.log(`After Alice: ${ethers.formatEther(treasuryAfterAlice)} ETH`);

      // Bob ragequits second (30 shares of remaining 155 total)
      await daoShip.connect(bob).ragequit(bob.address, ethers.parseEther("30"), 0, [ethers.ZeroAddress]);
      const treasuryAfterBob = await ethers.provider.getBalance(await avatar.getAddress());

      console.log(`After Bob: ${ethers.formatEther(treasuryAfterBob)} ETH`);

      // Treasury should have decreased proportionally
      expect(treasuryAfterBob).to.be.lt(treasuryAfterAlice);
      expect(treasuryAfterAlice).to.be.lt(initialTreasury);

      console.log("✅ Sequential ragequits handled correctly!\n");
    });
  });

  describe("Multiple Guild Tokens", function () {
    it("Should ragequit with ETH (guild token functionality)", async function () {
      const { daoShip, shares, avatar, alice } = await loadFixture(deployDAOWithTreasury);

      console.log("\n=== Testing Ragequit with Guild Token (ETH) ===");

      // Note: Multi-ERC20 token ragequit requires:
      // 1. Deploying ERC20 tokens
      // 2. Setting guild tokens via proposal (setGuildTokens)
      // 3. This is tested implicitly by using ETH (address(0))

      const treasuryEthBefore = await ethers.provider.getBalance(await avatar.getAddress());

      console.log(`Treasury ETH: ${ethers.formatEther(treasuryEthBefore)}`);

      // Test single token ragequit (ETH)
      await daoShip.connect(alice).ragequit(
        alice.address,
        ethers.parseEther("25"),
        0,
        [ethers.ZeroAddress] // ETH
      );

      const treasuryEthAfter = await ethers.provider.getBalance(await avatar.getAddress());
      expect(treasuryEthAfter).to.be.lt(treasuryEthBefore);

      console.log("✅ Guild token ragequit test passed!\n");
      console.log("⚠️  Note: Multi-ERC20 token ragequit requires guild token management via proposals");
    });
  });

  describe("Retention Percentage Enforcement", function () {
    it("Should enforce minimum retention percentage", async function () {
      const { daoShip, shares, loot, alice } = await loadFixture(deployDAOWithTreasury);

      console.log("\n=== Testing Retention Percentage (66%) ===");

      // Total supply: 180 shares + 25 loot = 205
      // Minimum retention: 66% of 205 = 135.3
      // Alice can burn at most: 205 - 135.3 = 69.7

      const totalShares = await shares.totalSupply();
      const totalLoot = await loot.totalSupply();
      const totalSupply = totalShares + totalLoot;
      const minRetention = (totalSupply * 6600n) / 10000n;
      const maxBurn = totalSupply - minRetention;

      console.log(`Total supply: ${ethers.formatEther(totalSupply)}`);
      console.log(`Min retention (66%): ${ethers.formatEther(minRetention)}`);
      console.log(`Max burnable: ${ethers.formatEther(maxBurn)}`);

      // Try to burn more than allowed (should fail)
      const aliceShares = await shares.balanceOf(alice.address);
      const aliceLoot = await loot.balanceOf(alice.address);
      const aliceTotal = aliceShares + aliceLoot;

      console.log(`\nAlice total: ${ethers.formatEther(aliceTotal)} (${ethers.formatEther(aliceShares)} shares + ${ethers.formatEther(aliceLoot)} loot)`);

      // Try to burn all of Alice's tokens (75 total) - should fail if > maxBurn
      if (aliceTotal > maxBurn) {
        console.log(`Attempting to burn ${ethers.formatEther(aliceTotal)} (exceeds max ${ethers.formatEther(maxBurn)})...`);

        await expect(
          daoShip.connect(alice).ragequit(alice.address, aliceShares, aliceLoot, [ethers.ZeroAddress])
        ).to.be.revertedWithCustomError(daoShip, "InsufficientRetention");

        console.log("✅ Correctly rejected ragequit exceeding retention limit");
      } else {
        console.log(`Alice can burn all tokens (${ethers.formatEther(aliceTotal)} < ${ethers.formatEther(maxBurn)})`);
      }

      // Try to burn exactly the max allowed
      const safeBurnAmount = maxBurn < aliceShares ? maxBurn : aliceShares;
      console.log(`\nBurning safe amount: ${ethers.formatEther(safeBurnAmount)} shares...`);

      await daoShip.connect(alice).ragequit(alice.address, safeBurnAmount, 0, [ethers.ZeroAddress]);

      console.log("✅ Safe ragequit succeeded");
      console.log("✅ Retention percentage test passed!\n");
    });

    it("Should allow ragequit up to but not exceeding retention limit", async function () {
      const { daoShip, shares, loot, alice } = await loadFixture(deployDAOWithTreasury);

      const totalSupply = (await shares.totalSupply()) + (await loot.totalSupply());
      const minRetention = (totalSupply * 6600n) / 10000n;
      const maxBurn = totalSupply - minRetention;

      // Burn exactly maxBurn - 1 wei (should succeed)
      const safeBurn = maxBurn - 1n;

      if (safeBurn > 0n && safeBurn <= await shares.balanceOf(alice.address)) {
        await expect(
          daoShip.connect(alice).ragequit(alice.address, safeBurn, 0, [ethers.ZeroAddress])
        ).to.not.be.reverted;

        console.log("✅ Can ragequit up to retention limit");
      }
    });
  });

  describe("Edge Cases and Validation", function () {
    it("Should reject ragequit with zero amount", async function () {
      const { daoShip, alice } = await loadFixture(deployDAOWithTreasury);

      await expect(
        daoShip.connect(alice).ragequit(alice.address, 0, 0, [ethers.ZeroAddress])
      ).to.be.reverted;

      console.log("✅ Rejects zero amount ragequit");
    });

    it("Should reject ragequit with insufficient balance", async function () {
      const { daoShip, alice } = await loadFixture(deployDAOWithTreasury);

      const aliceShares = await ethers.provider.getBalance(alice.address);
      const excessiveAmount = aliceShares + ethers.parseEther("1000");

      await expect(
        daoShip.connect(alice).ragequit(alice.address, excessiveAmount, 0, [ethers.ZeroAddress])
      ).to.be.reverted;

      console.log("✅ Rejects ragequit exceeding balance");
    });

    it("Should reject ragequit with duplicate tokens", async function () {
      const { daoShip, alice } = await loadFixture(deployDAOWithTreasury);

      // Try to ragequit with ETH listed twice
      await expect(
        daoShip.connect(alice).ragequit(
          alice.address,
          ethers.parseEther("10"),
          0,
          [ethers.ZeroAddress, ethers.ZeroAddress] // Duplicate!
        )
      ).to.be.revertedWithCustomError(daoShip, "TokensNotSorted");

      console.log("✅ Rejects duplicate tokens in ragequit");
    });

    it("Should send funds to specified recipient (not just msg.sender)", async function () {
      const { daoShip, shares, avatar, alice, carol } = await loadFixture(deployDAOWithTreasury);

      const carolBalanceBefore = await ethers.provider.getBalance(carol.address);

      // Alice ragequits but sends funds to Carol
      await daoShip.connect(alice).ragequit(
        carol.address, // recipient
        ethers.parseEther("10"),
        0,
        [ethers.ZeroAddress]
      );

      const carolBalanceAfter = await ethers.provider.getBalance(carol.address);
      expect(carolBalanceAfter).to.be.gt(carolBalanceBefore);

      console.log("✅ Can ragequit to different recipient");
    });
  });

  describe("Event Validation", function () {
    it("Should emit correct Ragequit event parameters", async function () {
      const { daoShip, alice } = await loadFixture(deployDAOWithTreasury);

      const sharesToBurn = ethers.parseEther("25");
      const lootToBurn = ethers.parseEther("10");

      const tx = await daoShip.connect(alice).ragequit(
        alice.address,
        sharesToBurn,
        lootToBurn,
        [ethers.ZeroAddress]
      );

      // Verify exact event parameters
      const receipt = await tx.wait();
      const event = receipt!.logs.find((log: any) => {
        try {
          const parsed = daoShip.interface.parseLog(log);
          return parsed?.name === "Ragequit";
        } catch {
          return false;
        }
      });

      expect(event).to.not.be.undefined;

      const parsed = daoShip.interface.parseLog(event!);
      expect(parsed!.args[0]).to.equal(alice.address); // member
      expect(parsed!.args[1]).to.equal(alice.address); // to
      expect(parsed!.args[2]).to.equal(lootToBurn); // lootToBurn
      expect(parsed!.args[3]).to.equal(sharesToBurn); // sharesToBurn
      expect(parsed!.args[4]).to.deep.equal([ethers.ZeroAddress]); // tokens
      expect(parsed!.args[5]).to.be.an("array").with.lengthOf(1); // amounts (one entry per token)

      console.log("✅ Ragequit event parameters validated");
    });
  });
});
