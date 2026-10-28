import { describe, expect, it } from 'vitest';
import { ago, contextMeter, duration, modelLabel, plural, stateLabel, tokens, usd } from '../src/format.ts';

describe('Live view formats (as in design/live.html)', () => {
  it('tokens: compact in the session header (412k, 86.4k), one decimal in rows (198.0k)', () => {
    expect(tokens(412_000)).toBe('412k');
    expect(tokens(86_400)).toBe('86.4k');
    expect(tokens(198_049, true)).toBe('198.0k');
    expect(tokens(950)).toBe('950');
    expect(tokens(1_234_567)).toBe('1.2M');
  });

  it('cost: dollars to the cent, exact zero as $0.00, under a cent as <$0.01, a floor (≥) when some model is unpriced', () => {
    expect(usd(0)).toBe('$0.00');
    expect(usd(1.384)).toBe('$1.38');
    expect(usd(0.01)).toBe('$0.01');
    expect(usd(0.004)).toBe('<$0.01');
    expect(usd(0.71, true)).toBe('≥ $0.71');
    expect(usd(0.004, true)).toBe('≥ $0.00');
  });

  it('plural: one is singular, zero and the rest are not', () => {
    expect([plural(1, 'day'), plural(0, 'day'), plural(5, 'file')]).toEqual(['1 day', '0 days', '5 files']);
  });

  it('durations and ages', () => {
    expect(duration(42_000)).toBe('42s');
    expect(duration(252_000)).toBe('4m 12s');
    expect(duration(2 * 3_600_000 + 60_000)).toBe('2h 01m');
    expect(ago(2_000)).toBe('2s ago');
    expect(ago(16 * 60_000)).toBe('16m ago');
  });

  it('models: family badge, unknown as given', () => {
    expect(modelLabel('claude-opus-5-5')).toEqual({ text: 'Opus 5.5', tone: 'opus' });
    expect(modelLabel('claude-haiku-5-5-20260901')).toEqual({ text: 'Haiku 5.5', tone: 'haiku' });
    expect(modelLabel('claude-sonnet-5-5[1m]')).toEqual({ text: 'Sonnet 5.5', tone: 'sonnet' });
    expect(modelLabel('gpt-x')).toEqual({ text: 'gpt-x', tone: '' });
    expect(modelLabel(undefined)).toEqual({ text: '—', tone: '' });
  });

  it('state: both waits read "waiting for you", a pricier model its own words, every other state as it is', () => {
    expect(stateLabel('waiting')).toBe('waiting for you');
    expect(stateLabel('model')).toBe('pricier model');
    for (const s of ['working', 'stalled', 'done', 'error']) expect(stateLabel(s)).toBe(s);
  });

  it('context meter: unknown stays unknown; the percent rounds first, then amber from 80%; the fill never passes the track', () => {
    expect(contextMeter(undefined)).toBeUndefined();
    expect(contextMeter(41.4)).toEqual({ percent: 41, fill: 41, near: false });
    expect(contextMeter(79.4)).toMatchObject({ percent: 79, near: false });
    expect(contextMeter(79.6)).toMatchObject({ percent: 80, near: true });
    expect(contextMeter(112)).toEqual({ percent: 112, fill: 100, near: true });
  });
});
