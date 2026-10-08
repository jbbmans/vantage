import type { Db } from './db/index.ts';
import type { AppConfig } from './config.ts';
import type { RuntimeSettings } from './context.ts';
import { metaGet } from './db/index.ts';
import { DEFAULT_METRICS, normalizeMetrics } from '../shared/constants.ts';
import { setCurrencySymbol } from '../shared/metrics.ts';

export function loadRuntime(db: Db, config: AppConfig): RuntimeSettings {
  const defaults: RuntimeSettings = {
    displayName: 'Vantage', organizationName: 'Marine Corps', announcement: '', selfRegistration: config.selfRegistration,
    aiEnabled: config.ai.enabled, aiModels: [...config.ai.models], aiDefaultModel: config.ai.defaultModel,
    attachmentsEnabled: config.attachments.enabled, maradminsEnabled: config.maradmins.enabled, maintenance: false, maintenanceWindow: null, metrics: DEFAULT_METRICS,
    selfServiceUnits: true, selfServiceUnitLimit: 5,
  };
  let runtime = defaults;
  try {
    const saved = JSON.parse(metaGet(db, 'runtime') || '{}') as Partial<RuntimeSettings>;
    runtime = { ...defaults, ...saved, metrics: saved.metrics ? normalizeMetrics(saved.metrics) : DEFAULT_METRICS };
    // A window belongs to maintenance that is on; one left behind with maintenance off (an edited file, an archive) is dropped.
    if (!runtime.maintenance) runtime.maintenanceWindow = null;
  } catch { /* unreadable runtime blob: defaults */ }
  setCurrencySymbol(runtime.metrics.currency_symbol);
  return runtime;
}

