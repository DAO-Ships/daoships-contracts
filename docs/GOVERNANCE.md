# Governance Guide - Quai DAO Launcher

> Complete guide to proposal creation, voting, and DAO operations

## Table of Contents

- [Overview](#overview)
- [Vault Module Enablement](#vault-module-enablement) ⚠️ Critical Setup
- [MultiSend Encoding Requirement](#multisend-encoding-requirement) ⚠️ Critical
- [Governance Parameters](#governance-parameters)
- [Proposal Lifecycle](#proposal-lifecycle)
- [Voting Mechanics](#voting-mechanics)
- [Proposal Types](#proposal-types)
- [Best Practices](#best-practices)
- [Common Scenarios](#common-scenarios)

## Overview

Quai DAO Launcher uses **share-weighted voting** where members with more shares have proportionally more voting power. The governance process follows the MolochDAO V3 (Baal) model:

1. **Submit** a proposal with details and pay offering
2. **Sponsor** the proposal (auto-sponsored if enough shares)
3. **Vote** during the voting period (e.g., 7 days)
4. **Grace Period** for dissenting members to ragequit (e.g., 3 days)
5. **Process** the proposal to execute approved actions

## Vault Module Enablement

⚠️ **CRITICAL**: Before a DAO can execute proposals, Baal must be enabled as a module on the QuaiVault.

### Why Module Enablement is Required

The Baal contract acts as a **Zodiac module** on the QuaiVault treasury. This allows approved proposals to execute treasury actions via `IAvatar.execTransactionFromModule()`. Without module enablement, all proposals will fail to execute.

### Enablement Workflow (Propose-Approve-Execute)

QuaiVault uses a propose-approve-execute pattern for security:

**Step 1: Propose the enableModule transaction**
```typescript
const vaultContract = new quais.Contract(vaultAddress, QuaiVaultABI, deployer);

const enableModuleData = vaultContract.interface.encodeFunctionData("enableModule", [baalAddress]);

const proposeTx = await vaultContract.proposeTransaction(
  vaultAddress, // to: vault itself
  0, // value: 0
  enableModuleData // data: enableModule(baalAddress)
);

const proposeReceipt = await proposeTx.wait();
```

**Step 2: Extract transaction hash from event**
```typescript
const proposeLog = proposeReceipt.logs.find((log) => {
  try {
    const parsed = vaultContract.interface.parseLog(log);
    return parsed && parsed.name === "TransactionProposed";
  } catch {
    return false;
  }
});

const proposeEvent = vaultContract.interface.parseLog(proposeLog);
const txHash = proposeEvent.args.txHash;
```

**Step 3: Approve the transaction**
```typescript
// Each vault owner must approve until threshold is met
const approveTx = await vaultContract.approveTransaction(txHash);
await approveTx.wait();
```

**Step 4: Execute the transaction**
```typescript
// After threshold met, anyone can execute
const executeTx = await vaultContract.executeTransaction(txHash);
await executeTx.wait();
```

**Step 5: Verify module is enabled**
```typescript
const isEnabled = await vaultContract.isModuleEnabled(baalAddress);
console.log("Baal module enabled:", isEnabled); // Should be true
```

### Automated Enablement (1/1 Vaults)

For vaults with a 1/1 threshold, the `summon-dao.ts` script automates this:

```typescript
// Single-owner vault can use approveAndExecute in one step
const tx = await vaultContract.approveAndExecute(txHash);
await tx.wait();
```

### Manual Enablement (Multisig Vaults)

For vaults with multiple owners (e.g., 2/3, 3/5):

1. **Deployer** proposes and approves (automated by `summon-dao.ts`)
2. **Other owners** must manually approve:
   ```bash
   # On QuaiVault frontend or via script
   vault.approveTransaction(txHash)
   ```
3. **Anyone** executes after threshold met:
   ```bash
   vault.executeTransaction(txHash)
   ```

### Important Notes

- **One-time setup**: Module enablement only needs to happen once per DAO
- **Security**: `enableModule` can only be called by the vault itself (via propose-approve-execute)
- **Verification**: Always verify with `isModuleEnabled(baalAddress)` before submitting proposals
- **Summoning**: The BaalAndVaultSummoner handles step 1-2 automatically, but owners must complete approval for multisig vaults

## MultiSend Encoding Requirement

⚠️ **CRITICAL**: ALL Baal proposals must be encoded in MultiSend format, even single-action proposals.

### Why MultiSend is Required

The Baal contract **always** executes proposals via the MultiSend library using DelegateCall. This architectural decision ensures:
- Consistent execution pattern for all proposals
- Atomic multi-action transactions
- Gas-efficient batching
- Compatibility with Gnosis Safe patterns

### MultiSend Format

Transactions are packed in this format:
```
[operation (1 byte)][to (20 bytes)][value (32 bytes)][dataLength (32 bytes)][data (N bytes)]...
```

Then wrapped in a `multiSend(bytes)` function call.

### Helper Function

Use this helper to encode proposals:

```typescript
function encodeMultiSend(transactions: Array<{
  operation: number,  // 0 = Call, 1 = DelegateCall
  to: string,
  value: bigint,
  data: string
}>): string {
  // Step 1: Pack transactions
  let packed = "0x";

  for (const tx of transactions) {
    packed += tx.operation.toString(16).padStart(2, "0");
    packed += tx.to.slice(2).toLowerCase();
    packed += tx.value.toString(16).padStart(64, "0");

    const dataBytes = tx.data === "0x" ? "" : tx.data.slice(2);
    const dataLength = (dataBytes.length / 2).toString(16).padStart(64, "0");
    packed += dataLength;

    if (dataBytes.length > 0) {
      packed += dataBytes;
    }
  }

  // Step 2: Wrap in multiSend(bytes) call
  const multiSendSelector = "0x8d80ff0a";
  const abiCoder = quais.AbiCoder.defaultAbiCoder();
  const encodedParam = abiCoder.encode(["bytes"], [packed]);

  return multiSendSelector + encodedParam.slice(2);
}
```

### Example: Single-Action Proposal

Even a simple QUAI transfer must be MultiSend-encoded:

```typescript
const proposalData = encodeMultiSend([
  {
    operation: 0, // Call
    to: recipientAddress,
    value: parseQuai("10"), // 10 QUAI
    data: "0x" // No data for native token transfer
  }
]);

await baal.submitProposal(
  proposalData,
  0, // expiration
  0, // baalGas
  JSON.stringify({ title: "Fund Carol", description: "Pay 10 QUAI" }),
  { value: proposalOffering }
);
```

### Example: Multi-Action Proposal

```typescript
const proposalData = encodeMultiSend([
  {
    operation: 0,
    to: tokenAddress,
    value: 0n,
    data: token.interface.encodeFunctionData("transfer", [recipient1, amount1])
  },
  {
    operation: 0,
    to: await baal.getAddress(),
    value: 0n,
    data: baal.interface.encodeFunctionData("mintShares", [[recipient2], [shares]])
  },
  {
    operation: 0,
    to: recipient3,
    value: parseQuai("5"),
    data: "0x"
  }
]);

await baal.submitProposal(
  proposalData,
  0,
  0,
  JSON.stringify({ title: "Quarterly Rewards", description: "..." }),
  { value: proposalOffering }
);
```

### MultiSend Library Address

- **Cyprus1**: `0x000bf87B9a7D4Bf60F95e0a27A6254dE7655b345`

### Important Notes

- **All proposals** require MultiSend encoding (no exceptions)
- **Single actions** are wrapped in a 1-element array
- **Operation**: Use `0` for Call, `1` for DelegateCall (rare)
- **Value**: Must be bigint (use `parseQuai()` or `BigInt()`)
- **Data**: Use `"0x"` for empty data (not `""` or `null`)

## Governance Parameters

Each DAO configures these parameters at creation (can be changed via proposal):

| Parameter | Description | Typical Value | Units |
|-----------|-------------|---------------|-------|
| **votingPeriod** | How long members can vote | 7 days | seconds |
| **gracePeriod** | Time to ragequit after vote ends | 3 days | seconds |
| **proposalOffering** | Fee to submit a proposal | 0.1 QUAI | wei |
| **quorumPercent** | Min % of shares that must vote yes | 20% | basis points (2000) |
| **sponsorThreshold** | Min shares to auto-sponsor | 1 share | wei |
| **minRetentionPercent** | Min % of supply that must remain | 66% | basis points (6600) |

**Basis Points**: 10000 = 100%, so 2000 = 20%, 6600 = 66%

### Example Configuration

```typescript
const config = {
  votingPeriod: 7 * 24 * 60 * 60,      // 7 days
  gracePeriod: 3 * 24 * 60 * 60,       // 3 days
  proposalOffering: parseEther("0.1"), // 0.1 QUAI
  quorumPercent: 2000,                 // 20%
  sponsorThreshold: parseEther("1"),   // 1 share
  minRetentionPercent: 6600            // 66%
};
```

## Proposal Lifecycle

### State Diagram

```
┌──────────┐
│ Unborn   │ (Proposal ID doesn't exist)
└──────────┘
     │
     │ submitProposal()
     ▼
┌──────────┐     ┌─────────────┐
│Submitted │────▶│ Cancelled   │ (Submitter cancels before sponsor)
└──────────┘     └─────────────┘
     │
     │ sponsorProposal() or auto-sponsor
     ▼
┌──────────┐     ┌─────────────┐
│ Voting   │────▶│ Expired     │ (Expiration time passed)
└──────────┘     └─────────────┘
     │
     │ votingEnds timestamp
     ▼
┌──────────┐
│  Grace   │ (Members can ragequit)
└──────────┘
     │
     │ graceEnds timestamp
     ▼
┌──────────┐
│  Ready   │ (Can be processed)
└──────────┘
     │
     │ processProposal()
     ▼
┌──────────┐     ┌─────────────┐
│Processed │  or │  Defeated   │ (Didn't meet quorum/majority)
└──────────┘     └─────────────┘
```

### Detailed States

**0. Unborn**: Proposal ID doesn't exist yet

**1. Submitted**: Proposal submitted, awaiting sponsorship
- Can be cancelled by submitter
- Requires member with >= `sponsorThreshold` to sponsor

**2. Voting**: Active voting period
- Members can submit votes (yes/no)
- Voting power = shares at `votingStarts` timestamp
- Lasts for `votingPeriod` seconds

**3. Grace**: Vote ended, grace period active
- No new votes accepted
- Dissenting members can ragequit
- Lasts for `gracePeriod` seconds

**4. Ready**: Grace period ended, ready to process
- Anyone can call `processProposal()`
- Execution may succeed or fail

**5. Processed**: Proposal processed successfully
- Vote passed (quorum + majority)
- Action executed (may have failed, check `actionFailed`)

**6. Defeated**: Proposal did not pass
- Didn't meet quorum OR
- More no votes than yes votes

**7. Cancelled**: Submitter cancelled before sponsorship

**8. Expired**: Expiration time passed (if set)

## Voting Mechanics

### Share-Weighted Voting

Each member's voting power is determined by their **share balance at the time voting started** (not current balance).

```solidity
uint256 votingPower = sharesToken.getPriorVotes(member, proposal.votingStarts);
```

**Example**:
- Alice has 100 shares when proposal is sponsored
- Voting starts at timestamp 1000
- Alice buys 50 more shares at timestamp 1500
- **Alice's voting power = 100** (not 150)

**Why?** Prevents flash loan attacks and vote buying after seeing results.

### Quorum Requirement

A proposal must receive "yes" votes from at least `quorumPercent` of total shares:

```
yesBalance >= (totalShares * quorumPercent) / 10000
```

**Example** (20% quorum):
- Total shares: 1000
- Quorum required: (1000 * 2000) / 10000 = 200 shares
- If yesBalance = 250 and noBalance = 50, **proposal passes**
- If yesBalance = 150 and noBalance = 50, **proposal fails** (quorum not met)

### Majority Requirement

In addition to quorum, yes votes must exceed no votes:

```
yesBalance > noBalance
```

**Example**:
- Total shares: 1000, quorum = 200
- Scenario A: yes = 250, no = 240 → **PASSES** (quorum met, yes > no)
- Scenario B: yes = 250, no = 260 → **FAILS** (quorum met, but no > yes)
- Scenario C: yes = 150, no = 50 → **FAILS** (quorum NOT met)

### Vote Tracking

The DAO tracks **two metrics** for each proposal:

1. **Vote Counts**: Number of voters
   - `yesVotes`: Count of members who voted yes
   - `noVotes`: Count of members who voted no

2. **Vote Balances**: Share-weighted voting power
   - `yesBalance`: Total shares voting yes
   - `noBalance`: Total shares voting no

**Example**:
- Alice (100 shares) votes yes
- Bob (50 shares) votes yes
- Carol (75 shares) votes no

Results:
- `yesVotes = 2`, `noVotes = 1`
- `yesBalance = 150`, `noBalance = 75`

### Voting Restrictions

- **One vote per member per proposal** (cannot change vote)
- **Must have shares** at `votingStarts` timestamp
- **Cannot vote after voting period ends**
- **Loot holders cannot vote** (economic rights only)

## Proposal Types

All examples below use the `encodeMultiSend()` helper function defined in the [MultiSend Encoding Requirement](#multisend-encoding-requirement) section.

### 1. Funding Proposals

Send assets from treasury to recipient.

**Simple QUAI Transfer**:
```typescript
const proposalData = encodeMultiSend([
  {
    operation: 0, // Call
    to: recipientAddress,
    value: parseQuai("10"), // 10 QUAI
    data: "0x"
  }
]);

await baal.submitProposal(
  proposalData,
  0, // No expiration
  0, // No gas limit
  JSON.stringify({ title: "Fund community event", description: "10 QUAI for venue rental" }),
  { value: proposalOffering }
);
```

**ERC20 Token Transfer**:
```typescript
const transferData = token.interface.encodeFunctionData("transfer", [
  recipientAddress,
  parseQuai("1000") // 1000 tokens
]);

const proposalData = encodeMultiSend([
  {
    operation: 0,
    to: tokenAddress,
    value: 0n,
    data: transferData
  }
]);

await baal.submitProposal(
  proposalData,
  0,
  0,
  JSON.stringify({ title: "Fund contributor", description: "1000 tokens for development work" }),
  { value: proposalOffering }
);
```

### 2. Member Management Proposals

**Mint Shares** (Add voting power):
```typescript
const mintData = baal.interface.encodeFunctionData("mintShares", [
  [newMemberAddress],
  [parseQuai("50")] // 50 shares
]);

const proposalData = encodeMultiSend([
  {
    operation: 0,
    to: await baal.getAddress(),
    value: 0n,
    data: mintData
  }
]);

await baal.submitProposal(
  proposalData,
  0,
  0,
  JSON.stringify({ title: "Onboard new contributor", description: "Grant 50 shares for Q1 contributions" }),
  { value: proposalOffering }
);
```

**Mint Loot** (Add economic rights without voting):
```typescript
const mintData = baal.interface.encodeFunctionData("mintLoot", [
  [contributorAddress],
  [parseQuai("100")] // 100 loot
]);

const proposalData = encodeMultiSend([
  {
    operation: 0,
    to: await baal.getAddress(),
    value: 0n,
    data: mintData
  }
]);

await baal.submitProposal(
  proposalData,
  0,
  0,
  JSON.stringify({ title: "Reward contributor", description: "100 loot for advisory role" }),
  { value: proposalOffering }
);
```

**Burn Shares/Loot** (Remove member):
```typescript
const burnData = baal.interface.encodeFunctionData("burnShares", [
  [memberAddress],
  [parseQuai("50")]
]);

const proposalData = encodeMultiSend([
  {
    operation: 0,
    to: await baal.getAddress(),
    value: 0n,
    data: burnData
  }
]);

await baal.submitProposal(
  proposalData,
  0,
  0,
  JSON.stringify({ title: "Remove inactive member", description: "Burn 50 shares due to inactivity" }),
  { value: proposalOffering }
);
```

### 3. Governance Configuration Proposals

**Change Voting Period**:
```typescript
const configData = baal.interface.encodeFunctionData("setGovernanceConfig", [
  quais.AbiCoder.defaultAbiCoder().encode(
    ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256"],
    [
      14 * 24 * 60 * 60, // New voting period: 14 days
      gracePeriod,       // Keep existing
      proposalOffering,  // Keep existing
      quorumPercent,     // Keep existing
      sponsorThreshold,  // Keep existing
      minRetentionPercent // Keep existing
    ]
  )
]);

const proposalData = encodeMultiSend([
  {
    operation: 0,
    to: await baal.getAddress(),
    value: 0n,
    data: configData
  }
]);

await baal.submitProposal(
  proposalData,
  0,
  0,
  JSON.stringify({ title: "Extend voting period", description: "Increase from 7 to 14 days" }),
  { value: proposalOffering }
);
```

### 4. Shaman Management Proposals

⚠️ **Note**: Shamans can only be set during DAO initialization. They **cannot** be added or removed via proposals due to the `baalOnly` constraint. The `setShamans()` function is reserved for the Baal contract itself during setup.

If you need custom shaman functionality after launch, you must:
1. Deploy a new DAO with the desired shamans, OR
2. Use workaround patterns (e.g., deploying a proxy shaman that the DAO controls)

**Deprecated Examples** (for reference, but won't work in practice):

~~Add New Shaman~~ (Not possible post-initialization):
```typescript
// This will FAIL - setShamans is baalOnly (locked after initialization)
const MANAGER = 2;
const shamanData = baal.interface.encodeFunctionData("setShamans", [
  [onboarderShamanAddress],
  [MANAGER]
]);
// Will revert with "Baal: not baal" when processed
```

~~Remove Shaman~~ (Not possible post-initialization):
```typescript
// This will FAIL - same reason as above
const shamanData = baal.interface.encodeFunctionData("setShamans", [
  [shamanAddress],
  [0]
]);
// Will revert when processed
```

### 5. Multi-Action Proposals (Using MultiSend)

Execute multiple actions atomically:

```typescript
const actions = [
  {
    to: token1Address,
    value: 0,
    data: token1.interface.encodeFunctionData("transfer", [recipient1, amount1])
  },
  {
    to: token2Address,
    value: 0,
    data: token2.interface.encodeFunctionData("transfer", [recipient2, amount2])
  },
  {
    to: await baal.getAddress(),
    value: 0,
    data: baal.interface.encodeFunctionData("mintShares", [[newMember], [shares]])
  }
];

// Encode MultiSend format
let multiSendData = "0x";
for (const action of actions) {
  const operation = 0; // Call
  const dataLength = (action.data.length - 2) / 2;

  multiSendData +=
    operation.toString(16).padStart(2, "0") +
    action.to.slice(2).padStart(40, "0") +
    BigInt(action.value).toString(16).padStart(64, "0") +
    dataLength.toString(16).padStart(64, "0") +
    action.data.slice(2);
}

const multiSendCall = ethers.concat([
  ethers.id("multiSend(bytes)").slice(0, 10),
  ethers.AbiCoder.defaultAbiCoder().encode(["bytes"], [multiSendData])
]);

const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
  ["address", "uint256", "bytes"],
  [MULTISEND_ADDRESS, 0, multiSendCall]
);

await baal.submitProposal(
  proposalData,
  0,
  0,
  "Quarterly distribution + onboard new members",
  { value: offering }
);
```

### 6. Guild Token Management (Ragequit Assets)

**Add Ragequittable Token**:
```typescript
const guildData = baal.interface.encodeFunctionData("setGuildTokens", [
  [token1Address, token2Address, token3Address]
]);

const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
  ["address", "uint256", "bytes"],
  [await baal.getAddress(), 0, guildData]
);

await baal.submitProposal(proposalData, 0, 0, "Add tokens to ragequit list", { value: offering });
```

## Best Practices

### For Proposal Submitters

1. **Clear Descriptions**: Use IPFS hashes or detailed text in `details` parameter
   ```typescript
   const ipfsHash = "ipfs://QmX123..."; // Full proposal document
   await baal.submitProposal(proposalData, 0, 0, ipfsHash, { value: offering });
   ```

2. **Set Expiration for Time-Sensitive Proposals**:
   ```typescript
   const oneWeekFromNow = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
   await baal.submitProposal(proposalData, oneWeekFromNow, 0, details, { value: offering });
   ```

3. **Use Gas Limits for Complex Proposals**:
   ```typescript
   const gasLimit = 500000; // 500K gas max
   await baal.submitProposal(proposalData, 0, gasLimit, details, { value: offering });
   ```

4. **Test Proposal Data Off-Chain**:
   ```typescript
   // Simulate proposal execution
   const simulatedResult = await baal.callStatic.processProposal(proposalId, proposalData);
   console.log("Would succeed:", simulatedResult);
   ```

### For Voters

1. **Review Full Proposal Data**: Check indexer/frontend for complete proposal details

2. **Understand Voting Power**: Your power is locked at `votingStarts` timestamp
   ```typescript
   const myVotingPower = await baal.getPriorVotes(myAddress, proposal.votingStarts);
   console.log("My voting power:", ethers.formatEther(myVotingPower));
   ```

3. **Consider Grace Period**: If you vote no and proposal passes, you can ragequit

4. **Vote Early**: Encourages discussion and shows commitment

### For DAO Operators

1. **Document Governance Process**: Create a guide for members

2. **Monitor Quorum**: Adjust `quorumPercent` if participation is too low/high

3. **Set Appropriate Offering**: Balance spam prevention with accessibility
   - Too high: Discourages proposals
   - Too low: Enables spam

4. **Review Shaman Permissions Regularly**: Via proposal, audit active shamans

5. **Use Time Locks for Critical Changes**: Add delays before execution

## Common Scenarios

### Scenario 1: Emergency Fund Distribution

**Context**: Treasury needs to quickly pay for urgent security audit.

**Approach**:
1. Member with >= `sponsorThreshold` submits proposal (auto-sponsored)
2. Details explain urgency and link to audit firm quote
3. Set shorter expiration (3 days) to signal urgency
4. Coordinate with members in Discord/forum for quick votes
5. Process immediately after grace period

**Code**:
```typescript
const threeDaysFromNow = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;

await baal.submitProposal(
  proposalData,
  threeDaysFromNow,
  0,
  "URGENT: Security audit funding - expires in 3 days",
  { value: offering }
);
```

### Scenario 2: Contributor Rewards Program

**Context**: Monthly rewards for top contributors.

**Approach**:
1. Use MultiSend for multiple transfers
2. Link to contribution tracking document
3. Include both share mints (voting) and loot mints (rewards)

**Code**:
```typescript
const actions = contributors.map(c => ({
  to: await baal.getAddress(),
  value: 0,
  data: baal.interface.encodeFunctionData(
    c.votingRights ? "mintShares" : "mintLoot",
    [[c.address], [c.amount]]
  )
}));

// Encode as MultiSend...
await baal.submitProposal(multiSendProposal, 0, 0, "January 2025 contributor rewards", { value: offering });
```

### Scenario 3: Governance Parameter Adjustment

**Context**: Quorum set too high (30%), only 20% voting → proposals failing.

**Approach**:
1. Analyze historical voting participation
2. Propose lower quorum (e.g., 15%)
3. Provide data in proposal details
4. Educate members on why change is needed

**Code**:
```typescript
const newConfig = ethers.AbiCoder.defaultAbiCoder().encode(
  ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256"],
  [
    votingPeriod,
    gracePeriod,
    proposalOffering,
    1500, // 15% quorum (down from 30%)
    sponsorThreshold,
    minRetentionPercent
  ]
);

await baal.submitProposal(
  governanceConfigProposal,
  0,
  0,
  "Lower quorum to 15% to match actual participation",
  { value: offering }
);
```

### Scenario 4: Rage Quitting After Disagreement

**Context**: Major proposal passes that you disagree with (e.g., risky investment).

**Approach**:
1. Vote "no" on proposal during voting period
2. If proposal passes, ragequit during grace period
3. Withdraw proportional share of treasury assets

**Code**:
```typescript
// 1. Vote no
await baal.submitVote(proposalId, false);

// 2. Wait for grace period (after vote ends)
// 3. Ragequit
const myShares = await baal.shares().balanceOf(myAddress);
const myLoot = await baal.loot().balanceOf(myAddress);
const guildTokens = await baal.getGuildTokenArray();

await baal.ragequit(
  myAddress,
  myShares,  // Burn all shares
  myLoot,    // Burn all loot
  guildTokens // Withdraw all guild tokens
);
```

### Scenario 5: Adding Onboarding Shaman

**Context**: Want to automate onboarding (ETH → shares).

**Approach**:
1. Deploy `OnboarderShaman` contract
2. Configure multiplier and min tribute
3. Submit proposal to grant MANAGER permission
4. After approval, new members can self-onboard

**Deployment**:
```typescript
const OnboarderShaman = await ethers.getContractFactory("OnboarderShaman");
const onboarder = await OnboarderShaman.deploy(
  await baal.getAddress(),
  20000, // 2x multiplier (1 QUAI = 2 shares)
  0,     // No loot
  parseEther("0.01"), // Min 0.01 QUAI tribute
  0      // No expiry
);
```

**Proposal**:
```typescript
const MANAGER = 2;
const shamanData = baal.interface.encodeFunctionData("setShamans", [
  [await onboarder.getAddress()],
  [MANAGER]
]);

await baal.submitProposal(
  shamanProposal,
  0,
  0,
  "Enable onboarder: 1 QUAI = 2 shares, min 0.01 QUAI",
  { value: offering }
);
```

**Usage** (After proposal passes):
```typescript
// New member onboards
await onboarder.onboard({ value: parseEther("1") }); // Get 2 shares
```

---

## Summary Checklist

**Submitting a Proposal**:
- [ ] Encode proposal data correctly
- [ ] Set expiration if time-sensitive
- [ ] Provide clear description/IPFS hash
- [ ] Pay proposal offering
- [ ] Share proposal details with members

**Voting**:
- [ ] Review full proposal details
- [ ] Check your voting power
- [ ] Vote within voting period
- [ ] Consider grace period for dissent

**Processing**:
- [ ] Wait for grace period to end
- [ ] Pass original `proposalData` (must match hash)
- [ ] Check if execution succeeded (`actionFailed` flag)
- [ ] Verify results on-chain

**Ragequitting**:
- [ ] Only during grace period (or anytime if not in proposal)
- [ ] Specify shares and loot to burn
- [ ] List guild tokens to withdraw
- [ ] Receive proportional assets

---

**Next**: See [API.md](./API.md) for complete contract function reference and [DEPLOYMENT_ADDRESSES.md](./DEPLOYMENT_ADDRESSES.md) for current deployment information.
