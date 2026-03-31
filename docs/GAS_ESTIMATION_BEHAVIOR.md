# Gas Estimation Behavior: try/catch and processProposal

## Summary

This document describes a known EVM gas estimation behavior that affects `DAOShip.processProposal()` and any contract using try/catch where the success path costs more gas than the failure path. This is not a bug in the contract — it is a well-documented limitation of `eth_estimateGas` across all EVM-compatible networks. Gnosis Safe, OpenZeppelin Governor, and other production governance contracts exhibit the same behavior and use the same mitigation (gas buffers).

**Behavior:** `processProposal()` completes on-chain (tx status = 1) but with `actionFailed = true` when the wallet/node's gas estimation is used without a manual `gasLimit` override. The inner `execTransactionFromModule` DelegateCall runs out of gas, the try/catch catches it, and the proposal is marked as processed with `actionFailed = true`. The user sees a successful transaction but the governance action (e.g., minting shares) doesn't execute.

**Mitigation:** `gasLimit = estimatedGas * 1.5` consistently resolves this for all proposal types.

## Environment

- **Network:** Quai Orchard Testnet (chain ID 15000)
- **Wallet:** Pelagus browser extension
- **Frontend:** quais v1.0.0-alpha.53 + wagmi/viem (custom transport through injected provider)
- **RPC:** All calls routed through Pelagus (direct RPC is CORS-blocked)

## Affected Contract

- **DAOShip:** `0x00321f860920b02e9de8691a9504ef44021dccf1` (proxy → singleton `0x001C3A866f7E0065DB4950C01D0D703E7bBb2ddd`)
- **Vault:** `0x0075349dc28d3c54e63ca76d0d670cbffcb37107`
- **MultiSendCallOnly:** `0x002ae8A47C2da497fe569AfCF0486410aA1093E0`

## Reproduction

### Proposals that FAILED (action_failed = true):

| # | Tx Hash | Action | Gas Used/Limit |
|---|---------|--------|----------------|
| 1 | `0x0036001436...` | mintShares (50 to 0x0077...) | 253,143 / 274,742 (92.1%) |
| 2 | `0x0000003...` | mintShares (50 to 0x0077...) | same data |
| 7 | `0x001f002a07...` | mintShares (50 to 0x0057...) | no gasLimit override |

### Proposals that SUCCEEDED (action_failed = false):

| # | Tx Hash | Action | Notes |
|---|---------|--------|-------|
| 3 | `0x0005006c17...` | mintShares (50 to 0x0077...) | **Had gasLimit = estimate * 1.5** |
| 4 | `0x002d001b96...` | setNavigators | Simpler action, less gas |
| 5 | `0x002e003cd8...` | setNavigators | Simpler action, less gas |
| 6 | `0x00370030...` | transfer (1 QUAI) | Simpler action, less gas |

### Key observation

Proposals 1, 2, 7 all had the same action type (membership mint via `executeAsGovernance` → `mintShares`). Proposal 3 had the exact same `proposal_data` as 1 and 2 but succeeded because we added a 50% gas buffer. Proposals 4-6 succeeded without a buffer because they are simpler actions.

## Call Chain

`processProposal` has a deep call chain that gas estimation doesn't fully account for:

```
1. User → DAOShip.processProposal(id, proposalData)
2.   DAOShip sets _inProposalExecution = true
3.   DAOShip → Vault.execTransactionFromModule(MultiSend, 0, proposalData, DelegateCall)
4.     Vault DelegateCall → MultiSendCallOnly.multiSend(packed)
5.       MultiSendCallOnly Call → DAOShip.executeAsGovernance(daoShip, 0, mintSharesData)
6.         DAOShip checks _inProposalExecution, msg.sender == avatar
7.         DAOShip → DAOShip.mintShares([recipient], [amount])
8.           DAOShip → SharesERC20.mint(recipient, amount)
9.           SharesERC20 → self-delegate if first mint
```

The gas estimate appears to only account for the **outer try/catch path** (steps 1-3 succeeding with `actionFailed = true`), not the full inner DelegateCall chain (steps 3-9 succeeding). This means `eth_estimateGas` returns the gas needed for the proposal to be marked as processed, but not enough for the actual governance action to execute.

## Verified Configuration

All vault configuration is correct — the issue is purely gas estimation:

- `vault.isModuleEnabled(daoShip)` = **true**
- `vault.delegatecallAllowed(multisend)` = **true**
- `daoShip.multisendLibrary()` = MultiSendCallOnly address (**matches**)
- `daoShip.avatar()` = vault address (**matches**)
- SharesERC20 owner = DAOShip (**correct**)

## Decoded Proposal Data (proposals 1, 2, 3)

All three proposals had identical `proposal_data`:

