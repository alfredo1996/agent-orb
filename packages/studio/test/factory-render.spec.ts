import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Asof, PrSheet, PrsCard, type FactoryPr } from '../src/Factory.tsx';

// The Factory page (v0.4 slice 1, #27; design/v0.4-factory.html, the Factory and Findings boards): each open PR's first reason it isn't ready, or "Ready for your ok", and its findings in a sheet;
// the PRs that close no issue have a card of their own (#90). The studio has no DOM library, so the pieces are rendered to markup.
const plain = (html: string) => html.replace(/<\/?b>/g, '').replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const MIN = 60_000;
const NOW = Date.parse('2026-11-03T10:00:00Z');

const cond = (ok: boolean | null, note: string) => ({ ok, note });
const ALL_OK = { findings: cond(true, '11 fixed, 2 dismissed, none open'), gate: cond(true, 'Test run passed on a1b2c3d'), bots: cond(true, 'No unread bot comment since the last commit'), clean: cond(true, 'CLEAN') };
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
const sheet = (pr: FactoryPr, readAt = NOW - 2 * MIN) => renderToStaticMarkup(createElement(PrSheet, { pr, readAt, now: NOW, sheet: false, onClose: () => {} }));

describe('Other open PRs (#90)', () => {
  const none = (p: FactoryPr): FactoryPr => ({ ...p, issue: null });
  const card = (prs: FactoryPr[]) => renderToStaticMarkup(createElement(PrsCard, { prs, onOpen: () => {} }));

  it('is not drawn when no open PR is without an issue', () => {
    expect(card([])).toBe('');
  });

  it('one line a PR: "PR #n" and its branch, a button that opens the PR\'s sheet, and its state as the page has always said it', () => {
    const html = card([none(P416), none(P418)]);
    expect(html.match(/<button type="button" class="fx-pr">/g)).toHaveLength(2);
    expect(html).not.toContain('href="#/issue');
    expect([...html.matchAll(/<button type="button" class="fx-pr">(.*?)<\/button>/g)].map((m) => plain(m[1]!))).toEqual(['PR #416 fix/409-token-retry Open findings', 'PR #418 feat/412-queue Ready']);
    expect(html).toContain('<span class="state stalled">Open findings</span>');
    expect(html).toContain('<span class="state working">Ready</span>');
    expect(plain(html)).toContain('Other open PRs 2 open');
    expect(plain(html)).not.toContain("No review reports on these");
  });

  it('a PR that closes an issue not on the board says which, and its milestone when the board read knows it (F1)', () => {
    const mine = (p: FactoryPr, n: number): FactoryPr => ({ ...p, issue: n });
    const board = { issues: [{ number: 125, milestone: 'v0.7 Share', outside: true, stage: 'building' as const, pr: null, ready: null, reason: null, sessions: [], sessionCount: 0 }] };
    const html = renderToStaticMarkup(createElement(PrsCard, { prs: [mine(P418, 125), mine(P416, 999), none(P414)], board, onOpen: () => {} }));
    expect([...html.matchAll(/<button type="button" class="fx-pr">(.*?)<\/button>/g)].map((m) => plain(m[1]!))).toEqual(['PR #418 feat/412-queue closes #125, v0.7 Share Ready', 'PR #416 fix/409-token-retry closes #999 Open findings', 'PR #414 feat/407-compress Not known']);
    expect(renderToStaticMarkup(createElement(PrsCard, { prs: [mine(P418, 125)], onOpen: () => {} }))).toContain('<small>closes #125</small>'); // with no board read, no milestone is guessed
  });

  it('a ready PR says Ready here too, and is counted in the card\'s heading', () => {
    expect(card([none(P418)])).toContain('<span class="state working">Ready</span>');
    expect(card([none(P418)])).toContain('id="fprs-h"');
  });

  it('with no review reported on any of them it says so once, and the rows carry no state', () => {
    const html = card([none({ ...P414, conditions: { ...ALL_OK, findings: cond(null, 'No review report') } }), none({ ...P418, ready: false, conditions: { ...ALL_OK, findings: cond(null, 'No review report') } })]);
    expect(html).not.toContain('class="state');
    expect(html.match(/No review reports on these, so agent-orb can&#x27;t say they&#x27;re ready\./g)).toHaveLength(1);
  });

  it('one PR with findings reported keeps every row\'s state, and the single line is left out', () => {
    const html = card([none(P416), none({ ...P414, conditions: { ...ALL_OK, findings: cond(null, 'No review report') } })]);
    expect(html.match(/class="state/g)).toHaveLength(2);
    expect(plain(html)).not.toContain('No review reports on these');
  });

  it('a PR that was ready when GitHub was last read, and is old now, is Not known in its sheet', () => {
    const was = { ...P418, ready: false, reason: 'Was ready when GitHub was last read, 47 min ago' };
    expect(plain(sheet(was))).toContain('PR #418 Not known');
    expect(plain(sheet(none(P414)))).toContain('Can it merge? ✓ No finding is open Reported, none found');
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
    expect(plain(sheet({ ...P418, dropped: 1 }))).toContain('1 line of the last report didn\'t parse: ask the reviewer to report it again, with a finding it has not listed before (a report that only confirms fixes cannot clear it).');
  });
});
