import { WalrusClient, WalrusFile } from '@mysten/walrus';
import { SealClient, SessionKey } from '@mysten/seal';
import { SuiGrpcClient, GrpcWebFetchTransport } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { fromHex } from '@mysten/sui/utils';

class WalrusSealClient {
	/** @type {SuiGrpcClient} */
	suiClient;
	/** @type {import('suidouble').SuiMaster | null} */
	suiMaster;
	/** @type {WalrusClient} */
	walrusClient;
	/** @type {SealClient | null} */
	sealClient;
	/** @type {'mainnet' | 'testnet' | 'localnet'} */
	network;

	config;

	constructor(params) {
		const network = params.network || 'localnet';
		if (['mainnet', 'testnet', 'localnet'].indexOf(network) == -1) {
			throw new Error('Invalid network specified: ' + network + '. Must be one of mainnet, testnet, or localnet.');
		}
		this.network = network;
		this.suiMaster = params.suiMaster || null;
		/** @type {import('./LocalnodeWalrusTestServer.js').default | null} */
		this._localnetServer = params.localnetServer ?? null;
	}

	async initialize() {
        const baseUrls = {
            mainnet: 'https://fullnode.mainnet.sui.io:443',
            testnet: 'https://fullnode.testnet.sui.io:443',
            devnet: 'https://fullnode.devnet.sui.io:443',
            localnet: 'http://127.0.0.1:9000',
        };

		if (this._localnetServer) {
			// Derive everything from the running LocalnodeWalrusTestServer —
			// no HTTP fetch needed.
			const server = this._localnetServer;
			const state = server.state;
			const walrusPackageId = state.walrusPackageId;

			this.suiMaster ??= state._suiMaster;
			this.suiClient = state._suiMaster.client;

			this.config = {
				walrus: {
					packageId:      walrusPackageId,
					systemObjectId: state.systemId,
					stakingPoolId:  state.stakingId,
					walCoinType:    `${walrusPackageId}::wal::WAL`,
					testTreasuryId: state.testTreasuryId,
					uploadRelayUrl: server.url,
					aggregatorUrl:  server.url,
				},
			};

			this.walrusClient = new WalrusClient({
				network: this.network,
				suiClient: this.suiClient,
				wasmUrl: 'https://unpkg.com/@mysten/walrus-wasm@0.2.2/web/walrus_wasm_bg.wasm',
				uploadRelay: { host: server.url, sendTip: null },
				packageConfig: {
					systemObjectId: state.systemId,
					stakingPoolId:  state.stakingId,
				},
			});

			if (server.seal) {
				this.config.seal = {
					serverObjectId: server.seal.serviceObjectId,
					serviceUrl:     server.url,
				};
				this.sealClient = new SealClient({
					suiClient: this.suiClient,
					serverConfigs: [{ objectId: server.seal.serviceObjectId, weight: 1 }],
					verifyKeyServers: true,
				});
			}
			return;
		}

		this.suiClient = new SuiGrpcClient({
			network: this.network,
			transport: (new GrpcWebFetchTransport({ baseUrl: baseUrls[this.network] }))
		});

		const uploadRelayOptions = {
			// https://upload-relay.mainnet.walrus.space/v1/tip-config
			host: 'https://upload-relay.mainnet.walrus.space',
			sendTip: {
				address: "0x765a6ff2c13b47e2603416d0b5a156df498a5c51bc8085be3838e43e06086256",
				kind: {
					linear: {
						base: 0,
						perEncodedKib: 40
					}
				}
			},
		};
		if (this.network == 'testnet') {
			// https://upload-relay.testnet.walrus.space/v1/tip-config
			uploadRelayOptions.host = 'https://upload-relay.testnet.walrus.space';
			uploadRelayOptions.sendTip.address = '0x4b6a7439159cf10533147fc3d678cf10b714f2bc998f6cb1f1b0b9594cdc52b6';
			uploadRelayOptions.sendTip.kind.const = 105;
			delete uploadRelayOptions.sendTip.kind.linear;
		}

		if (this.network === 'localnet') {
			// fetch config from Localnet Walrus + Seal — HTTP mock for prototyping and tests
			const serverConfig = await fetch(`http://localhost:8099/v1/localnet-config`);
			if (!serverConfig.ok) {
				throw new Error('Failed to fetch localnet config from test server: ' + serverConfig.statusText);
			}
			const { walrus, seal } = await serverConfig.json();
			this.config = { walrus, seal };
			// override upload relay URL for local testing with LocalnodeWalrusTestServer
			uploadRelayOptions.host = walrus.uploadRelayUrl;
			uploadRelayOptions.sendTip = null;

			this.walrusClient = new WalrusClient({
				network: this.network,
				suiClient: this.suiClient,
				wasmUrl: 'https://unpkg.com/@mysten/walrus-wasm@0.2.2/web/walrus_wasm_bg.wasm',
				uploadRelay: {
					host: walrus.uploadRelayUrl,
					sendTip: null,
				},
				packageConfig: {
					systemObjectId: walrus.systemObjectId,
					stakingPoolId: walrus.stakingPoolId,
				},
			});
			this.sealClient = new SealClient({
				suiClient: this.suiClient,
				serverConfigs: [
					{ objectId: seal.serverObjectId, weight: 1 },
				],
				verifyKeyServers: true,
			});
		} else {
			this.walrusClient = new WalrusClient({
				network: this.network,
				suiClient: this.suiClient,
				wasmUrl: 'https://unpkg.com/@mysten/walrus-wasm@0.2.2/web/walrus_wasm_bg.wasm',
				uploadRelay: uploadRelayOptions,
			});

			const sealKeyServers = {
				testnet: [
					{ objectId: '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75', weight: 1 },
					{ objectId: '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8', weight: 1 },
				],
				mainnet: [
					{ 
					  objectId: '0x686098f1439237fff9f36b99c7329683c22979d2005c2465cb891acb012a7595', 
						weight: 1,
						aggregatorUrl: "https://seal-aggregator-mainnet.mystenlabs.com",
					},
				],
			};

			if (!sealKeyServers[this.network]) {
				throw new Error('Seal key servers not configured for network: ' + this.network);
			}

			this.sealClient = new SealClient({
				suiClient: this.suiClient,
				serverConfigs: sealKeyServers[this.network],
				verifyKeyServers: true,
			});
		}

	}

