import { findModel, providerById, type Catalog } from './catalog.js';
import { resolveSelection } from './provider.js';
import type { AgentDelegate, AgentWorker, SurfConfig } from './types.js';

/**
 * Worker references are always `provider/model`. Model ids may themselves
 * contain slashes, so only the first slash separates the two halves.
 */
export function parseWorkerRef(reference: string): AgentWorker | undefined {
  const trimmed = reference.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1)
  };
}

export function workerLabel(worker: AgentWorker): string {
  return `${worker.provider}/${worker.model}`;
}

export interface ResolvedWorkers {
  delegates: AgentDelegate[];
  failures: string[];
}

/**
 * Resolve every configured worker against the catalog and the user's saved
 * credentials. One broken worker never blocks the rest of /agent mode.
 */
export async function resolveAgentWorkers(
  catalog: Catalog,
  config: SurfConfig
): Promise<ResolvedWorkers> {
  const delegates: AgentDelegate[] = [];
  const failures: string[] = [];
  const seen = new Set<string>();

  for (const worker of config.agents.workers) {
    const label = workerLabel(worker);
    if (seen.has(label)) continue;
    seen.add(label);
    if (!providerById(catalog, worker.provider)) {
      failures.push(`${label} — unknown provider`);
      continue;
    }
    if (!findModel(catalog, worker.provider, worker.model)) {
      failures.push(`${label} — model not in catalog`);
      continue;
    }
    try {
      const selection = await resolveSelection(catalog, config, {
        provider: worker.provider,
        model: worker.model
      });
      delegates.push({ provider: selection.provider, model: selection.model });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${label} — ${reason}`);
    }
  }

  return { delegates, failures };
}
