'use strict';

// --- date helpers ---------------------------------------------------------
function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

let currentDate = todayISO();
let saveTimer = null;
let loading = false;
// The shared editor shows either a dated daily note or a named reference note.
let mode = 'daily'; // 'daily' | 'reference'
let currentRef = null; // { slug, title } when mode === 'reference'

// Render the preview with `marked` (GFM on) so markdown tables, strikethrough,
// etc. render — EasyMDE's bundled parser doesn't do GFM tables. Same library
// and options as the email renderer, so preview and email stay consistent.
if (window.marked) {
  marked.setOptions({ gfm: true });
  // Open EXTERNAL links from rendered notes in a new browser tab instead of
  // navigating away from (and unloading) the Daily Notes app. Only absolute
  // http(s)/protocol-relative URLs get target=_blank; in-app #anchor and
  // relative links stay in the same tab so jumping within a note works.
  // Post-processing the HTML is version-robust across marked's renderer API
  // changes; rel guards the new tab from window.opener access.
  marked.use({
    hooks: {
      postprocess(html) {
        return html.replace(/<a href="((?:https?:)?\/\/[^"]*)"/g,
          '<a href="$1" target="_blank" rel="noopener noreferrer"');
      },
    },
  });
}

// Toolbar button: drop the current local time into the note as a bold anchor
// (e.g. "**3:42 PM** "). Handy for time-tagging diary entries — especially in
// reference notes, which aren't dated. Inserts on its own line so it reads as a
// marker; leaves the cursor right after it to keep typing.
const timestampButton = {
  name: 'timestamp',
  title: 'Insert current time',
  text: '🕒',
  action: (ed) => {
    const cm = ed.codemirror;
    const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const cur = cm.getCursor();
    // Start on a fresh line unless we're already at the start of an empty line.
    const atLineStart = cur.ch === 0 && !cm.getLine(cur.line);
    cm.replaceSelection(`${atLineStart ? '' : '\n'}**${time}** `);
    cm.focus();
  },
};

// Toolbar buttons: insert a GFM task-list item — unchecked for something still
// outstanding (☐) and checked for something accomplished (☑). They render as
// checkboxes in the preview (marked GFM). Each goes on its own fresh line and
// leaves the cursor after the marker so you can type the item right away.
function taskItemButton(checked) {
  return {
    name: checked ? 'task-done' : 'task-todo',
    title: checked ? 'Insert done item (checked box)' : 'Insert outstanding item (unchecked box)',
    text: checked ? '☑' : '☐',
    action: (ed) => {
      const cm = ed.codemirror;
      const cur = cm.getCursor();
      const atLineStart = cur.ch === 0 && !cm.getLine(cur.line);
      cm.replaceSelection(`${atLineStart ? '' : '\n'}- [${checked ? 'x' : ' '}] `);
      cm.focus();
    },
  };
}
const taskTodoButton = taskItemButton(false);
const taskDoneButton = taskItemButton(true);

// Toolbar button: embed an image that already lives on the web by its URL — no
// upload. Complements 'upload-image' (which stores a local file under
// /api/images); this just drops a markdown image `![alt](url)` pointing at a
// remote URL, which marked renders as an <img> in the preview/email. Prompts for
// the URL and alt text (alt defaults to any selected text).
const imageUrlButton = {
  name: 'image-url',
  title: 'Insert web image by URL',
  text: '🌐',
  action: (ed) => {
    const cm = ed.codemirror;
    const sel = cm.getSelection();
    const url = (window.prompt('Image URL (https://…):', 'https://') || '').trim();
    if (!url || url === 'https://') return;
    const alt = (window.prompt('Alt text (optional):', sel || '') || '').trim();
    cm.replaceSelection(`![${alt}](${url})`);
    cm.focus();
  },
};

const editor = new EasyMDE({
  element: document.getElementById('editor'),
  spellChecker: false,
  autofocus: true,
  status: false,
  placeholder: 'Write today\'s notes in markdown…',
  previewRender: (plainText) => (window.marked ? renderPreview(plainText) : plainText),
  // Image upload: toolbar button + paste + drag-and-drop (great for screenshots).
  // Uploads go to /api/images and the returned URL is inserted as markdown.
  uploadImage: true,
  imageMaxSize: 10 * 1024 * 1024,
  imageAccept: 'image/png, image/jpeg, image/gif, image/webp, image/*',
  imageUploadFunction: uploadImage,
  toolbar: ['bold', 'italic', 'heading', '|', 'unordered-list', 'ordered-list',
    taskTodoButton, taskDoneButton, '|',
    'code', 'quote', 'table', timestampButton, '|', 'link', 'upload-image', imageUrlButton, 'preview', 'side-by-side', 'fullscreen'],
});

// Notes open in the rendered preview (read) view by default; the 👁 toolbar
// toggle drops into the source editor. Route through EasyMDE.togglePreview so
// the toolbar button's active state stays in sync. Call setPreview(false) before
// editor.value() so the preview re-renders from the freshly loaded content.
function setPreview(on) {
  const active = editor.isPreviewActive();
  if (on && !active) EasyMDE.togglePreview(editor);
  else if (!on && active) EasyMDE.togglePreview(editor);
}

// Render the preview and make GFM task-list checkboxes interactive. marked
// emits task boxes as disabled inputs; we strip `disabled` and tag them so a
// click in the read view can flip the matching source line (see below).
function renderPreview(plainText) {
  return marked.parse(plainText).replace(
    /<input ((?:checked="" )?)disabled="" type="checkbox">/g,
    '<input $1type="checkbox" class="task-check">');
}

// Source line forms marked turns into a task checkbox: -, *, + or N. / N)
// bullets followed by [ ], [x] or [X]. The Nth box in the preview maps to the
// Nth such line in document order (marked renders them top-to-bottom).
const TASK_LINE_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)[ xX](\])/;

// Flip the index-th task-list line in the editor source to checked/unchecked.
// replaceRange edits just that line, so cursor/scroll are preserved and the
// codemirror 'change' event fires the normal debounced autosave.
function toggleSourceTask(index, checked) {
  const cm = editor.codemirror;
  const total = cm.lineCount();
  let count = -1;
  for (let i = 0; i < total; i++) {
    const line = cm.getLine(i);
    if (!TASK_LINE_RE.test(line)) continue;
    count++;
    if (count !== index) continue;
    cm.replaceRange(line.replace(TASK_LINE_RE, `$1${checked ? 'x' : ' '}$2`),
      { line: i, ch: 0 }, { line: i, ch: line.length });
    return;
  }
}

// Clicking a checkbox in the rendered preview toggles its source line. Delegated
// because EasyMDE rebuilds the preview DOM each time it's shown; the box's own
// native toggle handles the visual state, we just sync the markdown behind it.
document.addEventListener('change', (e) => {
  const box = e.target;
  if (!(box instanceof HTMLInputElement) || !box.classList.contains('task-check')) return;
  const container = box.closest('.editor-preview, .editor-preview-side');
  if (!container) return;
  const boxes = Array.from(container.querySelectorAll('input.task-check'));
  const idx = boxes.indexOf(box);
  if (idx >= 0) toggleSourceTask(idx, box.checked);
});

