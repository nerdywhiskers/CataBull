// Canonical industry taxonomy. Single source of truth for the onboarding
// industry picker, the Companies tab filter, and any other UI surface that
// needs the human-readable label or description for an industry id.
//
// The id field is the join key shared with INDUSTRY_KEYWORDS in
// dashboard-web/routes/onboarding.mjs (server-side inference) and with the
// `industries` array on each tracked_company entry in portals.yml. If you
// add or rename an id here, mirror the change in INDUSTRY_KEYWORDS so the
// discovery and inference flows stay consistent.

export const INDUSTRIES = [
  { id: 'tech', label: 'Tech', description: 'SaaS, platforms, cloud, data, product' },
  { id: 'ai', label: 'AI', description: 'Applied AI, ML, LLMs, agents, AI infrastructure' },
  { id: 'gaming', label: 'Gaming', description: 'Game studios, platforms, interactive entertainment' },
  { id: 'entertainment', label: 'Entertainment', description: 'Audio, video, creators, streaming, creative tools' },
  { id: 'media', label: 'Media', description: 'Publishing, social, content, audience products' },
  { id: 'fintech', label: 'Fintech', description: 'Payments, banking, trading, risk, finance platforms' },
  { id: 'ecommerce', label: 'E-commerce', description: 'Marketplaces, retail, travel, consumer commerce' },
  { id: 'healthcare', label: 'Healthcare', description: 'Health tech, bio, clinical, life sciences' },
  { id: 'education', label: 'Education', description: 'Learning, training, EdTech, curriculum' },
  { id: 'developer_tools', label: 'Developer Tools', description: 'APIs, DevRel, infrastructure, databases, DX' },
  { id: 'automation', label: 'Automation', description: 'Workflow, no-code, RevOps, business systems' },
  { id: 'enterprise', label: 'Enterprise', description: 'B2B software, customer systems, internal tools' },
  { id: 'design', label: 'Design', description: 'Creative tech, design engineering, generative tools' },
  { id: 'cybersecurity', label: 'Cybersecurity', description: 'Security, identity, guardrails, risk' },
  { id: 'climate', label: 'Climate', description: 'Sustainability, energy, carbon, climate data' },
];

export const INDUSTRY_IDS = INDUSTRIES.map(i => i.id);

export function getIndustryLabel(id) {
  const match = INDUSTRIES.find(i => i.id === id);
  return match ? match.label : id;
}
