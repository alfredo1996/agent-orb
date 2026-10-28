import { describe, expect, it } from 'vitest';
import { modelOption } from '../src/analysis-format.ts';

// The model select (design/pages.html, Analysis): "Opus 5.5 · $4 / $20", input / output dollars per million tokens.
// The server sends the price of 1k tokens; the select shows a million, whole dollars without cents.
const model = (label: string, input: number, output: number) => ({ label, costPer1k: { input, output } });

describe('modelOption', () => {
  it('whole dollars drop the cents, anything else keeps two decimals', () => {
    expect(modelOption(model('Opus 5.5', 0.004, 0.02))).toBe('Opus 5.5 · $4 / $20');
    expect(modelOption(model('Haiku 5.5', 0.0001, 0.0005))).toBe('Haiku 5.5 · $0.10 / $0.50');
    expect(modelOption(model('Mid 1', 0.0025, 0.0125))).toBe('Mid 1 · $2.50 / $12.50');
  });

  it('a price that carries float noise still reads as the whole dollar it is', () => {
    expect(modelOption(model('Sonnet 5.5', 0.0030000000000000005, 0.015))).toBe('Sonnet 5.5 · $3 / $15');
  });

  it('uses the label as given, input first and output second', () => {
    expect(modelOption(model('x', 0.001, 0.005))).toBe('x · $1 / $5');
  });
});