// Called by EasyMDE for button/paste/drag uploads. onSuccess(url) inserts the
// markdown image; onError(msg) shows a message in EasyMDE's status line.
async function uploadImage(file, onSuccess, onError) {
  try {
    const form = new FormData();
    form.append('image', file);
    const res = await fetch('/api/images', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { onError(data.error || 'upload failed'); return; }
    onSuccess(data.url);
  } catch (e) {
    onError('upload failed');
  }
}

// --- theme (dark / light) -------------------------------------------------
// The <head> init script already applied the saved theme to avoid a flash;
// here we sync the Settings toggle and handle switching. Choice persists in
// localStorage (a per-device display preference) and applies immediately.
const setDarkMode = document.getElementById('setDarkMode');
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
function applyTheme(theme) {
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  if (setDarkMode) setDarkMode.checked = theme === 'dark';
  try { localStorage.setItem('theme', theme); } catch (e) { /* ignore */ }
}
setDarkMode.addEventListener('change', () => applyTheme(setDarkMode.checked ? 'dark' : 'light'));
applyTheme(currentTheme()); // sync the toggle to the pre-applied theme

const datePicker = document.getElementById('datePicker');
const searchBox = document.getElementById('searchBox');
const searchResults = document.getElementById('searchResults');
const noteList = document.getElementById('noteList');
const currentDateEl = document.getElementById('currentDate');
const statusEl = document.getElementById('status');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const showArchived = document.getElementById('showArchived');
const notesHeading = document.getElementById('notesHeading');
const tagList = document.getElementById('tagList');
const clearTagBtn = document.getElementById('clearTagBtn');
const noteTagsEl = document.getElementById('noteTags');
const refList = document.getElementById('refList');
const newRefBtn = document.getElementById('newRefBtn');
const newFolderBtn = document.getElementById('newFolderBtn');
const renameRefBtn = document.getElementById('renameRefBtn');
const deleteRefBtn = document.getElementById('deleteRefBtn');

// --- editor change -> debounced autosave ----------------------------------
editor.codemirror.on('change', () => {
  if (loading) return;
  statusEl.textContent = 'editing…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 800);
});

// Route autosave to the daily note or reference note currently in the editor.
async function save() {
  return mode === 'reference' ? saveReference() : saveDaily();
}

async function saveDaily() {
  const content = editor.value();
  statusEl.textContent = 'saving…';
  try {
    const res = await fetch(`/api/notes/${currentDate}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const saved = await res.json().catch(() => ({}));
    statusEl.textContent = 'saved ✓';
    renderNoteTags(saved.tags);
    refreshTagList();
    refreshNoteList();
  } catch (e) {
    statusEl.textContent = 'save failed';
  }
}

async function saveReference() {
  if (!currentRef) return;
  const content = editor.value();
  statusEl.textContent = 'saving…';
  try {
    await fetch(`/api/references/${currentRef.slug}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    statusEl.textContent = 'saved ✓';
    refreshRefList();
  } catch (e) {
    statusEl.textContent = 'save failed';
  }
}

// --- load a day -----------------------------------------------------------
async function loadDate(date) {
  // flush any pending edits for the day we're leaving
  clearTimeout(saveTimer);
  if (!loading && editor.value()) await save();

  currentRef = null;
  setMode('daily');
  currentDate = date;
  datePicker.value = date;
  currentDateEl.textContent = formatHeading(date);
  loading = true;
  try {
    const res = await fetch(`/api/notes/${date}`);
    const doc = await res.json();
    setPreview(false); // edit mode so value() refreshes the preview cleanly
    editor.value(doc.content || '');
    statusEl.textContent = doc.updatedAt ? 'loaded' : 'new note';
    renderNoteTags(doc.tags);
    // Open existing notes in preview; keep empty/new notes in edit mode to type.
    setPreview(!!(doc.content || '').trim());
  } finally {
    loading = false;
  }
  // If we jumped into a collapsed month (date picker / search), open it so the
  // active day is visible; re-render only when it was actually closed.
  const mk = monthKey(date);
  if (!expandedMonths.has(mk)) {
    expandedMonths.add(mk);
    await refreshNoteList();
  } else {
    highlightActive();
  }
  closeDrawer(); // on mobile, dismiss the drawer once a day is opened
  syncHash();
}

function formatHeading(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

// --- sidebar: all notes (grouped by month) --------------------------------
// Daily notes are grouped under collapsible "Month YYYY" headers so the list
// stays navigable as the journal grows. Which months are open is tracked here,
// seeded once with the current date's month; the rest start collapsed.
const expandedMonths = new Set();
let monthsInitialized = false;

function monthKey(date) { return date.slice(0, 7); } // "2026-06"
// True for Sat/Sun. Parse the Y-M-D parts into a LOCAL date (not new Date(str),
// which parses as UTC and can shift the weekday across the date line).
function isWeekend(date) {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(y, m - 1, d).getDay(); // 0 Sun … 6 Sat
  return day === 0 || day === 6;
}
function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function toggleMonth(key) {
  if (expandedMonths.has(key)) expandedMonths.delete(key);
  else expandedMonths.add(key);
  refreshNoteList(); // re-render with the new open/closed state
}

async function refreshNoteList() {
  const archived = showArchived.checked;
  const url = `/api/notes?archived=${archived}` + (activeTag ? `&tag=${encodeURIComponent(activeTag)}` : '');
  const res = await fetch(url);
  const docs = await res.json();
  notesHeading.textContent = activeTag
    ? `Tagged #${activeTag}`
    : (archived ? 'Archived notes' : 'All notes');
  if (!monthsInitialized) { expandedMonths.add(monthKey(currentDate)); monthsInitialized = true; }
  // When filtering by tag, matches can live in months that are collapsed; open
  // every month with a hit so the filtered list is fully visible.
  if (activeTag) docs.forEach((d) => expandedMonths.add(monthKey(d.date)));
  noteList.innerHTML = '';
  if (!docs.length) {
    const li = document.createElement('li');
    li.textContent = activeTag ? `No notes tagged #${activeTag}` : (archived ? 'No archived notes' : 'No notes yet');
    li.className = 'empty';
    noteList.appendChild(li);
    return;
  }
  // Group by year-month, preserving the API's newest-first order.
  const groups = [];
  const byKey = new Map();
  for (const doc of docs) {
    const key = monthKey(doc.date);
    let g = byKey.get(key);
    if (!g) { g = { key, docs: [] }; byKey.set(key, g); groups.push(g); }
    g.docs.push(doc);
  }
  for (const g of groups) {
    const expanded = expandedMonths.has(g.key);
    const groupLi = document.createElement('li');
    groupLi.className = 'month-group' + (expanded ? '' : ' collapsed');

    const header = document.createElement('div');
    header.className = 'month-header';
    header.innerHTML = '<span class="caret">▾</span><span class="month-name"></span><span class="month-count"></span>';
    header.querySelector('.month-name').textContent = monthLabel(g.key);
    header.querySelector('.month-count').textContent = g.docs.length;
    header.onclick = () => toggleMonth(g.key);
    groupLi.appendChild(header);

    const sub = document.createElement('ul');
    sub.className = 'month-notes';
    const viewingArchived = showArchived.checked;
    for (const doc of g.docs) {
      const li = document.createElement('li');
      li.dataset.date = doc.date;
      // Color-code by day of week: workdays (Mon–Fri) tend to be work notes,
      // weekends (Sat/Sun) personal. CSS paints workday/weekend backgrounds.
      li.classList.add(isWeekend(doc.date) ? 'weekend' : 'workday');
      li.onclick = () => loadDate(doc.date);
      const label = document.createElement('span');
      label.className = 'note-date';
      label.textContent = doc.date;
      // Per-day archive (or restore, when viewing the archived list).
      const arch = document.createElement('button');
      arch.className = 'note-archive';
      arch.textContent = viewingArchived ? '♻' : '🗄';
      arch.title = viewingArchived ? 'Restore this day' : 'Archive this day';
      arch.onclick = (e) => { e.stopPropagation(); archiveDate(doc.date, viewingArchived); };
      li.append(label, arch);
      sub.appendChild(li);
    }
    groupLi.appendChild(sub);
    noteList.appendChild(groupLi);
  }
  highlightActive();
}

showArchived.addEventListener('change', refreshNoteList);

// --- tags -----------------------------------------------------------------
// Notes are tagged with inline #hashtags in their markdown; the server extracts
// them on save. This sidebar section lists every tag with a usage count, and
// clicking one filters the note list to notes carrying that tag.
let activeTag = null;

async function refreshTagList() {
  let tags = [];
  try { tags = await (await fetch('/api/tags')).json(); } catch { tags = []; }
  tagList.innerHTML = '';
  if (!tags.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No tags yet — add #tags in a note';
    tagList.appendChild(li);
    return;
  }
  for (const t of tags) {
    const li = document.createElement('li');
    li.className = 'tag-item' + (t.tag === activeTag ? ' active' : '');
    li.dataset.tag = t.tag;
    const name = document.createElement('span');
    name.className = 'tag-name';
    name.textContent = `#${t.tag}`;
    const count = document.createElement('span');
    count.className = 'tag-count';
    count.textContent = t.count;
    li.append(name, count);
    li.onclick = () => filterByTag(t.tag);
    tagList.appendChild(li);
  }
}

// Toggle a tag filter: clicking the active tag clears it.
function filterByTag(tag) {
  activeTag = (activeTag === tag) ? null : tag;
  clearTagBtn.hidden = !activeTag;
  tagList.querySelectorAll('li[data-tag]').forEach((li) => {
    li.classList.toggle('active', li.dataset.tag === activeTag);
  });
  refreshNoteList();
}

function clearTag() {
  if (!activeTag) return;
  activeTag = null;
  clearTagBtn.hidden = true;
  tagList.querySelectorAll('li[data-tag]').forEach((li) => li.classList.remove('active'));
  refreshNoteList();
}
clearTagBtn.addEventListener('click', clearTag);

// Render the current note's own tags as clickable chips under the header. Daily
// notes only; hidden when there are none or when a reference note is open.
function renderNoteTags(tags) {
  noteTagsEl.innerHTML = '';
  if (mode !== 'daily' || !tags || !tags.length) { noteTagsEl.hidden = true; return; }
  for (const t of tags) {
    const chip = document.createElement('button');
    chip.className = 'note-tag-chip';
    chip.textContent = `#${t}`;
    chip.title = `Show notes tagged #${t}`;
    chip.onclick = () => filterByTag(t);
    noteTagsEl.appendChild(chip);
  }
  noteTagsEl.hidden = false;
}

// Archive (or restore) a specific day from the note list.
async function archiveDate(date, unarchive) {
  const action = unarchive ? 'unarchive' : 'archive';
  const res = await fetch(`/api/notes/${date}/${action}`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    statusEl.textContent = `⚠️ ${data.error || 'archive failed'}`;
    return;
  }
  statusEl.textContent = unarchive ? `restored ${date}` : `archived ${date}`;
  await refreshNoteList();
}

function highlightActive() {
  // Date items are now nested inside month groups, so query them by attribute.
  noteList.querySelectorAll('li[data-date]').forEach((li) => {
    li.classList.toggle('active', mode === 'daily' && li.dataset.date === currentDate);
  });
  refList.querySelectorAll('li[data-slug]').forEach((li) => {
    li.classList.toggle('active', mode === 'reference' && currentRef && li.dataset.slug === currentRef.slug);
  });
}

// --- reference notes ------------------------------------------------------
// Toggle the header controls that apply to each note kind.
function setMode(m) {
  mode = m;
  const isRef = m === 'reference';
  renameRefBtn.hidden = !isRef;
  deleteRefBtn.hidden = !isRef;
  // The note-tags bar is for daily notes only; hide it in reference mode.
  if (isRef) { noteTagsEl.innerHTML = ''; noteTagsEl.hidden = true; }
}

// Folder collapse state (membership = collapsed, so new folders default open).
// The Ungrouped pseudo-folder uses this sentinel id.
const collapsedFolders = new Set();
const UNGROUPED = '__ungrouped__';
function toggleFolder(id) {
  if (collapsedFolders.has(id)) collapsedFolders.delete(id);
  else collapsedFolders.add(id);
  refreshRefList();
}

// One sidebar row for a reference note: title + a "move to folder" select and
// the ✎ rename button (both revealed on hover). The select/rename stop click
// propagation so they don't also trigger the row's open-note handler.
function makeRefRow(doc, folderList) {
  const li = document.createElement('li');
  li.dataset.slug = doc.slug;

  const name = document.createElement('span');
  name.className = 'ref-name';
  name.textContent = doc.title;

  const move = document.createElement('select');
  move.className = 'ref-move';
  move.title = 'Move to folder';
  const optU = document.createElement('option');
  optU.value = ''; optU.textContent = '📁 Ungrouped';
  move.appendChild(optU);
  for (const f of folderList) {
    const o = document.createElement('option');
    o.value = f.id; o.textContent = f.name;
    move.appendChild(o);
  }
  move.value = doc.folder || '';
  move.onclick = (e) => e.stopPropagation();
  move.onchange = (e) => { e.stopPropagation(); moveReference(doc.slug, move.value); };

  const renameBtn = document.createElement('button');
  renameBtn.className = 'ref-rename';
  renameBtn.textContent = '✎';
  renameBtn.title = 'Rename this reference note';
  renameBtn.onclick = (e) => { e.stopPropagation(); renameReference(doc.slug, doc.title); };

  li.append(name, move, renameBtn);
  li.onclick = () => loadReference(doc.slug);
  return li;
}

// A collapsible folder group (mirrors the daily list's month groups). Real
// folders get rename/delete buttons; the Ungrouped group does not.
function renderRefGroup(id, name, notes, deletable, folderList) {
  const expanded = !collapsedFolders.has(id);
  const groupLi = document.createElement('li');
  groupLi.className = 'ref-group' + (expanded ? '' : ' collapsed');

  const header = document.createElement('div');
  header.className = 'ref-group-header';
  const caret = document.createElement('span'); caret.className = 'caret'; caret.textContent = '▾';
  const icon = document.createElement('span'); icon.className = 'ref-group-icon'; icon.textContent = expanded ? '📂' : '📁';
  const nm = document.createElement('span'); nm.className = 'ref-group-name'; nm.textContent = name;
  const count = document.createElement('span'); count.className = 'ref-group-count'; count.textContent = notes.length;
  header.append(caret, icon, nm, count);
  if (deletable) {
    const ren = document.createElement('button');
    ren.className = 'ref-group-btn'; ren.textContent = '✎'; ren.title = 'Rename folder';
    ren.onclick = (e) => { e.stopPropagation(); renameFolder(id, name); };
    const del = document.createElement('button');
    del.className = 'ref-group-btn'; del.textContent = '✕'; del.title = 'Delete folder';
    del.onclick = (e) => { e.stopPropagation(); deleteFolder(id, name); };
    header.append(ren, del);
  }
  header.onclick = () => toggleFolder(id);
  groupLi.appendChild(header);

  const sub = document.createElement('ul');
  sub.className = 'ref-group-notes';
  for (const doc of notes) sub.appendChild(makeRefRow(doc, folderList));
  groupLi.appendChild(sub);
  return groupLi;
}

async function refreshRefList() {
  const [refRes, folRes] = await Promise.all([fetch('/api/references'), fetch('/api/folders')]);
  const docs = await refRes.json();
  const folderList = await folRes.json();
  refList.innerHTML = '';

  if (!docs.length && !folderList.length) {
    const li = document.createElement('li');
    li.textContent = 'No reference notes';
    li.className = 'ref-empty';
    refList.appendChild(li);
    highlightActive();
    return;
  }

  // No folders yet → keep the simple flat list to avoid sidebar clutter.
  if (!folderList.length) {
    for (const doc of docs) refList.appendChild(makeRefRow(doc, folderList));
    highlightActive();
    return;
  }

  // Group notes by folder; an unknown/missing folder id falls into Ungrouped.
  const validIds = new Set(folderList.map((f) => f.id));
  const byFolder = new Map();
  const ungrouped = [];
  for (const doc of docs) {
    if (doc.folder && validIds.has(doc.folder)) {
      if (!byFolder.has(doc.folder)) byFolder.set(doc.folder, []);
      byFolder.get(doc.folder).push(doc);
    } else {
      ungrouped.push(doc);
    }
  }
  for (const f of folderList) {
    refList.appendChild(renderRefGroup(f.id, f.name, byFolder.get(f.id) || [], true, folderList));
  }
  if (ungrouped.length) {
    refList.appendChild(renderRefGroup(UNGROUPED, 'Ungrouped', ungrouped, false, folderList));
  }
  highlightActive();
}

// Move a reference into a folder (id) or out of all folders ('' / null).
async function moveReference(slug, folderId) {
  const res = await fetch(`/api/references/${slug}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder: folderId || null }),
  });
  if (!res.ok) { statusEl.textContent = '⚠️ move failed'; return; }
  refreshRefList();
}

async function createFolder() {
  const name = prompt('New folder name:');
  if (!name || !name.trim()) return;
  const res = await fetch('/api/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim() }),
  });
  if (!res.ok) { statusEl.textContent = '⚠️ folder create failed'; return; }
  refreshRefList();
}

async function renameFolder(id, oldName) {
  const name = prompt('Rename folder:', oldName);
  if (!name || !name.trim() || name.trim() === oldName) return;
  const res = await fetch(`/api/folders/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim() }),
  });
  if (!res.ok) { statusEl.textContent = '⚠️ rename failed'; return; }
  refreshRefList();
}

