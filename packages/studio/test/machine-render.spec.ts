import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { idleText, leftRunning, MachineBand, memText, NeedsYou, type IssueCost, type MachineData, type MachineGroup, type MachineHost } from '../src/Factory.tsx';

// The Machine band and the "Left running" rows of Needs you (v0.4 slice 3, #29; design/v0.4-factory.html): the Mac's free memory, what its containers use, and one row per group of
// containers with its flags. Nothing here removes a container. The studio has no DOM library, so the pieces are rendered to markup.
const plain = (html: string) => html.replace(/<\/?b>/g, '').replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const MIN = 60_000;
const HOUR = 60 * MIN;
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const NOW = Date.parse('2026-11-05T12:00:00Z');

const group = (over: Partial<MachineGroup> = {}): MachineGroup => ({
  kind: 'compose', name: 'mobile-app', project: 'mobile-app', compose: 'mobile-app', containers: 3, memory: 3.1 * GiB, unhealthy: 0, leftRunning: false, idleMs: 4 * MIN, ...over,
});
const host = (over: Partial<MachineHost> = {}): MachineHost => ({
  host: 'studio-mac', at: NOW - 4 * MIN, ageMs: 4 * MIN, docker: 'ok', memFree: 6.2 * GiB, memTotal: 36 * GiB, containers: 12, memory: 7.4 * GiB,
  groups: [
    group({ kind: 'testcontainers', name: 'field-notes', project: 'field-notes', compose: null, memory: 1.2 * GiB, leftRunning: true, idleMs: 2 * HOUR }),
    group({ kind: 'compose', name: 'billing', project: null, compose: 'billing', containers: 1, memory: 1.9 * GiB, unhealthy: 1, idleMs: null }),
    group(),
    group({ kind: 'none', name: 'No project', project: null, compose: null, containers: 4, memory: 1.1 * GiB, idleMs: null }),
  ], ...over,
});
const band = (h: MachineHost, now = NOW) => renderToStaticMarkup(createElement(MachineBand, { host: h, now }));

describe('how sizes and quiet times read', () => {
  it('sizes are the Mac\'s: 1024s, one decimal under 10 GB', () => {
    expect([6.2 * GiB, 36 * GiB, 9.9 * GiB, 9.96 * GiB, 92 * MiB, 1.2 * GiB, 512, 0].map(memText)).toEqual(['6.2 GB', '36 GB', '9.9 GB', '10 GB', '92 MB', '1.2 GB', '1 KB', '0 KB']);
  });

  it('a quiet time is minutes under an hour, hours under two days, then days', () => {
    expect([59 * MIN, HOUR, 2 * HOUR + 40 * MIN, 47 * HOUR, 48 * HOUR, 80 * HOUR].map(idleText)).toEqual(['59 min', '1 h', '2 h', '47 h', '2 days', '3 days']);
  });
});

describe('the Machine band', () => {
  it('free memory of the total, how many containers run and what they use, then one row per group with its count and memory', () => {
    const t = plain(band(host()));
    expect(t).toContain('Machine studio-mac · read 4 min ago');
    expect(t).toContain('Free memory 6.2 GB of 36 GB');
    expect(t).toContain('Containers 12 running');
    expect(t).toContain('They use 7.4 GB by docker stats');
    expect(t).toContain('Project Containers Memory');
    expect(t).toContain('field-notes Left running Testcontainers, no session for 2 h 3 1.2 GB');
    expect(t).toContain('mobile-app compose 3 3.1 GB');
    expect(t).toContain('No project started by hand 4 1.1 GB');
  });

  it('the server\'s order is kept, flagged groups first', () => {
    const names = [...band(host()).matchAll(/<span class="nm">([^<]*)/g)].map((m) => m[1]);
    expect(names).toEqual(['field-notes', 'billing', 'mobile-app', 'No project']);
  });

  it('"Left running" and "Unhealthy" are flags beside the name, with their own marks', () => {
    const h = band(host());
    expect(h).toContain('<span class="flag left">Left running</span>');
    expect(h).toContain('<span class="flag sick">Unhealthy</span>');
    expect(plain(band(host({ groups: [group({ unhealthy: 3 })] })))).toContain('3 unhealthy');
    const calm = band(host({ groups: [group()] }));
    expect(calm).not.toContain('class="flag');
  });

  it('a compose group says its compose name when that differs from the project, and when no project holds it', () => {
    const t = plain(band(host({ groups: [group({ compose: 'mobile-app-stack' }), group({ name: 'shared-cache', project: null, compose: 'shared-cache' })] })));
    expect(t).toContain('mobile-app compose mobile-app-stack');
    expect(t).toContain('shared-cache compose, not an agent-orb project');
  });

  it('a Testcontainers group no test run was going for, and an excluded project\'s, say what they are', () => {
    const t = plain(band(host({ groups: [
      group({ kind: 'testcontainers', name: 'Testcontainers', project: null, compose: null }),
      group({ kind: 'excluded', name: 'An excluded project', project: null, compose: null, containers: 2, memory: 40 * MiB }),
    ] })));
    expect(t).toContain('Testcontainers Testcontainers, no test run was going when it started');
    expect(t).toContain('An excluded project names left out, as the project is excluded 2 40 MB');
  });

  it('there is no Remove button, and the band says so', () => {
    const h = band(host());
    expect(h).not.toMatch(/<button/);
    expect(h).not.toMatch(/Remove|Stop|Delete|Prune/);
    expect(plain(h)).toContain('never removes one');
  });

  it('a sample read within half an hour says how long ago; an older one says so in amber, and that it updates while a session runs', () => {
    const fresh = band(host({ at: NOW - 30 * MIN }));
    expect(fresh).toContain('<span class="hint">studio-mac · read 30 min ago</span>');
    const old = band(host({ at: NOW - 31 * MIN }));
    expect(old).toContain('<span class="hint stale">');
    expect(plain(old)).toContain('studio-mac · read 31 min ago: it updates while a session runs');
    expect(plain(band(host({ at: NOW - 3 * HOUR })))).toContain('read 3 h ago');
    expect(plain(band(host({ at: NOW - 10_000 })))).toContain('read just now');
  });

  it('Docker not installed, or stopped: the free memory stays, the message takes the containers\' place, and there are no rows', () => {
    for (const docker of ['absent', 'stopped'] as const) {
      const h = band(host({ docker, containers: 0, memory: 0, groups: [] }));
      expect(plain(h), docker).toContain("Free memory 6.2 GB of 36 GB Docker isn't running, so no containers to list.");
      expect(h, docker).not.toContain('class="mrow');
      expect(plain(h), docker).not.toMatch(/Containers \d|They use|No container is running/);
    }
  });

  it('Docker running with nothing in it says so', () => {
    const t = plain(band(host({ containers: 0, memory: 0, groups: [] })));
    expect(t).toContain('Containers 0 running');
    expect(t).toContain('No container is running.');
  });

  it('memory the plugin could not read is "Not read", not 0', () => {
    expect(plain(band(host({ memFree: null, memTotal: null, docker: 'absent', groups: [], containers: 0 })))).toContain("Free memory Not read Docker isn't running");
  });

  it('the band is the target of the "See machine" jump: it has the id and takes focus', () => {
    expect(band(host())).toContain('id="machine"');
    expect(band(host())).toContain('tabindex="-1"');
  });
});

