import { describe, expect, it } from 'vitest';
import { costAtMost, decide, digestText, monthStart, Report, REPORT_SCHEMA, type DigestData } from '../src/analysis-core.ts';

// Slice 7 (§15 2026-10-21): the estimate, the cap and the digest Claude reads, all before any call. Pure: no API, no store.
describe('costAtMost', () => {
  it('prices the counted input and the whole output allowance at list prices', () => {
    expect(costAtMost('claude-opus-5-5', 84_312, 16_000)).toBeCloseTo(84_312 * 4e-6 + 16_000 * 20e-6, 9);
    expect(costAtMost('claude-sonnet-5-5', 84_312, 16_000)).toBeCloseTo(0.3286, 4);
  });
  it('uses Haiku 5.5\'s higher price above 100k input', () => {
    expect(costAtMost('claude-haiku-5-5', 182_000, 8_200)).toBeCloseTo(182_000 * 0.5e-6 + 8_200 * 2.5e-6, 9);
    expect(costAtMost('claude-haiku-5-5', 90_000, 8_200)).toBeCloseTo(90_000 * 0.1e-6 + 8_200 * 0.5e-6, 9);
  });
  it('refuses a model with no price rather than guessing one', () => {
    expect(() => costAtMost('claude-unknown-9', 10, 10)).toThrow(/no price/);
  });
});

describe('decide (the monthly cap)', () => {
  it('allows a run only if the month stays within the cap even when all output is used', () => {
    expect(decide(1.05, 0.33, 20)).toEqual({ allowed: true, after: 1.38 });
    expect(decide(19.8, 0.33, 20)).toEqual({ allowed: false, after: 20.13 });
    expect(decide(19.67, 0.33, 20).allowed).toBe(true); // exactly at the cap is within it
  });
});

describe('monthStart', () => {
  it('is the first instant of the UTC month', () => {
    expect(new Date(monthStart(Date.UTC(2026, 9, 21, 13, 5))).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});

const data = (o: Partial<DigestData> = {}): DigestData => ({
  project: 'agent-orb', from: Date.UTC(2026, 9, 14), to: Date.UTC(2026, 9, 21), content: 'full',
  sessions: { count: 31, byModel: [{ model: 'claude-opus-5-5', tokens: 14_000_000, cost: 40 }, { model: 'claude-sonnet-5-5', tokens: 4_100_000, cost: 6 }] },
  topSessions: [{ id: 'b738da', started_at: Date.UTC(2026, 9, 21), tokens: 13_100_000, agents: 9 }],
  agents: [{ type: 'main', count: 31, tokens: 14_000_000, cost: 40, calls: 900, failed: 12 }],
  skills: { ran: [{ name: 'code', source: 'projectSettings', runs: 14, tokens: 2_400_000, how: { you: 14, model: 0, agent: 0, preload: 0 } }], idle: [{ name: 'commit', source: 'projectSettings', tokens: 28 }] },
  tools: [{ tool: 'Bash', calls: 1200, failed: 40, errors: ['exit 1'] }],
  failures: [{ ts: Date.UTC(2026, 9, 20), agent: 'implementer', tool: 'Bash', error: 'exit 1', input: 'pnpm test', output: 'ingest.test.ts: expected 34, got 35' }],
  thinking: { steps: 500, withText: 0 },
  ...o,
});

describe('digestText', () => {
  it('says what the week was, with the numbers Claude needs', () => {
    const t = digestText(data());
    for (const s of ['agent-orb', '2026-10-14', '31 sessions', 'claude-opus-5-5', '/code', 'commit', 'Bash', 'ingest.test.ts', 'thinking: 0 of 500 steps carry text']) expect(t).toContain(s);
  });
  it('stays bounded however large the week: long lists are cut with a count of the rest', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ ts: i, agent: 'a', tool: 'Bash', error: 'exit 1', input: 'x'.repeat(5_000), output: 'y'.repeat(5_000) }));
    const t = digestText(data({ failures: many }));
    expect(t).toContain('+460 more failures not shown');
    expect(t.length).toBeLessThan(120_000);
  });
});

describe('the report', () => {
  it('accepts a report in the schema and rejects one missing its changes', () => {
    const ok = { summary: 's', sections: [{ title: 't', body: 'b', evidence: ['e'] }], changes: [{ title: 'c', why: 'w', saving: '≈ 1k tok' }] };
    expect(Report.parse(ok)).toEqual(ok);
    expect(Report.safeParse({ summary: 's', sections: [] }).success).toBe(false);
    expect(REPORT_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false, required: ['summary', 'sections', 'changes'] });
  });
});