async function deleteFolder(id, name) {
  if (!confirm(`Delete folder “${name}”? Its notes move to Ungrouped (they are not deleted).`)) return;
  const res = await fetch(`/api/folders/${id}`, { method: 'DELETE' });
  if (!res.ok) { statusEl.textContent = '⚠️ delete failed'; return; }
  refreshRefList();
}

// Prompt-rename a reference note by slug (the slug itself never changes, so
// links/backups stay intact). Shared by the sidebar ✎ and the header Rename
// button. Syncs the open-note header too when the renamed note is the open one.
async function renameReference(slug, oldTitle) {
  const title = prompt('Rename reference note:', oldTitle);
  if (!title || !title.trim() || title.trim() === oldTitle) return;
  const res = await fetch(`/api/references/${slug}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title.trim() }),
  });
  if (!res.ok) { statusEl.textContent = '⚠️ rename failed'; return; }
  if (currentRef && currentRef.slug === slug) {
    currentRef.title = title.trim();
    currentDateEl.textContent = currentRef.title;
  }
  refreshRefList();
}

async function loadReference(slug) {
  // flush any pending edits for the note we're leaving
  clearTimeout(saveTimer);
  if (!loading && editor.value()) await save();

  loading = true;
  try {
    const res = await fetch(`/api/references/${slug}`);
    if (!res.ok) { statusEl.textContent = '⚠️ reference not found'; return; }
    const doc = await res.json();
    currentRef = { slug: doc.slug, title: doc.title };
    setMode('reference');
    currentDateEl.textContent = doc.title;
    setPreview(false); // edit mode so value() refreshes the preview cleanly
    editor.value(doc.content || '');
    statusEl.textContent = 'loaded';
    setPreview(!!(doc.content || '').trim());
  } finally {
    loading = false;
  }
  highlightActive();
  closeDrawer(); // on mobile, dismiss the drawer once a reference is opened
  syncHash();
}

newRefBtn.addEventListener('click', async () => {
  const title = prompt('Title for the new reference note:');
  if (!title || !title.trim()) return;
  const res = await fetch('/api/references', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title.trim() }),
  });
  if (!res.ok) { statusEl.textContent = '⚠️ could not create reference'; return; }
  const doc = await res.json();
  await refreshRefList();
  loadReference(doc.slug);
});

newFolderBtn.addEventListener('click', createFolder);

renameRefBtn.addEventListener('click', () => {
  if (!currentRef) return;
  renameReference(currentRef.slug, currentRef.title);
});

deleteRefBtn.addEventListener('click', async () => {
  if (!currentRef) return;
  if (!confirm(`Delete reference note “${currentRef.title}”? This cannot be undone.`)) return;
  const res = await fetch(`/api/references/${currentRef.slug}`, { method: 'DELETE' });
  if (!res.ok) { statusEl.textContent = '⚠️ delete failed'; return; }
  currentRef = null; // discard the editor's now-deleted content
  await refreshRefList();
  loadDate(todayISO());
});

// --- search ---------------------------------------------------------------
let searchTimer = null;
searchBox.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 300);
});

async function runSearch() {
  const q = searchBox.value.trim();
  if (!q) { searchResults.innerHTML = ''; return; }
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const results = await res.json();
  searchResults.innerHTML = '';
  if (!results.length) {
    const li = document.createElement('li');
    li.textContent = 'No matches';
    li.style.color = '#8a91a0';
    searchResults.appendChild(li);
    return;
  }
  for (const r of results) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="r-date">${r.date}</div><div class="r-snippet"></div>`;
    li.querySelector('.r-snippet').textContent = r.snippet;
    li.onclick = () => loadDate(r.date);
    searchResults.appendChild(li);
  }
}

