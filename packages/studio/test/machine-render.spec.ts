import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Factory, idleText, MachineCard, MachineCards, memText, type MachineData, type MachineGroup, type MachineHost } from '../src/Factory.tsx';

// The Machine card (v0.4 slice 3, #29; #90, design/factory.html): the Mac's free memory, what its containers use, the groups left running as lines, and one row per group of
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
const card = (h: MachineHost, named = false, now = NOW) => renderToStaticMarkup(createElement(MachineCard, { host: h, now, named }));
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

describe('the Machine card', () => {
  it('two figures: free memory of the total, and the containers with what they use; the folded rows are not in the text until opened', () => {
    const t = plain(card(host()));
    expect(t).toContain('Machine studio-mac · read 4 min ago');
    expect(t).toContain('Free memory 6.2 GB of 36 GB');
    expect(t).toContain('Containers 12 use 7.4 GB');
    expect(card(host())).toContain('<details class="fx-more"><summary>Every container · 4 projects</summary>');
    expect(plain(card(host({ groups: [group()] })))).toContain('Every container · 1 project');
  });

  it('what is left running is a line with its flag, its project and today\'s words for how long; the rest is folded', () => {
    const h = card(host());
    expect(h).toContain('<div class="hm-also"><span class="flag left">Left running</span><span><b>field-notes</b>: No session in that project for 2 h</span></div>');
    expect(h.split('<details')[0]).toContain('class="flag left"');
    expect(h.split('<details')[0]).not.toContain('mobile-app'); // not left running: only in the fold
    expect(plain(card(host({ groups: [group()] })))).toContain('Nothing is left running.');
    expect(plain(card(host())).includes('Nothing is left running.')).toBe(false);
  });

  it('a run says when it began, which Mac when there are several, and how old the sample is once it is not fresh', () => {
    const run = group({ kind: 'testcontainers', name: 'field-notes', project: 'field-notes', compose: null, containers: 3, memory: 1.2 * GiB, leftRunning: true, idleMs: 2 * HOUR, since: NOW - 3 * HOUR });
    expect(plain(card(host({ groups: [run] }))).split('Every container')[0]).toContain('field-notes: Run started 3 h ago, no session in that project for 2 h');
    expect(plain(card(host({ groups: [run] }), true)).split('Every container')[0]).toContain('for 2 h, on studio-mac');
    expect(plain(card(host({ groups: [run], at: NOW - 31 * MIN }))).split('Every container')[0]).toContain('for 2 h, read 31 min ago');
    expect(plain(card(host({ groups: [run], at: NOW - 30 * MIN }))).split('Every container')[0]).not.toContain('for 2 h, read');
  });

  it('every container, folded: one row per group with its count and memory, the server\'s order kept, flagged groups first', () => {
    const names = [...card(host()).matchAll(/<span class="nm">([^<]*)/g)].map((m) => m[1]);
    expect(names).toEqual(['field-notes', 'billing', 'mobile-app', 'No project']);
    const t = plain(card(host()));
    expect(t).toContain('field-notes Left running Testcontainers, no session for 2 h 3 1.2 GB');
    expect(t).toContain('mobile-app compose 3 3.1 GB');
    expect(t).toContain('No project started by hand 4 1.1 GB');
    expect(card(host())).toContain('<span class="flag sick">Unhealthy</span>');
    expect(plain(card(host({ groups: [group({ unhealthy: 3 })] })))).toContain('3 unhealthy');
  });

  it('a compose group says its compose name when that differs from the project, and when no project holds it', () => {
    const t = plain(card(host({ groups: [group({ compose: 'mobile-app-stack' }), group({ name: 'shared-cache', project: null, compose: 'shared-cache' })] })));
    expect(t).toContain('mobile-app compose mobile-app-stack');
    expect(t).toContain('shared-cache compose, not an agent-orb project');
  });

  it('a Testcontainers group says when it began, so two runs of one project are told apart, and keeps the flag text after it', () => {
    const t = plain(card(host({ groups: [
      group({ kind: 'testcontainers', name: 'field-notes', project: 'field-notes', compose: null, since: NOW - 3 * HOUR, leftRunning: true, idleMs: 2 * HOUR }),
      group({ kind: 'testcontainers', name: 'field-notes', project: 'field-notes', compose: null, since: NOW - 25 * MIN }),
      group({ kind: 'testcontainers', name: 'Testcontainers', project: null, compose: null, since: NOW - 90 * MIN }),
    ] })));
    expect(t).toContain('field-notes Left running Testcontainers, started 3 h ago, no session for 2 h');
    expect(t).toContain('field-notes Testcontainers, started 25 min ago');
    expect(t).toContain('Testcontainers Testcontainers, started 1 h ago, no test run was going when it started');
  });

  it('a Testcontainers group no test run was going for, and an excluded project\'s, say what they are', () => {
    const t = plain(card(host({ groups: [
      group({ kind: 'testcontainers', name: 'Testcontainers', project: null, compose: null }),
      group({ kind: 'excluded', name: 'An excluded project', project: null, compose: null, containers: 2, memory: 40 * MiB }),
    ] })));
    expect(t).toContain('Testcontainers Testcontainers, no test run was going when it started');
    expect(t).toContain('An excluded project names left out, as the project is excluded 2 40 MB');
  });

  it('there is no Remove button, and the card says so', () => {
    const h = card(host());
    expect(h).not.toMatch(/<button/);
    expect(h).not.toMatch(/Remove|Stop|Delete|Prune/);
    expect(plain(h)).toContain('agent-orb lists containers and never removes one: the clean-up stays yours.');
  });

  it('a sample read within half an hour says how long ago; an older one says so in amber, and that it updates while a session runs', () => {
    expect(card(host({ at: NOW - 30 * MIN }))).toContain('<span class="hint">studio-mac · read 30 min ago</span>');
    const old = card(host({ at: NOW - 31 * MIN }));
    expect(old).toContain('<span class="hint stale">');
    expect(plain(old)).toContain('studio-mac · read 31 min ago: it updates while a session runs');
    expect(plain(card(host({ at: NOW - 3 * HOUR })))).toContain('read 3 h ago');
    expect(plain(card(host({ at: NOW - 10_000 })))).toContain('read just now');
  });

  it('Docker not installed, or stopped: the free memory stays, the message takes the containers\' place, and there are no rows or fold', () => {
    for (const docker of ['absent', 'stopped'] as const) {
      const h = card(host({ docker, containers: 0, memory: 0, groups: [] }));
      expect(plain(h), docker).toContain("Free memory 6.2 GB of 36 GB Docker isn't running, so no containers to list.");
      expect(h, docker).not.toContain('class="mrow');
      expect(h, docker).not.toContain('<details');
      expect(plain(h), docker).not.toMatch(/Containers \d|No container is running|left running/i);
    }
  });

  it('Docker running with nothing in it says so', () => {
    const t = plain(card(host({ containers: 0, memory: 0, groups: [] })));
    expect(t).toContain('Containers 0 use 0 KB');
    expect(t).toContain('No container is running.');
  });

  it('memory the plugin could not read is "Not read", not 0', () => {
    expect(plain(card(host({ memFree: null, memTotal: null, docker: 'absent', groups: [], containers: 0 })))).toContain("Free memory Not read Docker isn't running");
  });

  it('two hosts never share an id', () => {
    const ids = [...renderToStaticMarkup(createElement(MachineCards, { data: { hosts: [host(), host({ host: 'other-mac' })] }, now: NOW })).matchAll(/<section[^>]* id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['machine-studio-mac', 'machine-other-mac']);
  });

  it('with more than one Mac every left-running line names its own', () => {
    const t = plain(renderToStaticMarkup(createElement(MachineCards, { data: { hosts: [host(), host({ host: 'other-mac', groups: [group({ name: 'old', project: 'old', leftRunning: true, idleMs: 3 * HOUR })] })] }, now: NOW })));
    expect(t).toContain('on studio-mac');
    expect(t).toContain('old: No session in that project for 3 h, on other-mac');
  });

  it('groups with one name and one kind do not collide: each row is keyed by the group\'s id, so the 30-second refresh cannot drop or duplicate a row', () => {
    const twice = [
      group({ kind: 'testcontainers', name: 'field-notes', project: 'field-notes', compose: null, id: 'studio-mac:t:aaa' }),
      group({ kind: 'testcontainers', name: 'field-notes', project: 'field-notes', compose: null, id: 'studio-mac:t:bbb' }),
      group({ kind: 'testcontainers', name: 'Testcontainers', project: null, compose: null, id: 'studio-mac:t:' }),
      group({ kind: 'testcontainers', name: 'Testcontainers', project: null, compose: null, id: 'studio-mac:t:ccc' }),
    ];
    const tree = MachineCard({ host: host({ groups: twice }), now: NOW });
    expect(keysOf(tree, 'mrow')).toEqual(twice.map((g) => g.id));
  });
});

describe('the Machine cards, whatever else the page could load', () => {
  const bands = (data: MachineData | undefined, error?: string) => renderToStaticMarkup(createElement(MachineCards, { data, error, now: NOW }));

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
  it('its subtitle says what the board answers', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })); // the page asks whether the screen is a phone's
    try {
      const html = renderToStaticMarkup(createElement(Factory, { now: NOW }));
      expect(plain(html)).toContain("What's blocked, what's ready, and what's left running");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
