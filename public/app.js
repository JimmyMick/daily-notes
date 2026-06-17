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

const editor = new EasyMDE({
  element: document.getElementById('editor'),
  spellChecker: false,
  autofocus: true,
  status: false,
  placeholder: 'Write today\'s notes in markdown…',
  toolbar: ['bold', 'italic', 'heading', '|', 'unordered-list', 'ordered-list',
    'code', 'quote', '|', 'link', 'preview', 'side-by-side', 'fullscreen'],
});

const datePicker = document.getElementById('datePicker');
const searchBox = document.getElementById('searchBox');
const searchResults = document.getElementById('searchResults');
const noteList = document.getElementById('noteList');
const currentDateEl = document.getElementById('currentDate');
const statusEl = document.getElementById('status');

// --- editor change -> debounced autosave ----------------------------------
editor.codemirror.on('change', () => {
  if (loading) return;
  statusEl.textContent = 'editing…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 800);
});

async function save() {
  const content = editor.value();
  statusEl.textContent = 'saving…';
  try {
    await fetch(`/api/notes/${currentDate}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    statusEl.textContent = 'saved ✓';
    refreshNoteList();
  } catch (e) {
    statusEl.textContent = 'save failed';
  }
}

// --- load a day -----------------------------------------------------------
async function loadDate(date) {
  // flush any pending edits for the day we're leaving
  clearTimeout(saveTimer);
  if (!loading && editor.value()) await save();

  currentDate = date;
  datePicker.value = date;
  currentDateEl.textContent = formatHeading(date);
  loading = true;
  try {
    const res = await fetch(`/api/notes/${date}`);
    const doc = await res.json();
    editor.value(doc.content || '');
    statusEl.textContent = doc.updatedAt ? 'loaded' : 'new note';
  } finally {
    loading = false;
  }
  highlightActive();
}

function formatHeading(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

// --- sidebar: all notes ---------------------------------------------------
async function refreshNoteList() {
  const res = await fetch('/api/notes');
  const docs = await res.json();
  noteList.innerHTML = '';
  for (const doc of docs) {
    const li = document.createElement('li');
    li.textContent = doc.date;
    li.dataset.date = doc.date;
    li.onclick = () => loadDate(doc.date);
    noteList.appendChild(li);
  }
  highlightActive();
}

function highlightActive() {
  for (const li of noteList.children) {
    li.classList.toggle('active', li.dataset.date === currentDate);
  }
}

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

// --- date picker ----------------------------------------------------------
datePicker.addEventListener('change', () => {
  if (datePicker.value) loadDate(datePicker.value);
});

// --- boot -----------------------------------------------------------------
(async function init() {
  await refreshNoteList();
  await loadDate(currentDate);
})();
