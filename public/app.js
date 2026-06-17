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

// --- date picker ----------------------------------------------------------
datePicker.addEventListener('change', () => {
  if (datePicker.value) loadDate(datePicker.value);
});

// --- boot -----------------------------------------------------------------
(async function init() {
  await loadModels();
  await refreshNoteList();
  await loadDate(currentDate);
})();
