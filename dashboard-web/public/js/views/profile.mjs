import { api } from '../api.mjs';
import { toast } from '../components/toast.mjs';
import { renderMarkdown } from '../components/markdown.mjs';
import { confirmModal } from '../components/confirm.mjs';

let profile = null;
let profileMd = '';
let cvRaw = '';
let cvList = [];
let activeCvPath = 'cv.md';
let activeCvFormat = 'md';
let activeTab = 'identity';
let storedProfiles = [];
let activeProfileId = null;

function renderProfileSwitcher() {
  const options = storedProfiles.map(p =>
    `<option value="${esc(p.id)}"${p.active ? ' selected' : ''}>${esc(p.label || p.id)}${p.active ? ' (active)' : ''}</option>`
  ).join('');
  const hasProfiles = storedProfiles.length > 0;
  // Only offer "Switch" when there's another profile to switch to — the active
  // (incl. synthetic "current") profile is already loaded, so a lone entry has
  // nothing to switch to.
  const hasSwitchTarget = storedProfiles.some(p => !p.active);
  return `
    <div class="profile-switcher-bar">
      <div class="profile-switcher-left">
        <span class="profile-switcher-label">Profile</span>
        ${hasProfiles
          ? `<select class="form-select profile-switcher-select" id="profile-switcher">${options}</select>
             ${hasSwitchTarget ? '<button class="btn btn-sm" id="switch-profile-btn">Switch</button>' : ''}`
          : `<span class="profile-switcher-empty">No saved profiles yet</span>`}
      </div>
      <div class="profile-switcher-actions">
        <button class="btn btn-secondary btn-sm" id="save-profile-btn" title="Write the current form fields to config/profile.yml">Save Profile</button>
        <button class="btn btn-outline btn-sm" id="restore-backup-btn" title="Restore from a backup zip">Import</button>
        <input type="file" id="restore-backup-file" accept=".zip" style="display:none">
        <a class="btn btn-outline btn-sm" href="/api/v1/backup" download title="Download all user data as a zip">Export</a>
        <button class="btn btn-outline btn-sm profile-switcher-danger" id="delete-profile-btn" title="Delete the active profile">Delete</button>
        <button class="btn btn-primary btn-sm" id="new-profile-btn" title="Save current and start onboarding for a new profile">New profile</button>
      </div>
    </div>
  `;
}

function renderProfileForm() {
  if (!profile) return '<div class="empty-state"><h3>No profile yet</h3><p>Complete onboarding to set up your profile.</p></div>';

  const c = profile.candidate || {};
  const t = profile.target_roles || {};
  const n = profile.narrative || {};
  const comp = profile.compensation || {};
  const loc = profile.location || {};

  return `
    <div class="profile-form-grid">
      <div class="card profile-card">
        <h3 class="profile-card-title">Personal Info</h3>
        <div class="form-group"><label class="form-label">Full Name</label><input class="form-input" name="candidate.full_name" value="${esc(c.full_name || '')}"></div>
        <div class="form-group"><label class="form-label">Email</label><input class="form-input" name="candidate.email" value="${esc(c.email || '')}"></div>
        <div class="form-group"><label class="form-label">Phone</label><input class="form-input" name="candidate.phone" value="${esc(c.phone || '')}"></div>
        <div class="form-group"><label class="form-label">Location</label><input class="form-input" name="candidate.location" value="${esc(c.location || '')}"></div>
        <div class="form-group"><label class="form-label">Portfolio URL</label><input class="form-input" name="candidate.portfolio_url" value="${esc(c.portfolio_url || '')}"></div>
      </div>

      <div class="card profile-card">
        <h3 class="profile-card-title">Narrative</h3>
        <div class="form-group"><label class="form-label">Headline</label><input class="form-input" name="narrative.headline" value="${esc(n.headline || '')}"></div>
        <div class="form-group"><label class="form-label">Exit Story</label><textarea class="form-textarea profile-card-grow" name="narrative.exit_story">${esc(n.exit_story || '')}</textarea></div>
        <div class="form-group"><label class="form-label">Superpowers (one per line)</label><textarea class="form-textarea profile-card-grow" name="narrative.superpowers">${(n.superpowers || []).join('\n')}</textarea></div>
      </div>

      <div class="card profile-card">
        <h3 class="profile-card-title">Compensation</h3>
        <div class="form-group"><label class="form-label">Target Range</label><input class="form-input" name="compensation.target_range" value="${esc(comp.target_range || '')}"></div>
        <div class="form-group"><label class="form-label">Minimum</label><input class="form-input" name="compensation.minimum" value="${esc(comp.minimum || '')}"></div>
        <div class="form-group"><label class="form-label">Location Flexibility</label><input class="form-input" name="compensation.location_flexibility" value="${esc(comp.location_flexibility || '')}"></div>
      </div>

      <div class="card profile-card">
        <h3 class="profile-card-title">Target Roles</h3>
        <div class="form-group"><label class="form-label">Primary Roles (one per line)</label><textarea class="form-textarea profile-card-grow" name="target_roles.primary">${(t.primary || []).join('\n')}</textarea></div>
        <div class="form-group"><label class="form-label">Location</label>
          <div class="grid-2" style="gap:8px">
            <input class="form-input" name="location.city" value="${esc(loc.city || '')}" placeholder="City">
            <input class="form-input" name="location.timezone" value="${esc(loc.timezone || '')}" placeholder="Timezone">
          </div>
        </div>
      </div>
    </div>
  `;
}

