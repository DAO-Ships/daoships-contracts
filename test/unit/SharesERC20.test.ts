import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployDAOShipFixture } from "../fixtures";

describe("SharesERC20", function () {
  describe("Deployment", function () {
    it("Should deploy with correct name and symbol", async function () {
      const { shares } = await deployDAOShipFixture();

      expect(await shares.name()).to.equal("DAOShip Shares");
      expect(await shares.symbol()).to.equal("SHARES");
      expect(await shares.decimals()).to.equal(18);
    });

    it("Should start unpaused", async function () {
      const { shares } = await deployDAOShipFixture();

      expect(await shares.paused()).to.equal(false);
    });

    it("Should have correct owner (DAOShip)", async function () {
      const { shares, daoShip } = await deployDAOShipFixture();

      expect(await shares.owner()).to.equal(await daoShip.getAddress());
    });
  });

  describe("Minting", function () {
    it("Should mint shares to address", async function () {
      const { shares, deployer } = await deployDAOShipFixture();

      // Deployer should have initial shares from fixture
      const balance = await shares.balanceOf(deployer.address);
      expect(balance).to.equal(ethers.parseEther("100"));
    });

    it("Should auto-delegate on first mint", async function () {
      const { shares, bob, daoShip } = await deployDAOShipFixture();

      // Bob has no shares yet
      expect(await shares.balanceOf(bob.address)).to.equal(0);
      expect(await shares.delegates(bob.address)).to.equal(ethers.ZeroAddress);

      // Impersonate DAOShip (owner of shares) to mint directly
      const daoShipAddr = await daoShip.getAddress();
      await ethers.provider.send("hardhat_setBalance", [
        daoShipAddr,
        "0x" + ethers.parseEther("1").toString(16),
      ]);
      const daoShipSigner = await ethers.getImpersonatedSigner(daoShipAddr);

      const amount = ethers.parseEther("10");
      await shares.connect(daoShipSigner).mint(bob.address, amount);

      // Bob should now be auto-delegated to self
      expect(await shares.balanceOf(bob.address)).to.equal(amount);
      expect(await shares.delegates(bob.address)).to.equal(bob.address);
    });

    it("Should only allow owner to mint", async function () {
      const { shares, alice, bob } = await deployDAOShipFixture();

      // Alice (not owner) cannot mint
      await expect(
        shares.connect(alice).mint(bob.address, ethers.parseEther("10"))
      ).to.be.revertedWithCustomError(shares, "OwnableUnauthorizedAccount");
    });
  });

  describe("Burning", function () {
    it("Should only allow owner to burn", async function () {
      const { shares, alice } = await deployDAOShipFixture();

      // Alice (not owner) cannot burn
      await expect(
        shares.connect(alice).burn(alice.address, ethers.parseEther("10"))
      ).to.be.revertedWithCustomError(shares, "OwnableUnauthorizedAccount");
    });
  });

  describe("Delegation", function () {
    it("Should allow delegation to another address", async function () {
      const { shares, deployer, alice } = await deployDAOShipFixture();

      // Initially delegated to self (auto-delegation)
      const initialDelegate = await shares.delegates(deployer.address);

      // Delegate to Alice
      await shares.connect(deployer).delegate(alice.address);

      expect(await shares.delegates(deployer.address)).to.equal(alice.address);
    });

    it("Should update voting power on delegation", async function () {
      const { shares, deployer, alice } = await deployDAOShipFixture();

      const deployerBalance = await shares.balanceOf(deployer.address);
      const aliceBalance = await shares.balanceOf(alice.address);

      // Delegate to Alice
      await shares.connect(deployer).delegate(alice.address);

      // Alice should now have both her own balance + deployer's delegated votes
      const aliceVotes = await shares.getCurrentVotes(alice.address);
      expect(aliceVotes).to.equal(deployerBalance + aliceBalance);
    });

    it("Should emit DelegateChanged event", async function () {
      const { shares, deployer, alice, bob } = await deployDAOShipFixture();

      // First delegate to Alice
      await shares.connect(deployer).delegate(alice.address);

      // Then delegate to Bob
      await expect(shares.connect(deployer).delegate(bob.address))
        .to.emit(shares, "DelegateChanged")
        .withArgs(deployer.address, alice.address, bob.address);
    });

    it("Should emit DelegateVotesChanged event", async function () {
      const { shares, deployer, alice } = await deployDAOShipFixture();

      const deployerBalance = await shares.balanceOf(deployer.address);
      const aliceBalance = await shares.balanceOf(alice.address);

      // Alice already has aliceBalance voting power (auto-delegation)
      // After deployer delegates, she'll have aliceBalance + deployerBalance
      await expect(shares.connect(deployer).delegate(alice.address))
        .to.emit(shares, "DelegateVotesChanged")
        .withArgs(alice.address, aliceBalance, aliceBalance + deployerBalance);
    });
  });

  describe("Voting Power", function () {
    it("Should track current voting power", async function () {
      const { shares, deployer, alice } = await deployDAOShipFixture();

      // Deployer auto-delegated to self, should have voting power
      const deployerVotes = await shares.getCurrentVotes(deployer.address);
      expect(deployerVotes).to.equal(ethers.parseEther("100"));

      // Alice also auto-delegated
      const aliceVotes = await shares.getCurrentVotes(alice.address);
      expect(aliceVotes).to.equal(ethers.parseEther("50"));
    });

    it("Should track historical voting power", async function () {
      const { shares, deployer } = await deployDAOShipFixture();

      // Get current timestamp
      const blockNum = await ethers.provider.getBlockNumber();
      const block = await ethers.provider.getBlock(blockNum);
      const timestamp = block!.timestamp;

      // Advance time
      await time.increase(100);

      // Should be able to query past voting power
      const pastVotes = await shares.getPriorVotes(deployer.address, timestamp);
      expect(pastVotes).to.equal(ethers.parseEther("100"));
    });

    it("Should revert when querying future timestamp", async function () {
      const { shares, deployer } = await deployDAOShipFixture();

      const futureTimestamp = (await time.latest()) + 1000;

      await expect(
        shares.getPriorVotes(deployer.address, futureTimestamp)
      ).to.be.revertedWith("DAOShipVotes: not yet determined");
    });
  });

  describe("Pausability", function () {
    it("Should only allow owner to pause", async function () {
      const { shares, alice } = await deployDAOShipFixture();

      await expect(
        shares.connect(alice).pause()
      ).to.be.revertedWithCustomError(shares, "OwnableUnauthorizedAccount");
    });

    it("Should only allow owner to unpause", async function () {
      const { shares, alice } = await deployDAOShipFixture();

      await expect(
        shares.connect(alice).unpause()
      ).to.be.revertedWithCustomError(shares, "OwnableUnauthorizedAccount");
    });

    it("Should prevent transfers when paused", async function () {
      const { shares, daoShip, deployer, alice, bob } = await deployDAOShipFixture();

      // Impersonate DAOShip (owner) to pause
      const daoShipAddr = await daoShip.getAddress();
      await ethers.provider.send("hardhat_setBalance", [
        daoShipAddr,
        "0x" + ethers.parseEther("1").toString(16),
      ]);
      const daoShipSigner = await ethers.getImpersonatedSigner(daoShipAddr);

      await shares.connect(daoShipSigner).pause();
      expect(await shares.paused()).to.be.true;

      // Transfers revert while paused
      await expect(
        shares.connect(deployer).transfer(bob.address, ethers.parseEther("1"))
      ).to.be.revertedWith("ERC20Pausable: token transfer while paused");

      // DAOShip can still mint while paused
      await shares.connect(daoShipSigner).mint(bob.address, ethers.parseEther("5"));
      expect(await shares.balanceOf(bob.address)).to.equal(ethers.parseEther("5"));

      // DAOShip can still burn while paused
      await shares.connect(daoShipSigner).burn(bob.address, ethers.parseEther("2"));
      expect(await shares.balanceOf(bob.address)).to.equal(ethers.parseEther("3"));
    });

    it("Should allow minting when paused", async function () {
      const { shares, daoShip, carol } = await deployDAOShipFixture();

      // Impersonate DAOShip to pause and then mint
      const daoShipAddr = await daoShip.getAddress();
      await ethers.provider.send("hardhat_setBalance", [
        daoShipAddr,
        "0x" + ethers.parseEther("1").toString(16),
      ]);
      const daoShipSigner = await ethers.getImpersonatedSigner(daoShipAddr);

      await shares.connect(daoShipSigner).pause();
      expect(await shares.paused()).to.be.true;

      // Minting works even when paused
      const amount = ethers.parseEther("25");
      await shares.connect(daoShipSigner).mint(carol.address, amount);
      expect(await shares.balanceOf(carol.address)).to.equal(amount);
    });
  });

  describe("Checkpoints", function () {
    it("Should create checkpoints on balance changes", async function () {
      const { shares, deployer, alice } = await deployDAOShipFixture();

      // Transfer some shares (creates checkpoint at current time)
      const tx = await shares.connect(deployer).transfer(alice.address, ethers.parseEther("10"));
      const receipt = await tx.wait();
      const transferBlock = await ethers.provider.getBlock(receipt!.blockNumber);
      const timestamp1 = transferBlock!.timestamp;

      // Advance time to make timestamp1 queryable
      await time.increase(100);

      // Do another transfer (creates new checkpoint)
      await shares.connect(deployer).transfer(alice.address, ethers.parseEther("10"));

      // Advance time again
      await time.increase(100);

      // Should be able to query voting power at timestamp1 (after first transfer)
      const votes1 = await shares.getPriorVotes(deployer.address, timestamp1);
      expect(votes1).to.equal(ethers.parseEther("90")); // After first 10 token transfer

      // Current votes should reflect both transfers
      const currentVotes = await shares.getCurrentVotes(deployer.address);
      expect(currentVotes).to.equal(ethers.parseEther("80")); // After both transfers
    });

    it("Should consolidate checkpoints in same block", async function () {
      const { shares, deployer, alice, bob } = await deployDAOShipFixture();

      // Disable automine to batch operations in the same block
      await ethers.provider.send("evm_setAutomine", [false]);

      // Queue two transfers in the same block
      await shares.connect(deployer).transfer(alice.address, ethers.parseEther("5"));
      await shares.connect(deployer).transfer(bob.address, ethers.parseEther("5"));

      // Mine the block containing both transactions
      await ethers.provider.send("evm_mine", []);

      // Re-enable automine
      await ethers.provider.send("evm_setAutomine", [true]);

      // Get the timestamp of the block we just mined
      const blockNum = await ethers.provider.getBlockNumber();
      const block = await ethers.provider.getBlock(blockNum);
      const timestamp = block!.timestamp;

      // Advance time so we can query the past
      await time.increase(100);

      // Deployer had 100e18, transferred 5+5 = 10 in one block
      // Should see 90e18 voting power at that timestamp (consolidated checkpoint)
      const votesAtBlock = await shares.getPriorVotes(deployer.address, timestamp);
      expect(votesAtBlock).to.equal(ethers.parseEther("90"));
    });
  });

  describe("Edge Cases", function () {
    it("Should handle zero address delegation", async function () {
      const { shares, deployer } = await deployDAOShipFixture();

      // Delegate to zero address (undelegation)
      await shares.connect(deployer).delegate(ethers.ZeroAddress);

      expect(await shares.delegates(deployer.address)).to.equal(
        ethers.ZeroAddress
      );
    });

    it("Should handle delegation to self", async function () {
      const { shares, deployer } = await deployDAOShipFixture();

      // Already delegated to self, doing it again should be fine
      await shares.connect(deployer).delegate(deployer.address);

      expect(await shares.delegates(deployer.address)).to.equal(
        deployer.address
      );
    });

    it("Should handle zero balance accounts", async function () {
      const { shares, bob } = await deployDAOShipFixture();

      // Bob has no shares
      expect(await shares.balanceOf(bob.address)).to.equal(0);
      expect(await shares.getCurrentVotes(bob.address)).to.equal(0);
    });
  });
});