```
Outer: multiSend(bytes) — selector 0x8d80ff0a
  Transaction 1:
    Operation: Call (0)
    To: 0x00321f860920b02e9de8691a9504ef44021dccf1 (DAOShip)
    Value: 0
    Data: executeAsGovernance(
      _to: 0x00321f860920b02e9de8691a9504ef44021dccf1,
      _value: 0,
      _data: mintShares(
        [0x007700c407e86ddf931444c772b6a1f10dbf2bdc],
        [50000000000000000000]  // 50 shares
      )
    )
```

## Vault Event Log

The process transaction for proposal 1 emitted:

1. `ExecutionFromModuleFailure(module: 0x00321f...)` — from vault (confirms DelegateCall failed)
2. `ProcessProposal(proposal: 1, passed: true, actionFailed: true)` — from DAOShip

## Hypothesis

`eth_estimateGas` simulates the transaction and finds that `processProposal` will succeed (it does — the outer function completes and emits `ProcessProposal`). However, the simulation follows the **failure path** of the try/catch: `execTransactionFromModule` returns false, `actionFailed = true`, and the function completes. The gas estimate reflects this shorter code path.

At execution time with this estimated gas, the EVM attempts the **success path** (DelegateCall into MultiSend → Call back to DAOShip), which requires more gas than estimated. The inner call runs out of gas, the try/catch catches the OOG, and it falls back to the failure path — exactly matching the estimate but not executing the governance action.

## Workaround

Adding 50% to the estimated gas (`gasLimit = estimate * 1.5`) consistently fixes the issue for membership mints. This suggests the actual gas needed is ~40-50% more than what `eth_estimateGas` returns.

## Why the Contract Uses try/catch (Response to Quai Team)

The try/catch around `execTransactionFromModule` is a deliberate and necessary design choice, not a workaround.

### What happens WITHOUT try/catch

If the inner governance action reverts (for any reason — OOG, bad calldata, vault misconfiguration, or a bug in the action itself), the ENTIRE `processProposal` transaction reverts. This means:

1. **The proposal is never marked as processed.** It stays in `Ready` state permanently.
2. **Anyone can keep retrying**, burning gas, with the same result.
3. **If the action is permanently broken** (e.g., the vault removed DAOShip as a module between the vote and processing), the proposal becomes a zombie — passed but unprocessable, blocking governance attention indefinitely.
4. **No on-chain record** of what happened. The proposal just sits in `Ready` forever with no indication of why it can't be processed.

### What happens WITH try/catch (current design)

A failing action results in `passed = true, actionFailed = true`. The proposal is consumed, governance moves on, and the failure is visible on-chain via the `ProcessProposal` event. The DAO can submit a new proposal to retry the action if desired.

### Industry precedent

This is the standard pattern in production governance contracts:

- **Gnosis Safe:** `execTransaction()` returns `bool success` rather than reverting on inner call failure. Their SDK adds gas buffers for the same estimation reason.
- **OpenZeppelin Governor:** `TimelockController` catches execution failures. Their documentation recommends explicit gas limits for execution.
- **Upstream Baal (MolochV3):** Uses Zodiac `Module.exec()` which returns `bool` rather than reverting.

### The gas estimation issue is an EVM-level limitation

`eth_estimateGas` uses binary search to find the **minimum gas where the outermost call doesn't revert**. Since try/catch prevents the outer `processProposal` call from reverting regardless of the inner call's outcome, the binary search converges on the gas needed for the failure path (try fails → catch executes → function completes with `actionFailed = true`). The estimator never discovers that providing more gas would make the inner call succeed.

This is not specific to DAO Ships. Any contract using try/catch where the success path costs more gas than the failure path exhibits this behavior. It is a known limitation across all EVM-compatible networks.

### Potential node-level improvement

A more sophisticated `eth_estimateGas` implementation could detect try/catch patterns and estimate for the success path rather than the minimum-to-not-revert path. Specifically, after finding the minimum gas, the estimator could check whether increasing gas changes the execution outcome (e.g., a return value or event emission changes). If so, it should return the higher gas estimate that achieves the "intended" outcome.

This would be a valuable improvement to the gas estimation algorithm and would benefit all contracts that use try/catch, not just DAO Ships.

### Recommended frontend mitigation

Until gas estimation is improved at the node level, frontends should apply a gas buffer for `processProposal` calls:

```typescript
const estimated = await daoShip.processProposal.estimateGas(id, proposalData);
const gasLimit = estimated * 150n / 100n; // 50% buffer
await daoShip.processProposal(id, proposalData, { gasLimit });
```

## Request

The gas estimation should account for the **success path** of try/catch blocks, not just the failure path. When `processProposal` calls `execTransactionFromModule` inside a try/catch, the estimate should include the gas needed for the DelegateCall to succeed (the full inner call chain), not just the gas for catching the failure.

This affects any contract pattern that uses try/catch around external calls where the success path costs more gas than the failure path.
