import { readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { DoubleSyncFolder } from '@fizzyflow/doublesync';
import { DoubleSyncFSFile } from './DoubleSyncFSFile.js';

const DEFAULT_EXCLUDES = ['node_modules', '.git', '.env', '.DS_Store', '.wdoublesync', 'pnpm-lock.yaml', 'package-lock.json'];

export class DoubleSyncFSFolder extends DoubleSyncFolder {
    constructor(dirPath, excludes = DEFAULT_EXCLUDES) {
        super();
        this._path = dirPath;
        this._name = basename(dirPath);
        this._excludes = excludes;
    }

    get name() { return this._name; }

    async list() {
        const entries = await readdir(this._path, { withFileTypes: true });
        const children = [];

        for (const entry of entries) {
            if (this._excludes.includes(entry.name)) continue;
            if (entry.name.startsWith('.')) continue;

            const fullPath = join(this._path, entry.name);

            if (entry.isDirectory()) {
                children.push(new DoubleSyncFSFolder(fullPath, this._excludes));
            } else if (entry.isFile()) {
                children.push(new DoubleSyncFSFile(fullPath));
            }
        }

        return children;
    }
}
