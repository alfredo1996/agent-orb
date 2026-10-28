import { describe, expect, it } from 'vitest';
import { Event, ROLE_INFO, ROLES, roles, types } from '../src/index.ts';

// Issue #8: every role says what it means, the map only uses real roles, and the built-in agent types say what they are for.
describe('roles and types', () => {
  it('gives every role one line, and nothing else a line', () => {
    expect(Object.keys(ROLE_INFO).sort()).toEqual([...ROLES].sort());
    for (const r of ROLES) expect(ROLE_INFO[r].length).toBeGreaterThan(10);
  });
  it('maps built-in types only to roles that exist (consultant and generalist were missing, so the picker could not select them)', () => {
    for (const role of Object.values(roles)) expect(ROLES).toContain(role);
  });
  it('describes every built-in type the role map names', () => {
    for (const type of Object.keys(roles)) expect(types[type as keyof typeof types]?.length ?? 0).toBeGreaterThan(10);
  });
  it('lets the catalogue carry an agent\'s description, cut at 300 characters', () => {
    const base = { v: 1, id: '00000000-0000-4000-8000-000000000001', ts: 1, host: 'h', user_id: 'u', session_id: 's', project: { cwd: '/r', name: 'r' } };
    const e = Event.parse({ ...base, kind: 'skills.catalog', data: { skills: [], agents: [{ name: 'scout', source: 'projectSettings', tokens: 15, description: 'd'.repeat(500) }] } });
    expect(e.kind === 'skills.catalog' && e.data.agents[0]!.description!.length).toBe(300);
  });
});
