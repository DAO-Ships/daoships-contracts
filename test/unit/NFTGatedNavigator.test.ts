import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/** EIP-1167 minimal-proxy clone bytecode for an implementation address */
function cloneBytecode(addr: string) {
  const impl = addr.slice(2).toLowerCase().padStart(40, "0");
  return `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`;
}

async function deployCloneOf(impl: any, factory: any, signer: any) {
  const f = new ethers.ContractFactory([], cloneBytecode(await impl.getAddress()), signer);
  const raw = await f.deploy();
  await raw.waitForDeployment();
  return factory.attach(await raw.getAddress());
}

/** OZ leaf for a single-address allowlist: keccak256(bytes.concat(keccak256(abi.encode(addr)))) */
function nftLeaf(addr: string): string {
  const inner = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address"], [addr]));
  return ethers.keccak256(inner);
}

/** OZ MerkleProof sorted-pair hash */
function hashPair(a: string, b: string): string {
  const [x, y] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}

interface DeployOpts {
  sharesPerHolder?: bigint;
  lootPerHolder?: bigint;
  requireTribute?: boolean;
  tributeAmount?: bigint;
  expiry?: number;
  mintCap?: bigint;
  perAddressCap?: bigint;
  allowlistRoot?: string;
  avatarReject?: boolean; // use an avatar that rejects ETH (to exercise TransferFailed)
}

/**
 * Self-contained deployment: a DAOShip clone with the NFTGatedNavigator registered
 * as a MANAGER (permission 2) at setUp time. Avoids the governance-proposal path so
 * each config is deterministic.
 */
async function deployNFTGated(opts: DeployOpts = {}) {
  const [deployer, alice, bob, carol] = await ethers.getSigners();

  const {
    sharesPerHolder = ethers.parseEther("10"),
    lootPerHolder = 0n,
    requireTribute = false,
    tributeAmount = 0n,
    expiry = 0,
    mintCap = ethers.parseEther("1000"),
    perAddressCap = 0n,
    allowlistRoot = ethers.ZeroHash,
    avatarReject = false,
  } = opts;

  const SharesERC20 = await ethers.getContractFactory("SharesERC20");
  const sharesImpl = await SharesERC20.deploy();
  await sharesImpl.waitForDeployment();
  const LootERC20 = await ethers.getContractFactory("LootERC20");
  const lootImpl = await LootERC20.deploy();
  await lootImpl.waitForDeployment();
  const DAOShip = await ethers.getContractFactory("DAOShip");
  const daoImpl = await DAOShip.deploy();
  await daoImpl.waitForDeployment();

  const shares = await deployCloneOf(sharesImpl, SharesERC20, deployer);
  const loot = await deployCloneOf(lootImpl, LootERC20, deployer);
  const daoShip = await deployCloneOf(daoImpl, DAOShip, deployer);

  const MockAvatar = await ethers.getContractFactory(avatarReject ? "MockAvatarRejectETH" : "MockAvatar");
  const avatar = await MockAvatar.deploy();
  await avatar.waitForDeployment();
  await avatar.enableModule(await daoShip.getAddress());

  const MultiSendCallOnly = await ethers.getContractFactory("MultiSendCallOnly");
  const multisend = await MultiSendCallOnly.deploy();
  await multisend.waitForDeployment();

  await shares.initialize(await daoShip.getAddress(), "Shares", "SH");
  await loot.initialize(await daoShip.getAddress(), "Loot", "LT");

  const MockERC721 = await ethers.getContractFactory("MockERC721");
  const nft = await MockERC721.deploy();
  await nft.waitForDeployment();

  const NFTGatedNavigator = await ethers.getContractFactory("NFTGatedNavigator");
  const nav = await NFTGatedNavigator.deploy(
    await daoShip.getAddress(),
    await nft.getAddress(),
    sharesPerHolder,
    lootPerHolder,
    requireTribute,
    tributeAmount,
    expiry,
    mintCap,
    perAddressCap,
    allowlistRoot,
    "NFT Gate",
    "test navigator"
  );
  await nav.waitForDeployment();

  const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
    [7 * 24 * 60 * 60, 3 * 24 * 60 * 60, ethers.parseEther("0.1"), 2000, ethers.parseEther("1"), 6600, 0]
  );

  const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
    [
      await loot.getAddress(),
      await shares.getAddress(),
      await avatar.getAddress(),
      await multisend.getAddress(),
      governanceConfig,
      [await nav.getAddress()],
      [2],
      [deployer.address],
      [ethers.parseEther("100")],
      [0n],
      [],
      false,
      false,
    ]
  );
  await daoShip.setUp(initParams);

  return { daoShip, shares, loot, avatar, nft, nav, deployer, alice, bob, carol };
}

