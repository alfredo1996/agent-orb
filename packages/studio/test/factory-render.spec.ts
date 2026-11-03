import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Asof, factoryReading, NeedsYou, PrSheet, type FactoryPr } from '../src/Factory.tsx';
import { Reading } from '../src/kit.tsx';

// The Factory page (v0.4 slice 1, #27; design/v0.4-factory.html, the Factory and Findings boards): Needs you lists each open PR with the first reason it isn't ready, or
// "Ready for your ok", and its findings open in a sheet. The studio has no DOM library, so the pieces are rendered to markup.
const plain = (html: string) => html.replace(/<\/?b>/g, '').replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const MIN = 60_000;
const NOW = Date.parse('2026-11-03T10:00:00Z');

const cond = (ok: boolean | null, note: string) => ({ ok, note });
const ALL_OK = { findings: cond(true, '11 fixed, 2 dismissed, none open'), gate: cond(true, 'orb-gate passed on a1b2c3d'), bots: cond(true, 'No unread bot comment since the last commit'), clean: cond(true, 'CLEAN') };
const FULL = [
  { id: 'F12', severity: 'major', file: 'src/auth/refresh.ts', fate: 'open' as const, title: 'Two refreshes can run at once' },
  { id: 'F14', severity: 'minor', file: 'src/auth/refresh.spec.ts', fate: 'open' as const, title: 'The retry test passes with the backoff removed' },
  { id: 'F09', severity: 'minor', file: 'src/net/client.ts', fate: 'dismissed' as const, title: 'Timeout value is not a constant', why: 'Used once, so no config' },
  { id: 'F03', severity: 'major', file: 'src/auth/refresh.ts', fate: 'fixed' as const, title: 'The token was written before the response was checked' },
];
const OFF = FULL.map(({ title: _t, why: _w, ...f }) => f); // Content off: id, severity, file and fate only

const P416: FactoryPr = {
  number: 416, head: 'fix/409-token-retry', headOid: 'e4f5a6b'.padEnd(40, '1'), ready: false, reason: '2 findings open: 1 major, 1 minor', dropped: 0, findings: FULL,
  conditions: { ...ALL_OK, findings: cond(false, '2 findings open: 1 major, 1 minor'), gate: cond(false, 'Lint failed') },
};
const P414: FactoryPr = {
  number: 414, head: 'feat/407-compress', headOid: 'c0d1e2f'.padEnd(40, '2'), ready: false, reason: 'E2E is running', dropped: 0, findings: [],
  conditions: { ...ALL_OK, findings: cond(true, 'Reported, none found'), gate: cond(null, 'E2E is running'), clean: cond(false, 'UNSTABLE: a check is not passing') },
};
const P418: FactoryPr = {
  number: 418, head: 'feat/412-queue', headOid: 'a1b2c3d'.padEnd(40, '3'), ready: true, reason: null, dropped: 0, conditions: ALL_OK,
  findings: [{ id: 'F2', severity: 'minor', file: 'q.ts', fate: 'dismissed', why: 'Covered by the queue test' }, { id: 'F1', severity: 'major', file: 'q.ts', fate: 'fixed' }],
};
const needs = (prs: FactoryPr[]) => renderToStaticMarkup(createElement(NeedsYou, { prs, onOpen: () => {} }));
const rows = (html: string) => html.split('<div class="need">').slice(1).map(plain);
const sheet = (pr: FactoryPr, readAt = NOW - 2 * MIN) => renderToStaticMarkup(createElement(PrSheet, { pr, readAt, now: NOW, sheet: false, onClose: () => {} }));

describe('Needs you', () => {
  it('one row per open PR, in the order given: its state, the first reason it is not ready, or "Ready for your ok"', () => {
    expect(rows(needs([P416, P414, P418]))).toEqual([
      'Open findings PR #416 fix/409-token-retry 2 findings open: 1 major, 1 minor · 1 dismissed: read it before merging 2 open See findings',
      'Not known PR #414 feat/407-compress E2E is running c0d1e2f See checks',
      'Ready PR #418 feat/412-queue Ready for your ok · 1 dismissed: read it before merging a1b2c3d See checks',
    ]);
    expect(needs([P416, P414, P418])).toContain('<span class="state stalled">Open findings</span>');
    expect(needs([P416, P414, P418])).toContain('<span class="state waiting">Not known</span>');
    expect(needs([P416, P414, P418])).toContain('<span class="state working">Ready</span>');
  });

  it('the state is the first condition that does not hold, as the reason is: a definite no that is not a finding is Blocked', () => {
    const p = { ...P414, reason: 'UNSTABLE: a check is not passing', conditions: { ...ALL_OK, clean: cond(false, 'UNSTABLE: a check is not passing') } };
    expect(rows(needs([p]))[0]).toBe('Blocked PR #414 feat/407-compress UNSTABLE: a check is not passing c0d1e2f See checks');
  });

  it('a PR that was ready when GitHub was last read, and is old now, is Not known, with the server\'s reason', () => {
    const was = { ...P418, ready: false, reason: 'Was ready when GitHub was last read, 47 min ago' };
    expect(rows(needs([was]))[0]).toBe('Not known PR #418 feat/412-queue Was ready when GitHub was last read, 47 min ago · 1 dismissed: read it before merging a1b2c3d See checks');
    expect(plain(sheet(was))).toContain('PR #418 Not known');
  });

  it('nothing open says "Nothing needs you." and the card stays', () => {
    expect(plain(needs([]))).toBe('Needs you Nothing needs you.');
  });

  it('says the same with Content off: the band holds no title or reason', () => {
    expect(rows(needs([{ ...P416, findings: OFF }]))[0]).toBe(rows(needs([P416]))[0]);
  });
});