describe('Needs you, with what was left running', () => {
  const gate = { ok: true, note: 'x' };
  const prs = [{ number: 416, head: 'fix/409-token-retry', issue: 409, headOid: 'a1b2c3d'.padEnd(40, '3'), ready: true, reason: null, dropped: 0, conditions: { findings: gate, gate, bots: gate, clean: gate }, findings: [] }];
  const cost: IssueCost = { number: 409, milestone: 'v0.4 Factory', usd: 118, partial: false, whole: 0, windows: 118, budget: 150, milestoneBudget: 150, source: 'milestone', mark: null };
  const needs = (left: MachineGroup[], withPrs = prs, costs?: Map<number, IssueCost>) => renderToStaticMarkup(createElement(NeedsYou, { prs: withPrs, costs, left, onOpen: () => {} }));
  const rows = (html: string) => html.split('<div class="need">').slice(1).map(plain);
  const field = group({ kind: 'testcontainers', name: 'field-notes', project: 'field-notes', compose: null, containers: 3, memory: 1.2 * GiB, leftRunning: true, idleMs: 2 * HOUR });

  it('one row per group left running, after the PRs: its project and container count, how long it was quiet, what it holds, and a way to the band', () => {
    expect(rows(needs([field]))).toEqual([
      'Ready PR #416 fix/409-token-retry Ready for your ok a1b2c3d See checks',
      'Left running field-notes: 3 containers No session in that project for 2 h 1.2 GB See machine',
    ]);
    expect(needs([field])).toContain('<span class="state waiting">Left running</span>');
    expect(needs([field])).toContain('<button type="button" class="btn">See machine</button>');
  });

  it('one container is "1 container", and each flagged group is its own row', () => {
    const two = rows(needs([{ ...field, containers: 1 }, group({ name: 'billing', project: 'billing', containers: 2, memory: 90 * MiB, leftRunning: true, idleMs: 70 * MIN })], []));
    expect(two).toEqual([
      'Left running field-notes: 1 container No session in that project for 2 h 1.2 GB See machine',
      'Left running billing: 2 containers No session in that project for 1 h 90 MB See machine',
    ]);
  });

  it('with the cost column on, a left-running row keeps the columns of the rows above it', () => {
    const h = needs([field], prs, new Map([[409, cost]]));
    const r = h.split('<div class="need">').slice(1);
    expect(r).toHaveLength(2);
    expect((r[1]!.match(/<(?:span|button)\b/g) ?? []).length).toBeGreaterThanOrEqual(5); // state, what, an empty cost cell, since, button
    expect(r[1]).toContain('<span></span>');
  });

  it('nothing needs you only when no PR does and nothing was left running', () => {
    expect(plain(needs([], []))).toContain('Nothing needs you.');
    expect(plain(needs([field], []))).not.toContain('Nothing needs you.');
    expect(plain(needs([], prs))).not.toContain('Nothing needs you.');
  });

  it('which groups are left running is the server\'s flag, read across the hosts: an unhealthy group, or one with no project, is not a row', () => {
    const data: MachineData = { hosts: [host(), host({ host: 'other-mac', groups: [group({ name: 'old', leftRunning: true, idleMs: 3 * HOUR }), group({ unhealthy: 2 })] })] };
    expect(leftRunning(data).map((g) => g.name)).toEqual(['field-notes', 'old']);
    expect(leftRunning(undefined)).toEqual([]);
    expect(leftRunning({ hosts: [] })).toEqual([]);
  });

  it('no Remove button anywhere in the page\'s bands', () => {
    expect(needs([field])).not.toMatch(/Remove|Delete|Prune|Stop/);
  });
});
