import ashby from './ashby.mjs';
import greenhouse from './greenhouse.mjs';
import lever from './lever.mjs';
import workday from './workday.mjs';
import bamboohr from './bamboohr.mjs';
import teamtailor from './teamtailor.mjs';
import smartrecruiters from './smartrecruiters.mjs';
import workable from './workable.mjs';
import jobspy from './jobspy.mjs';
import webfetch from './webfetch.mjs';

// Order matters for auto-resolution: more specific patterns first
// (Workday/BambooHR/Teamtailor URLs wouldn't accidentally match the
// generic Ashby/Greenhouse/Lever regexes, but webfetch must stay last
// as the universal fallback). jobspy is an explicit opt-in via
// `scan_method: jobspy` rather than URL pattern, so its position in
// auto-resolution doesn't matter — it's only picked when explicitly set.
const providers = [greenhouse, ashby, lever, workday, bamboohr, teamtailor, smartrecruiters, workable, jobspy, webfetch];

function normalizeProviderName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!name || name === 'auto') return 'auto';
  if (name === 'websearch') return 'webfetch';
  return name;
}

function getProvider(name) {
  return providers.find((provider) => provider.name === name) || null;
}

export function listProviders() {
  return providers.map((provider) => ({
    name: provider.name,
    description: provider.description,
    needsPlaywright: Boolean(provider.needsPlaywright),
  }));
}

// Used by scan/providers/sniff.mjs. Returns a list of { name, matchUrl }
// for every ATS provider that exposes a URL matcher (i.e. everything
// except the webfetch fallback). The sniffer iterates these against
// outbound <a href> values from a rendered careers page to detect which
// ATS the company actually uses, when the directly-configured careers_url
// is a marketing page that yielded zero jobs.
export function listAtsMatchers() {
  return providers
    .filter((provider) => provider.name !== 'webfetch' && typeof provider.matchUrl === 'function')
    .map((provider) => ({
      name: provider.name,
      matchUrl: provider.matchUrl.bind(provider),
      buildCareersUrl: typeof provider.buildCareersUrl === 'function'
        ? provider.buildCareersUrl.bind(provider)
        : null,
    }));
}

export function resolveProvider(company, defaultProvider = 'webfetch') {
  const rawExplicitName = String(company.provider || company.scan_method || '').trim().toLowerCase();
  const explicitName = normalizeProviderName(rawExplicitName);

  // `scan_method: websearch` is legacy config meaning "use the broad
  // fallback for custom careers pages." If the URL is now a known ATS, prefer
  // the ATS parser and keep webfetch as the fallback for truly custom pages.
  if (rawExplicitName === 'websearch') {
    for (const provider of providers) {
      if (provider.name === 'webfetch') continue;
      if (provider.match(company)) return provider;
    }
    return webfetch;
  }

  if (explicitName !== 'auto') {
    const explicit = getProvider(explicitName);
    if (!explicit) throw new Error(`Unknown provider: ${explicitName}`);
    return explicit;
  }

  for (const provider of providers) {
    if (provider.name === 'webfetch') continue;
    if (provider.match(company)) return provider;
  }

  const fallbackName = normalizeProviderName(defaultProvider);
  if (fallbackName !== 'auto') {
    const fallback = getProvider(fallbackName);
    if (!fallback) throw new Error(`Unknown default provider: ${fallbackName}`);
    return fallback;
  }

  return webfetch.match(company) ? webfetch : null;
}
