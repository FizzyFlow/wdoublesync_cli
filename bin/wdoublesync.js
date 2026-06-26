#!/usr/bin/env node

// Intercept process.exit() calls from dependencies so they don't interrupt
// the top-level await before it settles. Converts them to thrown errors that
// our try/catch handles, then sets process.exitCode without calling exit().
const _realExit = process.exit.bind(process);
process.exit = (code) => {
    const err = new Error(`process.exit(${code ?? 0})`);
    err._isProcessExit = true;
    err._exitCode = code ?? 0;
    throw err;
};

import { push, pull, info, watch, rebate } from '../lib/commands/index.js';

const USAGE = `wdoublesync — sync local folders to EndlessVector on Sui+Walrus

Usage:
  wdoublesync push [vector-id] [options]   Sync current folder to vector (creates if no id)
  wdoublesync pull <vector-id> [options]   Restore vector contents to current folder
  wdoublesync info <vector-id> [options]   Show vector metadata
  wdoublesync watch <vector-id> [options]  Watch folder and auto-push/pull
  wdoublesync rebate <vector-id> [options] Archive history, burn archives, push fresh snapshot

Options:
  --chain <name>            Chain: mainnet, testnet, devnet, localnet (default: testnet)
  --key <suiprivkey>        Sui private key (or set WDOUBLESYNC_KEY env var)
  --phrase <mnemonic>       Mnemonic phrase
  --version <n>             Version to restore (pull only, default: latest)
  --exclude <p1,p2>         Extra exclude patterns (comma-separated)
  --no-compress             Disable gzip compression
  --no-seal                 Create a new vector public (no Seal encryption); only applies on creation
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
        path: process.cwd(),
        chain: 'testnet',
        key: null,
        phrase: null,
        version: null,
        exclude: null,
        compress: 'gzip',
        seal: true,
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
        _realExit(0);
    }

    args.command = raw[0];

    let i = 1;

    // Collect up to two positional args: [vectorId] [path]
    // vectorId starts with 0x, path starts with /, ~, or .
    const positionals = [];
    while (i < raw.length && !raw[i].startsWith('--')) {
        positionals.push(raw[i]);
        i++;
    }
    if (positionals.length === 2) {
        args.vectorId = positionals[0];
        args.path = positionals[1];
    } else if (positionals.length === 1) {
        if (positionals[0].startsWith('0x')) {
            args.vectorId = positionals[0];
        } else {
            args.path = positionals[0];
        }
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
        } else if (flag === '--no-seal') {
            args.seal = false;
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

// The Sui/Walrus SDKs use undici (Node.js fetch) which unref's its HTTP connections.
// With only unref'd I/O in flight, the event loop drains and Node.js exits with code 13
// ("Detected unsettled top-level await") before network responses arrive.
// A ref'd interval keeps the event loop alive for the duration of the command.
const keepAlive = setInterval(() => {}, 60_000);

try {
    if (args.command === 'push') {
        await push(args);
    } else if (args.command === 'pull') {
        await pull(args);
    } else if (args.command === 'info') {
        await info(args);
    } else if (args.command === 'watch') {
        await watch(args);
    } else if (args.command === 'rebate') {
        await rebate(args);
    } else {
        console.error('Unknown command:', args.command);
        console.log(USAGE);
        process.exitCode = 1;
    }
} catch (err) {
    if (err._isProcessExit) {
        process.exitCode = err._exitCode;
    } else {
        console.error('Error:', err.message);
        if (err.stack) console.error(err.stack);
        process.exitCode = 1;
    }
} finally {
    clearInterval(keepAlive);
}
