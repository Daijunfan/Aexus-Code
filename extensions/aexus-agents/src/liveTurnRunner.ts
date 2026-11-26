/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import type { ExternalCancellationToken } from './turnCoordinator.ts';

export type LiveTurnChunk<TPart = unknown> =
	| { readonly kind: 'markdown'; readonly text: string }
	| { readonly kind: 'progress'; readonly text: string }
	| { readonly kind: 'thinking'; readonly text: string; readonly id: string }
	| { readonly kind: 'part'; readonly part: TPart };

export class LiveTurnRunner<TPart = unknown> {
	readonly requestId: string;
	readonly requestPrompt: string;
	readonly startedAt: number;
	readonly bufferedParts: LiveTurnChunk<TPart>[] = [];

	private readonly subscribers = new Set<(chunk: LiveTurnChunk<TPart>) => void>();
	private _settled = false;
	private _interrupted = false;
	private _interruptPromise?: Promise<void>;
	private _settlementError?: Error;
	private readonly onInterrupt?: () => Promise<void> | void;
	private readonly donePromise: Promise<void>;
	private resolveDone!: () => void;
	private rejectDone!: (err: Error) => void;

	constructor(
		requestPrompt: string,
		startedAt = Date.now(),
		onInterrupt?: () => Promise<void> | void,
	) {
		this.requestId = randomUUID();
		this.requestPrompt = requestPrompt;
		this.startedAt = startedAt;
		this.onInterrupt = onInterrupt;
		this.donePromise = new Promise<void>((resolve, reject) => {
			this.resolveDone = resolve;
			this.rejectDone = reject;
		});
		void this.donePromise.catch(() => { /* Prevent unhandled rejection when zero UI attaches */ });
	}

	get settled(): boolean {
		return this._settled;
	}

	get interrupted(): boolean {
		return this._interrupted;
	}

	get settlementError(): Error | undefined {
		return this._settlementError;
	}

	/**
	 * Aborts the underlying background CLI turn when the user explicitly clicks UI Stop
	 * (`$interruptChatSessionActiveResponse`), as opposed to closing the editor tab (`$disposeChatSessionContent`).
	 */
	async interrupt(): Promise<void> {
		this._interrupted = true;
		if (!this._interruptPromise) {
			this._interruptPromise = Promise.resolve()
				.then(() => this.onInterrupt?.())
				.catch(() => undefined)
				.finally(() => {
					this.complete();
				});
		}
		await this._interruptPromise;
	}

	push(chunk: LiveTurnChunk<TPart>): void {
		if (this._settled) {
			return;
		}
		this.bufferedParts.push(chunk);
		for (const sub of this.subscribers) {
			try { sub(chunk); } catch { /* ignore subscriber error */ }
		}
	}

	complete(): void {
		if (this._settled) {
			return;
		}
		this._settled = true;
		this.resolveDone();
	}

	fail(error: Error): void {
		if (this._settled) {
			return;
		}
		this._settled = true;
		this._settlementError = error;
		this.rejectDone(error);
	}

	async attach(
		replayFn: (chunk: LiveTurnChunk<TPart>) => void,
		token: ExternalCancellationToken,
		options?: { readonly interruptOnCancel?: boolean },
	): Promise<void> {
		const initialCount = this.bufferedParts.length;
		for (let i = 0; i < initialCount; i++) {
			if (token.isCancellationRequested) {
				if (options?.interruptOnCancel) {
					await this.interrupt();
				}
				return;
			}
			replayFn(this.bufferedParts[i]);
		}
		if (this._settled || token.isCancellationRequested) {
			if (token.isCancellationRequested && options?.interruptOnCancel) {
				await this.interrupt();
				return;
			}
			if (this._settlementError && !token.isCancellationRequested) {
				throw this._settlementError;
			}
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const onChunk = (chunk: LiveTurnChunk<TPart>) => {
				if (!token.isCancellationRequested) {
					replayFn(chunk);
				}
			};
			this.subscribers.add(onChunk);
			const cancelSub = token.onCancellationRequested(() => {
				cleanup();
				if (options?.interruptOnCancel) {
					void this.interrupt().finally(() => resolve());
				} else {
					resolve();
				}
			});
			const cleanup = () => {
				this.subscribers.delete(onChunk);
				cancelSub.dispose();
			};
			this.donePromise.then(
				() => {
					cleanup();
					resolve();
				},
				err => {
					cleanup();
					if (token.isCancellationRequested) {
						resolve();
					} else {
						reject(err);
					}
				},
			);
		});
	}
}
