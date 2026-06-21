import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

import { SuiMaster } from 'suidouble';
import { DoubleSync, CDCStore, DoubleSyncSnapshot } from '@fizzyflow/doublesync';
import WalrusSealClient from '../WalrusSealClient.js';
import { DoubleSyncFSFolder } from '../DoubleSyncFSFolder.js';

const DEFAULT_FS_EXCLUDES = ['node_modules', '.git', '.env', '.DS_Store', '.wdoublesync', '.claude', 'pnpm-lock.yaml', 'package-lock.json'];

export function makeExcludes(args) {
    if (!args.exclude) return undefined;
    const extra = args.exclude.split(',').map(s => s.trim());
    return [...DEFAULT_FS_EXCLUDES, ...extra];
}

export function resolvePath(p) {
    if (p.startsWith('~')) return join(homedir(), p.slice(1));
    return resolve(p);
}

export function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function formatPath(path) {
    const home = homedir();
    if (path.startsWith(home)) {
        return '~' + path.slice(home.length);
    }
    return path;
}

export async function makeWalrusSealClient(args) {
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

export async function makeReadOnlyWalrusSealClient(chain) {
    const client = new WalrusSealClient({ network: chain });
    await client.initialize();
    return client;
}

export async function makeClientForRead(args) {
    const key = args.key || process.env.WDOUBLESYNC_KEY;
    if (key || args.phrase) {
        return makeWalrusSealClient(args);
    }
    return makeReadOnlyWalrusSealClient(args.chain);
}

export async function countTree(folder) {
    let files = 0;
    let folders = 0;
    const children = await folder.list();
    for (const child of children) {
        if (child.getContent) {
            files++;
        } else {
            folders++;
            const sub = await countTree(child);
            files += sub.files;
            folders += sub.folders;
        }
    }
    return { files, folders };
}

export function hashContent(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

export async function readManifest(destPath) {
    try {
        const raw = await readFile(join(destPath, '.wdoublesync'), 'utf8');
        return JSON.parse(raw);
    } catch { return null; }
}

export async function writeManifest(destPath, manifest) {
    await writeFile(join(destPath, '.wdoublesync'), JSON.stringify(manifest, null, 2));
}

export const DISK_EXCLUDES = new Set(['.wdoublesync', '.git', '.DS_Store', 'node_modules']);

export async function hashDiskTree(dirPath, prefix = []) {
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

export async function localTreeHash(dirPath) {
    const fsFolder = new DoubleSyncFSFolder(dirPath);
    const children = await fsFolder.list();
    if (children.length === 0) return null;

    const sync = new DoubleSync();
    const store = new CDCStore();
    const snapshotBytes = await sync.buildSnapshot({ root: fsFolder, store });
    return new DoubleSyncSnapshot(snapshotBytes).treeHash;
}

export async function syncMemoryFolderToDisk(folder, destPath, oldFiles) {
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

export function hashMapsEqual(a, b) {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k, i) => k === keysB[i] && a[k] === b[k]);
}

export async function hashLocalTree(fsFolder, prefix = []) {
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
