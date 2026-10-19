// One Gemini call over one port, with the port faked: every way a call can end must end it
// exactly once, including the background dropping the connection without a done or an error.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExplainToBackground, ExplainToContent } from '@/messaging/types';
import {
  CALL_IDLE_TIMEOUT_MS,
  CONNECTION_LOST_MESSAGE,
  NO_TEXT_MESSAGE,
  TIMEOUT_MESSAGE,
  startExplainCall,
  type CallHandlers,
  type CallPort,
} from './explainCall';

/** An ExplainToContent message whose requestId is optional (defaults to this call's). */
type Incoming = ExplainToContent extends infer M ? (M extends { requestId: string } ? Omit<M, 'requestId'> & { requestId?: string } : never) : never;

class FakePort implements CallPort {
  posted: ExplainToBackground[] = [];
  disconnected = false;
  private messageListeners: ((message: unknown) => void)[] = [];
  private disconnectListeners: (() => void)[] = [];

  postMessage(message: ExplainToBackground): void {
    this.posted.push(message);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  onMessage = { addListener: (listener: (message: unknown) => void) => void this.messageListeners.push(listener) };
  onDisconnect = { addListener: (listener: () => void) => void this.disconnectListeners.push(listener) };

  /** A message from the background, for this call's request unless another id is given. */
  emit(message: Incoming): void {
    const full = { requestId: this.posted[0]!.requestId, ...message };
    for (const listener of this.messageListeners) listener(full);
  }
  /** The background end closing (worker stopped, extension reloaded). */
  drop(): void {
    for (const listener of this.disconnectListeners) listener();
  }
}

function recorder() {
  const calls: string[] = [];
  const handlers: CallHandlers = {
    onChunk: (text) => calls.push(`chunk:${text}`),
    onDone: (text) => calls.push(`done:${text}`),
    onError: (message) => calls.push(`error:${message}`),
  };
  return { calls, handlers };
}

function start(): { port: FakePort; calls: string[]; call: ReturnType<typeof startExplainCall> } {
  const port = new FakePort();
  const { calls, handlers } = recorder();
  const call = startExplainCall(() => port, 'the prompt', handlers);
  return { port, calls, call };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startExplainCall', () => {
  it('posts one explain-request with the prompt', () => {
    const { port } = start();
    expect(port.posted).toHaveLength(1);
    expect(port.posted[0]!.type).toBe('explain-request');
    expect(port.posted[0]!.prompt).toBe('the prompt');
    expect(port.posted[0]!.requestId).not.toBe('');
  });

  it('forwards chunks and finishes with the whole text', () => {
    const { port, calls } = start();
    port.emit({ type: 'explain-chunk', text: 'a' });
    port.emit({ type: 'explain-chunk', text: 'b' });
    port.emit({ type: 'explain-done' });
    expect(calls).toEqual(['chunk:a', 'chunk:b', 'done:ab']);
  });

  it('a dropped connection before done is an error, once', () => {
    const { port, calls } = start();
    port.emit({ type: 'explain-chunk', text: 'a' });
    port.drop();
    port.emit({ type: 'explain-done' });
    port.drop();
    expect(calls).toEqual(['chunk:a', `error:${CONNECTION_LOST_MESSAGE}`]);
  });

  it('a drop after done is ignored', () => {
    const { port, calls } = start();
    port.emit({ type: 'explain-chunk', text: 'a' });
    port.emit({ type: 'explain-done' });
    port.drop();
    expect(calls).toEqual(['chunk:a', 'done:a']);
  });

  it('ignores messages for another request', () => {
    const { port, calls } = start();
    port.emit({ type: 'explain-chunk', text: 'x', requestId: 'other' });
    port.emit({ type: 'explain-done', requestId: 'other' });
    expect(calls).toEqual([]);
  });

  it('done with no text is an error', () => {
    const { port, calls } = start();
    port.emit({ type: 'explain-done' });
    expect(calls).toEqual([`error:${NO_TEXT_MESSAGE}`]);
  });

  it('an error from the background is forwarded, and nothing after it', () => {
    const { port, calls } = start();
    port.emit({ type: 'explain-error', message: 'quota exceeded' });
    port.drop();
    port.emit({ type: 'explain-chunk', text: 'late' });
    expect(calls).toEqual(['error:quota exceeded']);
  });

  it('silence for the idle timeout is an error and disconnects', () => {
    const { port, calls } = start();
    vi.advanceTimersByTime(CALL_IDLE_TIMEOUT_MS);
    expect(calls).toEqual([`error:${TIMEOUT_MESSAGE}`]);
    expect(port.disconnected).toBe(true);
    port.drop();
    expect(calls).toHaveLength(1);
  });

  it('each message resets the idle timer', () => {
    const { port, calls } = start();
    vi.advanceTimersByTime(59_000);
    port.emit({ type: 'explain-chunk', text: 'a' });
    vi.advanceTimersByTime(1_000);
    expect(calls).toEqual(['chunk:a']);
    vi.advanceTimersByTime(59_000);
    expect(calls).toEqual(['chunk:a', `error:${TIMEOUT_MESSAGE}`]);
  });

  it('cancel disconnects and silences everything', () => {
    const { port, calls, call } = start();
    call.cancel();
    expect(port.disconnected).toBe(true);
    port.drop();
    port.emit({ type: 'explain-chunk', text: 'a' });
    port.emit({ type: 'explain-done' });
    vi.advanceTimersByTime(120_000);
    expect(calls).toEqual([]);
  });

  it('cancel after done still closes the port and calls nothing', () => {
    const { port, calls, call } = start();
    port.emit({ type: 'explain-chunk', text: 'a' });
    port.emit({ type: 'explain-done' });
    call.cancel();
    expect(port.disconnected).toBe(true);
    expect(calls).toEqual(['chunk:a', 'done:a']);
  });

  it('a throwing connect throws', () => {
    const { handlers } = recorder();
    expect(() =>
      startExplainCall(
        () => {
          throw new Error('Extension context invalidated.');
        },
        'p',
        handlers,
      ),
    ).toThrow('Extension context invalidated.');
  });
});