// --- summarize (local Ollama) ---------------------------------------------
const summarizeBtn = document.getElementById('summarizeBtn');
const summaryPanel = document.getElementById('summaryPanel');
const summaryBody = document.getElementById('summaryBody');
const summaryModel = document.getElementById('summaryModel');
const modelSelect = document.getElementById('modelSelect');
const insertSummaryBtn = document.getElementById('insertSummary');
document.getElementById('closeSummary').onclick = () => { summaryPanel.hidden = true; };

let lastSummary = '';

// Populate the model dropdown from the local Ollama install.
async function loadModels() {
  try {
    const res = await fetch('/api/models');
    const { models, default: def } = await res.json();
    modelSelect.innerHTML = '';
    const list = models.length ? models : [def];
    for (const name of list) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === def) opt.selected = true;
      modelSelect.appendChild(opt);
    }
  } catch (e) {
    modelSelect.innerHTML = '<option>(models unavailable)</option>';
  }
}

// Append the summary into the current note under a heading, then save.
insertSummaryBtn.addEventListener('click', () => {
  if (!lastSummary) return;
  const existing = editor.value();
  const block = `\n\n## Summary\n\n${lastSummary}\n`;
  editor.value(existing.trimEnd() + block);
  save();
  summaryPanel.hidden = true;
});

