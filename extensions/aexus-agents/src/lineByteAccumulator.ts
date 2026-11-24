/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * O(N) byte-accurate newline (`0x0a`) framing accumulator for JSONL agent stdio streams.
 *
 * Unlike `carry = Buffer.concat([carry, chunk])` (which copies the entire accumulated prefix on
 * every 64 KiB pipe chunk, causing multi-GB transient allocations on multi-MB tool outputs),
 * `LineByteAccumulator` scans only the newly arrived chunk and concatenates once per completed line,
 * while tracking exact raw byte lengths (including `\n`) for seamless SSH `tail -c +<offset>` reattach.
 */
export class LineByteAccumulator {
	private chunks: Buffer[] = [];
	private bufferedBytes = 0;
	private discardingOversizedLine = false;
	private discardedBytes = 0;
	private readonly maxLineBytes: number;

	constructor(maxLineBytes = 64 * 1024 * 1024) {
		this.maxLineBytes = Math.max(16, maxLineBytes);
	}

	get pendingBytes(): number {
		return this.bufferedBytes + this.discardedBytes;
	}

	reset(): void {
		this.chunks = [];
		this.bufferedBytes = 0;
		this.discardingOversizedLine = false;
		this.discardedBytes = 0;
	}

	push(
		chunk: Buffer | string,
		onLine: (line: string, rawByteLengthWithNewline: number) => void,
		onOversizedDrop?: (rawByteLengthWithNewline: number) => void,
	): void {
		const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
		if (buf.length === 0) {
			return;
		}

		let cursor = 0;
		while (cursor < buf.length) {
			const nlIdx = buf.indexOf(0x0a, cursor);
			if (nlIdx < 0) {
				const rem = buf.subarray(cursor);
				if (this.discardingOversizedLine) {
					this.discardedBytes += rem.length;
				} else if (this.bufferedBytes + rem.length > this.maxLineBytes) {
					this.discardedBytes = this.bufferedBytes + rem.length;
					this.chunks = [];
					this.bufferedBytes = 0;
					this.discardingOversizedLine = true;
				} else {
					this.chunks.push(rem);
					this.bufferedBytes += rem.length;
				}
				return;
			}

			const seg = buf.subarray(cursor, nlIdx);
			cursor = nlIdx + 1;

			if (this.discardingOversizedLine) {
				const totalBytes = this.discardedBytes + seg.length + 1;
				this.discardingOversizedLine = false;
				this.discardedBytes = 0;
				onOversizedDrop?.(totalBytes);
				continue;
			}

			const totalLineBytesWithNl = this.bufferedBytes + seg.length + 1;
			if (this.bufferedBytes + seg.length > this.maxLineBytes) {
				this.chunks = [];
				this.bufferedBytes = 0;
				onOversizedDrop?.(totalLineBytesWithNl);
				continue;
			}

			let lineBuf: Buffer;
			if (this.chunks.length === 0) {
				lineBuf = seg;
			} else {
				if (seg.length > 0) {
					this.chunks.push(seg);
				}
				lineBuf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.bufferedBytes + seg.length);
				this.chunks = [];
				this.bufferedBytes = 0;
			}

			const endIdx = lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d
				? lineBuf.length - 1
				: lineBuf.length;
			const cleanLine = endIdx > 0 ? lineBuf.subarray(0, endIdx).toString('utf8') : '';
			onLine(cleanLine, totalLineBytesWithNl);
		}
	}

	flushTail(
		onLine: (line: string, rawByteLength: number) => void,
		onOversizedDrop?: (rawByteLength: number) => void,
	): void {
		if (this.discardingOversizedLine) {
			const dropped = this.discardedBytes;
			this.reset();
			if (dropped > 0) {
				onOversizedDrop?.(dropped);
			}
			return;
		}
		if (this.bufferedBytes === 0 || this.chunks.length === 0) {
			this.reset();
			return;
		}
		const totalBytes = this.bufferedBytes;
		const lineBuf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, totalBytes);
		this.reset();
		const endIdx = lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d
			? lineBuf.length - 1
			: lineBuf.length;
		const cleanLine = endIdx > 0 ? lineBuf.subarray(0, endIdx).toString('utf8') : '';
		onLine(cleanLine, totalBytes);
	}
}
