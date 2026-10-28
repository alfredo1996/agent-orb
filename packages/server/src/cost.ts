import type { Usage } from '@agent-orb/shared';
import pricing from '@agent-orb/shared/pricing.json' with { type: 'json' };

type Rates = { input: number; output: number; cache_read: number; cache_creation: number };
type Price = Rates & { above_100k?: Rates };
const models: Record<string, Price> = pricing.models;

// API-equivalent cost of one request. null when the model is not in pricing.json (§5, §13).
// ponytail: first-party list prices only; Bedrock/Vertex ids, fast mode and 1h cache writes are priced as standard or null.
export function costUsd(model: string, u: Usage): number | null {
  const price = models[model.replace(/\[.*\]$/, '').replace(/-\d{8}$/, '')];
  if (!price) return null;
  const r = price.above_100k && u.input + u.cache_read + u.cache_creation > 100_000 ? price.above_100k : price;
  return (u.input * r.input + u.output * r.output + u.cache_read * r.cache_read + u.cache_creation * r.cache_creation) / 1e6;
}
