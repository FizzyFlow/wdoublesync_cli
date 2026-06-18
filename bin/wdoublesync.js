#!/usr/bin/env node

import { push, pull, info, watch } from '../lib/commands.js';

const USAGE = `wdoublesync — sync local folders to EndlessVector on Sui+Walrus

Usage:
  wdoublesync push [vector-id] [options]   Sync current folder to vector (creates if no id)
  wdoublesync pull <vector-id> [options]   Restore vector contents to current folder
  wdoublesync info <vector-id> [options]   Show vector metadata
  wdoublesync watch <vector-id> [options]  Watch folder and auto-push/pull

Options:
  --chain <name>            Chain: mainnet, testnet, devnet, localnet (default: testnet)
  --key <suiprivkey>        Sui private key (or set WDOUBLESYNC_KEY env var)
  --phrase <mnemonic>       Mnemonic phrase
  --version <n>             Version to restore (pull only, default: latest)
  --exclude <p1,p2>         Extra exclude patterns (comma-separated)
  --no-compress             Disable gzip compression
  --manifest                Write/use .wdoublesync manifest for faster change detection
  --force-snapshot          Push a full snapshot regardless of prior history (repairs corrupt vectors)
  --poll-interval <s>       Watch: seconds between remote checks (default: 2)
  --debounce <ms>           Watch: ms quiet period before pushing after a change (default: 1000)
  --push-only               Watch: disable auto-pull
  --pull-only               Watch: disable auto-push
  --help                    Show this help
`;

function parseArgs(argv) {
    const args = {
        command: null,
        vectorId: null,
        chain: 'testnet',
        key: null,
        phrase: null,
        version: null,
        exclude: null,
        compress: 'gzip',
        manifest: false,
        forceSnapshot: false,
        pollInterval: 2,
        debounce: 1000,
        pushOnly: false,
        pullOnly: false,
    };

    const raw = argv.slice(2);

    if (raw.length === 0 || raw.includes('--help')) {
        console.log(USAGE);
        process.exit(0);
    }

    args.command = raw[0];

    let i = 1;

    // Next positional arg is vector-id if it looks like one (starts with 0x)
    if (i < raw.length && !raw[i].startsWith('--')) {
        args.vectorId = raw[i];
        i++;
    }

    while (i < raw.length) {
        const flag = raw[i];
        if (flag === '--chain' && i + 1 < raw.length) {
            args.chain = raw[++i];
        } else if (flag === '--key' && i + 1 < raw.length) {
            args.key = raw[++i];
        } else if (flag === '--phrase' && i + 1 < raw.length) {
            args.phrase = raw[++i];
        } else if (flag === '--version' && i + 1 < raw.length) {
            args.version = raw[++i];
        } else if (flag === '--exclude' && i + 1 < raw.length) {
            args.exclude = raw[++i];
        } else if (flag === '--no-compress') {
            args.compress = false;
        } else if (flag === '--manifest') {
            args.manifest = true;
        } else if (flag === '--force-snapshot') {
            args.forceSnapshot = true;
        } else if (flag === '--poll-interval' && i + 1 < raw.length) {
            args.pollInterval = Number(raw[++i]);
        } else if (flag === '--debounce' && i + 1 < raw.length) {
            args.debounce = Number(raw[++i]);
        } else if (flag === '--push-only') {
            args.pushOnly = true;
        } else if (flag === '--pull-only') {
            args.pullOnly = true;
        }
        i++;
    }

    return args;
}

const args = parseArgs(process.argv);

try {
    if (args.command === 'push') {
        await push(args);
    } else if (args.command === 'pull') {
        await pull(args);
    } else if (args.command === 'info') {
        await info(args);
    } else if (args.command === 'watch') {
        await watch(args);
    } else {
        console.error('Unknown command:', args.command);
        console.log(USAGE);
        process.exit(1);
    }
    process.exit(0);
} catch (err) {
    console.error('Error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
}