async function handleDeleteProfile() {
  // When full_name is set, ask the user to type it. When the profile is
  // half-formed (blank or template name), fall back to the universal
  // "DELETE" confirmation — the only way to escape an aborted onboarding
  // without dropping to a shell.
  const name = (profile?.candidate?.full_name || '').trim();
  const hasName = Boolean(name);
  const expected = hasName ? name : 'DELETE';
  const confirmHtml = hasName
    ? `<p style="font-size:13px;color:var(--text);margin-bottom:6px">Type <strong>${esc(name)}</strong> to confirm:</p>`
    : `<p style="font-size:13px;color:var(--text);margin-bottom:6px">No profile name on record. Type <strong>DELETE</strong> to confirm:</p>`;

  const result = await confirmModal({
    title: 'Delete profile?',
    body: `
      <p style="font-size:14px;color:var(--subtext);margin-bottom:8px">This permanently removes your CV, profile, archetypes, portals, reports, outputs, applications tracker, and pipeline data.</p>
      <p style="font-size:13px;color:var(--subtext0);margin-bottom:12px">The dashboard will reload into onboarding. This cannot be undone.</p>
      ${confirmHtml}
      <input class="form-input" data-return="confirmName" autocomplete="off" spellcheck="false" autofocus>
    `,
    confirmText: 'Delete everything',
    danger: true,
  });
  if (!result) return;
  const typed = (result.data?.confirmName || '').trim();
  if (typed.toLowerCase() !== expected.toLowerCase()) {
    const retry = await confirmModal({
      title: 'Confirmation did not match',
      body: `<p style="font-size:14px;color:var(--subtext)">Expected <strong>${esc(expected)}</strong>, got <strong>${esc(typed || '(empty)')}</strong>. Try again?</p>`,
      confirmText: 'Try again',
    });
    if (retry) handleDeleteProfile();
    return;
  }
  try {
    await api.deleteUserProfile(typed);
    toast('Profile deleted — reloading to onboarding');
    setTimeout(() => window.location.reload(), 600);
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  }
}

function renderProfileMd() {
  return `
    <div class="grid-2" style="gap:24px">
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h3 style="font-size:14px;font-weight:600;color:var(--subtext)">Archetypes & Framing (_profile.md)</h3>
          <button class="btn btn-primary btn-sm" id="save-profile-md">Save</button>
        </div>
        <textarea class="form-textarea" id="profile-md-editor" style="min-height:500px;font-family:'SF Mono','Fira Code',monospace;font-size:13px">${esc(profileMd || '')}</textarea>
      </div>
      <div class="card">
        <h3 style="font-size:14px;font-weight:600;color:var(--subtext);margin-bottom:12px">Preview</h3>
        <div class="markdown-body" id="profile-md-preview">${renderMarkdown(profileMd || '')}</div>
      </div>
    </div>
  `;
}

function formatCvFormats(cv) {
  const formats = Array.isArray(cv?.formats) && cv.formats.length ? cv.formats : [cv?.format].filter(Boolean);
  return formats.map(f => String(f).toUpperCase()).join(' + ');
}

function findActiveCvItem() {
  return cvList.find(c => c.path === activeCvPath)
    || cvList.find(c => [c.downloadMdPath, c.downloadPdfPath, c.downloadHtmlPath].includes(activeCvPath))
    || null;
}

