/**
 * replace-navigator.ts
 *
 * Example script for replacing a navigator on a live DAOShip DAO.
 *
 * Gap 11: Future navigator deployments are unknown at DAO launch. This script shows
 * front-end developers and integrators the exact calldata construction needed to:
 *   1. Deploy a new navigator contract
 *   2. Build a setNavigators() proposal calling the DAO
 *   3. Optionally submit the proposal on-chain
 *
 * Usage:
 *   npx hardhat run scripts/replace-navigator.ts --network <network>
 *
 * Environment variables (see .env.example):
 *   DEPLOYER_PRIVATE_KEY  - Deployer / proposal submitter private key
 *   DAOSHIP_ADDRESS       - Address of the deployed DAOShip DAO
 *   OLD_NAVIGATOR_ADDRESS - Navigator to revoke (set to address(0) to skip revocation)
 *   NEW_NAVIGATOR_TYPE    - "onboarder" | "erc20tribute" (controls which navigator to deploy)
 *
 * Navigator permission bits (additive):
 *   0  = no permissions (effectively removes the navigator)
 *   1  = ADMIN   - can call admin functions (lockAdmin, setGuildTokens, setNavigators)
 *   2  = MANAGER - can mint/burn shares and loot
 *   4  = GOVERNOR - can call governor functions (setGovernanceConfig) + pause/unpause navigators
 *
 * Navigator combinations:
 *   2  = MANAGER only          (OnboarderNavigator, ERC20TributeNavigator)
 *   4  = GOVERNOR only         (pause/unpause authority without minting)
 *   6  = MANAGER + GOVERNOR    (trusted navigator with full operational scope)
 *   7  = ADMIN + MANAGER + GOVERNOR (maximum trust — use with caution)
 */

import { quais } from "quais";
import * as dotenv from "dotenv";

dotenv.config();

// ─── ABI fragments ───────────────────────────────────────────────────────────

const DAOSHIP_ABI = [
  // setNavigators: set permission flags for a list of navigator addresses
  "function setNavigators(address[] calldata navigators, uint256[] calldata permissions) external",
  // submitProposal: submit a governance proposal
  "function submitProposal(bytes calldata proposalData, uint32 expiration, string calldata details) external payable returns (uint32)",
  // Read-only
  "function navigators(address) external view returns (uint256)",
  "function avatar() external view returns (address)",
  "function proposalOffering() external view returns (uint256)",
  "function sponsorThreshold() external view returns (uint256)",
] as const;

const MULTISEND_ABI = [
  "function multiSend(bytes memory transactions) external",
] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Encode a single MultiSend operation.
 *
 * MultiSend packed format per operation:
 *   uint8  operation  (0 = Call, 1 = DelegateCall)
 *   address to        (20 bytes)
 *   uint256 value     (32 bytes)
 *   uint256 dataLength (32 bytes)
 *   bytes  data       (dataLength bytes)
 */
function encodeMultiSendOperation(
  operation: 0 | 1,
  to: string,
  value: bigint,
  data: string
): string {
  const dataBytes = quais.getBytes(data);
  return quais.concat([
    quais.toBeHex(operation, 1),                     // uint8 operation
    quais.getBytes(to),                               // address to (20 bytes)
    quais.toBeHex(value, 32),                         // uint256 value
    quais.toBeHex(dataBytes.length, 32),              // uint256 dataLength
    dataBytes,                                        // bytes data
  ]);
}

/**
 * Encode a full MultiSend batch (array of operations → single multiSend(bytes) calldata).
 * This is what goes into DAOShip proposal data — DAOShip DelegateCalls this to MultiSend.
 */
function encodeMultiSendBatch(
  operations: ReturnType<typeof encodeMultiSendOperation>[]
): string {
  const packed = quais.concat(operations);
  const iface = new quais.Interface(MULTISEND_ABI);
  return iface.encodeFunctionData("multiSend", [packed]);
}

/**
 * Encode setNavigators calldata.
 * @param addresses  Navigator addresses to configure
 * @param permissions  Permission bitmask for each address (0 = revoke)
 */
