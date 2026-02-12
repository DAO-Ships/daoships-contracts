import { ethers } from "hardhat";

async function main() {
  const vaultAddress = "0x003e747E866420E9260c24AccB5D48d0AAC47DC3"; // From summon-dao output

  console.log("Checking if vault already exists at:", vaultAddress, "\n");

  const code = await ethers.provider.getCode(vaultAddress);

  console.log("Bytecode at address:");
  console.log("  Length:", code.length, "chars");
  console.log("  Value:", code === "0x" ? "(empty - no contract)" : "(contract exists!)");

  if (code !== "0x") {
    console.log("\n❌ PROBLEM FOUND: A contract already exists at this address!");
    console.log("   This would cause CREATE2 deployment to fail.");
    console.log("   The vault salt needs to be different to get a new address.");

    // Try to identify what's deployed there
    try {
      const QuaiVault = await ethers.getContractFactory("QuaiVault");
      const vault = QuaiVault.attach(vaultAddress) as any;
      const owners = await vault.getOwners();
      console.log("\n   Deployed vault owners:", owners);
    } catch (error) {
      console.log("\n   Could not read as QuaiVault");
    }
  } else {
    console.log("\n✅ No contract at this address - deployment should work");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
