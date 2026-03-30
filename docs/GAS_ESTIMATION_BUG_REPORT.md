# Gas Estimation Bug: processProposal with Membership Mints

## Summary

`DAOShip.processProposal()` succeeds on-chain (tx status = 1) but with `actionFailed = true` when the wallet/node's gas estimation is used without a manual `gasLimit` override. The inner `execTransactionFromModule` DelegateCall runs out of gas, the try/catch catches it, and the proposal is marked as processed with `actionFailed = true`. The user sees a successful transaction but the governance action (minting shares) never executes.

Setting `gasLimit = estimatedGas * 1.5` fixes the issue. Without the override, the wallet-estimated gas is insufficient for the inner call chain.

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

## Request

The gas estimation should account for the **success path** of try/catch blocks, not just the failure path. When `processProposal` calls `execTransactionFromModule` inside a try/catch, the estimate should include the gas needed for the DelegateCall to succeed (the full inner call chain), not just the gas for catching the failure.

This affects any contract pattern that uses try/catch around external calls where the success path costs more gas than the failure path.
