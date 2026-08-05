function artifactKind(relPath) {
  if (/\/(?:tailored-)?cv\.md$/i.test(relPath)) return 'cv';
  if (/\/cv\.html$/i.test(relPath)) return 'cvHtml';
  if (/\/cv\.doc$/i.test(relPath)) return 'cvDoc';
  if (/\/cv\.pdf$/i.test(relPath)) return 'cvPdf';
  if (/\/cover-letter\.md$/i.test(relPath)) return 'coverLetter';
  if (/\/cover-letter\.html$/i.test(relPath)) return 'coverLetterHtml';
  if (/\/cover-letter\.doc$/i.test(relPath)) return 'coverLetterDoc';
  if (/\/cover-letter\.pdf$/i.test(relPath)) return 'coverLetterPdf';
  if (/\/answers\.md$/i.test(relPath)) return 'qa';
  return null;
}

function artifactDirectory(relPath) {
  return artifactKind(relPath) ? relPath.replace(/\/[^/]+$/, '') : relPath.replace(/\/+$/, '');
}

/**
 * Infer a tailored bundle from links or a bundle directory embedded in report
 * markdown. New bundles use `cv.md`; legacy `tailored-cv.md` remains readable
 * through the canonical `paths.cv` field.
 */
export function inferTailorBundleFromReport(raw = '') {
  const text = String(raw);
  const dirs = new Set();
  const explicitPaths = [];

  for (const match of text.matchAll(/output\/tailor-bundles\/[^)\s`]+\/(?:tailored-cv|cv|cover-letter|answers)\.(?:md|html|doc|pdf)/gi)) {
    explicitPaths.push(match[0]);
    dirs.add(artifactDirectory(match[0]));
  }

  for (const match of text.matchAll(/path=([^)\s`&]+)/g)) {
    let relPath;
    try {
      relPath = decodeURIComponent(match[1]);
    } catch {
      relPath = match[1];
    }
    if (!relPath.startsWith('output/tailor-bundles/')) continue;
    if (artifactKind(relPath)) explicitPaths.push(relPath);
    dirs.add(artifactDirectory(relPath));
  }

  for (const match of text.matchAll(/output\/tailor-bundles\/[a-z0-9._/-]+/gi)) {
    dirs.add(artifactDirectory(match[0]));
  }

  const candidatePaths = [];
  for (const dir of dirs) {
    candidatePaths.push(
      `${dir}/cv.md`,
      `${dir}/cv.doc`,
      `${dir}/cv.pdf`,
      `${dir}/cover-letter.md`,
      `${dir}/cover-letter.doc`,
      `${dir}/cover-letter.pdf`,
      `${dir}/answers.md`,
    );
  }
  // Explicit paths come last so a report that names legacy tailored-cv.md
  // wins over the inferred canonical cv.md candidate.
  candidatePaths.push(...explicitPaths);

  const paths = {};
  for (const relPath of candidatePaths) {
    const kind = artifactKind(relPath);
    if (kind) paths[kind] = relPath;
  }
  const firstPath = Object.values(paths)[0];
  if (!firstPath) return null;
  const dir = artifactDirectory(firstPath);
  return { dir, paths };
}
