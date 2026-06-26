---
name: wdoublesync
version: 0.1.8
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

- For **semantic/vector search over text** — if you need to index and search text by meaning, use [MemWal](https://raw.githubusercontent.com/MystenLabs/MemWal/refs/heads/dev/SKILL.md) instead (vector database with embeddings). You'd better use 'default' workspace for MemWal, no need to try to create one based on the current directory or doublesync state.

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

After you have access to `wdoublesync`, you can run `wdoublesync --help` to see the available commands and options. Use `wdoublesync info` to check your currently connected wallet (`your wallet` field), if there's no wallet, you can set one with `--key` or `--phrase` flags, or by exporting `WDOUBLESYNC_KEY` environment variable. Feel free to ask user to set up a wallet if they haven't done so yet, as it's required for push operations and pull encrypted vectors.

After wdoublesync is installed, ask the user to set up MemWal if they want.

### Set up your key (required for push and pull of encrypted vectors)

```bash
export WDOUBLESYNC_KEY=suiprivkey1...
```

For **read-only public vectors**, the key is not required.

### Push a folder (creates new vector if no ID provided)

Pass the path explicitly — no need to `cd` first:

```bash
wdoublesync push ~/my-folder
# Creates new vector + syncs folder
# Output: created: 0x1234... / syncing ./ → 0x1234...
```

This creates a new EndlessVector on-chain and pushes the folder as a snapshot encrypted by Seal. To create a **public** vector instead — unencrypted, pullable without a key and browsable from the dApp — add `--no-seal` (only effective on creation). The output will show the vector ID (e.g., `0x1234...`) which you can use for future pulls or pushes. It's a good idea to save this ID to MemWal, with addition to the path info, so you can easily find it later when you want to pull or view the vector state. Ask a user if they want to set up MemWal if it's not available and you are going to push new vector.

### Pull a vector to restore it

```bash
wdoublesync pull 0x1234... ~/restored-folder
# Restores vector to the specified folder
```

### View vector metadata

```bash
wdoublesync info 0x1234...
# Output: ID, owner, version count, total size, encryption status
```

### Watch for changes (bi-directional sync)

```bash
wdoublesync watch 0x1234... ~/my-data --poll-interval 5
# Monitors folder, auto-pushes changes
# Checks remote every 5 seconds, auto-pulls updates
```

## API Surface

| Command | Arguments | Use Case |
|---------|-----------|----------|
| **push** | `[vectorId]` `[path]` `[options]` | Sync folder to vector; creates new vector if no ID given |
| **pull** | `vectorId` `[path]` `[options]` | Restore vector (default: latest version) into folder |
| **info** | `[vectorId]` `[path]` | No ID: show chain + wallet. With ID: full vector details |
| **watch** | `vectorId` `[path]` `[options]` | Bi-directional sync: auto-push local changes, auto-pull remote updates |
| **rebate** | `vectorId` `[path]` | Burn archive patches, push folder as fresh single snapshot |

### Command Examples

#### push (create new vector)

```bash
wdoublesync push ~/my-data
# Output: creating new EndlessVector on testnet...
#         created: 0xabc123...
#         syncing ./ → 0xabc123...
```

#### push (create public, unencrypted vector)

```bash
wdoublesync push ~/my-data --no-seal
# Creates a public vector — anyone can pull it without a key, or browse it from the dApp.
# Only effective on creation; ignored when pushing to an existing vector.
```

#### push (to existing vector)

```bash
wdoublesync push 0x1234... ~/my-data
```

#### push (with manifest for faster change detection)

```bash
wdoublesync push 0x1234... ~/my-data --manifest
```

#### push (full snapshot, not incremental)

```bash
wdoublesync push 0x1234... ~/my-data --force-snapshot
# Uploads entire snapshot, useful if history is corrupted
```

#### pull (latest version)

```bash
wdoublesync pull 0x1234... ~/restored
```

#### pull (specific version)

```bash
wdoublesync pull 0x1234... ~/restored --version 10
```

#### watch (bi-directional)

```bash
wdoublesync watch 0x1234... ~/my-data --poll-interval 5
# Auto-pushes on change (debounce: 1000ms default)
# Checks remote every 5 seconds, auto-pulls new versions
# Runs indefinitely; stop with Ctrl+C
```

#### watch (push-only or pull-only)

```bash
wdoublesync watch 0x1234... ~/my-data --push-only
wdoublesync watch 0x1234... ~/my-data --pull-only
```

#### rebate

```bash
wdoublesync rebate 0x1234... ~/my-data
# Burns archive history, pushes folder as fresh single snapshot
```


## Configuration

### Command-line flags

| Flag | Arguments | Default | Use |
|------|-----------|---------|-----|
| `--chain` | `mainnet` \| `testnet` \| `devnet` \| `localnet` | `testnet` | Which Sui network to use |
| `--key` | Sui private key (`suiprivkey1...`) | — | Sign transactions (or use env vars) |
| `--phrase` | Mnemonic phrase | — | Alternative: derive key from mnemonic |
| `--no-compress` | — | — | Push: disable gzip compression |
| `--no-seal` | — | — | Push: create a new vector public (no Seal encryption). Only applies when creating a vector; ignored for existing ones |
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
wdoublesync push ~/important-data
# Output: creating new EndlessVector on testnet...
#         created: 0xabc123...

# 2. Verify by pulling to a fresh folder
wdoublesync pull 0xabc123... ~/verify-tmp

# 3. Check file counts match
ls ~/important-data | wc -l
ls ~/verify-tmp | wc -l
```

### Workflow 2: Multi-version history and rollback

```bash
# Push version 1
wdoublesync push 0xabc123... ~/data

# Make changes, push version 2
echo "new file" > ~/data/new.txt
wdoublesync push 0xabc123... ~/data

# List all versions
wdoublesync info 0xabc123...

# Rollback to version 1
wdoublesync pull 0xabc123... ~/data-v1 --version 1
```

### Workflow 3: Rebate to compact archive

After many incremental syncs, archive grows with lots of patches. Rebate burns old data and rebuilds as single snapshot:

```bash
wdoublesync info 0xabc123...
# Output: version 87, total size 45 MB (many patches)

wdoublesync rebate 0xabc123... ~/data
# Output: Burned 86 items, pushed version 88 (3.2 MB)
# Single snapshot instead of 87 patches — much more efficient
```

### Workflow 4: Watch for external changes

```bash
wdoublesync watch 0xabc123... ~/data --poll-interval 5
# Monitors folder for changes, auto-pushes them
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
| **Connection errors** | RPC endpoint unreachable or wrong chain | Check `--chain` flag; try again in a moment if the RPC is temporarily down |


## Links

- **Repository**: https://github.com/FizzyFlow/wdoublesync_cli

## Agent Guidelines

- **Always run `wdoublesync` commands as standalone Bash calls** — never chain them with `&&`, `;`, or combine with file creation commands in the same shell invocation. Create files first in a separate tool call, then push in a dedicated call.
- **Keep user posted**, After a successful push to an endless_vector, inform the user about the vector ID and the version that was just pushed. Also propose they view the current state in the browser by providing a link to the explorer, e.g. https://doublesync.wal.app/vector#testnet:0xafe7ab81339c9c4e5750f20708ef982ef553d9b20b17a85342e4af055661a852
- **MemWal vector ID logging is critical on first push** — when a new vector is created, immediately propose saving the vector ID + local path to MemWal. Phrase it as: "Want me to save the vector ID and path to MemWal so we can find it later?" This is the most important MemWal step — without it the vector ID can be lost. Only skip if the user explicitly says no.
- **MemWal version logging is mandatory after every push** — after every successful push, always propose saving a version description to MemWal. Phrase it as: "Want me to save a description of this version to MemWal?" and wait for the user response. Only skip if the user explicitly says no. Do not silently skip this step.