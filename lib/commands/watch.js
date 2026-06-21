import { watch as fsWatch } from 'node:fs';
import EndlessVector from '@fizzyflow/endless-vector';
import { WDoubleSync } from '@fizzyflow/wdoublesync';
import { DoubleSyncFSFolder } from '../DoubleSyncFSFolder.js';
import {
    makeWalrusSealClient,
    makeClientForRead,
    resolvePath,
    makeExcludes,
    formatPath,
    localTreeHash,
    hashDiskTree,
    syncMemoryFolderToDisk,
    DISK_EXCLUDES,
} from './shared.js';

function timestamp() {
    return new Date().toTimeString().slice(0, 8);
}

function hashesEqual(a, b) {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function isEnsureLengthError(err) {
    return err?.message?.includes('abort code: 98') ||
           err?.message?.includes('ensure_length') ||
           err?.message?.includes('EUnexpectedLength');
}

export async function watch(args) {
    if (!args.vectorId) throw new Error('vector-id is required for watch');

    const cwd = resolvePath(args.path);
    const chain = args.chain;
    const debounceMs = args.debounce ?? 5000;
    const pollIntervalMs = (args.pollInterval ?? 2) * 1000;
    const pushEnabled = !args.pullOnly;
    const pullEnabled = !args.pushOnly;

    const excludes = makeExcludes(args);

    const wsc = pushEnabled
        ? await makeWalrusSealClient(args)
        : await makeClientForRead(args);

    const evParams = {
        suiClient: wsc.suiClient,
        id: args.vectorId,
        packageId: chain,
        walrusClient: wsc.walrusClient,
        aggregatorUrl: wsc.aggregatorUrl,
    };
    if (wsc.sealClient && wsc.suiMaster) {
        evParams.sealClient = wsc.sealClient;
        evParams.senderAddress = wsc.suiMaster.address;
        evParams.signer = wsc.suiMaster._keypair;
        if (pushEnabled) {
            evParams.signAndExecuteTransaction = (tx) => wsc.signAndExecuteTransaction(tx);
        }
    }

    const ev = new EndlessVector({ ...evParams });
    const wdsync = new WDoubleSync({
        endlessVector: ev,
        compress: args.compress || 'gzip',
    });

    await wdsync.initialize();

    let remoteVersion = ev.length;
    let lastSyncedHash = await localTreeHash(cwd);
    let pushInFlight = false;
    let debounceTimer = null;
    let dirty = false;

    console.log(`watching ${formatPath(cwd)}`);
    console.log(`  vector:        ${args.vectorId}`);
    console.log(`  remote version: ${remoteVersion}`);
    console.log(`  push:          ${pushEnabled ? `enabled (debounce ${debounceMs}ms)` : 'disabled'}`);
    console.log(`  pull:          ${pullEnabled ? `enabled (poll every ${pollIntervalMs / 1000}s)` : 'disabled'}`);
    console.log('press Ctrl+C to stop\n');

    async function runPush() {
        if (!pushEnabled || pushInFlight) return;
        dirty = false;
        const newHash = await localTreeHash(cwd);
        if (hashesEqual(newHash, lastSyncedHash)) return;

        pushInFlight = true;
        try {
            const fsFolder = new DoubleSyncFSFolder(cwd, excludes);
            console.log(`[${timestamp()}] change detected — pushing...`);
            const result = await wdsync.push(fsFolder);
            lastSyncedHash = newHash;
            remoteVersion = result.version;
            console.log(`[${timestamp()}] pushed version ${result.version}`);
        } catch (err) {
            if (isEnsureLengthError(err)) {
                console.log(`[${timestamp()}] conflict: remote was updated while pushing — skipping push, will pull on next poll`);
                dirty = true;
            } else {
                console.error(`[${timestamp()}] push error:`, err.message);
            }
        } finally {
            pushInFlight = false;
        }
    }

    async function runPoll() {
        if (!pullEnabled || pushInFlight) return;
        try {
            ev.reInitialize();
            await ev.initialize();
            if (ev.length <= remoteVersion) return;

            const newRemoteVersion = ev.length;

            // Always resync wdsync when remote has advanced. Without this,
            // wdsync._lastSnapshot stays at the old version while ev.length has
            // advanced — the next push would build a diff against the wrong base
            // snapshot, corrupting the chain.
            wdsync.reInitialize();

            const localNow = await localTreeHash(cwd);

            if (!hashesEqual(localNow, lastSyncedHash)) {
                console.log(`[${timestamp()}] remote has ${newRemoteVersion - remoteVersion} new version(s) but local has unpushed changes — skipping pull`);
                return;
            }

            console.log(`[${timestamp()}] remote advanced to version ${newRemoteVersion} — pulling...`);
            let folder;
            try {
                folder = await wdsync.restore();
            } catch (err) {
                console.error(`[${timestamp()}] pull failed (${err.message}) — skipping to version ${newRemoteVersion}; run \`pull\` manually`);
                remoteVersion = newRemoteVersion;
                return;
            }
            const oldFiles = await hashDiskTree(cwd);
            const { stats } = await syncMemoryFolderToDisk(folder, cwd, oldFiles);
            lastSyncedHash = await localTreeHash(cwd);
            remoteVersion = newRemoteVersion;
            console.log(`[${timestamp()}] pulled version ${remoteVersion} (${stats.written} written, ${stats.skipped} unchanged, ${stats.deleted} deleted)`);
        } catch (err) {
            console.error(`[${timestamp()}] poll error:`, err.message);
        }
    }

    const watcher = fsWatch(cwd, { recursive: true }, (eventType, filename) => {
        if (!pushEnabled) return;
        if (!filename) return;
        const base = filename.split('/')[0];
        if (DISK_EXCLUDES.has(base) || base.startsWith('.')) return;
        dirty = true;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(runPush, debounceMs);
    });

    const poller = setInterval(runPoll, pollIntervalMs);

    let shutdownResolve;
    const shutdownPromise = new Promise((resolve) => {
        shutdownResolve = resolve;
    });

    function shutdown() {
        console.log('\nstopping watch...');
        clearTimeout(debounceTimer);
        clearInterval(poller);
        watcher.close();
        shutdownResolve();
    }
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    await shutdownPromise;
}
