import EndlessVector from '@fizzyflow/endless-vector';
import { WDoubleSync } from '@fizzyflow/wdoublesync';
import { CDCStore } from '@fizzyflow/doublesync';
import { DoubleSyncFSFolder } from '../DoubleSyncFSFolder.js';
import {
    makeWalrusSealClient,
    resolvePath,
    makeExcludes,
    formatBytes,
    countTree,
} from './shared.js';

export async function rebate(args) {
    if (!args.vectorId) {
        throw new Error('vector-id is required for rebate');
    }

    const destPath = resolvePath(args.path);
    const fsFolder = new DoubleSyncFSFolder(destPath, makeExcludes(args));

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

    console.log('step 1: archiving history...');
    await ev.archive();
    console.log('  archived');

    console.log('step 2: burning archives...');
    await ev.burnArchive();
    console.log('  burned');

    // archive() and burnArchive() both call ev.reInitialize() — refetch fresh state
    await ev.initialize();

    console.log('step 3: pushing local state as fresh snapshot...');

    const wdsync = new WDoubleSync({
        endlessVector: ev,
        compress: args.compress || 'gzip',
    });

    // Skip wdsync.initialize() replay entirely: rebate always pushes a full snapshot,
    // so there's no need to replay the existing (now partly burned) chain.
    // _lastSnapshot = null forces a full snapshot; _isInitialized = true bypasses replay.
    wdsync._senderStore = new CDCStore({ copyBytes: false });
    wdsync._receiverMirror = new CDCStore();
    wdsync._lastSnapshot = null;
    wdsync._replayedCount = ev.length;
    wdsync._isInitialized = true;

    const result = await wdsync.push(fsFolder);

    ev.reInitialize();
    await ev.initialize();

    console.log('  pushed version', result.version);
    console.log('  [debug] after push: length=', ev.length, 'burned=', ev.burnedArchiveCount, 'version=', result.version);

    console.log('\nrebate complete:');
    console.log('  new version:', result.version);
    console.log('  new on-chain size:', formatBytes(ev.binaryLength));
}