/** Impersonate the avatar (a contract) so we can call avatar-authorized functions */
async function asAvatar(avatarAddr: string) {
  await ethers.provider.send("hardhat_setBalance", [avatarAddr, "0x21e19e0c9bab2400000"]);
  return ethers.getImpersonatedSigner(avatarAddr);
}

describe("NFTGatedNavigator", function () {
  describe("Deployment & configuration", function () {
    it("sets immutable parameters", async function () {
      const { nav, daoShip, nft } = await deployNFTGated();
      expect(await nav.navigatorType()).to.equal("NFTGatedNavigator");
      expect(await nav.daoShip()).to.equal(await daoShip.getAddress());
      expect(await nav.gateToken()).to.equal(await nft.getAddress());
      expect(await nav.sharesPerHolder()).to.equal(ethers.parseEther("10"));
      expect(await nav.lootPerHolder()).to.equal(0);
      expect(await nav.requireTribute()).to.equal(false);
      expect(await nav.mintCap()).to.equal(ethers.parseEther("1000"));
    });

    it("emits NavigatorDeployed in constructor", async function () {
      // Re-deploy a navigator standalone and assert the constructor event
      const { daoShip, nft, deployer } = await deployNFTGated();
      const NFTGatedNavigator = await ethers.getContractFactory("NFTGatedNavigator");
      const tx = await NFTGatedNavigator.deploy(
        await daoShip.getAddress(),
        await nft.getAddress(),
        ethers.parseEther("10"), 0, false, 0, 0, ethers.parseEther("1000"), 0, ethers.ZeroHash,
        "My Gate", "desc"
      );
      await expect(tx.deploymentTransaction())
        .to.emit(tx, "NavigatorDeployed")
        .withArgs(await daoShip.getAddress(), deployer.address, "NFTGatedNavigator", "My Gate", "desc");
    });

    it("reverts when mintCap is 0 (mandatory backstop)", async function () {
      await expect(deployNFTGated({ mintCap: 0n })).to.be.reverted;
    });

    it("reverts when both shares and loot per holder are 0", async function () {
      await expect(deployNFTGated({ sharesPerHolder: 0n, lootPerHolder: 0n })).to.be.reverted;
    });

    it("reverts when requireTribute=true but tributeAmount=0", async function () {
      await expect(deployNFTGated({ requireTribute: true, tributeAmount: 0n })).to.be.reverted;
    });

    it("reverts when requireTribute=false but tributeAmount>0", async function () {
      await expect(deployNFTGated({ requireTribute: false, tributeAmount: ethers.parseEther("1") })).to.be.reverted;
    });

    it("reverts when a single claim cannot fit under mintCap", async function () {
      await expect(
        deployNFTGated({ sharesPerHolder: ethers.parseEther("10"), mintCap: ethers.parseEther("5") })
      ).to.be.reverted;
    });

    it("reverts when perAddressCap is smaller than one claim", async function () {
      await expect(
        deployNFTGated({ sharesPerHolder: ethers.parseEther("10"), perAddressCap: ethers.parseEther("5") })
      ).to.be.reverted;
    });

    it("reverts when gateToken is the zero address", async function () {
      const NFTGatedNavigator = await ethers.getContractFactory("NFTGatedNavigator");
      const { daoShip } = await deployNFTGated();
      await expect(
        NFTGatedNavigator.deploy(
          await daoShip.getAddress(),
          ethers.ZeroAddress,
          ethers.parseEther("10"), 0, false, 0, 0, ethers.parseEther("1000"), 0, ethers.ZeroHash,
          "x", "y"
        )
      ).to.be.reverted;
    });

    it("reverts when gateToken is an EOA (no code)", async function () {
      const [deployer, alice] = await ethers.getSigners();
      const NFTGatedNavigator = await ethers.getContractFactory("NFTGatedNavigator");
      // daoShip must be a real contract; reuse a deployed one but pass an EOA gate
      const { daoShip } = await deployNFTGated();
      await expect(
        NFTGatedNavigator.deploy(
          await daoShip.getAddress(),
          alice.address, // EOA, no code
          ethers.parseEther("10"), 0, false, 0, 0, ethers.parseEther("1000"), 0, ethers.ZeroHash,
          "x", "y"
        )
      ).to.be.reverted;
    });
  });

  describe("Onboarding — free mint", function () {
    it("happy path: holder onboards and receives shares", async function () {
      const { nav, nft, shares, alice, daoShip } = await deployNFTGated();
      await nft.mint(alice.address, 1);

      await expect(nav.connect(alice)["onboard(uint256)"](1))
        .to.emit(nav, "Onboard")
        .withArgs(await daoShip.getAddress(), alice.address, 0, ethers.parseEther("10"), 0)
        .and.to.emit(nav, "NFTClaimed")
        .withArgs(await daoShip.getAddress(), alice.address, 1, ethers.parseEther("10"), 0);

      expect(await shares.balanceOf(alice.address)).to.equal(ethers.parseEther("10"));
      expect(await nav.claimed(1)).to.equal(true);
      expect(await nav.totalMinted()).to.equal(ethers.parseEther("10"));
    });

    it("can mint loot-only", async function () {
      const { nav, nft, loot, shares, alice } = await deployNFTGated({
        sharesPerHolder: 0n,
        lootPerHolder: ethers.parseEther("5"),
      });
      await nft.mint(alice.address, 7);
      await nav.connect(alice)["onboard(uint256)"](7);
      expect(await loot.balanceOf(alice.address)).to.equal(ethers.parseEther("5"));
      expect(await shares.balanceOf(alice.address)).to.equal(0);
    });

    it("reverts NotHolder when caller does not own the token", async function () {
      const { nav, nft, alice, bob } = await deployNFTGated();
      await nft.mint(alice.address, 1);
      await expect(nav.connect(bob)["onboard(uint256)"](1)).to.be.revertedWithCustomError(nav, "NotHolder");
    });

    it("reverts NotHolder for a nonexistent token", async function () {
      const { nav, alice } = await deployNFTGated();
      await expect(nav.connect(alice)["onboard(uint256)"](999)).to.be.revertedWithCustomError(nav, "NotHolder");
    });

    it("reverts NotHolder for a burned token", async function () {
      const { nav, nft, alice } = await deployNFTGated();
      await nft.mint(alice.address, 1);
      await nft.connect(alice).burn(1);
      await expect(nav.connect(alice)["onboard(uint256)"](1)).to.be.revertedWithCustomError(nav, "NotHolder");
    });

    it("reverts AlreadyClaimed on second claim of same token", async function () {
      const { nav, nft, alice } = await deployNFTGated();
      await nft.mint(alice.address, 1);
      await nav.connect(alice)["onboard(uint256)"](1);
      await expect(nav.connect(alice)["onboard(uint256)"](1)).to.be.revertedWithCustomError(nav, "AlreadyClaimed");
    });

    it("defeats transfer-and-reclaim: new owner of a spent token cannot re-claim", async function () {
      const { nav, nft, shares, alice, bob } = await deployNFTGated();
      await nft.mint(alice.address, 1);

      await nav.connect(alice)["onboard(uint256)"](1);
      // Alice sells/transfers the NFT to Bob
      await nft.connect(alice).transferFrom(alice.address, bob.address, 1);

      // Bob now owns token 1 but it is already spent
      await expect(nav.connect(bob)["onboard(uint256)"](1)).to.be.revertedWithCustomError(nav, "AlreadyClaimed");
      // Alice keeps her shares (claim-ticket semantic)
      expect(await shares.balanceOf(alice.address)).to.equal(ethers.parseEther("10"));
      expect(await shares.balanceOf(bob.address)).to.equal(0);
    });

    it("rejects value in free-mint mode", async function () {
      const { nav, nft, alice } = await deployNFTGated();
      await nft.mint(alice.address, 1);
      await expect(
        nav.connect(alice)["onboard(uint256)"](1, { value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(nav, "NoTributeRequired");
    });

    it("multiple distinct tokens held by one address each mint once", async function () {
      const { nav, nft, shares, alice } = await deployNFTGated();
      await nft.mint(alice.address, 1);
      await nft.mint(alice.address, 2);
      await nav.connect(alice)["onboard(uint256)"](1);
      await nav.connect(alice)["onboard(uint256)"](2);
      expect(await shares.balanceOf(alice.address)).to.equal(ethers.parseEther("20"));
    });
  });

  describe("Onboarding — tribute required", function () {
    it("accepts exact tribute and forwards it to the vault", async function () {
      const { nav, nft, avatar, shares, alice } = await deployNFTGated({
        requireTribute: true,
        tributeAmount: ethers.parseEther("1"),
      });
      await nft.mint(alice.address, 1);

      const before = await ethers.provider.getBalance(await avatar.getAddress());
      await nav.connect(alice)["onboard(uint256)"](1, { value: ethers.parseEther("1") });
      const after = await ethers.provider.getBalance(await avatar.getAddress());

      expect(after - before).to.equal(ethers.parseEther("1"));
      expect(await shares.balanceOf(alice.address)).to.equal(ethers.parseEther("10"));
    });

    it("reverts IncorrectTribute on wrong amount", async function () {
      const { nav, nft, alice } = await deployNFTGated({
        requireTribute: true,
        tributeAmount: ethers.parseEther("1"),
      });
      await nft.mint(alice.address, 1);
      await expect(
        nav.connect(alice)["onboard(uint256)"](1, { value: ethers.parseEther("0.5") })
      ).to.be.revertedWithCustomError(nav, "IncorrectTribute");
    });

    it("reverts IncorrectTribute on zero value", async function () {
      const { nav, nft, alice } = await deployNFTGated({
        requireTribute: true,
        tributeAmount: ethers.parseEther("1"),
      });
      await nft.mint(alice.address, 1);
      await expect(nav.connect(alice)["onboard(uint256)"](1)).to.be.revertedWithCustomError(nav, "IncorrectTribute");
    });

    it("reverts TransferFailed (atomic rollback) when the vault rejects the tribute", async function () {
      const { nav, nft, alice } = await deployNFTGated({
        requireTribute: true,
        tributeAmount: ethers.parseEther("1"),
        avatarReject: true,
      });
      await nft.mint(alice.address, 1);
      await expect(
        nav.connect(alice)["onboard(uint256)"](1, { value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(nav, "TransferFailed");
      // Atomic rollback: the token must NOT be marked claimed
      expect(await nav.claimed(1)).to.equal(false);
    });
  });

  describe("Allowlist composition (NFT gate AND Merkle allowlist)", function () {
    it("allowlisted holder claims with a valid proof; bad/empty proofs revert NotAllowlisted", async function () {
      const [, alice, , carol] = await ethers.getSigners();
      // 2-leaf tree: { alice, carol } — alice is allowlisted, a third party is not
      const leafAlice = nftLeaf(alice.address);
      const leafCarol = nftLeaf(carol.address);
      const root = hashPair(leafAlice, leafCarol);

      const { nav, nft, shares } = await deployNFTGated({ allowlistRoot: root });
      await nft.mint(alice.address, 1);

      // No-proof overload reverts while an allowlist is active
      await expect(nav.connect(alice)["onboard(uint256)"](1)).to.be.revertedWithCustomError(nav, "NotAllowlisted");
      // Wrong proof reverts
      await expect(
        nav.connect(alice)["onboard(uint256,bytes32[])"](1, [leafAlice])
      ).to.be.revertedWithCustomError(nav, "NotAllowlisted");
      // Correct proof (sibling leaf) succeeds
      await nav.connect(alice)["onboard(uint256,bytes32[])"](1, [leafCarol]);
      expect(await shares.balanceOf(alice.address)).to.equal(ethers.parseEther("10"));
    });

    it("a token holder who is not on the allowlist cannot claim", async function () {
      const [, alice, bob, carol] = await ethers.getSigners();
      const root = hashPair(nftLeaf(alice.address), nftLeaf(carol.address));
      const { nav, nft } = await deployNFTGated({ allowlistRoot: root });
      // Bob owns a gate NFT but is not in the allowlist tree
      await nft.mint(bob.address, 2);
      await expect(
        nav.connect(bob)["onboard(uint256,bytes32[])"](2, [nftLeaf(carol.address)])
      ).to.be.revertedWithCustomError(nav, "NotAllowlisted");
    });
  });

  describe("Caps & limits", function () {
    it("enforces mintCap", async function () {
      const { nav, nft, alice, bob } = await deployNFTGated({ mintCap: ethers.parseEther("10") });
      await nft.mint(alice.address, 1);
      await nft.mint(bob.address, 2);
      await nav.connect(alice)["onboard(uint256)"](1); // fills the cap exactly
      await expect(nav.connect(bob)["onboard(uint256)"](2)).to.be.revertedWithCustomError(nav, "MintCapExceeded");
    });

    it("enforces perAddressCap across multiple tokens", async function () {
      const { nav, nft, alice } = await deployNFTGated({ perAddressCap: ethers.parseEther("10") });
      await nft.mint(alice.address, 1);
      await nft.mint(alice.address, 2);
      await nav.connect(alice)["onboard(uint256)"](1);
      await expect(nav.connect(alice)["onboard(uint256)"](2)).to.be.revertedWithCustomError(nav, "PerAddressCapExceeded");
    });
  });

  describe("Expiry & pause", function () {
    it("reverts Expired after expiry", async function () {
      const now = await time.latest();
      const { nav, nft, alice } = await deployNFTGated({ expiry: now + 1000 });
      await nft.mint(alice.address, 1);
      await time.increase(2000);
      await expect(nav.connect(alice)["onboard(uint256)"](1)).to.be.revertedWithCustomError(nav, "Expired");
    });

    it("avatar can pause and unpause; paused blocks onboarding", async function () {
      const { nav, nft, avatar, alice } = await deployNFTGated();
      await nft.mint(alice.address, 1);
      const avatarSigner = await asAvatar(await avatar.getAddress());

      await nav.connect(avatarSigner).pause();
      await expect(nav.connect(alice)["onboard(uint256)"](1)).to.be.revertedWithCustomError(nav, "IsPaused");

      await nav.connect(avatarSigner).unpause();
      await nav.connect(alice)["onboard(uint256)"](1);
      expect(await nav.claimed(1)).to.equal(true);
    });

    it("non-authorized caller cannot pause", async function () {
      const { nav, alice } = await deployNFTGated();
      await expect(nav.connect(alice).pause()).to.be.revertedWithCustomError(nav, "NotAuthorized");
    });
  });

  describe("IMembershipGate views", function () {
    it("isEligible reflects collection balance", async function () {
      const { nav, nft, alice, bob } = await deployNFTGated();
      await nft.mint(alice.address, 1);
      expect(await nav.isEligible(alice.address)).to.equal(true);
      expect(await nav.isEligible(bob.address)).to.equal(false);
    });

    it("isEligibleToken reflects specific ownership and survives nonexistent tokens", async function () {
      const { nav, nft, alice, bob } = await deployNFTGated();
      await nft.mint(alice.address, 1);
      expect(await nav.isEligibleToken(alice.address, 1)).to.equal(true);
      expect(await nav.isEligibleToken(bob.address, 1)).to.equal(false);
      expect(await nav.isEligibleToken(alice.address, 42)).to.equal(false); // nonexistent → false, no revert
    });

    it("canOnboard combines eligibility, claim status, pause and expiry", async function () {
      const { nav, nft, avatar, alice } = await deployNFTGated();
      await nft.mint(alice.address, 1);
      expect(await nav.canOnboard(alice.address, 1)).to.equal(true);

      await nav.connect(alice)["onboard(uint256)"](1);
      expect(await nav.canOnboard(alice.address, 1)).to.equal(false); // claimed

      await nft.mint(alice.address, 2);
      expect(await nav.canOnboard(alice.address, 2)).to.equal(true);
      const avatarSigner = await asAvatar(await avatar.getAddress());
      await nav.connect(avatarSigner).pause();
      expect(await nav.canOnboard(alice.address, 2)).to.equal(false); // paused
    });

    it("canOnboard returns false after expiry", async function () {
      const now = await time.latest();
      const { nav, nft, alice } = await deployNFTGated({ expiry: now + 1000 });
      await nft.mint(alice.address, 1);
      expect(await nav.canOnboard(alice.address, 1)).to.equal(true);
      await time.increase(2000);
      expect(await nav.canOnboard(alice.address, 1)).to.equal(false); // expired
    });
  });
});
