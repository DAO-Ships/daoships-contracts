import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { deployShamanFixture, deployBaalFixture, setShamansViaProposal } from "../fixtures-simple";

describe("Shaman Contracts", function () {
  describe("OnboarderShaman", function () {
    it("Should deploy with correct parameters", async function () {
      const { baal, onboarder } = await loadFixture(deployShamanFixture);

      expect(await onboarder.baal()).to.equal(await baal.getAddress());
      expect(await onboarder.shareMultiplier()).to.equal(20000); // 2x from fixture
      expect(await onboarder.lootMultiplier()).to.equal(0);
      expect(await onboarder.minTribute()).to.equal(ethers.parseEther("0.01"));
      expect(await onboarder.expiry()).to.equal(0);
    });

    it("Should allow onboarding with sufficient tribute", async function () {
      const { onboarder, shares, loot, alice, baal } = await loadFixture(
        deployShamanFixture
      );

      const tribute = ethers.parseEther("1.0");

      // Expected: 1 ETH * 20000 / 10000 = 2 shares (2x multiplier)
      const expectedShares = ethers.parseEther("2.0");
      const expectedLoot = 0n;

      const tx = await onboarder.connect(alice).onboard({ value: tribute });

      // Check event
      await expect(tx)
        .to.emit(onboarder, "Onboard")
        .withArgs(alice.address, tribute, expectedShares, expectedLoot);

      // Check shares minted
      expect(await shares.balanceOf(alice.address)).to.equal(
        ethers.parseEther("50") + expectedShares // Alice had 50 from fixture
      );

      // Check ETH forwarded to avatar
      const avatar = await baal.avatar();
      expect(await ethers.provider.getBalance(avatar)).to.equal(tribute);
    });

    it("Should reject insufficient tribute", async function () {
      const { onboarder, alice } = await loadFixture(deployShamanFixture);

      const tooSmall = ethers.parseEther("0.005"); // min is 0.01

      await expect(
        onboarder.connect(alice).onboard({ value: tooSmall })
      ).to.be.revertedWith("OnboarderShaman: insufficient tribute");
    });

    it("Should work via receive() fallback", async function () {
      const { onboarder, alice } = await loadFixture(deployShamanFixture);

      const tribute = ethers.parseEther("1.0");

      // Send ETH directly (triggers receive -> onboard)
      const tx = await alice.sendTransaction({
        to: await onboarder.getAddress(),
        value: tribute,
      });

      await expect(tx).to.emit(onboarder, "Onboard");
    });

    it("Should handle expiration correctly", async function () {
      const [deployer, alice, bob, carol] = await ethers.getSigners();
      const currentTime = await time.latest();
      const expiry = currentTime + 7 * 24 * 60 * 60; // 7 days from now

      // Deploy fresh Baal setup with timed shaman
      const SharesERC20 = await ethers.getContractFactory("SharesERC20");
      const shares = await SharesERC20.deploy();
      const LootERC20 = await ethers.getContractFactory("LootERC20");
      const loot = await LootERC20.deploy();
      const Baal = await ethers.getContractFactory("Baal");
      const baal = await Baal.deploy();
      const MockAvatar = await ethers.getContractFactory("MockAvatar");
      const avatar = await MockAvatar.deploy();
      await avatar.enableModule(await baal.getAddress());
      const MultiSend = await ethers.getContractFactory("MultiSend");
      const multisend = await MultiSend.deploy();
      await shares.transferOwnership(await baal.getAddress());
      await loot.transferOwnership(await baal.getAddress());

      // Deploy OnboarderShaman with expiration
      const OnboarderShaman = await ethers.getContractFactory("OnboarderShaman");
      const timedOnboarder = await OnboarderShaman.deploy(
        await baal.getAddress(),
        10000, // 1x multiplier for shares
        0,     // no loot
        ethers.parseEther("0.01"),
        expiry // expires in 7 days
      );

      const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256"],
        [7*24*60*60, 3*24*60*60, ethers.parseEther("0.1"), 2000, ethers.parseEther("1"), 6600]
      );

      // Initialize Baal WITH the timed shaman set during setUp
      const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]"],
        [await loot.getAddress(), await shares.getAddress(), await avatar.getAddress(), ethers.ZeroAddress, await multisend.getAddress(), governanceConfig,
         [await timedOnboarder.getAddress()], [2], // Set timed shaman as MANAGER
         [deployer.address], [ethers.parseEther("100")], [ethers.parseEther("0")], []] // guild tokens (empty for now)
      );

      await baal.setUp(initParams);

      // Onboard before expiry (should work)
      const tribute = ethers.parseEther("1.0");
      await expect(timedOnboarder.connect(alice).onboard({ value: tribute }))
        .to.emit(timedOnboarder, "Onboard")
        .withArgs(alice.address, tribute, ethers.parseEther("1.0"), 0);

      // Verify alice got shares
      expect(await shares.balanceOf(alice.address)).to.equal(ethers.parseEther("1.0"));

      // Advance past expiry
      await time.increase(8 * 24 * 60 * 60); // 8 days

      // Try to onboard after expiry (should fail)
      await expect(
        timedOnboarder.connect(bob).onboard({ value: tribute })
      ).to.be.revertedWith("OnboarderShaman: expired");
    });

    it("Should handle multiple onboards from same user", async function () {
      const { onboarder, shares, bob } = await loadFixture(deployShamanFixture);

      const tribute1 = ethers.parseEther("1.0"); // 2 shares
      const tribute2 = ethers.parseEther("2.0"); // 4 shares

      await onboarder.connect(bob).onboard({ value: tribute1 });
      await onboarder.connect(bob).onboard({ value: tribute2 });

      // Bob should have 6 shares total (2 + 4)
      expect(await shares.balanceOf(bob.address)).to.equal(
        ethers.parseEther("6")
      );
    });
  });

  describe("EthOnboarderShaman", function () {
    it("Should deploy with correct parameters", async function () {
      const { baal, ethOnboarder } = await loadFixture(deployShamanFixture);

      expect(await ethOnboarder.baal()).to.equal(await baal.getAddress());
      expect(await ethOnboarder.pricePerUnit()).to.equal(ethers.parseEther("0.1"));
      expect(await ethOnboarder.sharePerUnit()).to.equal(ethers.parseEther("1"));
      expect(await ethOnboarder.lootPerUnit()).to.equal(0);
      expect(await ethOnboarder.expiry()).to.equal(0);
    });

    it("Should allow onboarding with exact price", async function () {
      const { ethOnboarder, shares, alice, baal } = await loadFixture(
        deployShamanFixture
      );

      const payment = ethers.parseEther("0.1"); // Exactly 1 unit

      const tx = await ethOnboarder.connect(alice).onboard({ value: payment });

      // Check event: 1 unit purchased, 1 share minted, 0 loot
      await expect(tx)
        .to.emit(ethOnboarder, "Onboard")
        .withArgs(
          alice.address,
          payment, // cost
          1, // units
          ethers.parseEther("1"), // shares
          0 // loot
        );

      // Check shares minted
      expect(await shares.balanceOf(alice.address)).to.equal(
        ethers.parseEther("50") + ethers.parseEther("1") // Alice had 50 from fixture
      );

      // Check ETH forwarded to avatar
      const avatar = await baal.avatar();
      expect(await ethers.provider.getBalance(avatar)).to.be.gt(0);
    });

    it("Should handle multiple units purchase", async function () {
      const { ethOnboarder, shares, bob } = await loadFixture(
        deployShamanFixture
      );

      const payment = ethers.parseEther("1.0"); // 10 units

      const tx = await ethOnboarder.connect(bob).onboard({ value: payment });

      await expect(tx)
        .to.emit(ethOnboarder, "Onboard")
        .withArgs(
          bob.address,
          payment,
          10, // units
          ethers.parseEther("10"), // shares
          0 // loot
        );

      expect(await shares.balanceOf(bob.address)).to.equal(
        ethers.parseEther("10")
      );
    });

    it("Should refund remainder when payment exceeds whole units", async function () {
      const { ethOnboarder, shares, bob } = await loadFixture(
        deployShamanFixture
      );

      const payment = ethers.parseEther("0.35"); // 3.5 units -> 3 units purchased
      const expectedCost = ethers.parseEther("0.3"); // 3 units * 0.1
      const expectedRemainder = ethers.parseEther("0.05");

      const balanceBefore = await ethers.provider.getBalance(bob.address);

      const tx = await ethOnboarder.connect(bob).onboard({ value: payment });
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

      await expect(tx)
        .to.emit(ethOnboarder, "Onboard")
        .withArgs(
          bob.address,
          expectedCost, // only cost of 3 units
          3,
          ethers.parseEther("3"),
          0
        );

      // Check Bob got refunded
      const balanceAfter = await ethers.provider.getBalance(bob.address);
      expect(balanceAfter).to.equal(balanceBefore - expectedCost - gasUsed);

      // Check shares minted (only for 3 units)
      expect(await shares.balanceOf(bob.address)).to.equal(
        ethers.parseEther("3")
      );
    });

    it("Should reject insufficient payment", async function () {
      const { ethOnboarder, alice } = await loadFixture(deployShamanFixture);

      const tooSmall = ethers.parseEther("0.05"); // less than 0.1

      await expect(
        ethOnboarder.connect(alice).onboard({ value: tooSmall })
      ).to.be.revertedWith("EthOnboarderShaman: insufficient payment");
    });

    it("Should work via receive() fallback", async function () {
      const { ethOnboarder, alice } = await loadFixture(deployShamanFixture);

      const payment = ethers.parseEther("0.1");

      // Send ETH directly (triggers receive -> onboard)
      const tx = await alice.sendTransaction({
        to: await ethOnboarder.getAddress(),
        value: payment,
      });

      await expect(tx).to.emit(ethOnboarder, "Onboard");
    });
  });

  describe("CheckInShamanV2", function () {
    it("Should deploy with correct parameters", async function () {
      const { baal, checkInShaman } = await loadFixture(deployShamanFixture);

      expect(await checkInShaman.baal()).to.equal(await baal.getAddress());
      expect(await checkInShaman.claimInterval()).to.equal(30 * 24 * 60 * 60);
      expect(await checkInShaman.sharesPerClaim()).to.equal(ethers.parseEther("10"));
      expect(await checkInShaman.lootPerClaim()).to.equal(0);
      expect(await checkInShaman.maxMissedClaims()).to.equal(3);
    });

    it("Should allow immediate first check-in", async function () {
      const { checkInShaman, shares, loot, bob } = await loadFixture(
        deployShamanFixture
      );

      const tx = await checkInShaman.connect(bob).checkIn();

      await expect(tx)
        .to.emit(checkInShaman, "CheckIn")
        .withArgs(
          bob.address,
          ethers.parseEther("10"), // shares
          0, // loot (from fixture)
          await time.latest(), // timestamp
          0 // missed count
        );

      // Check shares minted
      expect(await shares.balanceOf(bob.address)).to.equal(
        ethers.parseEther("10")
      );

      // Check timestamp recorded
      expect(await checkInShaman.lastClaimTimestamp(bob.address)).to.be.gt(0);
    });

    it("Should allow check-in after interval", async function () {
      const { checkInShaman, shares, alice } = await loadFixture(deployShamanFixture);

      // First check-in
      await checkInShaman.connect(alice).checkIn();
      const firstBalance = await shares.balanceOf(alice.address);

      // Advance 30 days
      await time.increase(30 * 24 * 60 * 60);

      // Second check-in
      const tx = await checkInShaman.connect(alice).checkIn();

      await expect(tx).to.emit(checkInShaman, "CheckIn");

      // Should have 10 more shares
      expect(await shares.balanceOf(alice.address)).to.equal(
        firstBalance + ethers.parseEther("10")
      );
    });

    it("Should reject check-in before interval", async function () {
      const { checkInShaman, alice } = await loadFixture(deployShamanFixture);

      // First check-in
      await checkInShaman.connect(alice).checkIn();

      // Try to check-in again immediately
      await expect(checkInShaman.connect(alice).checkIn()).to.be.revertedWith(
        "CheckInShamanV2: too early"
      );

      // Advance 29 days (still too early)
      await time.increase(29 * 24 * 60 * 60);

      await expect(checkInShaman.connect(alice).checkIn()).to.be.revertedWith(
        "CheckInShamanV2: too early"
      );
    });

    it("Should track missed claims when late", async function () {
      const { checkInShaman, alice } = await loadFixture(deployShamanFixture);

      // First check-in
      await checkInShaman.connect(alice).checkIn();

      // Advance 60 days (missed 1 period)
      await time.increase(60 * 24 * 60 * 60);

      // Second check-in (late)
      const tx = await checkInShaman.connect(alice).checkIn();

      // Event should show 1 missed claim
      await expect(tx)
        .to.emit(checkInShaman, "CheckIn")
        .withArgs(
          alice.address,
          ethers.parseEther("10"),
          0,
          await time.latest(),
          1 // missed count
        );

      // missedClaims should be 1
      expect(await checkInShaman.missedClaims(alice.address)).to.equal(1);
    });

    it("Should reset missed count on on-time check-in", async function () {
      const { checkInShaman, alice } = await loadFixture(deployShamanFixture);

      // First check-in
      await checkInShaman.connect(alice).checkIn();

      // Advance exactly 30 days
      await time.increase(30 * 24 * 60 * 60);

      // Second check-in (on time)
      await checkInShaman.connect(alice).checkIn();

      // missedClaims should be 0
      expect(await checkInShaman.missedClaims(alice.address)).to.equal(0);
    });

    it("Should slash when max missed claims exceeded", async function () {
      const { checkInShaman, shares, loot, alice } = await loadFixture(
        deployShamanFixture
      );

      // First check-in
      await checkInShaman.connect(alice).checkIn();

      const initialShares = await shares.balanceOf(alice.address);
      const initialLoot = await loot.balanceOf(alice.address);

      // Advance 120 days (3 missed periods = meets maxMissedClaims threshold)
      await time.increase(120 * 24 * 60 * 60);

      // This check-in should trigger slashing
      const tx = await checkInShaman.connect(alice).checkIn();

      await expect(tx)
        .to.emit(checkInShaman, "Slash")
        .withArgs(alice.address, 3); // missed count

      // All shares and loot should be burned
      expect(await shares.balanceOf(alice.address)).to.equal(0);
      expect(await loot.balanceOf(alice.address)).to.equal(0);

      // State should be reset
      expect(await checkInShaman.lastClaimTimestamp(alice.address)).to.equal(0);
      expect(await checkInShaman.missedClaims(alice.address)).to.equal(0);
    });

    it("Should allow fresh start after being slashed", async function () {
      const { checkInShaman, shares, alice } = await loadFixture(deployShamanFixture);

      // First check-in
      await checkInShaman.connect(alice).checkIn();

      // Get slashed
      await time.increase(120 * 24 * 60 * 60);
      await checkInShaman.connect(alice).checkIn();

      // Should be slashed
      expect(await shares.balanceOf(alice.address)).to.equal(0);

      // Try to check-in again (should work as first check-in)
      const tx = await checkInShaman.connect(alice).checkIn();

      await expect(tx)
        .to.emit(checkInShaman, "CheckIn")
        .withArgs(
          alice.address,
          ethers.parseEther("10"),
          0,
          await time.latest(),
          0 // fresh start
        );

      expect(await shares.balanceOf(alice.address)).to.equal(
        ethers.parseEther("10")
      );
    });

    it("Should return correct canCheckIn status", async function () {
      const { checkInShaman, bob, alice } = await loadFixture(deployShamanFixture);

      // Bob hasn't checked in yet
      let [canClaim, nextClaimTime, missedCount] = await checkInShaman.canCheckIn(
        bob.address
      );

      expect(canClaim).to.be.true;
      expect(nextClaimTime).to.equal(0);
      expect(missedCount).to.equal(0);

      // Alice checks in
      await checkInShaman.connect(alice).checkIn();

      // Alice can't check in yet
      [canClaim, nextClaimTime, missedCount] = await checkInShaman.canCheckIn(
        alice.address
      );

      expect(canClaim).to.be.false;
      expect(nextClaimTime).to.be.gt(await time.latest());
      expect(missedCount).to.equal(0);

      // Advance 30 days
      await time.increase(30 * 24 * 60 * 60);

      // Alice can check in now
      [canClaim, nextClaimTime, missedCount] = await checkInShaman.canCheckIn(
        alice.address
      );

      expect(canClaim).to.be.true;
      expect(nextClaimTime).to.be.lte(await time.latest());
      expect(missedCount).to.equal(0);
    });
  });
});