summarizeBtn.addEventListener('click', async () => {
  const content = editor.value().trim();
  if (!content) { return; }
  summarizeBtn.disabled = true;
  summarizeBtn.textContent = '… summarizing';
  summaryPanel.hidden = false;
  summaryModel.textContent = '';
  summaryBody.textContent = 'Working…';
  insertSummaryBtn.hidden = true;
  lastSummary = '';
  try {
    const res = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, model: modelSelect.value }),
    });
    if (!res.ok) {
      // Errors come back as JSON before any streaming starts.
      const data = await res.json().catch(() => ({}));
      summaryBody.textContent = `⚠️ ${data.error || 'Summarize failed'}${data.detail ? '\n' + data.detail : ''}`;
    } else {
      summaryModel.textContent = `via ${res.headers.get('X-Model') || modelSelect.value}`;
      summaryBody.textContent = '';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        lastSummary += decoder.decode(value, { stream: true });
        summaryBody.textContent = lastSummary;
      }
      lastSummary = lastSummary.trim();
      summaryBody.textContent = lastSummary || '(empty summary)';
      insertSummaryBtn.hidden = !lastSummary;
    }
  } catch (e) {
    summaryBody.textContent = '⚠️ Request failed';
  } finally {
    summarizeBtn.disabled = false;
    summarizeBtn.textContent = '✨ Summarize';
  }
});

// --- email a note ---------------------------------------------------------
const emailBtn = document.getElementById('emailBtn');
let emailConfig = { configured: false, defaultTo: '' };

async function loadEmailConfig() {
  try {
    const res = await fetch('/api/email/status');
    emailConfig = await res.json();
  } catch (e) {
    emailConfig = { configured: false, defaultTo: '' };
  }
  if (!emailConfig.configured) {
    emailBtn.title = 'Email not configured — set GMAIL_USER and GMAIL_APP_PASSWORD';
  }
}

emailBtn.addEventListener('click', async () => {
  // Flush any pending edit so the emailed copy matches what's on screen.
  clearTimeout(saveTimer);
  if (!loading && editor.value()) await save();

  const kind = mode; // 'daily' | 'reference'
  const id = kind === 'reference' ? (currentRef && currentRef.slug) : currentDate;
  if (!id) return;
  if (!editor.value().trim()) { statusEl.textContent = '⚠️ nothing to email'; return; }
  if (!emailConfig.configured) {
    statusEl.textContent = '⚠️ email not configured (set GMAIL_USER / GMAIL_APP_PASSWORD)';
    return;
  }

  const to = prompt('Email this note to:', emailConfig.defaultTo || '');
  if (!to || !to.trim()) return;

  statusEl.textContent = 'emailing…';
  emailBtn.disabled = true;
  try {
    const res = await fetch('/api/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, id, to: to.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      statusEl.textContent = `⚠️ ${data.error || 'email failed'}${data.detail ? ': ' + data.detail : ''}`;
      return;
    }
    statusEl.textContent = `emailed to ${data.to} ✓`;
  } catch (e) {
    statusEl.textContent = '⚠️ email failed';
  } finally {
    emailBtn.disabled = false;
  }
});

// --- tickers (news headlines + sports scores) -----------------------------
const newsTicker = document.getElementById('newsTicker');
const newsTrack = document.getElementById('newsTrack');
const scoresTicker = document.getElementById('scoresTicker');
const scoresTrack = document.getElementById('scoresTrack');
const NEWS_POLL_MS = 5 * 60 * 1000; // headlines change slowly
const SCORES_POLL_MS = 60 * 1000; // scores change fast

// The tickers are position:fixed at the bottom, so reserve matching space on
// the app area to keep content from hiding behind them. The footer height
// changes as rows show/hide, so track it and keep the padding in sync.
const tickersEl = document.getElementById('tickers');
const appEl = document.getElementById('app');
function reserveTickerSpace() {
  // Footer height + a small gap so the editor's bottom clears the tickers.
  appEl.style.paddingBottom = tickersEl.offsetHeight + 8 + 'px';
}
new ResizeObserver(reserveTickerSpace).observe(tickersEl);

// Build one copy of a ticker's items (tag + text + bullet separators) as DOM
// nodes. textContent (not innerHTML) keeps feed/score text safe from injection.
// Each item: { tag, text, link, live? }.
function buildTickerCopy(items) {
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const a = document.createElement('a');
    a.className = it.live ? 'ticker-item live' : 'ticker-item';
    a.href = it.link || '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const tag = document.createElement('span');
    tag.className = 'src';
    tag.textContent = it.tag;
    a.appendChild(tag);
    a.appendChild(document.createTextNode(it.text));
    frag.appendChild(a);
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '•';
    frag.appendChild(sep);
  }
  return frag;
}

// Scroll speeds in px/s. News runs 15% slower than scores for easier reading.
const SCORES_SPEED = 70;
const NEWS_SPEED = SCORES_SPEED * 0.85;

