// The /orb panel's state ($.state), drawn by the Pane hook in hooks/register.tsx.
export type OrbAgentRow = { label: string; depth: number; model: string; tool: string; runningFor: string; tokens: string; state: 'working' | 'waiting' | 'stalled' | 'pricier model' | 'done' };
export type OrbEventRow = { time: string; agent: string; kind: string; detail: string; tone?: 'bad' | 'wait' | 'dim' };
export type OrbView = { project: string; branch?: string; totals: string; agents: OrbAgentRow[]; events: OrbEventRow[]; studio: string; warning?: string };

declare module 'claude-code' {
  interface PluginState {
    'agent-orb': { view: OrbView | null };
  }
}
