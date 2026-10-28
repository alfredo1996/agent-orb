import { expect } from 'vitest';

// Reads the figures out of rendered markup (#102): each `<div class="fig">` as its label, value, usual line (none when the figure says nothing), its explanation and whether the
// ⓘ has it open. Text is decoded the way a person would read it.
const decode = (s: string) => s.replace(/<[^>]*>/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export type Fig = { label: string; value: string; usual?: string; why: string; open: boolean; bad: boolean; id: string };

export const figs = (html: string): Fig[] =>
  [...html.matchAll(/<div class="fig"><span class="k">(.*?)<button type="button" class="info" aria-expanded="(true|false)" aria-controls="([^"]*)"[^>]*>i<\/button><\/span><span class="v( neg)?">(.*?)<\/span>(?:<span class="d">(.*?)<\/span>)?<p class="why" id="([^"]*)"( hidden="")?>(.*?)<\/p><\/div>/gs)]
    .map((m) => {
      expect(m[3]).toBe(m[7]); // the ⓘ controls the paragraph that follows it
      return { label: decode(m[1]!), value: decode(m[5]!), usual: m[6] === undefined ? undefined : decode(m[6]), why: decode(m[9]!), open: m[2] === 'true' && !m[8], bad: !!m[4], id: m[3]! };
    });
