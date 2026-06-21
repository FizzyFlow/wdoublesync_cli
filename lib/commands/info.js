import EndlessVector from '@fizzyflow/endless-vector';
import { WDoubleSync } from '@fizzyflow/wdoublesync';
import {
    makeClientForRead,
    resolvePath,
    formatBytes,
    localTreeHash,
} from './shared.js';

export async function info(args) {
    const wsc = await makeClientForRead(args);

    console.log('wdoublesync');
    console.log('  chain:          ', args.chain);
    console.log('  your wallet:    ', wsc.suiMaster?.address || '(none)');

    if (!args.vectorId) {
        return;
    }

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

    console.log('\nEndlessVector:', args.vectorId);

    let owner = '(unknown)';
    if (wsc.suiMaster) {
        try {
            const obj = await wsc.suiMaster.getObject(args.vectorId);
            if (obj?._owner) {
                const ownerData = obj._owner;
                if (typeof ownerData === 'string') {
                    owner = ownerData;
                } else if (ownerData.AddressOwner) {
                    owner = ownerData.AddressOwner;
                } else if (ownerData.ObjectOwner) {
                    owner = ownerData.ObjectOwner;
                }
            }
        } catch (err) {
            // silently fail, owner stays unknown
        }
    }

    console.log('  owner:          ', owner);
    console.log('  encrypted:      ', ev.sealEncryptedKey ? 'yes (Seal)' : 'no');
    console.log('  versions:       ', totalVersions);
    console.log('  binary size:    ', formatBytes(ev.binaryLength));
    console.log('  history items:  ', ev.historyItemsCount);
    console.log('  archives:       ', ev.archiveItemsCount);

    const destPath = resolvePath(args.path);
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
