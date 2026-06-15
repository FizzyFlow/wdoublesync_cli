import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { DoubleSyncFile } from '@fizzyflow/doublesync';

export class DoubleSyncFSFile extends DoubleSyncFile {
    constructor(filePath) {
        super();
        this._path = filePath;
        this._name = basename(filePath);
    }

    get name() { return this._name; }

    async getContent() {
        const buf = await readFile(this._path);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }

    async getSize() {
        const s = await stat(this._path);
        return s.size;
    }
}
