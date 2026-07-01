import remotiveProvider from './remotive.mjs';
import himalayasProvider from './himalayas.mjs';
import workingNomadsProvider from './workingnomads.mjs';
import remoteOkProvider from './remoteok.mjs';
import weWorkRemotelyProvider from './weworkremotely.mjs';

const PROVIDERS = [
  remotiveProvider,
  himalayasProvider,
  workingNomadsProvider,
  remoteOkProvider,
  weWorkRemotelyProvider,
];

const PROVIDER_ALIASES = new Map([
  ['working_nomads', 'workingnomads'],
  ['working-nomads', 'workingnomads'],
  ['remote_ok', 'remoteok'],
  ['remote-ok', 'remoteok'],
  ['we_work_remotely', 'weworkremotely'],
  ['we-work-remotely', 'weworkremotely'],
]);

const PROVIDER_MAP = new Map(
  PROVIDERS.map((provider) => [normalizeMarketProviderName(provider.name), provider]),
);

export function listMarketProviders() {
  return PROVIDERS.slice();
}

export function normalizeMarketProviderName(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  if (!normalized) return '';
  return PROVIDER_ALIASES.get(String(value || '').trim().toLowerCase())
    || PROVIDER_ALIASES.get(normalized)
    || normalized;
}

export function getMarketProvider(value) {
  return PROVIDER_MAP.get(normalizeMarketProviderName(value)) || null;
}
