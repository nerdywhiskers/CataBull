import { readProfile, writeProfile, readProfileMarkdown, writeProfileMarkdown } from '../lib/writers.mjs';
import { removeActiveUserData } from '../lib/user-data.mjs';

export default async function (app) {
  const root = app.careerBotRoot;

  app.get('/profile', async () => {
    const profile = readProfile(root);
    return { profile };
  });

  app.put('/profile', async (req) => {
    writeProfile(root, req.body);
    return { success: true };
  });

  app.patch('/profile', async (req) => {
    const existing = readProfile(root) || {};
    const merged = deepMerge(existing, req.body);
    writeProfile(root, merged);
    return { success: true };
  });

  app.get('/profile/markdown', async () => {
    const content = readProfileMarkdown(root);
    return { content };
  });

  app.put('/profile/markdown', async (req) => {
    writeProfileMarkdown(root, req.body.content);
    return { success: true };
  });

  // Wipe all user data and return to onboarding. Requires the client to
  // echo the current candidate.full_name as confirmation, OR the literal
  // string "DELETE" — the latter is the only viable path when onboarding
  // got stuck partway and full_name is blank or still the template.
  app.delete('/profile', async (req, reply) => {
    const { confirmName } = req.body || {};
    const profile = readProfile(root);
    const expected = (profile?.candidate?.full_name || '').trim().toLowerCase();
    const got = String(confirmName || '').trim().toLowerCase();

    const universalReset = got === 'delete';
    if (!universalReset) {
      if (!expected) return reply.code(400).send({ error: 'No profile to delete' });
      if (got !== expected) return reply.code(400).send({ error: 'Name does not match' });
    }

    const removed = removeActiveUserData(root);
    return { success: true, removed };
  });
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key] && typeof target[key] === 'object') {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