// Fill one ticker row. Hides the row when there's nothing to show. `pxPerSec`
// sets the scroll speed (steady regardless of how many/long the items are).
function fillTicker(trackEl, tickerEl, items, pxPerSec) {
  trackEl.innerHTML = '';
  if (!items.length) { tickerEl.hidden = true; return; }
  // Two copies back-to-back so the -50% scroll loops seamlessly.
  trackEl.appendChild(buildTickerCopy(items));
  trackEl.appendChild(buildTickerCopy(items));
  tickerEl.hidden = false;
  trackEl.dataset.pps = pxPerSec; // remember speed so we can recompute on resize
  requestAnimationFrame(() => setTickerDuration(trackEl));
}

// Derive the scroll duration from the track's real content width so speed stays
// a steady px/s. Skips while the track is hidden (scrollWidth 0) so it never
// locks in a bogus 20s — that was making the ticker race after rotating from a
// portrait view where the bar was hidden.
function setTickerDuration(trackEl) {
  const pps = Number(trackEl.dataset.pps || 0);
  const oneCopy = trackEl.scrollWidth / 2;
  if (pps > 0 && oneCopy > 0) {
    trackEl.style.animationDuration = Math.max(20, Math.round(oneCopy / pps)) + 's';
  }
}

// Re-derive ticker speed after an orientation/size change (debounced).
let tickerResizeTimer = null;
function recomputeTickers() {
  clearTimeout(tickerResizeTimer);
  tickerResizeTimer = setTimeout(() => {
    setTickerDuration(newsTrack);
    setTickerDuration(scoresTrack);
  }, 200);
}
window.addEventListener('resize', recomputeTickers);
window.addEventListener('orientationchange', recomputeTickers);

async function refreshNews() {
  try {
    const data = await (await fetch('/api/news')).json();
    fillTicker(newsTrack, newsTicker, (data.items || []).map((i) => ({ tag: i.source, text: i.title, link: i.link })), NEWS_SPEED);
  } catch (e) {
    // Leave whatever's currently scrolling; try again next poll.
  }
}

async function refreshScores() {
  try {
    const data = await (await fetch('/api/scores')).json();
    fillTicker(scoresTrack, scoresTicker, (data.games || []).map((g) => ({ tag: g.league, text: g.text, link: g.link, live: g.live })), SCORES_SPEED);
  } catch (e) {
    // Leave whatever's currently scrolling; try again next poll.
  }
}

// Show/hide the whole ticker bar and start/stop polling to match. Persisted as
// the showTickers setting.
let newsTimer = null;
let scoresTimer = null;
function applyTickerVisibility(show) {
  tickersEl.hidden = !show;
  if (show) {
    refreshNews();
    refreshScores();
    if (!newsTimer) newsTimer = setInterval(refreshNews, NEWS_POLL_MS);
    if (!scoresTimer) scoresTimer = setInterval(refreshScores, SCORES_POLL_MS);
  } else {
    clearInterval(newsTimer);
    clearInterval(scoresTimer);
    newsTimer = scoresTimer = null;
  }
  reserveTickerSpace(); // 0 when hidden, footer height when shown
}

// --- settings -------------------------------------------------------------
const settingsBtn = document.getElementById('settingsBtn');
const settingsOverlay = document.getElementById('settingsOverlay');
const setDefaultModel = document.getElementById('setDefaultModel');
const setBackupSchedule = document.getElementById('setBackupSchedule');
const setBackupHour = document.getElementById('setBackupHour');
const setEmailTo = document.getElementById('setEmailTo');
const setNewsCount = document.getElementById('setNewsCount');
const setShowTickers = document.getElementById('setShowTickers');
const setNewsSources = document.getElementById('setNewsSources');
const lastBackupVal = document.getElementById('lastBackupVal');
const settingsStatus = document.getElementById('settingsStatus');

// "Jun 18, 2026, 4:37 AM (2h ago)" — absolute time plus a relative hint.
function formatBackupTime(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  let rel;
  if (mins < 1) rel = 'just now';
  else if (mins < 60) rel = `${mins} min ago`;
  else if (mins < 1440) rel = `${Math.round(mins / 60)}h ago`;
  else rel = `${Math.round(mins / 1440)}d ago`;
  return `${d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} (${rel})`;
}

// Sources <-> textarea. Each line is "Name | URL" (name optional: a bare URL is
// fine and the server derives a name from the feed/host). Blank and #-comment
// lines are ignored.
function sourcesToText(sources) {
  return (sources || []).map((s) => (s.name ? `${s.name} | ${s.url}` : s.url)).join('\n');
}
function textToSources(text) {
  return text.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const i = line.indexOf('|');
      if (i === -1) return { name: '', url: line };
      return { name: line.slice(0, i).trim(), url: line.slice(i + 1).trim() };
    })
    .filter((s) => s.url);
}

// Populate the hour dropdown once (00:00 – 23:00).
for (let h = 0; h < 24; h++) {
  const opt = document.createElement('option');
  opt.value = h;
  opt.textContent = `${String(h).padStart(2, '0')}:00`;
  setBackupHour.appendChild(opt);
}

document.getElementById('closeSettings').onclick = () => { settingsOverlay.hidden = true; };
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) settingsOverlay.hidden = true;
});

settingsBtn.addEventListener('click', async () => {
  settingsStatus.textContent = '';
  // Mirror the model dropdown options into the settings select.
  setDefaultModel.innerHTML = modelSelect.innerHTML;
  const res = await fetch('/api/settings');
  const s = await res.json();
  setDefaultModel.value = s.defaultModel;
  setBackupSchedule.checked = s.backupSchedule === 'on';
  setBackupHour.value = s.backupHour;
  setEmailTo.value = s.emailTo || '';
  setNewsCount.value = s.newsCount != null ? s.newsCount : 3;
  setShowTickers.checked = s.showTickers !== false;
  setNewsSources.value = sourcesToText(s.newsSources);
  lastBackupVal.textContent = formatBackupTime(s.lastBackupAt);
  settingsOverlay.hidden = false;
});

document.getElementById('saveSettings').addEventListener('click', async () => {
  settingsStatus.textContent = 'saving…';
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      defaultModel: setDefaultModel.value,
      backupSchedule: setBackupSchedule.checked ? 'on' : 'off',
      backupHour: Number(setBackupHour.value),
      emailTo: setEmailTo.value.trim(),
      newsCount: Number(setNewsCount.value),
      newsSources: textToSources(setNewsSources.value),
      showTickers: setShowTickers.checked,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    settingsStatus.textContent = `⚠️ ${data.error || 'save failed'}`;
    return;
  }
  const s = await res.json();
  settingsStatus.textContent = 'saved ✓';
  // Keep the Email button's prefill in sync with the saved default.
  emailConfig.defaultTo = s.emailTo || '';
  // Apply ticker visibility + a changed count / source list immediately.
  applyTickerVisibility(s.showTickers !== false);
  // Reflect the new default model in the header dropdown selection.
  if ([...modelSelect.options].some((o) => o.value === s.defaultModel)) {
    modelSelect.value = s.defaultModel;
  }
});