	get aggregatorUrl() {
		if (this.config?.walrus?.aggregatorUrl) return this.config.walrus.aggregatorUrl;
		const urls = {
			mainnet: 'https://aggregator.walrus-mainnet.walrus.space',
			testnet: 'https://aggregator.walrus-testnet.walrus.space',
		};
		return urls[this.network] || null;
	}

	/**
	 * Calculate the predicted WAL cost to store `size` unencoded bytes for `epochs` epochs.
	 *
	 * Delegates to WalrusClient.storageCost which queries current on-chain prices.
	 *
	 * @param {number} size   - unencoded blob size in bytes
	 * @param {number} epochs
	 * @returns {Promise<{ storageCost: bigint, writeCost: bigint, totalCost: bigint }>} costs in FROST (1 WAL = 1e9 FROST)
	 */
	async storageCost(size, epochs) {
		return this.walrusClient.storageCost(size, epochs);
	}

	/**
	 * Seal-encrypt a key scoped to a blob object ID.
	 *
	 * @param {Uint8Array|string} key - raw AES key as Uint8Array or base64 string
	 * @param {string} objectId      - blob object ID (0x…)
	 * @param {string} packageId     - Seal policy package ID
	 * @returns {Promise<string>} base64-encoded encrypted key
	 */
	async encryptSealKey(key, objectId, packageId) {
		const keyBytes = typeof key === 'string' ? Uint8Array.from(atob(key), c => c.charCodeAt(0)) : key;
		const blobAddrHex = objectId.replace(/^0x/, '').padStart(64, '0');
		const { encryptedObject } = await this.sealClient.encrypt({
			threshold: 1,
			packageId,
			id: blobAddrHex,
			data: keyBytes,
		});
		return btoa(String.fromCharCode(...encryptedObject));
	}

	/**
	 * Decrypt a Seal-encrypted AES key for a blob object.
	 *
	 * Builds the seal_approve_blob_owner tx, creates a SessionKey, and calls sealClient.decrypt.
	 *
	 * @param {Uint8Array|string} encryptedKey - encrypted key as Uint8Array or base64 string
	 * @param {string} objectId               - blob object ID (0x…)
	 * @param {string} packageId              - Seal/Walrus package ID
	 * @returns {Promise<Uint8Array>} recovered AES key bytes
	 */
	async decryptSealKey(encryptedKey, objectId, packageId) {
		const encryptedBytes = typeof encryptedKey === 'string'
			? Uint8Array.from(atob(encryptedKey), c => c.charCodeAt(0))
			: encryptedKey;
		const walletAddress = this.suiMaster.address;
		const blobAddrHex = objectId.replace(/^0x/, '').padStart(64, '0');

		const tx = new Transaction();
		tx.moveCall({
			target: `${packageId}::blob_owner::seal_approve_blob_owner`,
			arguments: [
				tx.pure.vector('u8', Array.from(fromHex(blobAddrHex))),
				tx.object(objectId),
			],
		});
		const txBytes = await tx.build({ client: this.suiClient, onlyTransactionKind: true });

		const sessionKey = await this.createSessionKey(packageId);
		return this.sealClient.decrypt({ data: encryptedBytes, sessionKey, txBytes });
	}

