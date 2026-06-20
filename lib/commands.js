import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { SuiMaster } from 'suidouble';
import EndlessVector from '@fizzyflow/endless-vector';
import { WDoubleSync } from '@fizzyflow/wdoublesync';
import { DoubleSync, CDCStore, DoubleSyncSnapshot } from '@fizzyflow/doublesync';
import { WalrusSealClient } from 'walrus-seal-client-with-local';
import { DoubleSyncFSFolder } from './DoubleSyncFSFolder.js';

async function makeWalrusSealClient(args) {
    const params = { client: args.chain };
    const key = args.key || process.env.WDOUBLESYNC_KEY;
    if (key) {
        params.privateKey = key;
    } else if (args.phrase) {
        params.phrase = args.phrase;
    } else {
        throw new Error('No signing key. Use --key, --phrase, or WDOUBLESYNC_KEY env var');
    }

    const suiMaster = new SuiMaster(params);
    await suiMaster.initialize();

    const client = new WalrusSealClient({ network: args.chain, suiMaster });
    await client.initialize();
    return client;
}

async function makeReadOnlyWalrusSealClient(chain) {
    const client = new WalrusSealClient({ network: chain });
    await client.initialize();
    return client;
}

async function makeClientForRead(args) {
    const key = args.key || process.env.WDOUBLESYNC_KEY;
    if (key || args.phrase) {
        return makeWalrusSealClient(args);
    }
    return makeReadOnlyWalrusSealClient(args.chain);
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatPath(path) {
    const home = homedir();
    if (path.startsWith(home)) {
        return '~' + path.slice(home.length);
    }
    return path;
}

async function countTree(folder, prefix = []) {
    let files = 0;
    let folders = 0;
    const children = await folder.list();
    for (const child of children) {
        if (child.getContent) {
            files++;
        } else {
            folders++;
            const sub = await countTree(child, [...prefix, child.name]);
            files += sub.files;
            folders += sub.folders;
        }
    }
    return { files, folders };
}

export async function push(args) {
    let vectorId = args.vectorId;
    const chain = args.chain;

    const excludes = args.exclude
        ? args.exclude.split(',').map(s => s.trim())
        : undefined;
    const destPath = process.cwd();
    const fsFolder = new DoubleSyncFSFolder(destPath, excludes);

    const counts = await countTree(fsFolder);
    console.log('  scanning...', counts.files, 'files,', counts.folders, 'folders');

    if (args.manifest) {
        const manifest = await readManifest(destPath);
        const localFiles = await hashLocalTree(fsFolder);
        if (vectorId && manifest && manifest.vectorId === vectorId && manifest.files) {
            if (hashMapsEqual(localFiles, manifest.files)) {
                console.log('  no changes since last pull, nothing to push');
                return;
            }
        }
    }

    const wsc = await makeWalrusSealClient(args);
    const evParams = {
        suiClient: wsc.suiClient,
        packageId: chain,
        signAndExecuteTransaction: (tx) => wsc.signAndExecuteTransaction(tx),
        walrusClient: wsc.walrusClient,
        sealClient: wsc.sealClient,
        aggregatorUrl: wsc.aggregatorUrl,
        senderAddress: wsc.suiMaster.address,
        signer: wsc.suiMaster._keypair,
    };

    if (!vectorId) {
        console.log('creating new EndlessVector on', chain, '...');
        const ev = await EndlessVector.create(evParams);
        vectorId = ev.id;
        console.log('  created:', vectorId);
    }

    console.log('syncing ./ →', vectorId);

    const ev = new EndlessVector({ ...evParams, id: vectorId });

    const wdsync = new WDoubleSync({
        endlessVector: ev,
        compress: args.compress || 'gzip',
    });

    let existingVersions = 0;
    if (args.forceSnapshot) {
        // Bypass chain replay — chain may be corrupt. Force a full snapshot at the
        // current position so restore() can use it as a recovery point.
        console.log('  skipping chain replay — pushing full snapshot...');
        await ev.initialize();
        wdsync._isInitialized = true;
        wdsync._lastSnapshot = null;
        wdsync._replayedCount = ev.length;
    } else {
        await wdsync.initialize();
        existingVersions = await wdsync.length();

        if (vectorId && existingVersions > 0 && !args.manifest) {
            console.log('  comparing tree hashes...');
            const localHash = await localTreeHash(destPath);
            const remoteHash = await wdsync.getTreeHash(existingVersions);
            if (localHash && remoteHash.length === localHash.length &&
                localHash.every((b, i) => b === remoteHash[i])) {
                console.log('  no changes, nothing to push');
                return;
            }
        }
    }

    console.log('  building patch + pushing to chain...');
    const result = await wdsync.push(fsFolder);

    const patchType = args.forceSnapshot || existingVersions === 0 ? 'full snapshot' : 'diff';
    console.log('  version', result.version, 'pushed (' + patchType + ', gzip compressed)');
    console.log('  vector:', vectorId);

    if (args.manifest) {
        const localFiles = await hashLocalTree(fsFolder);
        await writeManifest(destPath, { vectorId, version: result.version, files: localFiles });
    }
}

export async function pull(args) {
    if (!args.vectorId) {
        throw new Error('vector-id is required for pull');
    }

    const wsc = await makeClientForRead(args);

    const evParams = {
        suiClient: wsc.suiClient,
        id: args.vectorId,
        packageId: args.chain,
        walrusClient: wsc.walrusClient,
        aggregatorUrl: wsc.aggregatorUrl,
    };
    if (wsc.sealClient && wsc.suiMaster) {
        evParams.sealClient = wsc.sealClient;
        evParams.signAndExecuteTransaction = (tx) => wsc.signAndExecuteTransaction(tx);
        evParams.senderAddress = wsc.suiMaster.address;
        evParams.signer = wsc.suiMaster._keypair;
    }

    const ev = new EndlessVector(evParams);

    const wdsync = new WDoubleSync({ endlessVector: ev });

    const version = args.version != null ? Number(args.version) : undefined;
    console.log('restoring', args.vectorId, version != null ? 'at version ' + version : '(latest)', '...');

    let folder;
    try {
        folder = await wdsync.restore(version);
    } catch (err) {
        if (err.message?.includes('sealClient not configured') || err.message?.includes('signer or sessionKey is required')) {
            throw new Error('This vector is Seal-encrypted. Provide --key or --phrase to decrypt.');
        }
        throw err;
    }

    const destPath = process.cwd();
    const oldFiles = await hashDiskTree(destPath);

    const { stats, newFiles } = await syncMemoryFolderToDisk(folder, destPath, oldFiles);

    if (args.manifest) {
        await ev.initialize();
        const pulledVersion = version ?? ev.length;
        await writeManifest(destPath, { vectorId: args.vectorId, version: pulledVersion, files: newFiles });
    }

    console.log(' ', stats.written, 'written,', stats.skipped, 'unchanged,',
                stats.deleted, 'deleted', '(' + formatBytes(stats.bytes) + ')');
}

export async function info(args) {
    if (!args.vectorId) {
        throw new Error('vector-id is required for info');
    }

    const wsc = await makeClientForRead(args);

    const evParams = {
        suiClient: wsc.suiClient,
        id: args.vectorId,
        packageId: args.chain,
        walrusClient: wsc.walrusClient,
        aggregatorUrl: wsc.aggregatorUrl,
    };
    if (wsc.sealClient && wsc.suiMaster) {
        evParams.sealClient = wsc.sealClient;
        evParams.signAndExecuteTransaction = (tx) => wsc.signAndExecuteTransaction(tx);
        evParams.senderAddress = wsc.suiMaster.address;
        evParams.signer = wsc.suiMaster._keypair;
    }

    const ev = new EndlessVector(evParams);

    await ev.initialize();

    const totalVersions = ev.length;

    console.log('EndlessVector:', args.vectorId);
    console.log('  chain:          ', args.chain);
    console.log('  versions:       ', totalVersions);
    console.log('  binary size:    ', formatBytes(ev.binaryLength));
    console.log('  history items:  ', ev.historyItemsCount);
    console.log('  archives:       ', ev.archiveItemsCount);

    const destPath = process.cwd();
    const localHash = await localTreeHash(destPath);

    if (!localHash) {
        console.log('\n  local folder:    empty (run pull to fetch)');
        return;
    }

    const localHex = Buffer.from(localHash).toString('hex').slice(0, 12);
    console.log('\n  local tree hash: ', localHex + '...');
    console.log('  detecting local version...');

    const wdsync = new WDoubleSync({ endlessVector: ev });
    let matchedVersion = null;

    for (let v = totalVersions; v >= 1; v--) {
        process.stdout.write('  checking version ' + v + '/' + totalVersions + '...          \r');
        let remoteHash;
        try {
            remoteHash = await wdsync.getTreeHash(v);
        } catch (err) {
            if (err.message?.includes('sealClient not configured')) {
                throw new Error('This vector is Seal-encrypted. Provide --key or --phrase to decrypt.');
            }
            throw err;
        }
        if (localHash.length === remoteHash.length && localHash.every((b, i) => b === remoteHash[i])) {
            matchedVersion = v;
            break;
        }
    }

    process.stdout.write('                                                \r');
    if (matchedVersion !== null) {
        console.log('  local matches:   version', matchedVersion, 'of', totalVersions);
        if (matchedVersion < totalVersions) {
            console.log('  behind by:      ', totalVersions - matchedVersion, 'version(s)');
        } else {
            console.log('  status:          up to date');
        }
    } else {
        console.log('  local matches:   no known version (local modifications?)');
        console.log('  latest remote:   version', totalVersions);
    }
}

function hashContent(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

async function readManifest(destPath) {
    try {
        const raw = await readFile(join(destPath, '.wdoublesync'), 'utf8');
        return JSON.parse(raw);
    } catch { return null; }
}

async function writeManifest(destPath, manifest) {
    await writeFile(join(destPath, '.wdoublesync'), JSON.stringify(manifest, null, 2));
}

const DISK_EXCLUDES = new Set(['.wdoublesync', '.git', '.DS_Store', 'node_modules']);

async function hashDiskTree(dirPath, prefix = []) {
    const files = {};
    let entries;
    try { entries = await readdir(dirPath, { withFileTypes: true }); } catch { return files; }
    for (const entry of entries) {
        if (DISK_EXCLUDES.has(entry.name) || entry.name.startsWith('.')) continue;
        const relParts = [...prefix, entry.name];
        const relPath = relParts.join('/');
        const fullPath = join(dirPath, entry.name);
        if (entry.isFile()) {
            const buf = await readFile(fullPath);
            files[relPath] = hashContent(buf);
        } else if (entry.isDirectory()) {
            Object.assign(files, await hashDiskTree(fullPath, relParts));
        }
    }
    return files;
}

async function localTreeHash(dirPath) {
    const fsFolder = new DoubleSyncFSFolder(dirPath);
    const children = await fsFolder.list();
    if (children.length === 0) return null;

    const sync = new DoubleSync();
    const store = new CDCStore();
    const snapshotBytes = await sync.buildSnapshot({ root: fsFolder, store });
    return new DoubleSyncSnapshot(snapshotBytes).treeHash;
}

async function syncMemoryFolderToDisk(folder, destPath, oldFiles) {
    const newFiles = {};
    const newDirs = new Set();
    const stats = { written: 0, skipped: 0, deleted: 0, folders: 0, bytes: 0 };

    await walkAndSync(folder, destPath, [], oldFiles, newFiles, newDirs, stats);

    if (oldFiles) {
        for (const relPath of Object.keys(oldFiles)) {
            if (!(relPath in newFiles)) {
                const absPath = join(destPath, ...relPath.split('/'));
                await rm(absPath, { force: true });
                stats.deleted++;
            }
        }
    }

    await removeStaleDirectories(destPath, newDirs);

    return { stats, newFiles };
}

function hashMapsEqual(a, b) {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k, i) => k === keysB[i] && a[k] === b[k]);
}

