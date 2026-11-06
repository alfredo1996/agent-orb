import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Factory, idleText, leftRunning, MachineBand, MachineBands, memText, NeedsYou, type IssueCost, type Left, type MachineData, type MachineGroup, type MachineHost } from '../src/Factory.tsx';

// The Machine band and the "Left running" rows of Needs you (v0.4 slice 3, #29; design/v0.4-factory.html): the Mac's free memory, what its containers use, and one row per group of
// containers with its flags. Nothing here removes a container. The studio has no DOM library, so the pieces are rendered to markup.
const plain = (html: string) => html.replace(/<\/?b>/g, '').replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const MIN = 60_000;
const HOUR = 60 * MIN;
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const NOW = Date.parse('2026-11-05T12:00:00Z');

let ids = 0;
const group = (over: Partial<MachineGroup> = {}): MachineGroup => ({
  id: `studio-mac:g${++ids}`, kind: 'compose', name: 'mobile-app', project: 'mobile-app', compose: 'mobile-app', containers: 3, memory: 3.1 * GiB, unhealthy: 0, leftRunning: false, idleMs: null, since: null, ...over,
});
const host = (over: Partial<MachineHost> = {}): MachineHost => ({
  host: 'studio-mac', at: NOW - 4 * MIN, ageMs: 4 * MIN, docker: 'ok', memFree: 6.2 * GiB, memTotal: 36 * GiB, containers: 12, memory: 7.4 * GiB,
  groups: [
    group({ kind: 'testcontainers', name: 'field-notes', project: 'field-notes', compose: null, memory: 1.2 * GiB, leftRunning: true, idleMs: 2 * HOUR }),
    group({ kind: 'compose', name: 'billing', project: null, compose: 'billing', containers: 1, memory: 1.9 * GiB, unhealthy: 1 }),
    group(),
    group({ kind: 'none', name: 'No project', project: null, compose: null, containers: 4, memory: 1.1 * GiB }),
  ], ...over,
});
const band = (h: MachineHost, now = NOW) => renderToStaticMarkup(createElement(MachineBand, { host: h, now }));
// React's server renderer does not check keys, so a key is read from the element tree itself: the components are plain functions, and this walks what they return.
type El = { key: string | null; props: { className?: string; children?: unknown } };
const elements = (node: unknown, out: El[] = []): El[] => {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out));
  else if (node && typeof node === 'object' && 'props' in node) (out.push(node as El), elements((node as El).props.children, out));
  return out;
};
const keysOf = (tree: unknown, className: string) => elements(tree).filter((e) => e.props.className === className).map((e) => e.key);

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

  it('a Testcontainers group says when it began, so two runs of one project are told apart, and keeps the flag text after it', () => {
    const t = plain(band(host({ groups: [
      group({ kind: 'testcontainers', name: 'field-notes', project: 'field-notes', compose: null, since: NOW - 3 * HOUR, leftRunning: true, idleMs: 2 * HOUR }),
      group({ kind: 'testcontainers', name: 'field-notes', project: 'field-notes', compose: null, since: NOW - 25 * MIN }),
      group({ kind: 'testcontainers', name: 'Testcontainers', project: null, compose: null, since: NOW - 90 * MIN }),
    ] })));
    expect(t).toContain('field-notes Left running Testcontainers, started 3 h ago, no session for 2 h');
    expect(t).toContain('field-notes Testcontainers, started 25 min ago');
    expect(t).toContain('Testcontainers Testcontainers, started 1 h ago, no test run was going when it started');
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

  it('the band is the target of the "See machine" jump: it has an id of its host\'s and takes focus; two hosts never share an id', () => {
    expect(band(host())).toContain('id="machine-studio-mac"');
    expect(band(host())).toContain('tabindex="-1"');
    const ids = [...renderToStaticMarkup(createElement(MachineBands, { data: { hosts: [host(), host({ host: 'other-mac' })] }, now: NOW })).matchAll(/<section[^>]* id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['machine-studio-mac', 'machine-other-mac']);
  });

  it('groups with one name and one kind do not collide: each row is keyed by the group\'s id, so the 30-second refresh cannot drop or duplicate a row', () => {
    const twice = [
      group({ kind: 'testcontainers', name: 'field-notes', project: 'field-notes', compose: null, id: 'studio-mac:t:aaa' }),
      group({ kind: 'testcontainers', name: 'field-notes', project: 'field-notes', compose: null, id: 'studio-mac:t:bbb' }),
      group({ kind: 'testcontainers', name: 'Testcontainers', project: null, compose: null, id: 'studio-mac:t:' }),
      group({ kind: 'testcontainers', name: 'Testcontainers', project: null, compose: null, id: 'studio-mac:t:ccc' }),
    ];
    expect(keysOf(MachineBand({ host: host({ groups: twice }), now: NOW }), 'mrow')).toEqual(twice.map((g) => g.id));
  });
});

describe('Needs you, with what was left running', () => {
  const gate = { ok: true, note: 'x' };
  const prs = [{ number: 416, head: 'fix/409-token-retry', issue: 409, headOid: 'a1b2c3d'.padEnd(40, '3'), ready: true, reason: null, dropped: 0, conditions: { findings: gate, gate, bots: gate, clean: gate }, findings: [] }];
  const cost: IssueCost = { number: 409, milestone: 'v0.4 Factory', usd: 118, partial: false, whole: 0, windows: 118, budget: 150, milestoneBudget: 150, source: 'milestone', mark: null };
  const needs = (left: Left[], withPrs = prs, costs?: Map<number, IssueCost>) => renderToStaticMarkup(createElement(NeedsYou, { prs: withPrs, costs, left, now: NOW, onOpen: () => {} }));
  const rows = (html: string) => html.split('<div class="need">').slice(1).map(plain);
  const field = group({ kind: 'testcontainers', name: 'field-notes', project: 'field-notes', compose: null, containers: 3, memory: 1.2 * GiB, leftRunning: true, idleMs: 2 * HOUR });
  const entry = (g: MachineGroup, over: Partial<Left> = {}): Left => ({ group: g, host: 'studio-mac', at: NOW - 4 * MIN, named: false, ...over });

  it('one row per group left running, after the PRs: its project and container count, how long it was quiet, what it holds, and a way to the band', () => {
    expect(rows(needs([entry(field)]))).toEqual([
      'Ready PR #416 fix/409-token-retry Ready for your ok a1b2c3d See checks',
      'Left running field-notes: 3 containers No session in that project for 2 h 1.2 GB See machine',
    ]);
    expect(needs([entry(field)])).toContain('<span class="state waiting">Left running</span>');
    expect(needs([entry(field)])).toContain('<button type="button" class="btn">See machine</button>');
  });

  it('one container is "1 container", and each flagged group is its own row', () => {
    const two = rows(needs([entry({ ...field, containers: 1 }), entry(group({ kind: 'testcontainers', name: 'billing', project: 'billing', containers: 2, memory: 90 * MiB, leftRunning: true, idleMs: 70 * MIN }))], []));
    expect(two).toEqual([
      'Left running field-notes: 1 container No session in that project for 2 h 1.2 GB See machine',
      'Left running billing: 2 containers No session in that project for 1 h 90 MB See machine',
    ]);
  });

  it('a run says when it began, so two runs of one project are two rows that can be told apart', () => {
    const a = { ...field, id: 'studio-mac:t:aaa', since: NOW - 3 * HOUR };
    const b = { ...field, id: 'studio-mac:t:bbb', since: NOW - 150 * MIN, containers: 1 };
    expect(rows(needs([entry(a), entry(b)], [])).map((r) => r.replace(/ 1\.2 GB See machine$/, ''))).toEqual([
      'Left running field-notes: 3 containers Run started 3 h ago, no session in that project for 2 h',
      'Left running field-notes: 1 container Run started 2 h ago, no session in that project for 2 h',
    ]);
  });

  it('each row is keyed by its group\'s id: two runs of one project, or one group on two Macs, are never given one key', () => {
    const a = { ...field, id: 'studio-mac:t:aaa' };
    const b = { ...field, id: 'studio-mac:t:bbb' };
    const c = { ...field, id: 'other-mac:t:aaa' };
    expect(keysOf(NeedsYou({ prs: [], left: [entry(a), entry(b), entry(c, { host: 'other-mac', named: true })], now: NOW, onOpen: () => {} }), 'need')).toEqual(['studio-mac:t:aaa', 'studio-mac:t:bbb', 'other-mac:t:aaa']);
  });

  it('a row from a sample more than half an hour old says how old it is, as the band does; a fresh one does not', () => {
    expect(rows(needs([entry(field, { at: NOW - 31 * MIN })], []))[0]).toContain('No session in that project for 2 h, read 31 min ago');
    expect(rows(needs([entry(field, { at: NOW - 3 * HOUR })], []))[0]).toContain('for 2 h, read 3 h ago');
    expect(rows(needs([entry(field, { at: NOW - 30 * MIN })], []))[0]).not.toContain('read');
  });

  it('with more than one Mac a row names its Mac, and its button goes to that Mac\'s band', () => {
    expect(rows(needs([entry(field, { host: 'other-mac', named: true })], []))[0]).toContain('No session in that project for 2 h, on other-mac');
    expect(rows(needs([entry(field)], []))[0]).not.toContain('studio-mac');
  });

  it('with the cost column on, a left-running row keeps the columns of the rows above it', () => {
    const h = needs([entry(field)], prs, new Map([[409, cost]]));
    const r = h.split('<div class="need">').slice(1);
    expect(r).toHaveLength(2);
    expect((r[1]!.match(/<(?:span|button)\b/g) ?? []).length).toBeGreaterThanOrEqual(5); // state, what, an empty cost cell, since, button
    expect(r[1]).toContain('<span></span>');
  });

  it('nothing needs you only when no PR does and nothing was left running', () => {
    expect(plain(needs([], []))).toContain('Nothing needs you.');
    expect(plain(needs([entry(field)], []))).not.toContain('Nothing needs you.');
    expect(plain(needs([], prs))).not.toContain('Nothing needs you.');
  });

  it('which groups are left running is the server\'s flag, read across the hosts, each with its Mac and when it was read: an unhealthy group, or one with no project, is not a row', () => {
    const data: MachineData = { hosts: [host(), host({ host: 'other-mac', at: NOW - HOUR, groups: [group({ name: 'old', leftRunning: true, idleMs: 3 * HOUR }), group({ unhealthy: 2 })] })] };
    expect(leftRunning(data).map((l) => [l.group.name, l.host, l.at, l.named])).toEqual([['field-notes', 'studio-mac', NOW - 4 * MIN, true], ['old', 'other-mac', NOW - HOUR, true]]);
    expect(leftRunning({ hosts: [host()] }).map((l) => l.named)).toEqual([false]);
    expect(leftRunning(undefined)).toEqual([]);
    expect(leftRunning({ hosts: [] })).toEqual([]);
  });

  it('no Remove button anywhere in the page\'s bands', () => {
    expect(needs([entry(field)])).not.toMatch(/Remove|Delete|Prune|Stop/);
  });
});

describe('the Machine bands, whatever else the page could load', () => {
  const bands = (data: MachineData | undefined, error?: string) => renderToStaticMarkup(createElement(MachineBands, { data, error, now: NOW }));

  it('one band per Mac, none when nothing was asked yet', () => {
    expect(plain(bands({ hosts: [host(), host({ host: 'other-mac' })] }))).toMatch(/Machine studio-mac.*Machine other-mac/);
    expect(bands(undefined)).toBe('');
  });

  it('no sample in 24 hours is said, so an old plugin or server is not mistaken for an idle Mac', () => {
    const t = plain(bands({ hosts: [] }));
    expect(t).toContain('Machine');
    expect(t).toContain('Not sampled yet');
    expect(t).toMatch(/while a session runs/);
    expect(t).toMatch(/older plugin or server/);
  });

  it('a server that cannot answer is said, with its words, and shown in place of nothing', () => {
    expect(plain(bands(undefined, 'The server answered 404.'))).toContain('The machine could not be read: The server answered 404.');
  });

  it('a failed read after a good one keeps showing the last good read', () => {
    const t = plain(bands({ hosts: [host()] }, 'The server answered 502.'));
    expect(t).toContain('Free memory 6.2 GB of 36 GB');
    expect(t).not.toContain('could not be read');
  });
});

describe('the Factory page, as it is first drawn', () => {
  it('its subtitle names the three bands of the approved mockup', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })); // the page asks whether the screen is a phone's
    try {
      const html = renderToStaticMarkup(createElement(Factory, { now: NOW, live: new Set<string>() }));
      expect(plain(html)).toContain("What's blocked, what's ready, and what's left running");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