function encodeSetNavigators(addresses: string[], permissions: bigint[]): string {
  const iface = new quais.Interface(DAOSHIP_ABI);
  return iface.encodeFunctionData("setNavigators", [addresses, permissions]);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── Config ────────────────────────────────────────────────────────────────
  const rpcUrl = process.env.RPC_URL ?? "http://localhost:8545";
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  const daoShipAddress = process.env.DAOSHIP_ADDRESS;
  const oldNavigatorAddress = process.env.OLD_NAVIGATOR_ADDRESS ?? quais.ZeroAddress;

  if (!privateKey) throw new Error("DEPLOYER_PRIVATE_KEY not set");
  if (!daoShipAddress) throw new Error("DAOSHIP_ADDRESS not set");

  const provider = new quais.JsonRpcProvider(rpcUrl, undefined, { usePathing: true });
  const signer = new quais.Wallet(privateKey, provider);

  const daoShip = new quais.Contract(daoShipAddress, DAOSHIP_ABI, signer);

  console.log("\n═══ Replace Navigator Script ═══════════════════════════════════════");
  console.log(`DAOShip:       ${daoShipAddress}`);
  console.log(`Old navigator: ${oldNavigatorAddress}`);
  console.log(`Submitter:     ${signer.address}`);

  // ── 1. Deploy new navigator ──────────────────────────────────────────────────
  // NOTE: Navigator deployment is navigator-type specific. This example shows the
  // pattern using a generic factory. Replace with your navigator's constructor args.
  //
  // For front-end integrators: you can deploy the navigator off-chain before
  // building the proposal. The navigator address is known at deploy time and
  // can be hard-coded into the setNavigators calldata below.

  console.log("\n[1] Deploy new navigator");
  console.log("    ↳ In production: deploy your navigator contract here and capture its address.");
  console.log("    ↳ For this example we use a placeholder address.");

  const newNavigatorAddress: string = process.env.NEW_NAVIGATOR_ADDRESS
    ?? "0x0000000000000000000000000000000000000001"; // replace with actual deployed address

  // Navigator permission: MANAGER (2) + GOVERNOR (4) = 6
  // Adjust based on what the navigator needs to do:
  //   OnboarderNavigator / ERC20TributeNavigator: 2 (MANAGER only — can mintShares/mintLoot)
  //   Pause authority navigator:                  4 (GOVERNOR only)
  //   Full operational navigator:                 6 (MANAGER + GOVERNOR)
  const newNavigatorPermission = 2n; // MANAGER

  console.log(`    New navigator: ${newNavigatorAddress}`);
  console.log(`    Permission:    ${newNavigatorPermission} (MANAGER)`);

  // ── 2. Build setNavigators calldata ──────────────────────────────────────────
  // Build ONE setNavigators call that atomically:
  //   a. Revokes the old navigator (permission = 0)
  //   b. Grants the new navigator its permissions
  //
  // Alternatively, if oldNavigatorAddress == address(0), skip the revocation.

  console.log("\n[2] Build setNavigators calldata");

  const navigatorAddresses: string[] = [];
  const navigatorPermissions: bigint[] = [];

  if (oldNavigatorAddress !== quais.ZeroAddress) {
    navigatorAddresses.push(oldNavigatorAddress);
    navigatorPermissions.push(0n); // revoke
    console.log(`    Revoke: ${oldNavigatorAddress} → 0`);
  }

  navigatorAddresses.push(newNavigatorAddress);
  navigatorPermissions.push(newNavigatorPermission);
  console.log(`    Grant:  ${newNavigatorAddress} → ${newNavigatorPermission}`);

  const setNavigatorsCalldata = encodeSetNavigators(navigatorAddresses, navigatorPermissions);
  console.log(`    setNavigators calldata: ${setNavigatorsCalldata.slice(0, 66)}...`);

  // ── 3. Wrap in MultiSend batch ────────────────────────────────────────────
  // DAOShip proposals execute via DelegateCall to MultiSend.
  // Even a single call must be wrapped in the MultiSend format.
  //
  // operation = 0 (Call) — setNavigators is a daoShipOnly function; DAOShip calls itself
  // via the avatar's execTransactionFromModule, which DelegateCalls MultiSend,
  // which then Calls the target. So the operation here is Call (0).

  console.log("\n[3] Wrap in MultiSend batch");

  const multiSendOp = encodeMultiSendOperation(
    0,                // Call
    daoShipAddress,   // to: DAOShip itself (setNavigators is daoShipOnly)
    0n,               // value: 0 ETH
    setNavigatorsCalldata
  );

  const proposalData = encodeMultiSendBatch([multiSendOp]);
  console.log(`    Proposal data: ${proposalData.slice(0, 66)}...`);
  console.log(`    Full proposal data (for verification):\n    ${proposalData}`);

  // ── 4. Read proposal offering ─────────────────────────────────────────────
  const offering = await daoShip.proposalOffering();
  console.log(`\n[4] Proposal offering: ${quais.formatQuai(offering)} QUAI`);

  // ── 5. Optionally submit proposal ─────────────────────────────────────────
  const DRY_RUN = process.env.DRY_RUN !== "false"; // default: dry run
  if (DRY_RUN) {
    console.log("\n[5] DRY RUN — proposal NOT submitted.");
    console.log("    Set DRY_RUN=false in your environment to submit on-chain.");
    console.log("\n    To submit manually, call:");
    console.log(`    daoShip.submitProposal(`);
    console.log(`      proposalData = "${proposalData}",`);
    console.log(`      expiration   = 0,`);
    console.log(`      details      = "Replace navigator: ${oldNavigatorAddress} → ${newNavigatorAddress}"`);
    console.log(`    , { value: ${offering} })`);
    return;
  }

  console.log("\n[5] Submitting proposal on-chain...");
  const tx = await daoShip.submitProposal(
    proposalData,
    0,  // expiration: 0 = no expiry
    `Replace navigator: revoke ${oldNavigatorAddress}, grant ${newNavigatorAddress} permission ${newNavigatorPermission}`,
    { value: offering }
  );

  const receipt = await tx.wait();
  console.log(`    Transaction: ${receipt.hash}`);

  // Parse proposal ID from SubmitProposal event
  const submitProposalTopic = quais.id("SubmitProposal(uint32,address,uint256,bytes,uint256,bool,uint256,string)");
  const log = receipt.logs?.find((l: any) => l.topics[0] === submitProposalTopic);
  if (log) {
    const proposalId = parseInt(log.topics[1], 16);
    console.log(`    Proposal ID: ${proposalId}`);
    console.log(`\n    Next steps:`);
    console.log(`    1. Wait for voting period`);
    console.log(`    2. Call daoShip.submitVote(${proposalId}, true) to vote yes`);
    console.log(`    3. Wait for grace period`);
    console.log(`    4. Call daoShip.processProposal(${proposalId}, proposalData) to execute`);
  }

  console.log("\n═══ Done ═══════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
