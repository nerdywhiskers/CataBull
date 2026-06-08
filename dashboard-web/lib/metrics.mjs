import { normalizeStatus } from './parsers.mjs';
import { join } from 'path';
import { cachedRead } from './file-cache.mjs';

/** Compute aggregate pipeline metrics (ported from Go ComputeMetrics). */
export function computeMetrics(apps) {
  const m = { total: apps.length, byStatus: {}, avgScore: 0, topScore: 0, withPdf: 0, actionable: 0 };
  let totalScore = 0, scored = 0;

  for (const app of apps) {
    const status = normalizeStatus(app.status);
    m.byStatus[status] = (m.byStatus[status] || 0) + 1;
    if (app.score > 0) {
      totalScore += app.score;
      scored++;
      if (app.score > m.topScore) m.topScore = app.score;
    }
    if (app.hasPdf) m.withPdf++;
    if (status !== 'skip' && status !== 'rejected' && status !== 'discarded') m.actionable++;
  }

  if (scored > 0) m.avgScore = totalScore / scored;
  return m;
}

/** Compute progress analytics (ported from Go ComputeProgressMetrics). */
export function computeProgressMetrics(apps) {
  const statusCounts = {};
  let totalScore = 0, scored = 0, topScore = 0, totalOffers = 0, activeApps = 0;

  for (const app of apps) {
    const norm = normalizeStatus(app.status);
    statusCounts[norm] = (statusCounts[norm] || 0) + 1;
    if (app.score > 0) { totalScore += app.score; scored++; if (app.score > topScore) topScore = app.score; }
    if (norm === 'offer') totalOffers++;
    if (norm !== 'skip' && norm !== 'rejected' && norm !== 'discarded') activeApps++;
  }

  const total = apps.length;
  const applied = (statusCounts.applied || 0) + (statusCounts.responded || 0) + (statusCounts.interview || 0) + (statusCounts.offer || 0) + (statusCounts.rejected || 0);
  const responded = (statusCounts.responded || 0) + (statusCounts.interview || 0) + (statusCounts.offer || 0);
  const interview = (statusCounts.interview || 0) + (statusCounts.offer || 0);
  const offer = statusCounts.offer || 0;
  const rejected = statusCounts.rejected || 0;

  const safePct = (part, whole) => whole === 0 ? 0 : (part / whole) * 100;

  const funnelStages = [
    { label: 'Evaluated', count: total, pct: 100 },
    { label: 'Applied', count: applied, pct: safePct(applied, total) },
    { label: 'Responded', count: responded, pct: safePct(responded, applied) },
    { label: 'Interview', count: interview, pct: safePct(interview, applied) },
    { label: 'Offer', count: offer, pct: safePct(offer, applied) },
  ];

  // Score distribution
  const buckets = [0, 0, 0, 0, 0];
  for (const app of apps) {
    if (app.score <= 0) continue;
    if (app.score >= 4.5) buckets[0]++;
    else if (app.score >= 4.0) buckets[1]++;
    else if (app.score >= 3.5) buckets[2]++;
    else if (app.score >= 3.0) buckets[3]++;
    else buckets[4]++;
  }
  const scoreBuckets = [
    { label: '4.5-5.0', count: buckets[0] },
    { label: '4.0-4.4', count: buckets[1] },
    { label: '3.5-3.9', count: buckets[2] },
    { label: '3.0-3.4', count: buckets[3] },
    { label: '<3.0', count: buckets[4] },
  ];

  // Weekly activity (last 8 weeks)
  const weekCounts = {};
  for (const app of apps) {
    if (!app.date) continue;
    const d = new Date(app.date + 'T00:00:00');
    if (isNaN(d.getTime())) continue;
    // ISO week calculation
    const jan4 = new Date(d.getFullYear(), 0, 4);
    const dayOfYear = Math.floor((d - new Date(d.getFullYear(), 0, 1)) / 86400000) + 1;
    const weekDay = (d.getDay() + 6) % 7; // Monday=0
    const weekNum = Math.floor((dayOfYear - weekDay + 10) / 7);
    const year = weekNum === 1 && d.getMonth() === 11 ? d.getFullYear() + 1 : d.getFullYear();
    const key = `${year}-W${String(weekNum).padStart(2, '0')}`;
    weekCounts[key] = (weekCounts[key] || 0) + 1;
  }
  let weeks = Object.keys(weekCounts).sort();
  if (weeks.length > 8) weeks = weeks.slice(-8);
  const weeklyActivity = weeks.map(w => ({ week: w, count: weekCounts[w] }));

  return {
    funnelStages,
    scoreBuckets,
    weeklyActivity,
    responseRate: applied > 0 ? (responded / applied) * 100 : 0,
    interviewRate: applied > 0 ? (interview / applied) * 100 : 0,
    offerRate: applied > 0 ? (offer / applied) * 100 : 0,
    rejectedCount: rejected,
    avgScore: scored > 0 ? totalScore / scored : 0,
    topScore,
    totalOffers,
    activeApps,
  };
}

function normalizeCompanyKey(name = '') {
  return name.trim().toLowerCase();
}

// Parse scan-history.tsv into { [companyKey]: { jobsFound, lastScannedAt, latestTitle } }.
// Pure function so we can pipe it through cachedRead() and let mtime invalidate.
function parseScanHistory(raw) {
  const out = {};
  if (!raw) return out;
  const lines = raw.split('\n');
  for (const line of lines.slice(1)) {
    const [url, firstSeen, , title, company] = line.split('\t');
    if (!url || !company) continue;
    const key = normalizeCompanyKey(company);
    if (!out[key]) out[key] = { jobsFound: 0, lastScannedAt: null, latestTitle: null };
    out[key].jobsFound += 1;
    if (firstSeen && (!out[key].lastScannedAt || firstSeen > out[key].lastScannedAt)) {
      out[key].lastScannedAt = firstSeen;
    }
    if (title && !out[key].latestTitle) out[key].latestTitle = title;
  }
  return out;
}

// Parse pipeline.md into { [companyKey]: matchCount }.
function parsePipelineMatches(raw) {
  const out = {};
  if (!raw) return out;
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*-\s+\[[ x]\]\s+https?:\/\/\S+\s*\|\s*([^|]+)\s*\|/);
    if (!match) continue;
    const key = normalizeCompanyKey(match[1]);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

export function perCompanyMetrics(root) {
  const history = cachedRead(join(root, 'data', 'scan-history.tsv'), parseScanHistory);
  const pipeline = cachedRead(join(root, 'data', 'pipeline.md'), parsePipelineMatches);
  const metrics = {};

  for (const [key, value] of Object.entries(history)) {
    metrics[key] = {
      lastScannedAt: value.lastScannedAt,
      jobsFound: value.jobsFound,
      matchRate: 0,
      pipelineMatches: 0,
      latestTitle: value.latestTitle,
    };
  }

  for (const [key, count] of Object.entries(pipeline)) {
    if (!metrics[key]) {
      metrics[key] = { lastScannedAt: null, jobsFound: 0, matchRate: 0, pipelineMatches: 0 };
    }
    metrics[key].pipelineMatches = count;
  }

  for (const value of Object.values(metrics)) {
    value.matchRate = value.jobsFound > 0
      ? Math.round((value.pipelineMatches / value.jobsFound) * 1000) / 10
      : 0;
  }

  return metrics;
}
