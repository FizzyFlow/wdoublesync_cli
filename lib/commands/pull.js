import EndlessVector from '@fizzyflow/endless-vector';
import { WDoubleSync } from '@fizzyflow/wdoublesync';
import {
    makeClientForRead,
    resolvePath,
    formatBytes,
    hashDiskTree,
    syncMemoryFolderToDisk,
    writeManifest,
} from './shared.js';

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

    const destPath = resolvePath(args.path);
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
