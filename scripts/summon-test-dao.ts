import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

/**
 * Summon a test DAO using deployed BaalSummoner
 * Requires factory deployment from previous step
 */
async function main() {
  console.log("=".repeat(60));
  console.log("🧙 Summoning Test DAO");
  console.log("=".repeat(60));

  const [deployer, alice, bob] = await ethers.getSigners();
  console.log("\n👤 Summoner:", deployer.address);

  // Load deployment addresses
  const deploymentsDir = path.join(__dirname, "../deployments");
  const files = fs.readdirSync(deploymentsDir);
  const deploymentFile = files
    .filter((f) => f.startsWith("deployment-complete-"))
    .sort()
    .reverse()[0];

  if (!deploymentFile) {
    throw new Error(
      "No deployment found. Run deploy-all.ts first."
    );
  }

  const deploymentData = JSON.parse(
    fs.readFileSync(path.join(deploymentsDir, deploymentFile), "utf-8")
  );

  const summonerAddress = deploymentData.contracts.BaalSummoner;
  const multisendLibrary = deploymentData.references.MultiSend;

  console.log("\n📦 Using contracts:");
  console.log(`   BaalSummoner: ${summonerAddress}`);
  console.log(`   MultiSend:    ${multisendLibrary}`);

  // Connect to BaalSummoner
  const BaalSummoner = await ethers.getContractFactory("BaalSummoner");
  const summoner = BaalSummoner.attach(summonerAddress);

  // Generate deterministic salt
  const salt = ethers.solidityPackedKeccak256(
    ["string", "uint256"],
    ["TEST_DAO", Date.now()]
  );

  console.log("\n🎲 Salt:", salt);

  // Predict addresses
  const [predictedBaal, predictedShares, predictedLoot] =
    await summoner.calculateAddresses(salt);

  console.log("\n🔮 Predicted Addresses:");
  console.log(`   Baal:   ${predictedBaal}`);
  console.log(`   Shares: ${predictedShares}`);
  console.log(`   Loot:   ${predictedLoot}`);

  // Create a mock avatar (for testing without actual Quai Vault)
  // In production, this would be a real Quai Vault address
  const MockAvatar = await ethers.getContractFactory("Poster"); // Use Poster as mock
  const mockAvatar = await MockAvatar.deploy();
  await mockAvatar.waitForDeployment();
  const avatarAddress = await mockAvatar.getAddress();

  console.log("\n🏛️  Mock Avatar (treasury):", avatarAddress);
  console.log("   ⚠️  In production, use actual Quai Vault address");

  // Prepare initialization params
  const votingPeriod = 7 * 24 * 60 * 60; // 7 days
  const gracePeriod = 3 * 24 * 60 * 60; // 3 days
  const proposalOffering = ethers.parseEther("0.1"); // 0.1 ETH
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

  // Initial members and shares
  const initMembers = [deployer.address, alice.address, bob.address];
  const initShareAmounts = [
    ethers.parseEther("100"), // Deployer: 100 shares
    ethers.parseEther("50"), // Alice: 50 shares
    ethers.parseEther("25"), // Bob: 25 shares
  ];
  const initLootAmounts = [
    ethers.parseEther("0"), // No loot
    ethers.parseEther("0"),
    ethers.parseEther("0"),
  ];

  console.log("\n⚙️  Governance Config:");
  console.log(`   Voting Period:       ${votingPeriod / 86400} days`);
  console.log(`   Grace Period:        ${gracePeriod / 86400} days`);
  console.log(`   Proposal Offering:   ${ethers.formatEther(proposalOffering)} ETH`);
  console.log(`   Quorum:              ${quorumPercent / 100}%`);
  console.log(`   Sponsor Threshold:   ${ethers.formatEther(sponsorThreshold)} shares`);
  console.log(`   Min Retention:       ${minRetentionPercent / 100}%`);

  console.log("\n👥 Initial Members:");
  initMembers.forEach((member, i) => {
    console.log(
      `   ${member} - ${ethers.formatEther(initShareAmounts[i])} shares`
    );
  });

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
      ethers.ZeroAddress, // lootToken (will be replaced by summoner)
      ethers.ZeroAddress, // sharesToken (will be replaced by summoner)
      avatarAddress, // avatar
      ethers.ZeroAddress, // forwarder (not using meta-txs)
      multisendLibrary, // multisend library
      governanceConfig,
      [], // no shamans initially
      [], // no shaman permissions
      initMembers,
      initShareAmounts,
      initLootAmounts,
    ]
  );

  // Summon!
  console.log("\n🔮 Summoning DAO...");
  const tx = await summoner.summonBaal(initializationParams, [], salt);
  console.log("   Transaction:", tx.hash);

  const receipt = await tx.wait();
  console.log("   Gas used:", receipt?.gasUsed.toString());

  // Verify deployment
  const Baal = await ethers.getContractFactory("Baal");
  const baal = Baal.attach(predictedBaal);

  const actualAvatar = await baal.avatar();
  const actualShares = await baal.sharesToken();
  const actualLoot = await baal.lootToken();
  const totalShares = await baal.totalShares();
  const totalLoot = await baal.totalLoot();

  console.log("\n✅ DAO Summoned Successfully!");
  console.log("\n📋 Deployed Contracts:");
  console.log(`   Baal:   ${predictedBaal}`);
  console.log(`   Shares: ${actualShares}`);
  console.log(`   Loot:   ${actualLoot}`);
  console.log(`   Avatar: ${actualAvatar}`);

  console.log("\n📊 DAO Stats:");
  console.log(`   Total Shares: ${ethers.formatEther(totalShares)}`);
  console.log(`   Total Loot:   ${ethers.formatEther(totalLoot)}`);

  // Verify member balances
  const SharesERC20 = await ethers.getContractFactory("SharesERC20");
  const shares = SharesERC20.attach(actualShares);

  console.log("\n👥 Member Balances:");
  for (let i = 0; i < initMembers.length; i++) {
    const balance = await shares.balanceOf(initMembers[i]);
    const votingPower = await shares.balanceOf(initMembers[i]);
    console.log(
      `   ${initMembers[i]}: ${ethers.formatEther(balance)} shares (${ethers.formatEther(votingPower)} voting power)`
    );
  }

  // Save summoned DAO info
  const summonInfo = {
    network: (await ethers.provider.getNetwork()).name,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    timestamp: Date.now(),
    summoner: deployer.address,
    salt,
    dao: {
      baal: predictedBaal,
      shares: actualShares,
      loot: actualLoot,
      avatar: actualAvatar,
    },
    governance: {
      votingPeriod,
      gracePeriod,
      proposalOffering: proposalOffering.toString(),
      quorumPercent,
      sponsorThreshold: sponsorThreshold.toString(),
      minRetentionPercent,
    },
    members: initMembers.map((address, i) => ({
      address,
      shares: initShareAmounts[i].toString(),
      loot: initLootAmounts[i].toString(),
    })),
  };

  const filename = `summoned-dao-${Date.now()}.json`;
  fs.writeFileSync(
    path.join(deploymentsDir, filename),
    JSON.stringify(summonInfo, null, 2)
  );

  console.log(`\n📝 DAO info saved to: deployments/${filename}`);

  console.log("\n🎉 Test DAO ready!");
  console.log("\n📝 Next Steps:");
  console.log("   1. Submit a test proposal");
  console.log("   2. Vote on the proposal");
  console.log("   3. Process the proposal after voting period");
  console.log("   4. Test ragequit functionality");

  return summonInfo;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Summoning failed:");
    console.error(error);
    process.exit(1);
  });
