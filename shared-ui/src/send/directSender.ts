// Phone-side sending (the `direct` send mode). One instance per signed-in
// user: wires Node's result events into the outbox + mirror pipeline once,
// and runs at most ONE batch at a time — the Node sender would interleave two
// concurrent batches and break pacing, so the WebView serializes them.
import type { NativeBridge, OutboxBatch, SendResultEvent, LocalStore } from '../types.js';
import { OutboxManager, type MirrorFn } from './outboxManager.js';
import { confirmAndSend, wireSendResultHandling, type MediaResolver } from './sendFlow.js';
import type { BuiltQueue } from './queueBuilder.js';

export type BatchEvent = { type: 'started'; batch: OutboxBatch } | { type: 'result'; index: number; result: SendResultEvent } | { type: 'done' };

export class SenderBusyError extends Error {
  code = 'SENDER_BUSY';
  constructor() {
    super('Another message is still being sent from this phone. Try again when it finishes.');
    this.name = 'SenderBusyError';
  }
}

export interface DirectSenderDeps {
  userId: string;
  storage: LocalStore;
  nativeBridge: Pick<NativeBridge, 'sendBatch' | 'onSendResult' | 'onBatchDone'>;
  mirror: MirrorFn;
  mediaResolver?: MediaResolver;
  now?: () => number;
}

interface ActiveBatch {
  batchId: string;
  rowIndex: Map<number, number> | null;
  early: SendResultEvent[];
  listeners: Set<(e: BatchEvent) => void>;
  done: boolean;
  doneWaiters: (() => void)[];
}

export class DirectSender {
  readonly outboxManager: OutboxManager;
  private active: ActiveBatch | null = null;
  private busyListeners = new Set<(busy: boolean) => void>();
  private offs: (() => void)[] = [];

  constructor(private readonly deps: DirectSenderDeps) {
    this.outboxManager = new OutboxManager(deps.storage, deps.mirror);
  }

  /** Wire result handling and flush mirrors left over from earlier runs. Returns a stop function. */
  start(): () => void {
    this.offs.push(wireSendResultHandling(this.deps.nativeBridge, this.outboxManager, () => ({ userId: this.deps.userId, batchId: this.active?.batchId ?? '' })));
    this.offs.push(this.deps.nativeBridge.onSendResult((evt) => this.onResult(evt)));
    this.offs.push(this.deps.nativeBridge.onBatchDone((evt) => this.onDone(evt.batchId)));
    this.outboxManager.retryUnmirrored(this.deps.userId).catch(() => {});
    return () => this.stop();
  }

  stop(): void {
    this.offs.forEach((off) => off());
    this.offs = [];
  }

  get busy(): boolean {
    return this.active !== null && !this.active.done;
  }

  onBusyChange(cb: (busy: boolean) => void): () => void {
    this.busyListeners.add(cb);
    return () => this.busyListeners.delete(cb);
  }

  /**
   * Durably enqueue and hand a batch to Node. Rejects with SenderBusyError
   * while another batch is running. `listener` receives per-recipient results
   * (index into queue.items) and completion.
   */
  async send(orgId: string, batchId: string, queue: BuiltQueue, listener?: (e: BatchEvent) => void): Promise<OutboxBatch> {
    if (this.busy) throw new SenderBusyError();
    const active: ActiveBatch = { batchId, rowIndex: null, early: [], listeners: new Set(listener ? [listener] : []), done: false, doneWaiters: [] };
    this.active = active;
    this.emitBusy();
    try {
      const batch = await confirmAndSend(
        { nativeBridge: this.deps.nativeBridge, outboxManager: this.outboxManager, mediaResolver: this.deps.mediaResolver, now: this.deps.now },
        this.deps.userId,
        orgId,
        batchId,
        queue,
      );
      active.rowIndex = new Map(batch.items.map((item, idx) => [item.id, idx]));
      this.emit(active, { type: 'started', batch });
      const early = active.early;
      active.early = [];
      for (const evt of early) this.onResult(evt);
      if (active.done) this.emit(active, { type: 'done' });
      return batch;
    } catch (err) {
      if (this.active === active) this.active = null;
      this.finish(active);
      throw err;
    }
  }

  /** Resolves when the batch with this id has finished (immediately if it isn't the active one). */
  waitForDone(batchId: string): Promise<void> {
    const a = this.active;
    if (!a || a.batchId !== batchId || a.done) return Promise.resolve();
    return new Promise((resolve) => a.doneWaiters.push(resolve));
  }

  private onResult(evt: SendResultEvent): void {
    const a = this.active;
    if (!a) return;
    if (!a.rowIndex) {
      a.early.push(evt);
      return;
    }
    const index = a.rowIndex.get(evt.id);
    if (index !== undefined) this.emit(a, { type: 'result', index, result: evt });
  }

  private onDone(batchId: string): void {
    const a = this.active;
    if (!a || a.batchId !== batchId) return;
    a.done = true;
    if (a.rowIndex) this.emit(a, { type: 'done' });
    this.finish(a);
  }

  private finish(a: ActiveBatch): void {
    a.done = true;
    a.doneWaiters.splice(0).forEach((w) => w());
    this.emitBusy();
  }

  private emit(a: ActiveBatch, e: BatchEvent): void {
    a.listeners.forEach((l) => l(e));
  }

  private emitBusy(): void {
    const busy = this.busy;
    this.busyListeners.forEach((l) => l(busy));
  }
}
