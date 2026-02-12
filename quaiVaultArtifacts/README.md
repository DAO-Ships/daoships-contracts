# Quai Vault Artifacts

This folder contains compiled artifacts from the Quai Vault contracts, used by the DAO summoning script for vault creation and address prediction.

## Files

| File | Description | Source |
|------|-------------|--------|
| `QuaiVault.json` | QuaiVault implementation contract ABI and bytecode | [quaivault-contracts](https://github.com/Quai-Vault/quaivault-contracts) |
| `QuaiVaultProxy.json` | QuaiVaultProxy (EIP-1967) ABI and bytecode | [quaivault-contracts](https://github.com/Quai-Vault/quaivault-contracts) |
| `MultiSend.json` | MultiSend library for batched proposal execution | [quaivault-contracts](https://github.com/Quai-Vault/quaivault-contracts) |

## Purpose

These artifacts are used by `scripts/summon-dao.ts` to:

1. **Calculate CREATE2 addresses** for vault deployment
2. **Encode initialization data** for vault setup (owners, threshold)
3. **Mine salts** that produce Cyprus1 shard addresses (`0x00` prefix)

## Usage

The summon script loads these artifacts to predict the vault address before deployment:

```typescript
// Load Quai Vault artifacts
const QuaiVaultJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../quaiVaultArtifacts/QuaiVault.json"), "utf-8")
);
const QuaiVaultProxyJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../quaiVaultArtifacts/QuaiVaultProxy.json"), "utf-8")
);

// Prepare vault initialization data
const vaultIface = new quais.Interface(QuaiVaultJson.abi);
const initData = vaultIface.encodeFunctionData("initialize", [owners, threshold]);

// Calculate CREATE2 address
const encodedArgs = quais.AbiCoder.defaultAbiCoder().encode(
  ["address", "bytes"],
  [vaultImplementation, initData]
);
const fullBytecode = QuaiVaultProxyJson.bytecode + encodedArgs.slice(2);
const bytecodeHash = quais.keccak256(fullBytecode);
const predictedAddress = quais.getCreate2Address(factory, salt, bytecodeHash);
```

## Source Repository

These artifacts are copied from the Quai Vault repository:

- **Repository**: [github.com/Quai-Vault/quaivault-contracts](https://github.com/Quai-Vault/quaivault-contracts)
- **Commit**: Latest stable release
- **License**: MIT

## Updating

If Quai Vault contracts are updated, regenerate these artifacts:

```bash
# In quaivault-contracts repo:
npm run compile

# Copy updated artifacts:
cp artifacts/contracts/QuaiVault.sol/QuaiVault.json ../qdl-contracts/quaiVaultArtifacts/
cp artifacts/contracts/QuaiVaultProxy.sol/QuaiVaultProxy.json ../qdl-contracts/quaiVaultArtifacts/
cp artifacts/contracts/libraries/MultiSend.sol/MultiSend.json ../qdl-contracts/quaiVaultArtifacts/
```

**Important**: Ensure the artifacts match the deployed contracts on the network (Cyprus1):
- QuaiVault Implementation: `0x00707D5c7e35253265267DE764d2625cAb04082C`
- QuaiVaultFactory: `0x005261a837f1eFEa0e23b66dc526EB6054FD2250`
- MultiSend Library: `0x000bf87B9a7D4Bf60F95e0a27A6254dE7655b345`

## Why Local Copies?

Including these artifacts locally makes `qdl-contracts` standalone - users don't need to clone the Quai Vault repository to summon DAOs. This simplifies:

- Development setup (fewer dependencies)
- CI/CD pipelines (no external repo clones)
- Distribution (single repository)
- Version consistency (locked artifacts)

---

**Last Updated**: 2026-02-10
**Quai Vault Version**: v1.0.0 (or specific commit hash)
