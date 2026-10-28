import { describe, expect, it } from 'vitest';
import { costUsd } from '../src/cost.ts';

// Expected values worked by hand from the price table (USD per MTok).
describe('costUsd', () => {
  it('prices all four token counts (Opus 5.5: $4 in, $20 out, $0.20 read, $5 write)', () => {
    // 1000*4 + 2000*20 + 10000*0.2 + 4000*5 = 66,000 µ$
    expect(costUsd('claude-opus-5-5', { input: 1000, output: 2000, cache_read: 10_000, cache_creation: 4000 })).toBeCloseTo(0.066, 12);
  });

  it('is null for an unknown model', () => {
    expect(costUsd('claude-opus-9', { input: 1, output: 1, cache_read: 0, cache_creation: 0 })).toBeNull();
    expect(costUsd('gpt-5', { input: 1, output: 1, cache_read: 0, cache_creation: 0 })).toBeNull();
  });

  it('matches dated snapshot ids and the [1m] suffix to their model', () => {
    expect(costUsd('claude-haiku-4-5-20251001', { input: 1_000_000, output: 0, cache_read: 0, cache_creation: 0 })).toBe(1);
    expect(costUsd('claude-opus-5-5[1m]', { input: 1_000_000, output: 0, cache_read: 0, cache_creation: 0 })).toBe(4);
  });

  it('switches Haiku 5.5 to the long-prompt prices only above 100,000 prompt tokens', () => {
    // at 100,000: 50000*0.1 + 1000*0.5 + 50000*0.01 = 6,000 µ$
    expect(costUsd('claude-haiku-5-5', { input: 50_000, output: 1000, cache_read: 50_000, cache_creation: 0 })).toBeCloseTo(0.006, 12);
    // at 100,001: 50000*0.5 + 1000*2.5 + 50001*0.05 = 30,000.05 µ$
    expect(costUsd('claude-haiku-5-5', { input: 50_000, output: 1000, cache_read: 50_001, cache_creation: 0 })).toBeCloseTo(0.03000005, 12);
  });
});
