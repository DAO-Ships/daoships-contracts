import { ethers } from "ethers";

// Transaction data from the error
const txData = "0xfc5d57120000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000056000000000000000000000000000000000000000000000000000000000000005800000000000000000000000000000000000000000000000000000000000000001030c74a4da54b992b395b98909d120aba7585f708beafdb6bd72f2b59079c9def5c3309f6cf46272d156b62ddf2a62a3cafaffd123111929887566612ae36ffde683acb8fbaea1e5b61ea3dbe539d20499913cc824077e3903074d3c974bef0d2dc53d45cbd17958e1be57ba6b535f3adbed6dc8f6ff8da6522c88065beecdd9000000000000000000000000000000000000000000000000000000000000044000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060a725ef00cb737f24f7e00da94c1ce03bf1dc00000000000000000000000000000000000000000000000000000000000001800000000000000000000000000000000000000000000000000000000000000260000000000000000000000000000000000000000000000000000000000000028000000000000000000000000000000000000000000000000000000000000002a0000000000000000000000000000000000000000000000000000000000000032000000000000000000000000000000000000000000000000000000000000003a0000000000000000000000000000000000000000000000000000000000000042000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000093a80000000000000000000000000000000000000000000000000000000000003f480000000000000000000000000000000000000000000000000016345785d8a000000000000000000000000000000000000000000000000000000000000000007d00000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000000019c8000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000007204c0f8eb96e207482e1c472e4f74309adb86000000000000000000000000002c3c3fa4c095e0924d3996cce23c2649edfb04000000000000000000000000005b2a57142fa88bd32e7f06ce9933f4d569af1000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000056bc75e2d63100000000000000000000000000000000000000000000000000002b5e3af16b18800000000000000000000000000000000000000000000000000015af1d78b58c40000000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000015af1d78b58c400000000000000000000000000000000000000000000000000008ac7230489e80000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000007204c0f8eb96e207482e1c472e4f74309adb86";

// Extract function selector
const selector = txData.slice(0, 10);
console.log("Function Selector:", selector);

// Generate selector for expected function signature
const expectedSig = "summonBaalAndVault(bytes,bytes[],address[],uint256,uint256,uint256,uint256,uint256)";
const expectedSelector = ethers.id(expectedSig).slice(0, 10);
console.log("Expected Selector:", expectedSelector, `(${expectedSig})`);

if (selector === expectedSelector) {
  console.log("✅ Function selector matches!\n");
} else {
  console.log("❌ Function selector MISMATCH!\n");
}

// Try to decode the parameters
console.log("Attempting to decode parameters...\n");

const iface = new ethers.Interface([
  "function summonBaalAndVault(bytes initializationParams, bytes[] initializationActions, address[] vaultOwners, uint256 vaultThreshold, uint256 vaultSalt, uint256 sharesSalt, uint256 lootSalt, uint256 baalSalt)"
]);

try {
  const decoded = iface.decodeFunctionData("summonBaalAndVault", txData);
  console.log("✅ Successfully decoded transaction data!");
  console.log("\nDecoded Parameters:");
  console.log("==================");
  console.log("initializationParams length:", decoded.initializationParams.length, "bytes");
  console.log("initializationActions length:", decoded.initializationActions.length);
  console.log("vaultOwners:", decoded.vaultOwners);
  console.log("vaultThreshold:", decoded.vaultThreshold.toString());
  console.log("vaultSalt:", decoded.vaultSalt.toString());
  console.log("sharesSalt:", decoded.sharesSalt.toString());
  console.log("lootSalt:", decoded.lootSalt.toString());
  console.log("baalSalt:", decoded.baalSalt.toString());

  // Now try to decode the initializationParams to check parameter count
  console.log("\n\nDecoding initializationParams...");
  console.log("=================================\n");

  // Try with 11 parameters
  console.log("--- Attempt 1: Decode with 11 parameters ---");
  try {
    const decoded11 = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]"],
      decoded.initializationParams
    );
    console.log("✅ SUCCESS with 11 parameters");
    console.log("   This means initializationParams has 11 parameters!");
  } catch (error: any) {
    console.log("❌ FAILED with 11 parameters");
    console.log("   Error:", error.message.split('\n')[0]);
  }

  // Try with 12 parameters
  console.log("\n--- Attempt 2: Decode with 12 parameters ---");
  try {
    const decoded12 = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]"],
      decoded.initializationParams
    );
    console.log("✅ SUCCESS with 12 parameters");
    console.log("   This means initializationParams has 12 parameters!");
    console.log("\n   Decoded values:");
    console.log("   - lootToken:", decoded12[0]);
    console.log("   - sharesToken:", decoded12[1]);
    console.log("   - avatar:", decoded12[2]);
    console.log("   - forwarder:", decoded12[3]);
    console.log("   - multisendLibrary:", decoded12[4]);
    console.log("   - governanceConfig length:", decoded12[5].length, "bytes");
    console.log("   - shamans:", decoded12[6]);
    console.log("   - shamanPermissions:", decoded12[7]);
    console.log("   - initMembers:", decoded12[8]);
    console.log("   - initShareAmounts:", decoded12[9].map((x: any) => ethers.formatEther(x)));
    console.log("   - initLootAmounts:", decoded12[10].map((x: any) => ethers.formatEther(x)));
    console.log("   - guildTokens:", decoded12[11]);
  } catch (error: any) {
    console.log("❌ FAILED with 12 parameters");
    console.log("   Error:", error.message.split('\n')[0]);
  }

} catch (error: any) {
  console.log("❌ Failed to decode transaction data");
  console.log("   Error:", error.message);
}