function downloadButton(path, label) {
  if (!path) return '';
  return `<a class="btn btn-sm" href="${api.cvDownloadUrl(path)}" download>${esc(label)}</a>`;
}

function renderCV() {
  const options = cvList.map(c =>
    `<option value="${esc(c.path)}"${c.path === activeCvPath ? ' selected' : ''}>${esc(c.name)}${formatCvFormats(c) ? ` (${esc(formatCvFormats(c))})` : ''}</option>`
  ).join('');

  const activeCv = findActiveCvItem();
  const mdPath = activeCv?.downloadMdPath || (activeCvFormat === 'md' ? activeCvPath : '');
  const pdfPath = activeCv?.downloadPdfPath || (activeCvFormat === 'pdf' ? activeCvPath : '');
  const htmlPath = activeCv?.downloadHtmlPath || (activeCvFormat === 'html' ? activeCvPath : '');
  const downloadActions = [
    downloadButton(mdPath, 'Download MD'),
    downloadButton(pdfPath, 'Download PDF'),
    downloadButton(htmlPath, 'Download HTML'),
  ].filter(Boolean).join('');
  const isEditable = activeCvFormat === 'md';
  const editorOrPreview = isEditable
    ? `<textarea class="form-textarea" id="cv-editor" style="min-height:500px;font-family:'SF Mono','Fira Code',monospace;font-size:13px">${esc(cvRaw || '')}</textarea>`
    : `<div class="empty-state" style="min-height:500px;display:flex;flex-direction:column;justify-content:center;align-items:center"><h3>${esc(activeCvFormat.toUpperCase())} file</h3><p style="font-size:13px;color:var(--subtext)">This CV is binary (${esc(activeCvFormat)}) and isn't editable in the dashboard.</p><p style="font-size:13px;color:var(--subtext)">Use the download buttons to save it locally, or pick a <code>.md</code> CV to edit.</p></div>`;

  return `
    <div class="card" style="margin-bottom:16px;background:var(--surface0);border-left:3px solid var(--mauve)">
      <div style="font-size:13px;color:var(--text);line-height:1.6">
        <strong style="color:var(--mauve)">Tip:</strong> Tailor a role to create an application bundle with a role-specific CV.
        Generated CVs appear here from <code>output/cv-*</code> files and <code>output/tailor-bundles/*/cv.md</code>.
        Matching Markdown, PDF, and HTML variants are grouped when available.
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:240px">
          <label style="font-size:13px;color:var(--subtext)">CV:</label>
          <select class="form-select" id="cv-switcher" style="flex:1;min-width:200px">${options}</select>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          ${downloadActions || downloadButton(activeCvPath, 'Download')}
          ${isEditable ? '<button class="btn btn-primary btn-sm" id="save-cv">Save</button>' : ''}
        </div>
      </div>
    </div>
    <div class="grid-2" style="gap:24px">
      <div class="card">
        <h3 style="font-size:14px;font-weight:600;color:var(--subtext);margin-bottom:12px">${isEditable ? 'Editor' : 'Source'} (${esc(activeCvPath)})</h3>
        ${editorOrPreview}
      </div>
      <div class="card">
        <h3 style="font-size:14px;font-weight:600;color:var(--subtext);margin-bottom:12px">Preview</h3>
        <div class="markdown-body" id="cv-preview">${isEditable ? renderMarkdown(cvRaw || '') : '<p style="color:var(--subtext)">No markdown preview for ' + esc(activeCvFormat) + ' files.</p>'}</div>
      </div>
    </div>
  `;
}

async function loadCv(path, container) {
  try {
    const data = await api.getCV(path);
    cvRaw = data.raw || '';
    activeCvPath = data.path || path;
    activeCvFormat = data.format || 'md';
    update(container);
  } catch { toast('Failed to load CV', 'error'); }
}

