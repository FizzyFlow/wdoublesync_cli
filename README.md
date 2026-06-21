# wdoublesync cli

CLI tool to sync local folders to Sui and [Walrus](https://walrus.xyz) decentralised storage on the Sui network.

Built on top of the [`wdoublesync`](https://github.com/fizzyFlow/wdoublesync) library.

Each `push` stores a versioned, gzip-compressed diff or shapshot inside an [EndlessVector](https://github.com/fizzyFlow/endless_vector) on-chain object. Any past version can be restored at any time with `pull`. Folders can optionally be encrypted with [Seal](https://github.com/MystenLabs/seal).

## AI Agent Skill

wdoublesync ships with a [SKILL.md](https://github.com/FizzyFlow/wdoublesync_cli/SKILL.md) that teaches AI coding agents how to use it autonomously. Once loaded, an agent can push folders to on-chain storage, pull specific versions for inspection or rollback, watch a directory for bi-directional sync, and run rebate to compact a vector's archive — all without hand-holding on the commands. This is useful when you want an agent to persist its own working state, archive project snapshots, or coordinate versioned data across sessions. The skill also covers how to combine wdoublesync with [MemWal](https://github.com/MystenLabs/MemWal) for workflows.

## Installation

```bash
pnpm install
# make the binary globally available (optional)
pnpm link --global
```

## Usage

```
wdoublesync push [vector-id] [path] [options]   Sync folder to a vector (creates one if no id given)
wdoublesync pull <vector-id> [path] [options]   Restore vector contents to a folder
wdoublesync info [vector-id] [path] [options]   Show chain/wallet info, or full vector metadata
wdoublesync watch <vector-id> [path] [options]  Watch folder: auto-push on changes, auto-pull on remote updates
wdoublesync rebate <vector-id> [path] [options] Burn archive patches and push folder as a fresh snapshot
```

The `[path]` argument is optional — if omitted, the current working directory is used.

### Options

| Flag | Description |
|---|---|
| `--chain <name>` | Chain: `mainnet`, `testnet`, `devnet`, `localnet` (default: `testnet`) |
| `--key <suiprivkey>` | Sui private key (or set `WDOUBLESYNC_KEY` env var) |
| `--phrase <mnemonic>` | Mnemonic phrase instead of a raw key |
| `--version <n>` | Version to restore (`pull` only, default: latest) |
| `--exclude <p1,p2>` | Extra exclude patterns (comma-separated) |
| `--no-compress` | Disable gzip compression |
| `--manifest` | Write/use `.wdoublesync` manifest for faster change detection |
| `--force-snapshot` | Push a full snapshot regardless of prior history (repairs a corrupt vector) |
| `--poll-interval <s>` | `watch`: seconds between remote version checks (default: `2`) |
| `--debounce <ms>` | `watch`: quiet period in ms before pushing after a local change (default: `1000`) |
| `--push-only` | `watch`: disable auto-pull |
| `--pull-only` | `watch`: disable auto-push |
| `--help` | Show help |

### Authentication

Supply a signing key in one of three ways (checked in order):

1. `--key suiprivkey1...`
2. `--phrase "word1 word2 ..."`
3. `WDOUBLESYNC_KEY` environment variable

`pull` and `info` work without a key for public (unencrypted) vectors. A key is required for Seal-encrypted vectors and for any `push`.

## Examples

### Push a folder (first time)

```bash
# from current directory
wdoublesync push --chain testnet --key suiprivkey1...

# or pass path explicitly
wdoublesync push ~/my-project --chain testnet --key suiprivkey1...

# prints the new vector id, e.g.:
#   created: 0xabc123...
#   version 1 pushed (full snapshot, gzip compressed)
```

### Push an update

```bash
wdoublesync push 0xabc123... --chain testnet --key suiprivkey1...

# or with explicit path
wdoublesync push 0xabc123... ~/my-project --chain testnet --key suiprivkey1...
```

### Pull the latest version

```bash
wdoublesync pull 0xabc123... ~/restored --chain testnet
```

### Pull a specific version

```bash
wdoublesync pull 0xabc123... ~/restored --chain testnet --version 1
```

### Inspect a vector

```bash
# check your wallet + chain (no vector ID needed)
wdoublesync info

# full vector metadata + local sync status
wdoublesync info 0xabc123... --chain testnet
wdoublesync info 0xabc123... ~/my-project --chain testnet
```

### Fast incremental pushes with a manifest

```bash
wdoublesync push 0xabc123... --chain testnet --key suiprivkey1... --manifest
# subsequent pushes are skipped when nothing has changed locally
```

### Watch a folder (auto push + pull)

```bash
wdoublesync watch 0xabc123... --chain testnet --key suiprivkey1...

# or with explicit path
wdoublesync watch 0xabc123... ~/my-project --chain testnet --key suiprivkey1...
# pushes local changes 1 s after the last edit
# pulls remote updates every 2 s
# Ctrl-C to stop
```

Tune the timing:

```bash
wdoublesync watch 0xabc123... --debounce 3000 --poll-interval 5
```

Watch in push-only or pull-only mode:

```bash
wdoublesync watch 0xabc123... --push-only   # no auto-pull
wdoublesync watch 0xabc123... --pull-only   # no auto-push (read-only mirror)
```

### Rebate (compact archive)

After many incremental syncs, burn old archive patches and push the current folder as a fresh single snapshot. Reduces storage cost.

```bash
wdoublesync rebate 0xabc123... --chain testnet --key suiprivkey1...

# or with explicit path
wdoublesync rebate 0xabc123... ~/my-project --chain testnet --key suiprivkey1...
```

### Repair a corrupt vector with a force snapshot

If a diff patch was pushed against a stale base (e.g. a race condition in `watch`), subsequent pulls will fail. Fix it by pushing a new full snapshot:

```bash
wdoublesync push 0xabc123... --chain testnet --key suiprivkey1... --force-snapshot
# skips chain replay and pushes the current folder as a self-contained full snapshot
# restore() will recover from this snapshot, skipping any corrupt diffs before it
```

## How it works

1. **push** — scans the current directory, computes a tree hash, and compares it against the last stored version. If changes are detected, a compressed diff (or full snapshot on the first push) is uploaded to Walrus and appended to the EndlessVector on-chain.
2. **pull** — reads the requested version from the EndlessVector, decrypts it if Seal-encrypted, and writes only changed files to disk. Files absent from the stored version are deleted.
3. **info** — reads EndlessVector metadata from the chain (version count, binary size, history) and checks whether the local folder matches any stored version.
4. **watch** — combines push and pull in a loop. A filesystem watcher triggers a debounced push on local changes. A poll interval checks the remote vector for new versions and pulls them if found. Push and pull never run concurrently.
5. **rebate** — burns all existing archive patches on-chain and pushes the current folder as a single fresh full snapshot, reducing Walrus storage costs after many incremental syncs.

### Default excludes

The following are always excluded from snapshots: `node_modules`, `.git`, `.env`, `.DS_Store`, `.wdoublesync`, `pnpm-lock.yaml`, `package-lock.json`. Add more with `--exclude`.

## Dependencies

| Package | Role |
|---|---|
| `@fizzyflow/wdoublesync` | Folder-diff / snapshot layer |
| `@fizzyflow/doublesync` | Core CDC store and snapshot primitives |
| `@fizzyflow/endless-vector` | On-chain EndlessVector (Sui + Walrus + Seal) |
| `suidouble` | Sui client / key management |
