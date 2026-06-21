---
name: wdoublesync
version: 0.1.7
description: Claude agent skill for decentralized file storage, versioning, and sync on Sui + Walrus + Seal. Enables agents to push local folders as on-chain vectors, pull versions, manage Walrus storage, and watch for changes.
keywords: [walrus, sui, storage, versioning, sync, seal-encryption, blockchain, defi]
---

# wdoublesync

Decentralized file storage, versioning, and sync on **Sui + Walrus + Seal**.

An abstract virtual filesystem that synchronizes folder state on-chain via Sui + Walrus using Content-Defined Chunking (CDC) to compute minimal binary diffs. Files can optionally be encrypted with Seal so only authorized addresses can decrypt them.

## When to Use

- **Archive and restore folder snapshots** on-chain with full version history
- **Efficient incremental sync** — only changed chunks uploaded, not entire files
- **End-to-end encrypted storage** — data encrypted with Seal before Walrus upload
- **Verify data integrity** — pull any version and reconstruct exact folder state
- **Extend storage** before Walrus epochs expire without re-uploading data
- **Clean archive** with rebate workflow (burn old archive, push as fresh snapshot)

## When NOT to Use

- For **semantic/vector search over text** — if you need to index and search text by meaning, use [MemWal](https://raw.githubusercontent.com/MystenLabs/MemWal/refs/heads/dev/SKILL.md) instead (vector database with embeddings)

## MemWal + WDoubleSync

Feel free to combine MemWal and WDoubleSync in your agent workflows. For example, you can use MemWal to store and search text embeddings, and WDoubleSync to store the original files or folders that correspond to those embeddings. This allows you to have both semantic search capabilities and versioned file storage in one system.

## Installation

Check if `wdoublesync` is already installed:

```bash
wdoublesync --help
```

if not, install via npm:

**Global npm install**
```bash
npm install -g @fizzyflow/wdoublesync_cli
# Now use: wdoublesync <command> (installed from npm)
```

After you have access to `wdoublesync`, you can run `wdoublesync --help` to see the available commands and options. Use `wdoublesync info` to check your currently connected wallet (`your wallet` field), if there's no - wallet, you can set one with `--key` or `--phrase` flags, or by exporting `WDOUBLESYNC_KEY` environment variable. Feel free to ask user to set up a wallet if they haven't done so yet, as it's required for push operations and pull encrypted vectors.

### Set up your key (required for push and pull of encrypted vectors)

```bash
export WDOUBLESYNC_KEY=suiprivkey1...
```

For **read-only public vectors**, the key is not required.

### Push a folder (creates new vector if no ID provided)

Be sure to run this command from the folder you want to sync:

```bash
cd ~/my-folder
wdoublesync push
# Creates new vector + syncs current folder
# Output: created: 0x1234... / syncing ./ → 0x1234...
```

This creates a new EndlessVector on-chain and pushes the current folder as a snapshot encrypted by Seal. The output will show the vector ID (e.g., `0x1234...`) which you can use for future pulls or pushes.

### Pull a vector to restore it

```bash
mkdir ~/restored-folder && cd ~/restored-folder
wdoublesync pull 0x1234...
# Restores vector to current directory
```

### View vector metadata

```bash
wdoublesync info 0x1234...
# Output: ID, owner, version count, total size, encryption status
```

### Watch for changes (bi-directional sync)

```bash
cd ~/my-data
wdoublesync watch 0x1234... --poll-interval 5
# Monitors local folder, auto-pushes changes
# Checks remote every 5 seconds, auto-pulls updates
```

## API Surface

All commands operate on the **current working directory** — `cd` into your folder first.

| Command | Arguments | Use Case |
|---------|-----------|----------|
| **push** | `[vectorId]` `[options]` | Sync current folder to vector; creates new vector if no ID given |
| **pull** | `vectorId` `[options]` | Restore vector (default: latest version) into current directory |
| **info** | `[vectorId]` | No ID: show chain + wallet. With ID: full vector details |
| **watch** | `vectorId` `[options]` | Bi-directional sync: auto-push local changes, auto-pull remote updates |
| **rebate** | `vectorId` | Burn archive patches, push current folder as fresh single snapshot |

### Command Examples

#### push (create new vector)

```bash
cd ~/my-data
wdoublesync push
# Syncs current folder as new vector
# Output: creating new EndlessVector on testnet...
#         created: 0xabc123...
#         syncing ./ → 0xabc123...
```

#### push (with manifest for faster change detection)

```bash
cd ~/my-data
wdoublesync push 0x1234... --manifest
# Writes .wdoublesync manifest; faster change detection on future pushes
```

#### push (full snapshot, not incremental)

```bash
cd ~/my-data
wdoublesync push 0x1234... --force-snapshot
# Uploads entire snapshot, useful if history is corrupted
```

#### pull (latest version)

```bash
mkdir ~/restored && cd ~/restored
wdoublesync pull 0x1234...
# Restores latest version to current directory
```

#### pull (specific version)

```bash
cd ~/restored
wdoublesync pull 0x1234... --version 10
# Restores version 10 instead of latest
```

#### watch (bi-directional)

```bash
cd ~/my-data
wdoublesync watch 0x1234... --poll-interval 5
# Monitors current folder, auto-pushes on change (debounce: 1000ms default)
# Checks remote every 5 seconds, auto-pulls new versions
# Runs indefinitely; stop with Ctrl+C
```

#### watch (push-only)

```bash
cd ~/my-data
wdoublesync watch 0x1234... --push-only
# Only auto-push on local changes, don't pull remote updates
```

#### watch (pull-only)

```bash
cd ~/my-data
wdoublesync watch 0x1234... --pull-only
# Only pull remote updates, don't auto-push local changes
```

#### rebate

When user asks to rebate, you can explain that this command is useful after many incremental syncs to reclaim on-chain storage. It burns the archive history and pushes the current folder as a fresh single snapshot. Make sure user understands that after rebate, only the latest snapshot is available, and old patches will be burned.

```bash
cd ~/my-data
wdoublesync rebate 0x1234...
# Burns archive history, pushes current folder as fresh single snapshot
# Useful after many incremental syncs to reclaim on-chain storage
```


## Configuration

### Command-line flags

| Flag | Arguments | Default | Use |
|------|-----------|---------|-----|
| `--chain` | `mainnet` \| `testnet` \| `devnet` \| `localnet` | `testnet` | Which Sui network to use |
| `--key` | Sui private key (`suiprivkey1...`) | — | Sign transactions (or use env vars) |
| `--phrase` | Mnemonic phrase | — | Alternative: derive key from mnemonic |
| `--no-compress` | — | — | Push: disable gzip compression |
| `--manifest` | — | — | Push: write/use `.wdoublesync` file for faster change detection |
| `--force-snapshot` | — | — | Push: full snapshot (repairs corrupt vectors) |
| `--version` | Number | `latest` | Pull: restore specific version instead of latest |
| `--exclude` | Patterns (comma-separated) | — | Extra file patterns to exclude from sync |
| `--poll-interval` | Seconds | `2` | Watch: check for remote updates every N seconds |
| `--debounce` | Milliseconds | `1000` | Watch: quiet period before pushing after local change |
| `--push-only` | — | — | Watch: disable auto-pull |
| `--pull-only` | — | — | Watch: disable auto-push |

### Environment variables

| Variable | Type | Use |
|----------|------|-----|
| `WDOUBLESYNC_KEY` | Sui private key (`suiprivkey1...`) | Sign transactions (alternative to `--key` flag) |

## Example Workflows

### Workflow 1: Create and verify

```bash
# 1. Push a folder (creates new vector on first push)
cd ~/important-data
wdoublesync push
# Output: creating new EndlessVector on testnet...
#         created: 0xabc123...

# 2. Verify by pulling to a fresh folder
mkdir ~/verify-tmp && cd ~/verify-tmp
wdoublesync pull 0xabc123...

# 3. Check file counts match
ls ~/important-data | wc -l
ls ~/verify-tmp | wc -l
```

### Workflow 2: Multi-version history and rollback

```bash
cd ~/data
# Push version 1
wdoublesync push 0xabc123...

# Make changes, push version 2
echo "new file" > new.txt
wdoublesync push 0xabc123...

# List all versions
wdoublesync info 0xabc123...

# Rollback to version 1
mkdir ~/data-v1 && cd ~/data-v1
wdoublesync pull 0xabc123... --version 1
# Folder now matches state from version 1
```

### Workflow 3: Rebate to compact archive

After many incremental syncs, archive grows with lots of patches. Rebate burns old data and rebuilds as single snapshot:

```bash
# Before rebate: many small patches
wdoublesync info 0xabc123...
# Output: version 87, total size 45 MB (many patches)

# Run rebate from current directory
cd ~/data
wdoublesync rebate 0xabc123...
# Output: Burned 86 items, pushed version 88 (3.2 MB)

# After rebate: single snapshot instead of 87 patches
# Much more efficient for Walrus storage
```

### Workflow 4: Watch for external changes

```bash
# Another user pushes to the same vector
# You want to auto-sync your local copy

cd ~/data
wdoublesync watch 0xabc123... --poll-interval 5
# Monitors local folder for changes, auto-pushes them
# Also checks remote every 5 seconds for updates, auto-pulls
# Press Ctrl+C to stop
```

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| **"No signing key"** | Trying to push/pull without credentials | Export `WDOUBLESYNC_KEY=suiprivkey1...` or use `--key` / `--phrase` flag |
| **"vector-id is required"** | Command needs a vector ID but none provided | Pass the vector ID as the first argument: `wdoublesync pull 0x...` |
| **"This vector is Seal-encrypted"** | Vector is encrypted but no key provided | Provide `--key` or `--phrase`, or export `WDOUBLESYNC_KEY` |
| **"at() is out of range, this part of archive has been burned"** | Trying to restore a version whose archive was burned by rebate | Only the latest snapshot is available after rebate; pull without `--version` |
| **Connection errors** | RPC endpoint unreachable or wrong chain | You may need to try again little later |

## Links

- **Repository**: https://github.com/FizzyFlow/wdoublesync_cli