describe('how old the GitHub data is', () => {
  const asof = (readAt: number | null) => renderToStaticMarkup(createElement(Asof, { readAt, now: NOW }));
  it('in minutes; past 10 minutes it says why it is old', () => {
    expect(plain(asof(NOW - 2 * MIN))).toBe('GitHub data 2 min old');
    expect(asof(NOW - 2 * MIN)).not.toContain('stale');
    expect(plain(asof(NOW - 47 * MIN))).toBe('GitHub data 47 min old: it updates while a session runs in this repo');
    expect(asof(NOW - 47 * MIN)).toContain('class="asof stale"');
    expect(plain(asof(NOW - 3 * 60 * MIN))).toBe('GitHub data 3 h old: it updates while a session runs in this repo');
    expect(plain(asof(null))).toBe('No GitHub data yet: the plugin reads it while a session runs in this repo, with gh logged in');
  });
});

describe('the findings sheet', () => {
  it('Can it merge?: the four conditions, each held, failed or not known, with its note, the data\'s age and the head', () => {
    const h = sheet(P416);
    expect(plain(h.slice(h.indexOf('Can it merge?'), h.indexOf('Findings</h4>')))).toBe([
      'Can it merge?', '✗ No finding is open 2 findings open: 1 major, 1 minor', '✗ The gate passed on this head Lint failed',
      '✓ No bot comment is newer than the last commit No unread bot comment since the last commit', '✓ Merge state is CLEAN CLEAN', 'GitHub data 2 min old · head e4f5a6b',
    ].join(' '));
    expect(sheet(P414)).toContain('<li class="unk"><span class="mk" aria-hidden="true">?</span>');
  });

  it('with Content full: Open, then Dismissed with why, then Fixed folded; each finding its id, severity, file and title', () => {
    const h = sheet(P416);
    const f = plain(h.slice(h.indexOf('Findings</h4>')));
    expect(f).toBe([
      'Findings', 'Open (2)', 'F12 major src/auth/refresh.ts Two refreshes can run at once', 'F14 minor src/auth/refresh.spec.ts The retry test passes with the backoff removed',
      'Dismissed: read these before merging (1)', 'F09 minor src/net/client.ts Timeout value is not a constant Why dismissed: Used once, so no config',
      'Fixed (1)', 'F03 major src/auth/refresh.ts The token was written before the response was checked',
    ].join(' '));
    expect(h).toMatch(/<details class="fgroup"><summary>Fixed \(1\)<\/summary>/); // closed: read the dismissed ones first
  });

  it('with Content off: id, severity, file and fate only, and each title says it needs Content on full', () => {
    const h = sheet({ ...P416, findings: OFF });
    expect(h).not.toMatch(/Two refreshes|Timeout value|Used once|Why dismissed/);
    expect(h.match(/Title needs Content on full/g)).toHaveLength(4);
    expect(plain(h)).toContain('F09 minor src/net/client.ts Title needs Content on full');
  });

  it('a PR whose agents reported no findings says so instead of an empty list; a dropped line is named', () => {
    const unreported = { ...P414, reason: 'No findings reported yet', conditions: { ...P414.conditions, findings: cond(null, 'No findings reported yet') } };
    expect(plain(sheet(unreported))).toContain('No orb-findings block has reached this PR\'s branch yet, so ready can\'t be proved.');
    expect(plain(sheet(P414))).toContain('Reported, none found.');
    expect(plain(sheet({ ...P418, dropped: 1 }))).toContain('1 line of the last report didn\'t parse: ask the reviewer to report it again.');
  });
});

describe('the reading', () => {
  const said = (prs: FactoryPr[], readAt: number | null = NOW) => plain(renderToStaticMarkup(createElement(Reading, { said: factoryReading({ project: 'mobile-app', readAt, prs }) }))).replace(/ Written from.*$/, '');
  it('counts what is ready and what is not, from the PRs below it', () => {
    expect(said([P416, P414, P418])).toBe('1 PR is ready for your ok, 2 aren\'t: 1 PR with open findings.');
    expect(said([P418, { ...P418, number: 419 }])).toBe('2 PRs are ready for your ok.');
    expect(said([P414])).toBe('0 PRs are ready for your ok, 1 isn\'t.');
    expect(said([])).toBe('No open PR in mobile-app.');
    expect(said([], null)).toBe('Nothing read from GitHub for mobile-app.');
  });
});
