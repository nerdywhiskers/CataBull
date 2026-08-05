const COMPANY_SUFFIX_RE = /\b(?:inc|llc|ltd|corp|corporation|company|co|group|holdings?)\b/g;

export function canonicalCompanyRoleKey(company, role) {
  const companyKey = String(company || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(COMPANY_SUFFIX_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const roleKey = String(role || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${companyKey}||${roleKey}`;
}