function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// Full-screen skeleton overlay used during a profile switch / new-profile
// flow. Both paths trigger a window reload, so we want a placeholder that
// keeps the interface readable instead of flashing the previous profile's
// data while the reload races. The overlay stays visible until reload tears
// it down — no separate hide is needed on the happy path.
function showProfileSwitchSkeleton(label) {
  hideProfileSwitchSkeleton();
  const overlay = document.createElement('div');
  overlay.id = 'profile-switch-skeleton';
  overlay.className = 'profile-switch-skeleton';
  overlay.innerHTML = `
    <div class="profile-switch-skeleton-card">
      <span class="spinner profile-switch-skeleton-spinner" aria-hidden="true"></span>
      <span class="profile-switch-skeleton-label">${esc(label || 'Switching profile…')}</span>
    </div>
    <div class="profile-switch-skeleton-grid">
      <div class="skeleton profile-switch-skeleton-row" style="height:48px"></div>
      <div class="skeleton profile-switch-skeleton-row" style="height:120px"></div>
      <div class="skeleton profile-switch-skeleton-row" style="height:200px"></div>
      <div class="skeleton profile-switch-skeleton-row" style="height:120px"></div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function hideProfileSwitchSkeleton() {
  document.getElementById('profile-switch-skeleton')?.remove();
}

export async function render(container) {
  container.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';

  try {
    const [profData, mdData, cvData, cvListData, profilesData] = await Promise.all([
      api.getProfile(),
      api.getProfileMarkdown(),
      api.getCV(),
      api.listCVs(),
      api.listProfiles(),
    ]);
    profile = profData.profile;
    profileMd = mdData.content || '';
    cvRaw = cvData.raw || '';
    activeCvPath = cvData.path || 'cv.md';
    activeCvFormat = cvData.format || 'md';
    cvList = cvListData.cvs || [];
    storedProfiles = profilesData.profiles || [];
    activeProfileId = profilesData.active || null;
  } catch { /* partial load ok */ }

  update(container);
}

function update(container) {
  const header = `
    <div class="section-header">
      <h2 class="section-title">Profile</h2>
    </div>
  `;
  const tabs = `
    <div class="filter-tabs filter-tabs-plain" style="margin-bottom:20px">
      <button class="filter-tab${activeTab === 'identity' ? ' active' : ''}" data-tab="identity">Identity</button>
      <button class="filter-tab${activeTab === 'archetypes' ? ' active' : ''}" data-tab="archetypes">Archetypes</button>
      <button class="filter-tab${activeTab === 'cv' ? ' active' : ''}" data-tab="cv">CV</button>
    </div>
  `;

  let content = '';
  if (activeTab === 'identity') content = renderProfileForm();
  else if (activeTab === 'archetypes') content = renderProfileMd();
  else if (activeTab === 'cv') content = renderCV();

  container.innerHTML = header + renderProfileSwitcher() + tabs + content;

  // Save Profile — writes the current form fields back to config/profile.yml.
  // Lives at the top of the page (was previously a duplicate button at the
  // bottom of the form; consolidated 2026-05-16).
  container.querySelector('#save-profile-btn')?.addEventListener('click', async () => {
    const updated = { ...profile };
    container.querySelectorAll('.form-input, .form-textarea').forEach(input => {
      const path = (input.name || '').split('.');
      if (path.length === 2) {
        if (!updated[path[0]]) updated[path[0]] = {};
        const val = input.tagName === 'TEXTAREA' && (path[1] === 'superpowers' || path[1] === 'primary')
          ? input.value.split('\n').map(s => s.trim()).filter(Boolean)
          : input.value;
        updated[path[0]][path[1]] = val;
      }
    });
    try {
      await api.updateProfile(updated);
      profile = updated;
      // Refresh the switcher so the current-profile label reflects any name
      // edit just saved (the active profile always shows in the dropdown).
      try {
        const pd = await api.listProfiles();
        storedProfiles = pd.profiles || [];
        activeProfileId = pd.active || null;
      } catch { /* keep existing switcher state */ }
      toast('Profile saved');
      update(container);
    } catch (err) { toast(`Save failed: ${err.message}`, 'error'); }
  });

  container.querySelector('#new-profile-btn')?.addEventListener('click', async () => {
    const ok = await confirmModal({
      title: 'Create a new profile?',
      body: `<p style="font-size:14px;color:var(--subtext);margin-bottom:8px">CataBull will save the current profile as a snapshot, clear the active workspace, and reload onboarding for a fresh profile.</p><p style="font-size:13px;color:var(--subtext0)">Your existing CV, profile, portals, reports, and applications stay stored under Profiles.</p>`,
      confirmText: 'Save current and start new',
    });
    if (!ok) return;
    showProfileSwitchSkeleton('Saving snapshot and resetting workspace…');
    try {
      await api.createNewProfile();
      window.location.reload();
    } catch (err) {
      hideProfileSwitchSkeleton();
      toast(`Could not create profile: ${err.message}`, 'error');
    }
  });

  container.querySelector('#switch-profile-btn')?.addEventListener('click', async () => {
    const selected = container.querySelector('#profile-switcher')?.value;
    if (!selected || selected === activeProfileId) return;
    const target = storedProfiles.find(p => p.id === selected);
    const ok = await confirmModal({
      title: `Switch to ${esc(target?.label || selected)}?`,
      body: `<p style="font-size:14px;color:var(--subtext)">CataBull will save the current active profile, restore the selected profile, and reload the dashboard.</p>`,
      confirmText: 'Switch profile',
    });
    if (!ok) return;
    showProfileSwitchSkeleton(`Switching to ${target?.label || selected}…`);
    try {
      await api.switchProfile(selected);
      window.location.reload();
    } catch (err) {
      hideProfileSwitchSkeleton();
      toast(`Switch failed: ${err.message}`, 'error');
    }
  });

  // Tab switching
  container.querySelectorAll('.filter-tab[data-tab]').forEach(btn => {
    btn.onclick = () => { activeTab = btn.dataset.tab; update(container); };
  });

  // Delete profile (start-over / testing)
  container.querySelector('#delete-profile-btn')?.addEventListener('click', handleDeleteProfile);

  // Restore from backup zip
  const restoreBtn = container.querySelector('#restore-backup-btn');
  const restoreInput = container.querySelector('#restore-backup-file');
  if (restoreBtn && restoreInput) {
    restoreBtn.onclick = () => restoreInput.click();
    restoreInput.onchange = async () => {
      const file = restoreInput.files?.[0];
      if (!file) return;
      const ok = await confirmModal({
        title: `Restore from ${esc(file.name)}?`,
        body: `<p style="font-size:14px;color:var(--subtext);margin-bottom:8px">This will overwrite your CV, profile, archetypes, applications, reports, and outputs with the contents of the backup zip.</p><p style="font-size:13px;color:var(--subtext0)">Files outside the user-data layer (system code, scripts, modes) won't be touched. Existing files not present in the backup are left in place.</p>`,
        confirmText: 'Restore',
        danger: true,
      });
      if (!ok) { restoreInput.value = ''; return; }
      try {
        const result = await api.restoreBackup(file);
        toast(`Restored ${result.written} files${result.skipped ? `, ${result.skipped} skipped` : ''}`);
        setTimeout(() => window.location.reload(), 800);
      } catch (err) {
        toast(`Restore failed: ${err.message}`, 'error');
      } finally {
        restoreInput.value = '';
      }
    };
  }

  // Save profile markdown + live preview
  const saveMdBtn = container.querySelector('#save-profile-md');
  if (saveMdBtn) {
    saveMdBtn.onclick = async () => {
      const content = container.querySelector('#profile-md-editor').value;
      try {
        await api.updateProfileMarkdown(content);
        profileMd = content;
        toast('Archetypes saved');
      } catch { toast('Failed to save', 'error'); }
    };

    const editor = container.querySelector('#profile-md-editor');
    const preview = container.querySelector('#profile-md-preview');
    if (editor && preview) {
      editor.oninput = () => { preview.innerHTML = renderMarkdown(editor.value); };
    }
  }

  // CV switcher — loads the selected CV. List is also refreshed on switch
  // so newly-generated tailored CVs appear without a full page reload.
  const switcher = container.querySelector('#cv-switcher');
  if (switcher) {
    switcher.onchange = async () => {
      try {
        const data = await api.listCVs();
        cvList = data.cvs || [];
      } catch { /* keep stale list */ }
      await loadCv(switcher.value, container);
    };
  }

  // Save CV (writes to the active path; only enabled for .md)
  const saveCvBtn = container.querySelector('#save-cv');
  if (saveCvBtn) {
    saveCvBtn.onclick = async () => {
      const content = container.querySelector('#cv-editor').value;
      try {
        await api.updateCV(content, activeCvPath);
        cvRaw = content;
        toast(`Saved ${activeCvPath}`);
      } catch { toast('Failed to save', 'error'); }
    };

    // Live preview
    const editor = container.querySelector('#cv-editor');
    const preview = container.querySelector('#cv-preview');
    if (editor && preview) {
      editor.oninput = () => { preview.innerHTML = renderMarkdown(editor.value); };
    }
  }
}
