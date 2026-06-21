import EndlessVector from '@fizzyflow/endless-vector';
import { WDoubleSync } from '@fizzyflow/wdoublesync';
import { CDCStore } from '@fizzyflow/doublesync';
import { DoubleSyncFSFolder } from '../DoubleSyncFSFolder.js';
import {
    makeWalrusSealClient,
    resolvePath,
    makeExcludes,
    countTree,
    localTreeHash,
    readManifest,
    writeManifest,
    hashLocalTree,
    hashMapsEqual,
} from './shared.js';

export async function push(args) {
    let vectorId = args.vectorId;
    const chain = args.chain;

    const destPath = resolvePath(args.path);
    const fsFolder = new DoubleSyncFSFolder(destPath, makeExcludes(args));

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
