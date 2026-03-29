import { quais } from "quais";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

/**
 * Post-deployment vault verification script.
 *
 * Checks that a deployed Quai Vault is correctly configured for DAO use:
 *   - delegatecallAllowed whitelist  (MultiSendCallOnly must be whitelisted for DAOShip proposal execution)
 *   - minExecutionDelay              (matches expected value)
 *   - DAOShip is enabled as module   (vault accepts proposal execution from DAOShip)
 *   - Owners and threshold           (match deployment parameters)
 *
 * Usage:
 *   VAULT_ADDRESS=0x... DAOSHIP_ADDRESS=0x... npx hardhat run scripts/verify-vault-config.ts --network quai
 *
 * Or with .env:
 *   Set VAULT_ADDRESS and DAOSHIP_ADDRESS in .env, then:
 *   npx hardhat run scripts/verify-vault-config.ts --network quai
 */

const QUAI_VAULT_ABI = [
  "function delegatecallAllowed(address target) view returns (bool)",
  "function minExecutionDelay() view returns (uint32)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function isModuleEnabled(address module) view returns (bool)",
  "function isOwner(address owner) view returns (bool)",
];

async function main() {
  console.log("============================================================");
  console.log("🔍 Quai Vault Configuration Verifier");
  console.log("============================================================\n");

  // Load environment
  const rpcUrl = process.env.RPC_URL || "https://rpc.orchard.quai.network";
  const provider = new quais.JsonRpcProvider(rpcUrl, undefined, { usePathing: true });

  // Resolve vault and DAOShip addresses
  const vaultAddress = process.env.VAULT_ADDRESS || resolveFromDeployment("QuaiVault");
  const daoShipAddress = process.env.DAOSHIP_ADDRESS || resolveFromDeployment("DAOShip");

  if (!vaultAddress) {
    console.error("❌ VAULT_ADDRESS not set and not found in deployment-addresses.json");
    console.error("   Set VAULT_ADDRESS=0x... in your environment or .env file");
    process.exit(1);
  }

  console.log(`📍 Vault:   ${vaultAddress}`);
  if (daoShipAddress) {
    console.log(`📍 DAOShip: ${daoShipAddress}`);
  } else {
    console.log(`⚠️  DAOShip: not provided — module check will be skipped`);
  }
  console.log();

  const vault = new quais.Contract(vaultAddress, QUAI_VAULT_ABI, provider);

  let allPassed = true;

  // ─── 1. DelegateCall whitelist check ────────────────────────────────────────
  console.log("1. DelegateCall whitelist check");
  const multisendCallOnlyAddress = process.env.MULTISEND_CALL_ONLY;
  if (!multisendCallOnlyAddress) {
    console.log("   ⚠️  MULTISEND_CALL_ONLY not set in environment — cannot verify delegatecall whitelist");
  } else {
    try {
      const allowed: boolean = await vault.delegatecallAllowed(multisendCallOnlyAddress);
      if (allowed) {
        console.log(`   ✅ delegatecallAllowed(${multisendCallOnlyAddress}) = true  (MultiSendCallOnly is whitelisted — correct for DAO vaults)`);
      } else {
        console.log(`   ❌ delegatecallAllowed(${multisendCallOnlyAddress}) = false  (MultiSendCallOnly is NOT whitelisted — FATAL for DAOShip proposal execution)`);
        console.log("      All DAO proposals will fail. The vault must be redeployed with MultiSendCallOnly in initialDelegatecallTargets.");
        allPassed = false;
      }
    } catch (e) {
      console.log(`   ⚠️  Could not read delegatecallAllowed: ${(e as Error).message}`);
      console.log("      Vault may not support this view or the address is incorrect.");
    }
  }

  // ─── 2. minExecutionDelay ───────────────────────────────────────────────────
  console.log("\n2. Execution delay check");
  try {
    const delay: bigint = await vault.minExecutionDelay();
    const expectedDelay = Number(process.env.VAULT_MIN_EXECUTION_DELAY ?? 0);
    const delaySeconds = Number(delay);

    if (delaySeconds === expectedDelay) {
      console.log(`   ✅ minExecutionDelay = ${delaySeconds}s  (matches VAULT_MIN_EXECUTION_DELAY=${expectedDelay})`);
    } else {
      console.log(`   ⚠️  minExecutionDelay = ${delaySeconds}s  (expected ${expectedDelay}s from VAULT_MIN_EXECUTION_DELAY)`);
      if (delaySeconds > 0) {
        const days = (delaySeconds / 86400).toFixed(1);
        console.log(`      Proposals require a ${days}-day wait before execution.`);
      }
    }
  } catch (e) {
    console.log(`   ⚠️  Could not read minExecutionDelay: ${(e as Error).message}`);
  }

  // ─── 3. Module check (DAOShip) ─────────────────────────────────────────────
  console.log("\n3. Module check (DAOShip)");
  if (daoShipAddress) {
    try {
      const enabled: boolean = await vault.isModuleEnabled(daoShipAddress);
      if (enabled) {
        console.log(`   ✅ DAOShip (${daoShipAddress}) is enabled as a module`);
      } else {
        console.log(`   ❌ DAOShip (${daoShipAddress}) is NOT enabled as a module`);
        console.log("      DAOShip cannot execute proposals through the vault.");
        console.log("      Call vault.enableModule(daoShipAddress) from an owner.");
        allPassed = false;
      }
    } catch (e) {
      console.log(`   ⚠️  Could not check module status: ${(e as Error).message}`);
    }
  } else {
    console.log("   ⏭️  Skipped — set DAOSHIP_ADDRESS to check module enablement");
  }

  // ─── 4. Owners and threshold ─────────────────────────────────────────────────
  console.log("\n4. Owners and threshold");
  try {
    const [owners, threshold] = await Promise.all([
      vault.getOwners(),
      vault.getThreshold(),
    ]);

    console.log(`   Threshold: ${threshold} / ${owners.length}`);
    console.log("   Owners:");
    for (const owner of owners) {
      console.log(`     - ${owner}`);
    }

    // Cross-check with env if provided
    const envOwners = process.env.VAULT_OWNERS?.split(",").map((o) => o.trim().toLowerCase()) ?? [];
    const envThreshold = process.env.VAULT_THRESHOLD ? Number(process.env.VAULT_THRESHOLD) : null;

    if (envOwners.length > 0) {
      const actualLower = (owners as string[]).map((o: string) => o.toLowerCase());
      const missing = envOwners.filter((o) => !actualLower.includes(o));
      const extra = actualLower.filter((o) => !envOwners.includes(o));
      if (missing.length === 0 && extra.length === 0) {
        console.log("   ✅ Owners match VAULT_OWNERS");
      } else {
        if (missing.length > 0) console.log(`   ⚠️  Missing owners: ${missing.join(", ")}`);
        if (extra.length > 0) console.log(`   ⚠️  Unexpected owners: ${extra.join(", ")}`);
      }
    }

    if (envThreshold !== null) {
      if (Number(threshold) === envThreshold) {
        console.log(`   ✅ Threshold matches VAULT_THRESHOLD=${envThreshold}`);
      } else {
        console.log(`   ⚠️  Threshold mismatch: vault=${threshold}, VAULT_THRESHOLD=${envThreshold}`);
      }
    }
  } catch (e) {
    console.log(`   ⚠️  Could not read owners/threshold: ${(e as Error).message}`);
  }

  // ─── Summary ─────────────────────────────────────────────────────────────────
  console.log("\n============================================================");
  if (allPassed) {
    console.log("✅ Vault configuration looks correct.");
  } else {
    console.log("❌ Vault has configuration issues — review items marked ❌ above.");
  }
  console.log("============================================================\n");

  if (!allPassed) process.exit(1);
}

function resolveFromDeployment(key: string): string | undefined {
  try {
    const deploymentPath = path.join(__dirname, "../deployment-addresses.json");
    if (!fs.existsSync(deploymentPath)) return undefined;
    const data = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
    return data?.contracts?.[key];
  } catch {
    return undefined;
  }
}

main().catch((err) => {
  console.error("\n💥 Verification failed:", err.message ?? err);
  process.exit(1);
});
