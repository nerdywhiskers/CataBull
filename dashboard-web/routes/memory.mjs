import { readGrouped, supersedeEntry, updateEntry } from '../lib/memory.mjs';

export default async function (app) {
  const root = app.careerBotRoot;

  app.get('/memory', async () => {
    return { files: readGrouped(root) };
  });

  app.patch('/memory/:id', async (req, reply) => {
    const id = decodeURIComponent(req.params.id);
    const updated = updateEntry(root, id, req.body || {});
    if (!updated) return reply.code(404).send({ error: 'Memory entry not found' });
    return { success: true, entry: updated };
  });

  app.delete('/memory/:id', async (req, reply) => {
    const id = decodeURIComponent(req.params.id);
    const updated = supersedeEntry(root, id);
    if (!updated) return reply.code(404).send({ error: 'Memory entry not found' });
    return { success: true, entry: updated };
  });
}
