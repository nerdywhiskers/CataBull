import {
  archiveActiveProfile,
  deleteStoredProfile,
  getActiveProfileId,
  listProfiles,
  removeActiveUserData,
  restoreProfile,
  setActiveProfileId,
} from '../lib/user-data.mjs';

export default async function (app) {
  const root = app.cataBullRoot;

  app.get('/profiles', async () => ({
    profiles: listProfiles(root),
    active: getActiveProfileId(root),
  }));

  // Save the current on-disk user layer into .profiles/<id>. Used before
  // creating a new profile and before switching away from the active one.
  app.post('/profiles/archive-current', async (req) => {
    const { id, label } = req.body || {};
    const profile = archiveActiveProfile(root, { id, label });
    return { success: true, profile };
  });

  // Start onboarding for a second profile without deleting the existing one:
  // archive current user data, clear the active layer, and unset active id.
  app.post('/profiles/new', async (req) => {
    const { label } = req.body || {};
    const archived = archiveActiveProfile(root, { label });
    const removed = removeActiveUserData(root);
    setActiveProfileId(root, null);
    return { success: true, archived, removed };
  });

  app.post('/profiles/:id/switch', async (req) => {
    const { id } = req.params;
    const archived = archiveActiveProfile(root);
    const profile = restoreProfile(root, id);
    return { success: true, archived, profile };
  });

  app.delete('/profiles/:id', async (req, reply) => {
    const ok = deleteStoredProfile(root, req.params.id);
    if (!ok) return reply.code(404).send({ error: 'Profile not found' });
    return { success: true };
  });
}
