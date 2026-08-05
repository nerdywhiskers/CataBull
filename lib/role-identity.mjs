const COMPANY_SUFFIX_RE = /\b(?:inc|llc|ltd|corp|corporation|company|co|group|holdings?)\b/g;

export function canonicalCompanyName(company) {
  return String(company || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(COMPANY_SUFFIX_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function canonicalRoleName(role) {
  return String(role || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function canonicalCompanyRoleKey(company, role) {
  return `${canonicalCompanyName(company)}||${canonicalRoleName(role)}`;
}
