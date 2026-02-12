/**
 * Generate Test Wallets for E2E Testing
 *
 * This script generates 5 test wallets with private keys for E2E testing.
 *
 * Usage:
 *   npx hardhat run scripts/generate-test-wallets.ts
 *
 * Output:
 *   - Private keys and addresses for 5 test wallets
 *   - Ready to paste into .env.e2e
 *
 * IMPORTANT:
 *   - These are random wallets - you need to fund them with testnet QUAI
 *   - NEVER use these for production or mainnet
 *   - NEVER commit .env.e2e with actual keys
 */

import { ethers } from "hardhat";

async function main() {
  console.log("\n🔑 Generating Test Wallets for E2E Testing\n");
  console.log("=" .repeat(80));
  console.log("\nIMPORTANT:");
  console.log("- These are NEW random wallets");
  console.log("- You need to fund each with ~1 QUAI on Orchard testnet");
  console.log("- Copy the private keys to .env.e2e");
  console.log("- NEVER commit .env.e2e or use these keys for production\n");
  console.log("=" .repeat(80) + "\n");

  const walletNames = ["Deployer", "Alice", "Bob", "Carol", "Dave"];
  const wallets: { name: string; address: string; privateKey: string }[] = [];

  // Generate wallets
  for (const name of walletNames) {
    const wallet = ethers.Wallet.createRandom();
    wallets.push({
      name,
      address: wallet.address,
      privateKey: wallet.privateKey,
    });
  }

  // Display wallet info
  console.log("📋 Generated Wallets:\n");
  for (const wallet of wallets) {
    console.log(`${wallet.name}:`);
    console.log(`  Address:     ${wallet.address}`);
    console.log(`  Private Key: ${wallet.privateKey}\n`);
  }

  // Display .env.e2e format
  console.log("=" .repeat(80));
  console.log("\n📝 Copy to .env.e2e:\n");
  console.log("# TEST WALLET PRIVATE KEYS");
  console.log(`DEPLOYER_PK=${wallets[0].privateKey}`);
  console.log(`ALICE_PK=${wallets[1].privateKey}`);
  console.log(`BOB_PK=${wallets[2].privateKey}`);
  console.log(`CAROL_PK=${wallets[3].privateKey}`);
  console.log(`DAVE_PK=${wallets[4].privateKey}\n`);

  // Display funding instructions
  console.log("=" .repeat(80));
  console.log("\n💰 Funding Instructions:\n");
  console.log("1. Visit Quai Orchard Faucet: https://faucet.quai.network");
  console.log("2. Fund each address with ~1 QUAI:");
  for (const wallet of wallets) {
    console.log(`   - ${wallet.name}: ${wallet.address}`);
  }
  console.log("\n3. Wait for transactions to confirm");
  console.log("4. Run E2E tests: npm run test:e2e:local\n");
  console.log("=" .repeat(80) + "\n");

  // Display security reminder
  console.log("🔒 Security Reminders:");
  console.log("- Only use these wallets for E2E testing");
  console.log("- Keep .env.e2e in .gitignore (already configured)");
  console.log("- Do not commit actual private keys to git");
  console.log("- These wallets are for testnet only - NEVER use on mainnet\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