document.getElementById('backupNowBtn').addEventListener('click', async () => {
  settingsStatus.textContent = 'backing up…';
  const res = await fetch('/api/backup', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  settingsStatus.textContent = res.ok ? `backed up ${data.count} note(s) ✓` : '⚠️ backup failed';
  if (res.ok) lastBackupVal.textContent = formatBackupTime(data.lastBackupAt || new Date().toISOString());
});

// --- date picker ----------------------------------------------------------
datePicker.addEventListener('change', () => {
  if (datePicker.value) loadDate(datePicker.value);
});

// --- boot -----------------------------------------------------------------
// --- tasks / todo panel ---------------------------------------------------
// (appEl is declared earlier in this file)
const taskPanel = document.getElementById('taskPanel');
const tasksToggleBtn = document.getElementById('tasksToggleBtn');
const taskForm = document.getElementById('taskForm');
const taskInput = document.getElementById('taskInput');
const taskDue = document.getElementById('taskDue');
const taskCat = document.getElementById('taskCat');
const taskFilter = document.getElementById('taskFilter');
const taskList = document.getElementById('taskList');

// Which category to show: 'all' | 'work' | 'personal' (remembered per device).
let taskFilterValue = 'all';
try { taskFilterValue = localStorage.getItem('taskFilter') || 'all'; } catch (e) { /* default all */ }

taskFilter.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-cat]');
  if (!btn) return;
  taskFilterValue = btn.dataset.cat;
  try { localStorage.setItem('taskFilter', taskFilterValue); } catch (err) { /* ignore */ }
  syncTaskFilterButtons();
  refreshTasks();
});

function syncTaskFilterButtons() {
  for (const b of taskFilter.querySelectorAll('button[data-cat]')) {
    b.classList.toggle('active', b.dataset.cat === taskFilterValue);
  }
}
syncTaskFilterButtons(); // reflect the persisted filter on load

// Category metadata: label/icon and the "other" category (for the move button).
const TASK_CATS = {
  work: { label: 'Work', icon: '💼', other: 'personal' },
  personal: { label: 'Personal', icon: '🏠', other: 'work' },
};
const taskCount = document.getElementById('taskCount');
const clearDoneBtn = document.getElementById('clearDoneBtn');

// Show/hide the panel; the open state is a per-device preference.
function applyTasksOpen(open) {
  appEl.classList.toggle('tasks-open', open);
  tasksToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  tasksToggleBtn.classList.toggle('active', open);
  try { localStorage.setItem('tasksOpen', open ? '1' : '0'); } catch (e) { /* ignore */ }
  if (open) refreshTasks();
}
tasksToggleBtn.addEventListener('click', () => applyTasksOpen(!appEl.classList.contains('tasks-open')));

// --- mobile sidebar drawer (PWA) ------------------------------------------
// On phones the sidebar is an off-canvas drawer toggled by the header ☰ button.
// closeDrawer() is also called after picking a note so the editor takes over.
const menuBtn = document.getElementById('menuBtn');
const sidebarEl = document.getElementById('sidebar');
function closeDrawer() { appEl.classList.remove('sidebar-open'); }
if (menuBtn) {
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    appEl.classList.toggle('sidebar-open');
  });
  // Tap outside the open drawer (the dimmed area) to close it.
  document.addEventListener('click', (e) => {
    if (!appEl.classList.contains('sidebar-open')) return;
    if (sidebarEl.contains(e.target) || e.target.closest('#menuBtn')) return;
    closeDrawer();
  });
}

async function refreshTasks() {
  let docs = [];
  try { docs = await (await fetch('/api/tasks')).json(); } catch (e) { return; }
  taskList.innerHTML = '';
  // Apply the category filter (All / Work / Personal).
  const shown = taskFilterValue === 'all'
    ? docs
    : docs.filter((t) => (t.category || 'personal') === taskFilterValue);
  const open = shown.filter((t) => !t.done).length;
  taskCount.textContent = shown.length ? `${open} open` : '';
  clearDoneBtn.hidden = !shown.some((t) => t.done);
  if (!shown.length) {
    const li = document.createElement('li');
    li.className = 'task-empty';
    li.textContent = docs.length ? 'No tasks in this view' : 'No tasks yet';
    taskList.appendChild(li);
    return;
  }
  const today = todayISO();
  // Group into Work and Personal sections (docs are already sorted open-first).
  for (const cat of ['work', 'personal']) {
    const inCat = shown.filter((t) => (t.category || 'personal') === cat);
    if (!inCat.length) continue;
    const meta = TASK_CATS[cat];
    const head = document.createElement('li');
    head.className = 'task-group';
    head.textContent = `${meta.icon} ${meta.label}`;
    const n = document.createElement('span');
    n.className = 'task-group-count';
    n.textContent = `${inCat.filter((t) => !t.done).length} open`;
    head.appendChild(n);
    taskList.appendChild(head);
    for (const t of inCat) taskList.appendChild(renderTask(t, today));
  }
}

// Build one task row.
function renderTask(t, today) {
  const cat = t.category || 'personal';
  const meta = TASK_CATS[cat];
  const overdue = !t.done && t.dueDate && t.dueDate < today;
  const li = document.createElement('li');
  li.className = 'task' + (t.done ? ' done' : '') + (t.dueDate ? ' has-due' : '') + (overdue ? ' overdue' : '');
  li.dataset.id = t.id;

  // Drag handle for manual reordering. Only enabled in the unfiltered 'all'
  // view, where the DOM holds every task (so the saved order stays complete).
  const handle = document.createElement('span');
  handle.className = 'task-handle';
  handle.textContent = '⠿';
  if (taskFilterValue === 'all') {
    handle.draggable = true;
    handle.title = 'Drag to reorder';
    handle.addEventListener('dragstart', (e) => {
      draggingLi = li;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', t.id); } catch (_) { /* required by some browsers */ }
    });
    handle.addEventListener('dragend', () => { li.classList.remove('dragging'); draggingLi = null; persistOrder(); });
  } else {
    handle.classList.add('disabled');
    handle.title = 'Reordering is available in the “All” view';
  }

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = t.done;
  cb.addEventListener('change', () => toggleTask(t.id, cb.checked));

  const main = document.createElement('div');
  main.className = 'task-main';
  const span = document.createElement('span');
  span.className = 'task-text';
  span.textContent = t.text; // textContent — never inject HTML from user text
  span.title = 'Double-click to edit';
  span.addEventListener('dblclick', () => editTask(t, span));
  // Per-task due date: native picker, low-key until set or hovered.
  const due = document.createElement('input');
  due.type = 'date';
  due.className = 'task-due';
  due.value = t.dueDate || '';
  due.title = overdue ? 'Overdue' : 'Due date (optional)';
  due.addEventListener('change', () => setDue(t.id, due.value));
  main.append(span, due);

  // Move to the other category.
  const move = document.createElement('button');
  move.className = 'task-move';
  move.textContent = TASK_CATS[meta.other].icon;
  move.title = `Move to ${TASK_CATS[meta.other].label}`;
  move.addEventListener('click', () => moveTask(t.id, meta.other));

  const del = document.createElement('button');
  del.className = 'task-del';
  del.textContent = '✕';
  del.title = 'Delete task';
  del.addEventListener('click', () => deleteTask(t.id));
  li.append(handle, cb, main, move, del);
  return li;
}

