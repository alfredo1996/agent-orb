import { describe, expect, it } from 'vitest';
import { askFor, boardFor, linksFor, linksQuery, pinAfter } from '../src/board-view.ts';
import type { BoardData } from '../src/Factory.tsx';
import type { LinksData } from '../src/FactoryMap.tsx';

// The milestone the Board asks for (#32, R8 and R17 of the first review): the one picked, else the one the server chose first and the page kept, so that a default worked out afresh at every
// read cannot switch under a viewer; and the rows shown only for the milestone asked for.
const board = (milestone: string | null): BoardData => ({ project: 'mobile-app', milestone, content: 'full', milestones: [], issues: [] });

describe('askFor', () => {
  it('a pick wins over the pin; the pin is used only for the project it was made in; with neither the server chooses', () => {
    expect(askFor('v2.4', { project: 'mobile-app', milestone: 'v2.3' }, 'mobile-app')).toBe('v2.4');
    expect(askFor(undefined, { project: 'mobile-app', milestone: 'v2.3' }, 'mobile-app')).toBe('v2.3');
    expect(askFor(undefined, { project: 'mobile-app', milestone: 'v2.3' }, 'billing')).toBeUndefined();
    expect(askFor(undefined, undefined, 'mobile-app')).toBeUndefined();
  });
});

describe('pinAfter', () => {
  it('keeps the milestone the server chose when none was asked for, and changes nothing once one was', () => {
    expect(pinAfter(undefined, board('v2.3'), 'mobile-app', undefined)).toEqual({ project: 'mobile-app', milestone: 'v2.3' });
    const pin = { project: 'mobile-app', milestone: 'v2.3' };
    expect(pinAfter('v2.3', board('v2.3'), 'mobile-app', pin)).toBe(pin); // asked for the pin: it stays, whatever the server's default has become
    expect(pinAfter(undefined, board(null), 'mobile-app', undefined)).toBeUndefined(); // no milestone at all: ask again next time, a new one may have come
    expect(pinAfter(undefined, board('v2.4'), 'billing', pin)).toEqual({ project: 'billing', milestone: 'v2.4' });
  });
});

describe('boardFor', () => {
  it('shows the last answer for the milestone asked for, or for any when none was asked for, and not the old one\'s after a pick', () => {
    const last = board('v2.3');
    expect(boardFor(last, 'v2.3')).toBe(last);
    expect(boardFor(last, undefined)).toBe(last);
    expect(boardFor(last, 'v2.4')).toBeUndefined(); // v2.4 was picked and its read failed: the rows of v2.3 are not v2.4's
    expect(boardFor(undefined, 'v2.3')).toBeUndefined();
  });
});

describe('linksQuery', () => {
  it('asks for nothing unless the Map is open, a project is chosen and the board has answered; else for that project and the milestone the board shows, none when the board shows none', () => {
    expect(linksQuery('board', 'mobile-app', board('v2.3'))).toBeUndefined(); // the Board view never reads the links
    expect(linksQuery('map', undefined, board('v2.3'))).toBeUndefined();
    expect(linksQuery('map', 'mobile-app', undefined)).toBeUndefined();
    expect(linksQuery('map', 'mobile-app', board('v2.3'))).toBe('project=mobile-app&milestone=v2.3');
    expect(linksQuery('map', 'mobile-app', board('v2.3 Offline'))).toBe('project=mobile-app&milestone=v2.3+Offline');
    expect(linksQuery('map', 'mobile-app', board(null))).toBe('project=mobile-app');
  });
});

describe('linksFor', () => {
  const links = (project: string, milestone: string | null): LinksData => ({ project, milestone, links: [] });
  it('shows the last links answer only when it is for this project and for the milestone the board shows', () => {
    const last = links('mobile-app', 'v2.3');
    expect(linksFor(last, 'mobile-app', board('v2.3'))).toBe(last);
    expect(linksFor(last, 'mobile-app', board('v2.4'))).toBeUndefined();
    expect(linksFor(last, 'billing', board('v2.3'))).toBeUndefined();
    expect(linksFor(last, 'mobile-app', board(null))).toBeUndefined();
    expect(linksFor(links('mobile-app', null), 'mobile-app', board(null))).toEqual(links('mobile-app', null));
    expect(linksFor(last, 'mobile-app', undefined)).toBeUndefined();
    expect(linksFor(undefined, 'mobile-app', board('v2.3'))).toBeUndefined();
  });
});
