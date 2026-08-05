const COMPANY_SUFFIX_RE = /(?:\s+(?:(?:and\s+)?(?:inc|llc|ltd|corp|corporation|company|co|group|holdings?)))+$/;

function preserveTechnicalTokens(value) {
  return String(value || '')
    .replace(/(^|[^a-z0-9])c\+\+(?=$|[^a-z0-9])/gi, '$1cplusplus')
    .replace(/(^|[^a-z0-9])c#(?=$|[^a-z0-9])/gi, '$1csharp')
    .replace(/(^|[^a-z0-9])\.net(?=$|[^a-z0-9])/gi, '$1dotnet');
}

export function canonicalCompanyRoleKey(company, role) {
  const companyKey = preserveTechnicalTokens(company)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(COMPANY_SUFFIX_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const roleKey = preserveTechnicalTokens(role)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${companyKey}||${roleKey}`;
}