// --- drag-to-reorder ------------------------------------------------------
let draggingLi = null;

// While dragging, move the dragged row to follow the pointer among the others.
taskList.addEventListener('dragover', (e) => {
  if (!draggingLi) return;
  e.preventDefault();
  const after = dragAfterElement(e.clientY);
  if (after == null) taskList.appendChild(draggingLi);
  else taskList.insertBefore(draggingLi, after);
});

// The task row whose midpoint is just below the pointer (insertion target).
function dragAfterElement(y) {
  const rows = [...taskList.querySelectorAll('.task:not(.dragging)')];
  let closest = { offset: -Infinity, element: null };
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: row };
  }
  return closest.element;
}

// Save the current DOM order of all task rows.
async function persistOrder() {
  const ids = [...taskList.querySelectorAll('.task')].map((li) => li.dataset.id);
  if (!ids.length) return;
  await fetch('/api/tasks/reorder', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
  });
  refreshTasks();
}

async function setDue(id, value) {
  await fetch(`/api/tasks/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dueDate: value || null }),
  });
  refreshTasks();
}

async function moveTask(id, category) {
  await fetch(`/api/tasks/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category }),
  });
  refreshTasks();
}

taskForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = taskInput.value.trim();
  if (!text) return;
  const dueDate = taskDue.value || null;
  const category = taskCat.value; // keep the selected category for the next add
  taskInput.value = '';
  taskDue.value = '';
  await fetch('/api/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, dueDate, category }),
  });
  refreshTasks();
});

async function toggleTask(id, done) {
  await fetch(`/api/tasks/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done }),
  });
  refreshTasks();
}

async function deleteTask(id) {
  await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
  refreshTasks();
}

// Inline-edit a task's text on double-click.
function editTask(t, span) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'task-edit';
  input.value = t.text;
  span.replaceWith(input);
  input.focus();
  input.select();
  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const v = input.value.trim();
    if (v && v !== t.text) {
      await fetch(`/api/tasks/${t.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: v }),
      });
    }
    refreshTasks();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { committed = true; refreshTasks(); }
  });
}

clearDoneBtn.addEventListener('click', async () => {
  await fetch('/api/tasks', { method: 'DELETE' });
  refreshTasks();
});

// --- deep links (URL hash) -------------------------------------------------
// #/YYYY-MM-DD links a daily note; #/ref/<slug> links a reference note. Keeping
// the hash in sync makes notes bookmarkable/shareable and powers back/forward.
let suppressHashChange = false;

function currentHash() {
  return mode === 'reference' && currentRef ? `#/ref/${currentRef.slug}` : `#/${currentDate}`;
}

// Reflect the current note in the URL without triggering a reload.
function syncHash() {
  const h = currentHash();
  if (location.hash !== h) {
    suppressHashChange = true; // our own change — don't treat as navigation
    location.hash = h;
  }
}

function parseHash() {
  let m;
  if ((m = location.hash.match(/^#\/ref\/(.+)$/))) return { kind: 'reference', slug: decodeURIComponent(m[1]) };
  if ((m = location.hash.match(/^#\/(\d{4}-\d{2}-\d{2})$/))) return { kind: 'daily', date: m[1] };
  return null;
}

// Load whatever the hash points at. Returns false if the hash isn't a note link.
async function navigateFromHash() {
  const target = parseHash();
  if (!target) return false;
  if (target.kind === 'daily') {
    if (!(mode === 'daily' && currentDate === target.date)) await loadDate(target.date);
  } else if (!(mode === 'reference' && currentRef && currentRef.slug === target.slug)) {
    await loadReference(target.slug);
  }
  return true;
}

window.addEventListener('hashchange', () => {
  if (suppressHashChange) { suppressHashChange = false; return; }
  navigateFromHash();
});

// Copy a shareable link to the current note.
copyLinkBtn.addEventListener('click', async () => {
  syncHash();
  try {
    await navigator.clipboard.writeText(location.href);
    statusEl.textContent = 'link copied ✓';
  } catch (e) {
    statusEl.textContent = location.href; // clipboard blocked — show it to copy manually
  }
});

// --- chatbot (ask your data) ----------------------------------------------
const chatBtn = document.getElementById('chatBtn');
const chatOverlay = document.getElementById('chatOverlay');
const chatMessages = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatModel = document.getElementById('chatModel');

let chatHistory = []; // [{ role, content }] sent to /api/chat each turn
let chatBusy = false;

chatBtn.addEventListener('click', () => {
  chatOverlay.hidden = false;
  chatModel.textContent = modelSelect.value ? `via ${modelSelect.value}` : '';
  if (!chatMessages.children.length) {
    addChatBubble('assistant', 'Ask me anything about your notes, references, or tasks.');
  }
  chatInput.focus();
});
document.getElementById('closeChat').onclick = () => { chatOverlay.hidden = true; };
chatOverlay.addEventListener('click', (e) => { if (e.target === chatOverlay) chatOverlay.hidden = true; });
document.getElementById('clearChat').addEventListener('click', () => {
  chatHistory = [];
  chatMessages.innerHTML = '';
});

function addChatBubble(role, text) {
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  if (role === 'assistant' && window.marked) div.innerHTML = marked.parse(text || '');
  else div.textContent = text || '';
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = chatInput.value.trim();
  if (!q || chatBusy) return;
  chatInput.value = '';
  chatBusy = true;
  addChatBubble('user', q);
  chatHistory.push({ role: 'user', content: q });
  const bubble = addChatBubble('assistant', '');
  bubble.classList.add('streaming');
  bubble.textContent = '…';
  let answer = '';
  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatHistory, model: modelSelect.value }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      bubble.textContent = `⚠️ ${data.error || 'chat failed'}`;
      return;
    }
    if (res.headers.get('X-Model')) chatModel.textContent = `via ${res.headers.get('X-Model')}`;
    bubble.textContent = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      answer += decoder.decode(value, { stream: true });
      bubble.textContent = answer; // plain text while streaming
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    answer = answer.trim();
    if (window.marked) bubble.innerHTML = marked.parse(answer || '_(no answer)_');
    else bubble.textContent = answer || '(no answer)';
    chatHistory.push({ role: 'assistant', content: answer });
  } catch (err) {
    bubble.textContent = '⚠️ request failed';
  } finally {
    bubble.classList.remove('streaming');
    chatBusy = false;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
});

(async function init() {
  try { applyTasksOpen(localStorage.getItem('tasksOpen') === '1'); } catch (e) { /* closed by default */ }
  await loadModels();
  await loadEmailConfig();
  await refreshNoteList();
  await refreshRefList();
  await refreshTagList();
  // Open the note named in the URL hash (shared/bookmarked link), else today.
  if (!(await navigateFromHash())) await loadDate(currentDate);
  // Honor the saved show/hide preference (starts polling only when shown).
  try {
    const s = await (await fetch('/api/settings')).json();
    applyTickerVisibility(s.showTickers !== false);
  } catch (e) {
    applyTickerVisibility(true);
  }
})();
