# Baal Module Integration Guide for Quai Vault

**For**: Quai Vault Development Team
**Date**: 2026-02-12
**Version**: 1.0
**Purpose**: Enable proper decoding and display of Baal DAO governance proposals in Quai Vault UI

---

## Executive Summary

When a Quai Vault enables a Baal DAO as a module, vault owners need to understand what governance proposals will execute before approving them. This guide details how to integrate Baal transaction decoding into the existing Quai Vault indexer and frontend.

**Integration Complexity**: 🟡 MEDIUM (~8-16 hours)

**Components to Update**:
1. ✅ **Indexer**: Add Baal event tracking + transaction decoding
2. ✅ **Frontend**: Display decoded Baal proposals in pending transactions UI
3. ✅ **Database**: Add Baal-specific tables for governance data

---

## Table of Contents

1. [Background: How Baal Uses Quai Vault](#background)
2. [Architecture Overview](#architecture-overview)
3. [Indexer Integration](#indexer-integration)
4. [Frontend Integration](#frontend-integration)
5. [Database Schema Updates](#database-schema-updates)
6. [Testing Guide](#testing-guide)
7. [Deployment Checklist](#deployment-checklist)
8. [Reference Materials](#reference-materials)

---

## Background

### How Baal Uses Quai Vault

**Baal DAO Governance** operates as a Zodiac IAvatar module on Quai Vault:

```
┌─────────────────┐
│   Quai Vault    │ ← Treasury (holds all DAO assets)
│   (Avatar)      │
└────────┬────────┘
         │
         │ IAvatar.execTransactionFromModule()
         │
┌────────▼────────┐
│   Baal Module   │ ← Governance (processes proposals)
│   (DAO)         │
└────────┬────────┘
         │
         │ Share-weighted voting
         │
    ┌────▼─────┐
    │ Members  │
    └──────────┘
```

### Key User Flows

**1. Initial Setup** (One-time, requires vault owner approval):
```
BaalAndVaultSummoner.summonBaalAndVault()
  → Creates vault with owners
  → Creates Baal DAO
  → Owners must approve: enableModule(baal)
```

**2. Ongoing Governance** (Every proposal execution):
```
Member submits proposal → DAO votes → Proposal passes
  → Baal calls: IAvatar.execTransactionFromModule(to, value, data, operation)
  → Vault executes action (NO owner approval needed - module is trusted)
```

### The Problem

**Current State**: When `enableModule(baal)` is proposed, vault owners see:
```
❌ Transaction: enableModule(0x00ABC123...)
   Type: wallet_admin
   Data: 0x610b5925000000000000000000000000...
```

**Desired State**: Vault owners should see:
```
✅ Enable Baal DAO Module
   📋 DAO Name: "Quai Foundation DAO"
   👥 Initial Members: 5 (see list)
   ⚖️ Governance: 7 days voting, 20% quorum
   🔒 Permissions: Full treasury control via proposals
   ⚠️ WARNING: This module can execute transactions without approval once enabled!
```

---

## Architecture Overview

### Existing Quai Vault Architecture

**Indexer** (`quaivault-indexer`):
- Polls QuaiVault events via RPC
- Decodes transaction calldata
- Stores in Supabase (27 event types currently)
- Real-time sync via Supabase subscriptions

**Frontend** (`quaivault-frontend`):
- React 18 + TypeScript + quais.js
- TanStack Query for data fetching
- Displays pending transactions with decoded details
- Owner approval workflow

### Integration Points

```
┌──────────────────────────────────────────────────────────────┐
│                        INDEXER                                │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  1. Track Baal Events                                        │
│     - SetupComplete (DAO created)                            │
│     - SubmitProposal, ProcessProposal                        │
│     - MintShares, ShamanSet, etc.                           │
│                                                               │
│  2. Decode enableModule(baal) Proposals                      │
│     - Fetch Baal contract data (name, config)                │
│     - Store in `baal_modules` table                          │
│                                                               │
│  3. Decode Baal Proposal Executions                          │
│     - Parse MultiSend batched actions                        │
│     - Store action details in `baal_proposal_actions`        │
│                                                               │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                       SUPABASE                                │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  New Tables:                                                  │
│  - baal_modules        (DAO info per vault)                 │
│  - baal_proposals      (All proposals)                       │
│  - baal_proposal_actions (Decoded actions)                   │
│                                                               │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                       FRONTEND                                │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  1. Display enableModule(baal) Details                       │
│     - Show DAO name, governance config                       │
│     - Display warning about module permissions               │
│                                                               │
│  2. Show Baal Proposal Execution Details                     │
│     - List all actions in MultiSend batch                    │
│     - Decode each action (transfer, config change, etc.)     │
│                                                               │
│  3. Link to DAO Dashboard (optional)                         │
│     - View full proposal history                             │
│     - See current governance state                           │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

---

## Indexer Integration

### Step 1: Add Baal Contract ABIs

**File**: `src/abis/Baal.json`

```typescript
// Add Baal ABI (see REFERENCE MATERIALS section for full ABI)
// Key functions/events to include:
export const BaalABI = [
  // Events
  "event SetupComplete(...)",
  "event SubmitProposal(...)",
  "event ProcessProposal(...)",
  // View functions
  "function name() view returns (string)",
  "function votingPeriod() view returns (uint32)",
  "function gracePeriod() view returns (uint32)",
  "function quorumPercent() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function totalLoot() view returns (uint256)",
  "function proposalCount() view returns (uint32)",
  // ... (see full ABI below)
];
```

**File**: `src/abis/MultiSend.json`

```typescript
export const MultiSendABI = [
  "function multiSend(bytes memory transactions) public payable"
];
```

### Step 2: Detect Baal Module Enablement

**File**: `src/decoders/transactionDecoder.ts`

Add to existing transaction type detection:

```typescript
import { BaalABI } from '../abis/Baal';
import { quais } from 'quais';

interface BaalModuleInfo {
  baalAddress: string;
  name: string;
  votingPeriod: number;
  gracePeriod: number;
  quorumPercent: number;
  totalShares: string;
  totalLoot: string;
  proposalCount: number;
  sharesToken: string;
  lootToken: string;
}

async function decodeBaalEnableModule(
  data: string,
  provider: quais.JsonRpcProvider
): Promise<BaalModuleInfo | null> {
  try {
    // Decode enableModule call
    const iface = new quais.Interface(['function enableModule(address module)']);
    const decoded = iface.decodeFunctionData('enableModule', data);
    const baalAddress = decoded[0];

    // Check if address is a Baal contract (has SetupComplete event in history)
    const baal = new quais.Contract(baalAddress, BaalABI, provider);

    // Fetch Baal configuration
    const [
      name,
      votingPeriod,
      gracePeriod,
      quorumPercent,
      totalShares,
      totalLoot,
      proposalCount,
      sharesToken,
      lootToken
    ] = await Promise.all([
      baal.name ? baal.name() : getTokenName(await baal.sharesToken(), provider),
      baal.votingPeriod(),
      baal.gracePeriod(),
      baal.quorumPercent(),
      baal.totalShares(),
      baal.totalLoot(),
      baal.proposalCount(),
      baal.sharesToken(),
      baal.lootToken()
    ]);

    return {
      baalAddress,
      name,
      votingPeriod: Number(votingPeriod),
      gracePeriod: Number(gracePeriod),
      quorumPercent: Number(quorumPercent),
      totalShares: totalShares.toString(),
      totalLoot: totalLoot.toString(),
      proposalCount: Number(proposalCount),
      sharesToken,
      lootToken
    };
  } catch (error) {
    console.error('Failed to decode Baal module:', error);
    return null;
  }
}

async function getTokenName(tokenAddress: string, provider: quais.JsonRpcProvider): Promise<string> {
  try {
    const token = new quais.Contract(tokenAddress, ['function name() view returns (string)'], provider);
    return await token.name();
  } catch {
    return 'Unknown DAO';
  }
}
```

**Update main decoder**:

```typescript
export async function decodeTransaction(
  to: string,
  data: string,
  provider: quais.JsonRpcProvider
): Promise<DecodedTransaction> {
  // ... existing logic ...

  // Check for enableModule(baal)
  if (data.startsWith('0x610b5925')) { // enableModule selector
    const baalInfo = await decodeBaalEnableModule(data, provider);
    if (baalInfo) {
      return {
        type: 'enable_baal_module',
        details: baalInfo,
        displayName: `Enable Baal DAO Module: ${baalInfo.name}`,
        risk: 'high', // Module gets full control
        requiresApproval: true
      };
    }
  }

  // ... rest of existing logic ...
}
```

### Step 3: Decode Baal Proposal Executions

When Baal executes a proposal via `execTransactionFromModule`, decode the action:

```typescript
interface BaalProposalAction {
  type: 'transfer' | 'contract_call' | 'multisend_batch' | 'baal_config';
  to: string;
  value: string;
  data: string;
  decodedCall?: any;
}

async function decodeBaalProposalExecution(
  module: string, // Baal address
  to: string,
  value: bigint,
  data: string,
  operation: number,
  provider: quais.JsonRpcProvider
): Promise<BaalProposalAction> {
  // Check if it's a MultiSend batch
  if (operation === 1 && data.startsWith('0x8d80ff0a')) { // multiSend selector
    return decodeMultiSendBatch(data, provider);
  }

  // Check if it's a call back to Baal itself (governance config)
  const baal = new quais.Contract(module, BaalABI, provider);
  if (to.toLowerCase() === module.toLowerCase()) {
    try {
      const iface = new quais.Interface(BaalABI);
      const decoded = iface.parseTransaction({ data });

      return {
        type: 'baal_config',
        to,
        value: value.toString(),
        data,
        decodedCall: {
          function: decoded.name,
          args: decoded.args,
          signature: decoded.signature
        }
      };
    } catch (e) {
      // Fall through to generic call
    }
  }

  // Simple transfer
  if (!data || data === '0x') {
    return {
      type: 'transfer',
      to,
      value: value.toString(),
      data: '0x'
    };
  }

  // Generic contract call
  return {
    type: 'contract_call',
    to,
    value: value.toString(),
    data
  };
}

async function decodeMultiSendBatch(
  data: string,
  provider: quais.JsonRpcProvider
): Promise<BaalProposalAction> {
  const iface = new quais.Interface(MultiSendABI);
  const decoded = iface.decodeFunctionData('multiSend', data);
  const transactions = decoded[0]; // bytes

  // Parse MultiSend format: [operation][to][value][dataLength][data]...
  const actions = parseMultiSendTransactions(transactions);

  return {
    type: 'multisend_batch',
    to: 'MultiSend Library',
    value: '0',
    data,
    decodedCall: {
      actions: actions.map(action => ({
        operation: action.operation === 0 ? 'Call' : 'DelegateCall',
        to: action.to,
        value: action.value.toString(),
        data: action.data
      }))
    }
  };
}

function parseMultiSendTransactions(packedData: string): any[] {
  // Remove 0x prefix
  const data = packedData.startsWith('0x') ? packedData.slice(2) : packedData;
  const actions = [];
  let offset = 0;

  while (offset < data.length) {
    // Each transaction: operation(1) + to(20) + value(32) + dataLength(32) + data
    const operation = parseInt(data.slice(offset, offset + 2), 16);
    offset += 2;

    const to = '0x' + data.slice(offset, offset + 40);
    offset += 40;

    const value = BigInt('0x' + data.slice(offset, offset + 64));
    offset += 64;

    const dataLength = parseInt(data.slice(offset, offset + 64), 16);
    offset += 64;

    const txData = '0x' + data.slice(offset, offset + dataLength * 2);
    offset += dataLength * 2;

    actions.push({ operation, to, value, data: txData });
  }

  return actions;
}
```

### Step 4: Track Baal Events

Add event handlers for key Baal events:

```typescript
// src/handlers/baalEventHandlers.ts

import { supabase } from '../config/supabase';

export async function handleSetupComplete(
  event: any,
  baalAddress: string,
  vaultAddress: string
) {
  const { data, error } = await supabase
    .from('baal_modules')
    .insert({
      vault_address: vaultAddress.toLowerCase(),
      baal_address: baalAddress.toLowerCase(),
      name: event.args.name,
      symbol: event.args.symbol,
      voting_period: Number(event.args.votingPeriod),
      grace_period: Number(event.args.gracePeriod),
      quorum_percent: Number(event.args.quorumPercent),
      proposal_offering: event.args.proposalOffering.toString(),
      sponsor_threshold: event.args.sponsorThreshold.toString(),
      min_retention_percent: Number(event.args.minRetentionPercent),
      total_shares: event.args.totalShares.toString(),
      total_loot: event.args.totalLoot.toString(),
      shares_paused: event.args.sharesPaused,
      loot_paused: event.args.lootPaused,
      block_number: event.blockNumber,
      tx_hash: event.transactionHash
    });

  if (error) {
    console.error('Failed to store Baal setup:', error);
  }
}

export async function handleProcessProposal(
  event: any,
  baalAddress: string
) {
  const proposalId = Number(event.args.proposalId);
  const passed = event.args.passed;
  const actionFailed = event.args.actionFailed;

  const { error } = await supabase
    .from('baal_proposals')
    .update({
      processed: true,
      passed,
      action_failed: actionFailed,
      processed_at: new Date().toISOString(),
      processed_block: event.blockNumber,
      processed_tx_hash: event.transactionHash
    })
    .eq('baal_address', baalAddress.toLowerCase())
    .eq('proposal_id', proposalId);

  if (error) {
    console.error('Failed to update proposal:', error);
  }
}
```

---

## Frontend Integration

### Step 1: Create Baal Transaction Display Component

**File**: `src/components/transactions/BaalModuleTransaction.tsx`

```typescript
import React from 'react';
import { BaalModuleInfo } from '@/types/baal';

interface Props {
  baalInfo: BaalModuleInfo;
  isEnableProposal?: boolean;
}

export function BaalModuleTransaction({ baalInfo, isEnableProposal }: Props) {
  const votingDays = Math.floor(baalInfo.votingPeriod / 86400);
  const graceDays = Math.floor(baalInfo.gracePeriod / 86400);

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
      {isEnableProposal && (
        <div className="bg-yellow-100 border border-yellow-400 rounded p-3 mb-4">
          <div className="flex items-start">
            <svg className="h-5 w-5 text-yellow-600 mt-0.5 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd"/>
            </svg>
            <div>
              <h4 className="font-semibold text-yellow-800">Module Permissions Warning</h4>
              <p className="text-sm text-yellow-700 mt-1">
                This Baal DAO module will have full control over vault treasury once enabled.
                Passed governance proposals execute automatically without owner approval.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <div>
          <h3 className="text-lg font-bold text-gray-900">
            {isEnableProposal ? 'Enable' : ''} Baal DAO Module
          </h3>
          <p className="text-sm text-gray-600">Moloch V3 Governance System</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-gray-500">DAO Name</label>
            <p className="text-sm font-semibold text-gray-900">{baalInfo.name}</p>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-500">Module Address</label>
            <p className="text-sm font-mono text-gray-900">
              {baalInfo.baalAddress.slice(0, 8)}...{baalInfo.baalAddress.slice(-6)}
            </p>
          </div>
        </div>

        <div className="border-t border-gray-200 pt-3">
          <h4 className="text-sm font-semibold text-gray-700 mb-2">Governance Configuration</h4>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-gray-500">Voting Period:</span>
              <span className="ml-2 font-medium">{votingDays} days</span>
            </div>
            <div>
              <span className="text-gray-500">Grace Period:</span>
              <span className="ml-2 font-medium">{graceDays} days</span>
            </div>
            <div>
              <span className="text-gray-500">Quorum:</span>
              <span className="ml-2 font-medium">{baalInfo.quorumPercent / 100}%</span>
            </div>
            <div>
              <span className="text-gray-500">Total Members:</span>
              <span className="ml-2 font-medium">
                {(BigInt(baalInfo.totalShares) + BigInt(baalInfo.totalLoot) > 0n)
                  ? 'Active'
                  : 'Not yet initialized'}
              </span>
            </div>
          </div>
        </div>

        {(BigInt(baalInfo.totalShares) > 0n || BigInt(baalInfo.totalLoot) > 0n) && (
          <div className="border-t border-gray-200 pt-3">
            <h4 className="text-sm font-semibold text-gray-700 mb-2">Current DAO State</h4>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-gray-500">Voting Shares:</span>
                <span className="ml-2 font-medium">{baalInfo.totalShares}</span>
              </div>
              <div>
                <span className="text-gray-500">Non-Voting Loot:</span>
                <span className="ml-2 font-medium">{baalInfo.totalLoot}</span>
              </div>
              <div className="col-span-2">
                <span className="text-gray-500">Proposals Processed:</span>
                <span className="ml-2 font-medium">{baalInfo.proposalCount}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

### Step 2: Integrate into Transaction Display

**File**: `src/components/transactions/TransactionDetails.tsx`

```typescript
import { BaalModuleTransaction } from './BaalModuleTransaction';

export function TransactionDetails({ transaction }: { transaction: Transaction }) {
  // ... existing code ...

  // Add Baal module detection
  if (transaction.decoded_type === 'enable_baal_module') {
    return (
      <div>
        <TransactionHeader transaction={transaction} />
        <BaalModuleTransaction
          baalInfo={transaction.decoded_details}
          isEnableProposal={true}
        />
        <TransactionActions transaction={transaction} />
      </div>
    );
  }

  // ... rest of existing transaction types ...
}
```

### Step 3: Add Baal Proposal Action Decoder

**File**: `src/components/transactions/BaalProposalActions.tsx`

```typescript
import React from 'react';

interface BaalAction {
  type: string;
  to: string;
  value: string;
  data: string;
  decodedCall?: any;
}

export function BaalProposalActions({ actions }: { actions: BaalAction[] }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h4 className="font-semibold text-gray-900 mb-3">
        Proposal Actions ({actions.length})
      </h4>

      <div className="space-y-3">
        {actions.map((action, idx) => (
          <div key={idx} className="border-l-4 border-blue-500 pl-3">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900">
                  {idx + 1}. {formatActionType(action.type)}
                </p>
                <p className="text-xs text-gray-600 mt-1">
                  To: <code className="bg-gray-100 px-1 rounded">{action.to}</code>
                </p>
                {BigInt(action.value) > 0n && (
                  <p className="text-xs text-gray-600">
                    Value: {quais.formatEther(action.value)} QUAI
                  </p>
                )}
                {action.decodedCall && (
                  <details className="mt-2">
                    <summary className="text-xs text-blue-600 cursor-pointer">
                      View Details
                    </summary>
                    <pre className="text-xs bg-gray-50 p-2 mt-1 rounded overflow-x-auto">
                      {JSON.stringify(action.decodedCall, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatActionType(type: string): string {
  const typeMap: Record<string, string> = {
    transfer: '💸 Transfer QUAI',
    contract_call: '📞 Contract Call',
    baal_config: '⚙️ Update DAO Configuration',
    multisend_batch: '📦 Batched Actions'
  };
  return typeMap[type] || type;
}
```

---

## Database Schema Updates

### New Tables

**File**: `supabase/migrations/YYYYMMDD_add_baal_support.sql`

```sql
-- Table: baal_modules
-- Stores Baal DAOs enabled as modules on vaults
CREATE TABLE IF NOT EXISTS baal_modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_address TEXT NOT NULL,
  baal_address TEXT NOT NULL,
  name TEXT NOT NULL,
  symbol TEXT,
  voting_period INTEGER NOT NULL,
  grace_period INTEGER NOT NULL,
  quorum_percent INTEGER NOT NULL,
  proposal_offering TEXT NOT NULL,
  sponsor_threshold TEXT NOT NULL,
  min_retention_percent INTEGER NOT NULL,
  total_shares TEXT NOT NULL DEFAULT '0',
  total_loot TEXT NOT NULL DEFAULT '0',
  shares_paused BOOLEAN DEFAULT FALSE,
  loot_paused BOOLEAN DEFAULT FALSE,
  shares_token TEXT,
  loot_token TEXT,
  enabled_at TIMESTAMP WITH TIME ZONE,
  block_number BIGINT,
  tx_hash TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(vault_address, baal_address)
);

CREATE INDEX idx_baal_modules_vault ON baal_modules(vault_address);
CREATE INDEX idx_baal_modules_baal ON baal_modules(baal_address);

-- Table: baal_proposals
-- Stores all Baal governance proposals
CREATE TABLE IF NOT EXISTS baal_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  baal_address TEXT NOT NULL,
  proposal_id INTEGER NOT NULL,
  submitter TEXT NOT NULL,
  sponsor TEXT,
  proposal_data_hash TEXT NOT NULL,
  expiration BIGINT,
  voting_starts BIGINT,
  voting_ends BIGINT,
  grace_ends BIGINT,
  yes_votes INTEGER DEFAULT 0,
  no_votes INTEGER DEFAULT 0,
  yes_balance TEXT DEFAULT '0',
  no_balance TEXT DEFAULT '0',
  processed BOOLEAN DEFAULT FALSE,
  passed BOOLEAN,
  action_failed BOOLEAN,
  cancelled BOOLEAN DEFAULT FALSE,
  details TEXT,
  submitted_at TIMESTAMP WITH TIME ZONE,
  processed_at TIMESTAMP WITH TIME ZONE,
  submitted_block BIGINT,
  submitted_tx_hash TEXT,
  processed_block BIGINT,
  processed_tx_hash TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(baal_address, proposal_id)
);

CREATE INDEX idx_baal_proposals_baal ON baal_proposals(baal_address);
CREATE INDEX idx_baal_proposals_status ON baal_proposals(processed, passed);

-- Table: baal_proposal_actions
-- Stores decoded actions from proposal executions
CREATE TABLE IF NOT EXISTS baal_proposal_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  baal_address TEXT NOT NULL,
  proposal_id INTEGER NOT NULL,
  action_index INTEGER NOT NULL,
  action_type TEXT NOT NULL, -- transfer, contract_call, baal_config, etc.
  to_address TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '0',
  data TEXT,
  operation INTEGER, -- 0 = Call, 1 = DelegateCall
  decoded_function TEXT,
  decoded_args JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(baal_address, proposal_id, action_index)
);

CREATE INDEX idx_baal_actions_proposal ON baal_proposal_actions(baal_address, proposal_id);

-- Add RLS policies (if using Row Level Security)
ALTER TABLE baal_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE baal_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE baal_proposal_actions ENABLE ROW LEVEL SECURITY;

-- Allow public read access (adjust based on your security model)
CREATE POLICY "Enable read access for all users" ON baal_modules FOR SELECT USING (true);
CREATE POLICY "Enable read access for all users" ON baal_proposals FOR SELECT USING (true);
CREATE POLICY "Enable read access for all users" ON baal_proposal_actions FOR SELECT USING (true);
```

---

## Testing Guide

### Manual Testing Checklist

**1. Test Baal Module Enablement**:

```bash
# Deploy a test Baal DAO
cd /path/to/qdl-contracts
npm run summon-dao

# Note the Baal address from output
# Submit enableModule proposal in Quai Vault UI
# Verify:
✅ Transaction shows "Enable Baal DAO Module" type
✅ DAO name displays correctly
✅ Governance config shows (voting period, quorum, etc.)
✅ Warning message appears about module permissions
✅ After approval, baal_modules table has entry
```

**2. Test Proposal Execution Decoding**:

```bash
# Submit a governance proposal in Baal
# (Fund a member, update config, etc.)
# Vote and process the proposal
# Verify in Vault UI:
✅ Module execution appears in transaction history
✅ Actions are decoded and displayed
✅ MultiSend batches show all individual actions
✅ baal_proposals table updated correctly
```

**3. Test Real-Time Updates**:

```bash
# Ensure Supabase real-time subscriptions work
# Submit a proposal → Should appear in UI immediately
# Process a proposal → Status should update in real-time
```

### Automated Tests

**File**: `tests/integration/baal-decoding.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { decodeBaalEnableModule, decodeBaalProposalExecution } from '@/decoders/transactionDecoder';

describe('Baal Transaction Decoding', () => {
  it('should decode enableModule(baal) correctly', async () => {
    const data = '0x610b5925000000000000000000000000...'; // enableModule calldata
    const result = await decodeBaalEnableModule(data, provider);

    expect(result).toBeDefined();
    expect(result.name).toBe('Test DAO');
    expect(result.votingPeriod).toBeGreaterThan(0);
    expect(result.quorumPercent).toBeGreaterThan(0);
  });

  it('should decode proposal execution with MultiSend', async () => {
    const multiSendData = '0x8d80ff0a...'; // multiSend calldata
    const result = await decodeBaalProposalExecution(
      baalAddress,
      multiSendLibrary,
      0n,
      multiSendData,
      1, // DelegateCall
      provider
    );

    expect(result.type).toBe('multisend_batch');
    expect(result.decodedCall.actions).toHaveLength(3);
  });
});
```

---

## Deployment Checklist

### Phase 1: Indexer Updates

- [ ] Add Baal ABI to `src/abis/Baal.json`
- [ ] Add MultiSend ABI to `src/abis/MultiSend.json`
- [ ] Implement `decodeBaalEnableModule()` in `transactionDecoder.ts`
- [ ] Implement `decodeBaalProposalExecution()` in `transactionDecoder.ts`
- [ ] Add Baal event handlers (`handleSetupComplete`, `handleProcessProposal`, etc.)
- [ ] Update main event listener to track Baal events
- [ ] Test on Cyprus1 testnet with deployed Baal DAO
- [ ] Deploy indexer update to staging
- [ ] Verify events are being captured in database

### Phase 2: Database Migration

- [ ] Create migration file: `add_baal_support.sql`
- [ ] Test migration on local Supabase instance
- [ ] Apply migration to staging database
- [ ] Verify tables created correctly
- [ ] Test RLS policies
- [ ] Apply migration to production database

### Phase 3: Frontend Updates

- [ ] Create `BaalModuleTransaction.tsx` component
- [ ] Create `BaalProposalActions.tsx` component
- [ ] Update `TransactionDetails.tsx` to handle Baal transactions
- [ ] Add Baal service for fetching DAO data: `src/services/BaalService.ts`
- [ ] Add TypeScript types for Baal data structures
- [ ] Test UI rendering with mock data
- [ ] Test UI with real Baal transactions on testnet
- [ ] Deploy frontend update to staging
- [ ] User acceptance testing
- [ ] Deploy to production

### Phase 4: Documentation

- [ ] Update Quai Vault docs with Baal integration info
- [ ] Add guide for vault owners: "Understanding Baal Module Proposals"
- [ ] Add FAQ: "What is a Baal DAO?"
- [ ] Create video tutorial (optional)

---

## Reference Materials

### Baal Contract Addresses (Cyprus1 Testnet)

```
BaalSingleton:         [TBD - from deployment-addresses.json]
BaalSummoner:          [TBD]
BaalAndVaultSummoner:  [TBD]
SharesERC20 Template:  [TBD]
LootERC20 Template:    [TBD]
```

### Full Baal ABI (Key Functions/Events)

```json
[
  "event SetupComplete(bool lootPaused, bool sharesPaused, uint32 gracePeriod, uint32 votingPeriod, uint256 proposalOffering, uint256 quorumPercent, uint256 sponsorThreshold, uint256 minRetentionPercent, string name, string symbol, address[] guildTokens, uint256 totalShares, uint256 totalLoot)",
  "event SubmitProposal(uint256 indexed proposal, bytes32 indexed proposalDataHash, uint256 votingPeriod, bytes proposalData, uint256 expiration, bool selfSponsor, uint256 timestamp, string details)",
  "event SponsorProposal(address indexed member, uint256 indexed proposal, uint256 votingStarts)",
  "event SubmitVote(address indexed member, uint256 balance, uint256 indexed proposal, bool indexed approved)",
  "event ProcessProposal(uint256 indexed proposal, bool passed, bool actionFailed)",
  "event CancelProposal(uint256 indexed proposal)",
  "event Ragequit(address indexed member, address to, uint256 lootToBurn, uint256 sharesToBurn, address[] tokens)",
  "event MintShares(address indexed to, uint256 amount)",
  "event MintLoot(address indexed to, uint256 amount)",
  "event BurnShares(address indexed from, uint256 amount)",
  "event BurnLoot(address indexed from, uint256 amount)",
  "event ShamanSet(address indexed shaman, uint256 permission)",
  "event SetGuildTokens(address[] tokens, bool[] enabled)",
  "event GovernanceConfigSet(uint32 voting, uint32 grace, uint256 newOffering, uint256 quorum, uint256 sponsor, uint256 minRetention)",
  "event LockAdmin()",
  "event LockManager()",
  "event LockGovernor()",
  "event SetAdminConfig(bool pauseShares, bool pauseLoot)",

  "function avatar() view returns (address)",
  "function sharesToken() view returns (address)",
  "function lootToken() view returns (address)",
  "function totalShares() view returns (uint256)",
  "function totalLoot() view returns (uint256)",
  "function proposalCount() view returns (uint32)",
  "function votingPeriod() view returns (uint32)",
  "function gracePeriod() view returns (uint32)",
  "function quorumPercent() view returns (uint256)",
  "function sponsorThreshold() view returns (uint256)",
  "function minRetentionPercent() view returns (uint256)",
  "function proposals(uint32) view returns (tuple)",
  "function state(uint32) view returns (uint8)",
  "function shamans(address) view returns (uint256)"
]
```

### Example Transaction Data

**enableModule(baal)**:
```
Function: enableModule(address module)
Selector: 0x610b5925
Calldata: 0x610b5925000000000000000000000000[BAAL_ADDRESS_40_HEX_CHARS]
```

**execTransactionFromModule (Simple Transfer)**:
```
Function: execTransactionFromModule(address to, uint256 value, bytes data, uint8 operation)
Selector: 0x468721a7
Example: Send 1 QUAI to alice
To: 0x00abc... (alice)
Value: 1000000000000000000 (1 QUAI in wei)
Data: 0x (empty for simple transfer)
Operation: 0 (Call)
```

**execTransactionFromModule (MultiSend Batch)**:
```
To: 0x0060a725Ef00CB737f24F7e00da94c1Ce03bf1Dc (MultiSend library)
Value: 0
Data: 0x8d80ff0a[PACKED_TRANSACTIONS]
Operation: 1 (DelegateCall)

Packed transactions format (repeated for each action):
  - operation: 1 byte (0=Call, 1=DelegateCall)
  - to: 20 bytes (address)
  - value: 32 bytes (uint256)
  - dataLength: 32 bytes (uint256)
  - data: dataLength bytes
```

### Links

- **Baal Contracts**: `/home/mpoletiek/Devspace/QUAIDAO/qdl-contracts/contracts/core/Baal.sol`
- **Deployment Guide**: `/home/mpoletiek/Devspace/QUAIDAO/qdl-contracts/docs/DEPLOYMENT_GUIDE.md`
- **E2E Testing**: `/home/mpoletiek/Devspace/QUAIDAO/qdl-contracts/docs/E2E_TESTING.md`
- **Quai Vault Contracts**: `https://github.com/Quai-Vault/quaivault-contracts`
- **Quai Vault Frontend**: `https://github.com/Quai-Vault/quaivault-frontend`
- **Quai Vault Indexer**: `https://github.com/Quai-Vault/quaivault-indexer`

---

## Support & Contact

For questions or issues during integration:

1. **Review FINAL_REVIEW.md** - Comprehensive system assessment
2. **Review SECURITY_AUDIT.md** - All security considerations
3. **Review ARCHITECTURE.md** - System design and patterns
4. **Check E2E_TESTING.md** - Event verification and testing patterns

**Quai DAO Launcher Team**:
- Repository: `https://github.com/QUAIDAO/qdl-contracts`
- Issues: `https://github.com/QUAIDAO/qdl-contracts/issues`

---

**Document Version**: 1.0
**Last Updated**: 2026-02-12
**Maintainer**: Claude Sonnet 4.5
**Status**: Ready for Implementation
