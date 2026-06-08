export const CONTEXTUAL_SCORING_KEY = 'catabull-contextual-scoring';

function scoringStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function contextualScoringEnabled() {
  return scoringStorage()?.getItem(CONTEXTUAL_SCORING_KEY) !== '0';
}

export function setContextualScoringEnabled(enabled) {
  scoringStorage()?.setItem(CONTEXTUAL_SCORING_KEY, enabled ? '1' : '0');
}

export function resetPendingToHeuristicScores(pending = []) {
  return pending.map((item) => ({
    ...item,
    relevance: Number.isFinite(item.heuristicRelevance) ? item.heuristicRelevance : item.relevance,
    contextualScoring: false,
    contextualScore: undefined,
    contextualRationale: undefined,
    contextualSignals: undefined,
    contextualScoreSource: undefined,
  }));
}

export function mergePendingContextualState(nextPending = [], previousPending = []) {
  const previousByUrl = new Map(previousPending.map((item) => [item.url, item]));
  return nextPending.map((item) => {
    const previous = previousByUrl.get(item.url);
    if (!previous) return item;
    const merged = { ...item };
    if (Number.isFinite(previous.heuristicRelevance)) {
      merged.heuristicRelevance = previous.heuristicRelevance;
    }
    if (previous.contextualScoreSource === 'llm' && Number.isFinite(previous.contextualScore)) {
      merged.relevance = previous.contextualScore;
      merged.contextualScore = previous.contextualScore;
      merged.contextualRationale = previous.contextualRationale || '';
      merged.contextualSignals = Array.isArray(previous.contextualSignals) ? previous.contextualSignals : [];
      merged.contextualScoreSource = 'llm';
      merged.contextualScoring = false;
    }
    return merged;
  });
}

export function applyContextualScoreResults(pending = [], scores = []) {
  const byId = new Map((scores || []).map((score) => [score.id, score]));
  return pending.map((item) => {
    const score = byId.get(item.url);
    if (!score) return { ...item, contextualScoring: false };
    return {
      ...item,
      heuristicRelevance: Number.isFinite(item.heuristicRelevance) ? item.heuristicRelevance : item.relevance,
      relevance: score.score,
      contextualScore: score.score,
      contextualRationale: score.rationale || '',
      contextualSignals: score.signals || [],
      contextualScoring: false,
      contextualScoreSource: 'llm',
    };
  });
}
