#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  archiveActiveProfile,
  getActiveProfileId,
  listProfiles,
  removeActiveUserData,
  restoreProfile,
  setActiveProfileId,
} from '../dashboard-web/lib/user-data.mjs';

const root = mkdtempSync(join(tmpdir(), 'catabull-profiles-'));

function writeProfile(name, email) {
  writeFileSync(join(root, 'cv.md'), `# ${name}\n`);
  writeFileSync(join(root, 'portals.yml'), 'tracked_companies: []\n');
  writeFileSync(join(root, 'config/profile.yml'), `candidate:\n  full_name: ${name}\n  email: ${email}\n`);
  writeFileSync(join(root, 'modes/_profile.md'), `# ${name} framing\n`);
  writeFileSync(join(root, 'data/scan-health.json'), `{"candidate":"${name}"}\n`);
  writeFileSync(join(root, 'data/scan-health.log'), `${name} scan ok\n`);
  mkdirSync(join(root, 'data', 'outreach'), { recursive: true });
  writeFileSync(join(root, 'data', 'outreach', 'contacts.md'), `# ${name} outreach\n`);
}

await import('fs').then(fs => {
  fs.mkdirSync(join(root, 'config'), { recursive: true });
  fs.mkdirSync(join(root, 'modes'), { recursive: true });
  fs.mkdirSync(join(root, 'data'), { recursive: true });
});

writeProfile('Ada Lovelace', 'ada@example.com');
const first = archiveActiveProfile(root);
assert.equal(first.id, 'ada-lovelace');
assert.equal(getActiveProfileId(root), 'ada-lovelace');
assert.equal(listProfiles(root).length, 1);

removeActiveUserData(root);
setActiveProfileId(root, null);
assert.equal(existsSync(join(root, 'config/profile.yml')), false);

writeProfile('Grace Hopper', 'grace@example.com');
const second = archiveActiveProfile(root);
assert.equal(second.id, 'grace-hopper');
assert.equal(listProfiles(root).length, 2);

restoreProfile(root, 'ada-lovelace');
assert.equal(getActiveProfileId(root), 'ada-lovelace');
assert.match(readFileSync(join(root, 'config/profile.yml'), 'utf-8'), /Ada Lovelace/);
assert.match(readFileSync(join(root, 'cv.md'), 'utf-8'), /Ada Lovelace/);
assert.match(readFileSync(join(root, 'data/scan-health.json'), 'utf-8'), /Ada Lovelace/);
assert.match(readFileSync(join(root, 'data/scan-health.log'), 'utf-8'), /Ada Lovelace/);
assert.match(readFileSync(join(root, 'data/outreach/contacts.md'), 'utf-8'), /Ada Lovelace/);

console.log('profile store tests passed');