	/**
	 * Create a SessionKey for the given packageId, signed via suiMaster (keypair or browser wallet).
	 *
	 * @param {string} packageId
	 * @returns {Promise<SessionKey>}
	 */
	async createSessionKey(packageId) {
		const walletAddress = this.suiMaster.address;
		const sessionKey = await SessionKey.create({
			address: walletAddress,
			packageId,
			ttlMin: 5,
			suiClient: this.suiClient,
		});
		const personalMessage = sessionKey.getPersonalMessage();
		let sig;
		if (this.suiMaster._keypair?.signPersonalMessage) {
			({ signature: sig } = await this.suiMaster._keypair.signPersonalMessage(personalMessage));
		} else {
			({ signature: sig } = await this.suiMaster._signer.activeAdapter.signPersonalMessage({ message: personalMessage }));
		}
		await sessionKey.setPersonalMessageSignature(sig);
		return sessionKey;
	}

	/**
	 * Upload multiple files as a single Walrus quilt blob.
	 *
	 * @param {Array<{ name: string, data: Uint8Array }>} files
	 * @param {{ epochs?: number, deletable?: boolean, attributes?: Record<string, string> }} [options]
	 * @returns {Promise<{ quiltBlobId: string, quiltBlobObjectId: string, files: Array<{ name: string, patchId: string }> }>}
	 */
	async writeQuilt(files, { epochs = 3, deletable = false, attributes } = {}) {
		const owner = this.suiMaster.address;
		if (!owner) throw new Error('suiMaster has no connected address');

		const walrusFiles = files.map(({ name, data }) =>
			WalrusFile.from({ contents: data, identifier: name })
		);

		const flow = this.walrusClient.writeFilesFlow({ files: walrusFiles });
		await flow.encode();

		const registerTx = flow.register({ epochs, owner, deletable, attributes });
		const digest = await this.signAndExecuteTransaction(registerTx);
		if (!digest) throw new Error('Register transaction returned no digest');
		await flow.upload({ digest });

		const certifyTx = flow.certify();
		await this.signAndExecuteTransaction(certifyTx);

		const patches = await flow.listFiles();

		// encodeQuilt sorts blobs alphabetically by identifier, so patches come back
		// in sorted order — not the caller's original order. Build a stable sort map
		// to assign each patchId back to its original-order file.
		const sortedOrder = files
			.map(({ name }, i) => ({ name, i }))
			.sort((a, b) => a.name < b.name ? -1 : 1);
		const patchByOriginalIdx = new Array(files.length);
		sortedOrder.forEach(({ i }, sortedPos) => {
			patchByOriginalIdx[i] = patches[sortedPos].id;
		});

		return {
			quiltBlobId: patches[0]?.blobId ?? null,
			quiltBlobObjectId: patches[0]?.blobObject?.id ?? null,
			files: files.map(({ name }, i) => ({ name, patchId: patchByOriginalIdx[i] })),
		};
	}

	/**
	 * Sign and execute a Transaction via suiMaster (pre-builds to bytes first so
	 * the browser wallet never has to resolve CoinWithBalance itself).
	 *
	 * @param {import('@mysten/sui/transactions').Transaction} tx
	 * @returns {Promise<string>} transaction digest
	 */
	async signAndExecuteTransaction(tx) {
		tx.setSenderIfNotSet(this.suiMaster.address);
		await tx.build({ client: this.suiClient });
		const results = await this.suiMaster.signAndExecuteTransaction({ transaction: tx });
		return results?.Transaction?.digest ?? results?.digest;
	}

	/**
	 * Upload a blob to Walrus using the step-by-step flow (encode → register → upload → certify).
	 * Each on-chain step is signed via suiMaster so browser wallets work correctly.
	 *
	 * @param {Uint8Array} data
	 * @param {{ epochs?: number, deletable?: boolean, attributes?: Record<string, string> }} [options]
	 * @returns {Promise<{ blobId: string, blobObjectId: string }>}
	 */
	async writeBlob(data, { epochs = 3, deletable = false, attributes } = {}) {
		const owner = this.suiMaster.address;
		if (!owner) throw new Error('suiMaster has no connected address');

		const flow = this.walrusClient.writeBlobFlow({ blob: data });
		await flow.encode();

		// Register: builds a Transaction, we sign+execute it, then upload shards.
		const registerTx = flow.register({ epochs, owner, deletable });
		const digest = await this.signAndExecuteTransaction(registerTx);
		if (!digest) throw new Error('Register transaction returned no digest');
		await flow.upload({ digest });

		// Certify: builds a Transaction, we sign+execute it to finalise on-chain.
		const certifyTx = flow.certify();
		await this.signAndExecuteTransaction(certifyTx);

		const blob = await flow.getBlob();

		if (attributes && Object.keys(attributes).length) {
			const attrTx = await this.walrusClient.writeBlobAttributesTransaction({
				blobObjectId: blob.blobObjectId,
				attributes,
			});
			await this.signAndExecuteTransaction(attrTx);
		}

		return { blobId: blob.blobId, blobObjectId: blob.blobObjectId };
	}
}

export default WalrusSealClient;
