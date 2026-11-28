import { beforeEach, describe, expect, it } from 'vitest';
import { readPlaybackRate, savePlaybackRate } from '../playbackRate';

// jsdom's localStorage is partial on some Node versions; install a plain one.
beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    configurable: true,
    writable: true,
  });
});

describe('lesson playback rate', () => {
  it('defaults to 1x', () => {
    expect(readPlaybackRate()).toBe(1);
  });
  it('remembers a chosen speed', () => {
    savePlaybackRate(1.5);
    expect(readPlaybackRate()).toBe(1.5);
    savePlaybackRate(1);
    expect(readPlaybackRate()).toBe(1);
  });
  it('ignores nonsense', () => {
    savePlaybackRate(1.75);
    savePlaybackRate(0);
    savePlaybackRate(Number.NaN);
    savePlaybackRate(16);
    expect(readPlaybackRate()).toBe(1.75);
    window.localStorage.setItem('omnidex.learn.playbackRate', 'fast');
    expect(readPlaybackRate()).toBe(1);
  });
  it('falls back to 1x when storage throws', () => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('denied');
      },
      configurable: true,
    });
    expect(readPlaybackRate()).toBe(1);
    expect(() => savePlaybackRate(2)).not.toThrow();
  });
});
