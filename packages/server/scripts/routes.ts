/**
 * Every GET API the studio calls, with parameters that match something in the history: the soak calls each 40 times, and a test calls each twice.
 * Not here: `/stream` (it never ends) and `/api/analysis/reports/:id` (it needs a report, which only a paid run makes; analysis.test.ts reads one).
 */
export const getRoutes = ({ project, session, agent, now, tz = 'Europe/Rome' }: { project: string; session: string; agent: string; now: number; tz?: string }) => {
  const p = encodeURIComponent(project);
  const s = encodeURIComponent(session);
  const week = now - 7 * 86_400_000;
  return [
    `/api/ledger?from=0&to=${now}&unit=week&tz=${tz}`, `/api/ledger?from=${week}&to=${now}`, `/api/trends?from=0&to=${now}&project=${p}`,
    `/api/worth?project=${p}&month=${new Date(now).toISOString().slice(0, 7)}&tz=${tz}`, `/api/patterns?project=${p}`, `/api/history?session=${s}&agent=${encodeURIComponent(agent)}`,
    `/api/goal?project=${p}&tz=${tz}`, `/api/skills?project=${p}&from=0&to=${now}`, `/api/analysis`, `/api/analysis/reads?project=${p}&from=0&to=${now}`,
    `/api/pipeline?project=${p}&from=0&to=${now}`, `/api/pipeline?project=${p}&session=${s}`, `/api/lanes?session=${s}`,
    `/api/projects`, `/api/sessions?project=${p}`, '/healthz',
  ];
};