async function hashLocalTree(fsFolder, prefix = []) {
    const files = {};
    const children = await fsFolder.list();
    for (const child of children) {
        const relParts = [...prefix, child.name];
        const relPath = relParts.join('/');
        if (child.getContent) {
            const content = await child.getContent();
            files[relPath] = hashContent(content);
        } else {
            Object.assign(files, await hashLocalTree(child, relParts));
        }
    }
    return files;
}

async function walkAndSync(folder, destPath, prefix, oldFiles, newFiles, newDirs, stats) {
    const children = await folder.list();

    for (const child of children) {
        const relParts = [...prefix, child.name];
        const relPath = relParts.join('/');
        const absPath = join(destPath, child.name);

        if (child.getContent) {
            const content = await child.getContent();
            const hash = hashContent(content);
            newFiles[relPath] = hash;

            if (oldFiles && oldFiles[relPath] === hash) {
                stats.skipped++;
            } else {
                await writeFile(absPath, content);
                stats.written++;
                stats.bytes += content.length;
            }
        } else {
            await mkdir(absPath, { recursive: true });
            newDirs.add(relPath);
            stats.folders++;
            await walkAndSync(child, absPath, relParts, oldFiles, newFiles, newDirs, stats);
        }
    }
}

async function removeStaleDirectories(destPath, newDirs) {
    let entries;
    try { entries = await readdir(destPath, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (DISK_EXCLUDES.has(entry.name) || entry.name.startsWith('.')) continue;
        const fullPath = join(destPath, entry.name);
        if (!newDirs.has(entry.name)) {
            await rm(fullPath, { recursive: true, force: true });
        } else {
            await removeStaleSubdirs(fullPath, entry.name, newDirs);
        }
    }
}

async function removeStaleSubdirs(dirPath, prefix, newDirs) {
    let entries;
    try { entries = await readdir(dirPath, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const relPath = prefix + '/' + entry.name;
        const fullPath = join(dirPath, entry.name);
        if (!newDirs.has(relPath)) {
            await rm(fullPath, { recursive: true, force: true });
        } else {
            await removeStaleSubdirs(fullPath, relPath, newDirs);
        }
    }
}

export async function watch(args) {
    if (!args.vectorId) throw new Error('vector-id is required for watch');

    const cwd = process.cwd();
    const chain = args.chain;
    const debounceMs = args.debounce ?? 5000;
    const pollIntervalMs = (args.pollInterval ?? 2) * 1000;
    const pushEnabled = !args.pullOnly;
    const pullEnabled = !args.pushOnly;

    const excludes = args.exclude ? args.exclude.split(',').map(s => s.trim()) : undefined;

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
                dirty = true; // retry push after next pull
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
                // Unrestorable chain (e.g. corrupt patch). Skip past it so we don't
                // retry forever, and let the user pull manually to diagnose.
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

    // FS watcher
    const watcher = fsWatch(cwd, { recursive: true }, (eventType, filename) => {
        if (!pushEnabled) return;
        if (!filename) return;
        const base = filename.split('/')[0];
        if (DISK_EXCLUDES.has(base) || base.startsWith('.')) return;
        dirty = true;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(runPush, debounceMs);
    });

    // Poll interval
    const poller = setInterval(runPoll, pollIntervalMs);

    // Graceful shutdown
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

export async function rebate(args) {
    if (!args.vectorId) {
        throw new Error('vector-id is required for rebate');
    }

    const destPath = process.cwd();
    const excludes = args.exclude
        ? args.exclude.split(',').map(s => s.trim())
        : undefined;
    const fsFolder = new DoubleSyncFSFolder(destPath, excludes);

    const counts = await countTree(fsFolder);
    console.log('  scanning...', counts.files, 'files,', counts.folders, 'folders');

    const wsc = await makeWalrusSealClient(args);

    const evParams = {
        suiClient: wsc.suiClient,
        id: args.vectorId,
        packageId: args.chain,
        signAndExecuteTransaction: (tx) => wsc.signAndExecuteTransaction(tx),
        walrusClient: wsc.walrusClient,
        aggregatorUrl: wsc.aggregatorUrl,
        senderAddress: wsc.suiMaster.address,
        signer: wsc.suiMaster._keypair,
    };
    if (wsc.sealClient && wsc.suiMaster) {
        evParams.sealClient = wsc.sealClient;
    }

    const ev = new EndlessVector(evParams);
    await ev.initialize();

    const beforeHistoryItems = ev.historyItemsCount;
    const beforeArchiveItems = ev.archiveItemsCount;

    console.log('step 1: archiving history...');
    await ev.archive();
    console.log('  archived');

    console.log('step 2: burning archives...');
    await ev.burnArchive();
    console.log('  burned');

    console.log('step 3: pushing local state as fresh snapshot...');

    const wdsync = new WDoubleSync({
        endlessVector: ev,
        compress: args.compress || 'gzip',
    });

    // Force fresh snapshot by resetting internal state to prevent replay of broken diffs
    wdsync._senderStore = new CDCStore({ copyBytes: false });
    wdsync._receiverMirror = new CDCStore();
    wdsync._lastSnapshot = null;
    wdsync._replayedCount = 0;
    wdsync._isInitialized = false;

    const result = await wdsync.push(fsFolder);

    // Reinitialize to get fresh state and updated length
    ev.reInitialize();
    await ev.initialize();

    console.log('  pushed version', result.version);
    console.log('  [debug] after push: length=', ev.length, 'burned=', ev.burnedArchiveCount, 'version=', result.version);

    console.log('\nrebate complete:');
    console.log('  new version:', result.version);
    console.log('  new on-chain size:', formatBytes(ev.binaryLength));
}
