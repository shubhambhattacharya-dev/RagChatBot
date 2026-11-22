/* ============================================
   RAG ChatBot — Frontend Application Logic
   Theme: Light (Exact Screenshot Match) & Pure Dark (Gray & Black, No Blue)
   ============================================ */

const configuredApi = typeof window.RAG_API_BASE === 'string'
  ? window.RAG_API_BASE.trim().replace(/\/$/, '')
  : '';
const isLocalHost = location.protocol === 'file:'
  || /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname);
const isStaticDevServer = isLocalHost && location.port !== '3001';
const localBackend = `http://${location.hostname || 'localhost'}:3001`;
const API = configuredApi || (isStaticDevServer ? localBackend : '');

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const DOC_SCOPE_STORAGE_KEY = 'rag-chatbot-active-document-v1';
const THEME_STORAGE_KEY = 'rag-chatbot-theme-v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let activeRequestController = null;

function apiUrl(path) {
  return `${API}${path}`;
}

function isDocumentId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

async function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeout);
  try {
    return await fetch(url, { ...options, signal: options.signal || controller.signal });
  } finally {
    clearTimeout(timer);
  }
}



// ==================== STATE ====================
const state = {
  docs: [],
  history: [],
  messages: [],
  streaming: false,
  activeDocId: null,
  activeConversationId: 'default-conv-1',
  searchMode: 'hybrid',
  topK: 6,
  theme: 'light',
};

// Initial default conversation matching the user reference image.
// local: true — these are UI placeholders, not server objects: no delete button.
const DEFAULT_CONVERSATIONS = [
  {
    id: 'default-conv-1',
    title: 'New Conversation',
    time: 'Just now',
    messages: [],
    local: true
  }
];

function loadPersistedState() {
  try {
    const savedDocumentId = localStorage.getItem(DOC_SCOPE_STORAGE_KEY);
    state.activeDocId = isDocumentId(savedDocumentId) ? savedDocumentId : null;
    if (savedDocumentId && !state.activeDocId) {
      localStorage.removeItem(DOC_SCOPE_STORAGE_KEY);
    }
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme) {
      state.theme = savedTheme;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      state.theme = 'dark';
    } else {
      state.theme = 'light';
    }
  } catch {
    state.activeDocId = null;
    state.theme = 'light';
  }
}

function persistState() {
  try {
    if (state.activeDocId) localStorage.setItem(DOC_SCOPE_STORAGE_KEY, state.activeDocId);
    else localStorage.removeItem(DOC_SCOPE_STORAGE_KEY);
    localStorage.setItem(THEME_STORAGE_KEY, state.theme);
  } catch {
    // Graceful fallback
  }
}

// ==================== DOM CACHE ====================
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];

const el = {};
function initDOM() {
  el.sidebar = $('#sidebar');
  el.sidebarCollapseBtn = $('#sidebarCollapseBtn');
  el.mobileMenuBtn = $('#mobileMenuBtn');
  el.overlay = $('#sidebarOverlay');
  el.themeToggleBtn = $('#themeToggleBtn');
  el.messages = $('#messages');
  el.welcome = $('#welcomeScreen');
  el.activeMessages = $('#activeMessagesContainer');
  el.chatInput = $('#chatInput');
  el.sendBtn = $('#sendBtn');
  el.stopBtn = $('#stopBtn');
  el.attachBtn = $('#attachBtn');
  el.addDocBtn = $('#addDocBtn');
  el.fileInput = $('#fileInput');
  el.dropZone = $('#dropZone');
  el.fileList = $('#fileList');
  el.docList = $('#docList');
  el.emptyDocsState = $('#emptyDocsState');
  el.docsCount = $('#docsCount');
  el.historyList = $('#historyList');
  el.clearBtn = $('#clearChat');
  el.newConversationBtn = $('#newConversationBtn');
  el.infoBtn = $('#infoBtn');
  el.toast = $('#toastContainer');
  el.statusDot = $('#statusDot');
  el.statusLabel = $('#statusLabel');
  el.followUpBar = $('#followUpBar');
  el.followUpInput = $('#followUpInput');
  el.followUpSendBtn = $('#followUpSendBtn');
  el.followUpAttachBtn = $('#followUpAttachBtn');
  el.searchModeBtn = $('#searchModeBtn');
  el.searchModeMenu = $('#searchModeMenu');
  el.currentSearchModeText = $('#currentSearchModeText');
  el.topKBtn = $('#topKBtn');
  el.topKMenu = $('#topKMenu');
  el.currentTopKText = $('#currentTopKText');
  el.userChip = $('#userChip');
  el.userName = $('#userName');
  el.logoutBtn = $('#logoutBtn');
}
initDOM();
loadPersistedState();

// ==================== VIEW MODE CONTROLLER ====================
// Switches between Welcome (Center Input only) and Active Chat (Messages on top, Followup Bar on bottom)
function setViewMode(mode) {
  if (mode === 'welcome') {
    if (el.welcome) el.welcome.style.display = 'flex';
    if (el.activeMessages) el.activeMessages.style.display = 'none';
    if (el.followUpBar) el.followUpBar.style.display = 'none';
    if (el.chatInput) el.chatInput.focus();
  } else {
    // active chat mode
    if (el.welcome) el.welcome.style.display = 'none';
    if (el.activeMessages) el.activeMessages.style.display = 'flex';
    if (el.followUpBar) el.followUpBar.style.display = 'flex';
    if (el.followUpInput) el.followUpInput.focus();
  }
}

// ==================== THEME CONTROLLER ====================
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  if (el.themeToggleBtn) {
    el.themeToggleBtn.title = theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode';
    el.themeToggleBtn.setAttribute('aria-label', el.themeToggleBtn.title);
  }
  persistState();
}

function toggleTheme() {
  const nextTheme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(nextTheme);
  toast(`Switched to ${nextTheme} mode`, 'success', 1500);
}

if (el.themeToggleBtn) {
  el.themeToggleBtn.addEventListener('click', toggleTheme);
}
applyTheme(state.theme);

// ==================== SIDEBAR COLLAPSE & MOBILE ====================
if (el.sidebarCollapseBtn) {
  el.sidebarCollapseBtn.addEventListener('click', () => {
    el.sidebar.classList.toggle('collapsed');
  });
}

if (el.mobileMenuBtn) {
  el.mobileMenuBtn.addEventListener('click', () => {
    if (window.matchMedia('(max-width: 1023px)').matches) {
      // Drawer mode (tablet/phone): slide the sidebar in over an overlay
      el.sidebar.classList.add('open');
      el.overlay.classList.add('visible');
      document.body.style.overflow = 'hidden';
    } else {
      // Desktop: the header ☰ re-opens a collapsed sidebar
      el.sidebar.classList.remove('collapsed');
    }
  });
}

if (el.overlay) {
  el.overlay.addEventListener('click', () => {
    el.sidebar.classList.remove('open');
    el.overlay.classList.remove('visible');
    document.body.style.overflow = '';
  });
}

if (el.infoBtn) {
  el.infoBtn.addEventListener('click', () => {
    toast('Grounded Engine: Hybrid vector search with pgvector and anti-hallucination gating.', 'success', 3500);
  });
}

// ==================== SEARCH MODE & TOP K DROPDOWNS ====================
function closeAllDropdowns() {
  if (el.searchModeMenu) el.searchModeMenu.classList.remove('open');
  if (el.topKMenu) el.topKMenu.classList.remove('open');
}

if (el.searchModeBtn) {
  el.searchModeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = el.searchModeMenu.classList.contains('open');
    closeAllDropdowns();
    if (!isOpen) el.searchModeMenu.classList.add('open');
  });
}

if (el.searchModeMenu) {
  el.searchModeMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.dropdown-item');
    if (!item) return;
    $$('.dropdown-item', el.searchModeMenu).forEach(d => d.classList.remove('active'));
    item.classList.add('active');
    state.searchMode = item.dataset.value;
    el.currentSearchModeText.textContent = item.textContent.replace(/[💎✨⚡📝]/g, '').trim();
    closeAllDropdowns();
  });
}

if (el.topKBtn) {
  el.topKBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = el.topKMenu.classList.contains('open');
    closeAllDropdowns();
    if (!isOpen) el.topKMenu.classList.add('open');
  });
}

if (el.topKMenu) {
  el.topKMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.dropdown-item');
    if (!item) return;
    $$('.dropdown-item', el.topKMenu).forEach(d => d.classList.remove('active'));
    item.classList.add('active');
    state.topK = parseInt(item.dataset.value, 10) || 6;
    el.currentTopKText.textContent = `Top K: ${state.topK}`;
    closeAllDropdowns();
  });
}

document.addEventListener('click', closeAllDropdowns);

// ==================== UTILITIES ====================
function escapeHTML(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatCurrentTime() {
  const now = new Date();
  return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatHistoryTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function scrollBottom() {
  requestAnimationFrame(() => {
    if (el.messages) el.messages.scrollTop = el.messages.scrollHeight;
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ==================== TOAST ====================
function toast(msg, type = 'success', duration = 3000) {
  if (!el.toast) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  el.toast.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 250);
  }, duration);
}

// ==================== OPEN SANDBOX / GUEST SESSION ====================
function renderUserChip(user) {
  if (!el.userChip) return;
  el.userChip.hidden = false;
  const displayName = user?.name || 'Guest Sandbox';
  if (el.userName) el.userName.textContent = displayName;
}

async function bootstrapAuth() {
  try {
    const r = await fetchWithTimeout(apiUrl('/auth/me'), { credentials: 'include' }, 8000);
    if (r.ok) {
      const user = await r.json();
      renderUserChip(user);
      return true;
    }
  } catch {
    // Offline or network hiccup — visitor still has open sandbox access
  }
  renderUserChip({ name: 'Guest Sandbox' });
  return true;
}

function handleAuthExpired() {
  // In open sandbox mode, refresh session seamlessly without blocking the visitor
  bootstrapAuth();
}

if (el.logoutBtn) {
  el.logoutBtn.addEventListener('click', async () => {
    try {
      await fetchWithTimeout(apiUrl('/auth/reset'), { method: 'POST', credentials: 'include' }, 8000);
    } catch { /* clearing client-side anyway */ }
    toast('Sandbox session reset — starting fresh', 'info', 1500);
    setTimeout(() => {
      window.location.href = apiUrl('/');
    }, 350);
  });
}

// ==================== HEALTH ====================
async function checkHealth() {
  try {
    const r = await fetchWithTimeout(apiUrl('/health'), {}, 4000);
    if (r.ok) {
      el.statusDot.className = 'status-dot connected';
      el.statusLabel.textContent = 'Connected';
      return;
    }
  } catch {
    // fall through to the offline state
  }
  el.statusDot.className = 'status-dot disconnected';
  el.statusLabel.textContent = 'Offline';
}
checkHealth();
setInterval(checkHealth, 20000);

// ==================== INPUT LISTENERS ====================
// 1. Center Hero Input
if (el.chatInput) {
  el.chatInput.addEventListener('input', () => {
    el.chatInput.style.height = 'auto';
    el.chatInput.style.height = Math.min(el.chatInput.scrollHeight, 140) + 'px';
    if (el.sendBtn) el.sendBtn.disabled = !el.chatInput.value.trim() || state.streaming;
  });

  el.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendHeroMessage();
    }
  });
}

if (el.sendBtn) {
  el.sendBtn.addEventListener('click', sendHeroMessage);
}

function sendHeroMessage() {
  const text = el.chatInput.value.trim();
  if (!text || state.streaming) return;
  el.chatInput.value = '';
  el.chatInput.style.height = 'auto';
  if (el.sendBtn) el.sendBtn.disabled = true;
  executeChatMessage(text);
}

// 2. Bottom Follow-up Input
if (el.followUpInput) {
  el.followUpInput.addEventListener('input', () => {
    el.followUpInput.style.height = 'auto';
    el.followUpInput.style.height = Math.min(el.followUpInput.scrollHeight, 100) + 'px';
    if (el.followUpSendBtn) el.followUpSendBtn.disabled = !el.followUpInput.value.trim() || state.streaming;
  });

  el.followUpInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendFollowUpMessage();
    }
  });
}

if (el.followUpSendBtn) {
  el.followUpSendBtn.addEventListener('click', sendFollowUpMessage);
}

function sendFollowUpMessage() {
  const text = el.followUpInput.value.trim();
  if (!text || state.streaming) return;
  el.followUpInput.value = '';
  el.followUpInput.style.height = 'auto';
  if (el.followUpSendBtn) el.followUpSendBtn.disabled = true;
  executeChatMessage(text);
}

// ==================== UPLOAD ====================
if (el.dropZone) {
  el.dropZone.addEventListener('click', () => el.fileInput.click());
  el.dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el.fileInput.click();
    }
  });
  el.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.dropZone.classList.add('drag-over');
  });
  el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('drag-over'));
  el.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    el.dropZone.classList.remove('drag-over');
    handleFiles([...e.dataTransfer.files]);
  });
}

if (el.addDocBtn) el.addDocBtn.addEventListener('click', () => el.fileInput.click());
if (el.attachBtn) el.attachBtn.addEventListener('click', () => el.fileInput.click());
if (el.followUpAttachBtn) el.followUpAttachBtn.addEventListener('click', () => el.fileInput.click());

if (el.fileInput) {
  el.fileInput.addEventListener('change', () => {
    handleFiles([...el.fileInput.files]);
    el.fileInput.value = '';
  });
}

if (el.stopBtn) {
  el.stopBtn.addEventListener('click', () => {
    activeRequestController?.abort(new DOMException('Stopped by user', 'AbortError'));
  });
}

async function handleFiles(files) {
  const validFiles = files.filter((f) => {
    const validExtension = /\.(pdf|docx|txt|md)$/i.test(f.name);
    if (!validExtension) return false;
    if (f.size > MAX_FILE_SIZE) {
      toast(`${f.name} exceeds the 25 MB limit.`, 'error');
      return false;
    }
    if (f.size === 0) {
      toast(`${f.name} is empty.`, 'error');
      return false;
    }
    return true;
  });

  if (validFiles.length !== files.length) {
    toast('Some file types not supported. Use PDF, DOCX, TXT, MD.', 'error');
  }

  for (const file of validFiles) {
    addFileProgressItem(file);
    try {
      const res = await uploadFile(file, (pct) => setFileProgress(file, 'uploading', pct));
      setFileProgress(file, 'indexing');
      pollStatus(res.documentId || res.id, file);
    } catch (error) {
      setFileProgress(file, 'failed');
      toast(`${file.name} upload failed: ${error.message}`, 'error', 5_000);
    }
  }
}

function uploadFile(file, onProgress) {
  // XHR (not fetch) so real upload-bytes progress is possible — no fake percentages.
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/upload'));
    xhr.withCredentials = true; // carry the guest session cookie cross-origin (Live Server dev setup)
    xhr.timeout = 120_000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* empty body */ }
      if (xhr.status === 401) { handleAuthExpired(); reject(new Error('Sign in required')); return; }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(body.error || body.message || `Upload failed (${xhr.status})`));
        return;
      }
      resolve(body);
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.ontimeout = () => reject(new Error('Upload timed out'));
    xhr.send(fd);
  });
}

const uploadTimers = new Map();

function elapsedLabel(startedAt) {
  const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function addFileProgressItem(file) {
  if (!el.fileList) return;
  const existing = [...el.fileList.querySelectorAll('.upload-file-item')]
    .find((item) => item.dataset.name === file.name);
  if (existing) existing.remove();

  const startedAt = Date.now();
  const item = document.createElement('div');
  item.className = 'upload-file-item';
  item.dataset.name = file.name;
  item.innerHTML = `
    <div class="upload-file-main">
      <span class="upload-file-name">${escapeHTML(file.name)}</span>
      <span class="file-status upload-file-status">Uploading · 0% · 0s</span>
    </div>
    <div class="upload-file-bar"><div class="upload-file-bar-fill"></div></div>
  `;
  el.fileList.appendChild(item);

  const timer = setInterval(() => {
    const status = item.querySelector('.upload-file-status');
    if (!status) return;
    const stage = item.dataset.stage || 'Uploading';
    const pct = item.dataset.pct || '';
    status.textContent = pct ? `${stage} · ${pct}% · ${elapsedLabel(startedAt)}` : `${stage} · ${elapsedLabel(startedAt)}`;
  }, 1000);
  uploadTimers.set(file.name, { item, timer, startedAt });
}

function setFileProgress(file, stage, percent) {
  if (!el.fileList) return;
  const item = [...el.fileList.querySelectorAll('.upload-file-item')]
    .find((element) => element.dataset.name === file.name);
  if (!item) return;
  const fill = item.querySelector('.upload-file-bar-fill');
  const status = item.querySelector('.file-status');
  const tracked = uploadTimers.get(file.name);
  const startedAt = tracked ? tracked.startedAt : Date.now();

  if (stage === 'uploading') {
    item.dataset.stage = 'Uploading';
    item.dataset.pct = String(percent ?? 0);
    if (fill) { fill.classList.remove('indeterminate'); fill.style.width = `${percent ?? 0}%`; }
    if (status) status.textContent = `Uploading · ${percent ?? 0}% · ${elapsedLabel(startedAt)}`;
  } else if (stage === 'indexing') {
    item.dataset.stage = 'Indexing';
    item.dataset.pct = '';
    if (fill) fill.classList.add('indeterminate');
    if (status) status.textContent = `Indexing · ${elapsedLabel(startedAt)}`;
  } else if (stage === 'ready') {
    if (tracked) clearInterval(tracked.timer);
    uploadTimers.delete(file.name);
    item.remove();
    toast(`${file.name} indexed in ${elapsedLabel(startedAt)}`, 'success', 2500);
  } else {
    if (tracked) clearInterval(tracked.timer);
    uploadTimers.delete(file.name);
    item.classList.add('failed');
    if (status) status.textContent = `Failed · ${elapsedLabel(startedAt)}`;
  }
}

async function pollStatus(docId, file) {
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    try {
      const r = await fetchWithTimeout(apiUrl(`/document/${encodeURIComponent(docId)}`), { credentials: 'include' }, 10_000);
      if (!r.ok) throw new Error('Unable to retrieve document status');
      const doc = await r.json();
      if (doc.status === 'READY' || doc.status === 'ready') {
        setFileProgress(file, 'ready');
        state.docs.push(doc);
        await loadDocs();
        return;
      }
      if (doc.status === 'FAILED' || doc.status === 'failed') {
        setFileProgress(file, 'failed');
        toast(`Failed to process ${file.name}`, 'error');
        return;
      }
    } catch {
      // Retry
    }
  }
  setFileProgress(file, 'failed');
  toast(`${file.name} timed out`, 'error');
}

// ==================== DOCUMENTS LIST ====================
async function loadDocs() {
  try {
    const r = await fetchWithTimeout(apiUrl('/documents'), { credentials: 'include' }, 10_000);
    if (r.status === 401) return handleAuthExpired();
    if (!r.ok) throw new Error('Failed to load documents');
    const docs = await r.json();
    state.docs = Array.isArray(docs) ? docs : [];
    renderDocs();
  } catch (err) {
    console.warn('Backend documents unavailable, keeping local state', err);
    renderDocs();
  }
}

function formatDocSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderDocs() {
  if (!el.docList) return;
  el.docList.innerHTML = '';

  if (el.docsCount) el.docsCount.textContent = state.docs.length;

  if (state.docs.length === 0) {
    if (el.emptyDocsState) el.emptyDocsState.hidden = false;
    el.docList.hidden = true;
    return;
  }

  if (el.emptyDocsState) el.emptyDocsState.hidden = true;
  el.docList.hidden = false;

  state.docs.forEach((doc) => {
    const ext = (doc.filename.split('.').pop() || 'pdf').toLowerCase();
    const size = formatDocSize(doc.size);
    const isReady = doc.status === 'READY' || doc.status === 'ready';
    const isFailed = doc.status === 'FAILED' || doc.status === 'failed';
    const isActive = doc.id === state.activeDocId;

    const row = document.createElement('div');
    row.className = `doc-row-item${isActive ? ' active' : ''}`;
    row.dataset.id = doc.id;
    row.title = doc.filename;

    let iconType = 'pdf';
    let iconLabel = 'PDF';
    if (ext === 'docx') { iconType = 'docx'; iconLabel = 'DOC'; }
    else if (ext === 'md') { iconType = 'md'; iconLabel = 'MD'; }
    else if (ext === 'txt') { iconType = 'txt'; iconLabel = 'TXT'; }

    row.innerHTML = `
      <div class="doc-left-group">
        <div class="doc-type-icon ${iconType}">
          ${iconLabel}
        </div>
        <div class="doc-text-meta">
          <span class="doc-filename">${escapeHTML(doc.filename)}</span>
          <span class="doc-submeta">${[size, isReady ? 'Indexed' : isFailed ? 'Failed' : 'Indexing…'].filter(Boolean).join(' · ')}</span>
        </div>
      </div>
      <span class="doc-status-dot ${isReady ? 'ready' : isFailed ? 'failed' : 'indexing'}" title="${isReady ? 'Ready' : 'Indexing'}"></span>
      <button class="doc-delete-btn" title="Delete document" aria-label="Delete document">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M3 4.5H13M5.5 4.5V3C5.5 2.5 5.8 2 6.5 2H9.5C10.2 2 10.5 2.5 10.5 3V4.5M12 4.5V13C12 13.5 11.5 14 11 14H5C4.5 14 4 13.5 4 13V4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
      </button>
    `;

    row.addEventListener('click', (e) => {
      if (e.target.closest('.doc-delete-btn')) return;
      state.activeDocId = state.activeDocId === doc.id ? null : doc.id;
      persistState();
      renderDocs();
      toast(state.activeDocId ? `Filter: ${doc.filename}` : 'Search scope: All Documents', 'success', 1500);
    });

    const delBtn = row.querySelector('.doc-delete-btn');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${doc.filename}"?`)) return;
        try {
          await fetchWithTimeout(apiUrl(`/document/${encodeURIComponent(doc.id)}`), { method: 'DELETE' }, 15_000);
        } catch {
          // Local removal fallback
        }
        state.docs = state.docs.filter(d => d.id !== doc.id);
        if (state.activeDocId === doc.id) state.activeDocId = null;
        renderDocs();
        toast('Document deleted', 'success', 2000);
      });
    }

    el.docList.appendChild(row);
  });
}

// ==================== CONVERSATIONS / HISTORY ====================
async function loadRemoteHistory() {
  try {
    const r = await fetchWithTimeout(apiUrl('/conversations'), { credentials: 'include' }, 10_000);
    if (!r.ok) throw new Error('Unable to load conversation history');
    const conversations = await r.json();
    if (Array.isArray(conversations) && conversations.length > 0) {
      state.history = conversations.map((conv, idx) => ({
        id: conv.id || `conv-${idx}`,
        title: conv.messages?.find((m) => m.role === 'user')?.content || 'New Conversation',
        time: formatHistoryTime(conv.updatedAt || conv.createdAt),
        messages: (conv.messages || []).map((m) => ({
          role: m.role,
          content: m.content,
          time: formatCurrentTime(),
          sources: Array.isArray(m.sources) ? m.sources : [],
        })),
      }));
    } else {
      state.history = DEFAULT_CONVERSATIONS;
    }
  } catch (err) {
    console.warn('Remote history unavailable, using default', err);
    state.history = DEFAULT_CONVERSATIONS;
  }
  renderHistory();
}

function renderHistory() {
  if (!el.historyList) return;
  el.historyList.innerHTML = '';

  const list = state.history.length > 0 ? state.history : DEFAULT_CONVERSATIONS;

  list.forEach((conv) => {
    const item = document.createElement('div');
    const isActive = conv.id === state.activeConversationId;
    item.className = `conversation-item${isActive ? ' active' : ''}`;
    item.innerHTML = `
      <div class="conv-left-col">
        <span class="conversation-icon">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </span>
        <div class="conv-meta">
          <span class="conversation-title">${escapeHTML(conv.title)}</span>
          <span class="conversation-time">${conv.time || 'Just now'}</span>
        </div>
      </div>
      <button class="conv-delete-btn" title="Delete conversation" aria-label="Delete conversation" ${conv.local ? 'hidden' : ''}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <path d="M3 4.5H13M5.5 4.5V3C5.5 2.5 5.8 2 6.5 2H9.5C10.2 2 10.5 2.5 10.5 3V4.5M12 4.5V13C12 13.5 11.5 14 11 14H5C4.5 14 4 13.5 4 13V4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
      </button>
    `;

    item.addEventListener('click', () => {
      state.activeConversationId = conv.id;
      renderHistory();
      if (conv.messages && conv.messages.length > 0) {
        loadConversationMessages(conv);
      } else {
        clearChatArea();
      }
    });

    const deleteBtn = item.querySelector('.conv-delete-btn');
    if (deleteBtn && !conv.local) {
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteConversation(conv);
      });
    }

    el.historyList.appendChild(item);
  });
}

async function deleteConversation(conv) {
  if (conv.local) return; // UI placeholder — nothing stored on the server
  if (!confirm(`Delete "${conv.title}"? This cannot be undone.`)) return;

  const wasActive = conv.id === state.activeConversationId;

  try {
    const r = await fetchWithTimeout(apiUrl(`/conversations/${encodeURIComponent(conv.id)}`), {
      method: 'DELETE',
      credentials: 'include',
    }, 10_000);
    if (r.status === 401) return handleAuthExpired();
    if (!r.ok) throw new Error('Delete failed');
  } catch (err) {
    if (err && err.message === 'Sign in required') return;
    toast('Could not delete conversation. Please try again.', 'error');
    return;
  }

  state.history = state.history.filter((c) => c.id !== conv.id);
  if (wasActive) {
    state.activeConversationId = 'default-conv-1';
    clearChatArea();
  }
  renderHistory();
  toast('Conversation deleted', 'success', 2000);
}

function clearChatArea() {
  if (el.activeMessages) el.activeMessages.innerHTML = '';
  setViewMode('welcome');
  if (el.chatInput) {
    el.chatInput.value = '';
    el.chatInput.style.height = 'auto';
    el.chatInput.focus();
  }
}

function startNewConversation() {
  state.activeConversationId = `conv-${Date.now()}`;
  state.history.unshift({
    id: state.activeConversationId,
    title: 'New Conversation',
    time: 'Just now',
    messages: [],
    local: true
  });
  renderHistory();
  clearChatArea();
  toast('Started new conversation', 'success', 1500);
}

if (el.newConversationBtn) {
  el.newConversationBtn.addEventListener('click', startNewConversation);
}

if (el.clearBtn) {
  el.clearBtn.addEventListener('click', () => {
    clearChatArea();
    fetchWithTimeout(apiUrl('/conversations'), { method: 'DELETE', credentials: 'include' }, 10_000)
      .catch((err) => console.warn('Unable to clear remote history', err));
  });
}

// ==================== CHAT STREAMING & EXECUTION ====================
function loadConversationMessages(conv) {
  setViewMode('chat');
  el.activeMessages.innerHTML = '';

  if (conv && conv.messages && conv.messages.length > 0) {
    conv.messages.forEach((msg) => {
      renderChatMessage(msg.content, msg.role, msg.time || formatCurrentTime(), msg.sources);
    });
  }
  scrollBottom();
}

function renderChatMessage(content, role, time = formatCurrentTime(), sources = []) {
  const row = document.createElement('div');
  row.className = `message-row ${role}`;

  const isUser = role === 'user';
  const avatarText = isUser ? `
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="2" />
      <path d="M4 20C4 16.6863 7.58172 14 12 14C16.4183 14 20 16.6863 20 20" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
  ` : `
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
      <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M2 17L12 22L22 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M2 12L12 17L22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  `;

  row.innerHTML = `
    <div class="message-avatar-box">
      ${avatarText}
    </div>
    <div class="message-body-col">
      <div class="message-meta-header">
        <span class="message-sender-name">${isUser ? 'You' : 'RAG Chat'}</span>
        <span class="message-timestamp">${time}</span>
      </div>
      <div class="message-text">${isUser ? escapeHTML(content) : renderMD(content)}</div>
      ${sources && sources.length ? renderSourcesHTML(sources) : ''}
    </div>
  `;

  el.activeMessages.appendChild(row);
  scrollBottom();
  return row;
}

function renderSourcesHTML(sources) {
  if (!sources || !sources.length) return '';
  const firstThree = sources.slice(0, 3);
  const remaining = sources.length - 3;

  const cardsHtml = firstThree.map((s) => {
    const filename = typeof s === 'string' ? s : s.filename || 'Document.pdf';
    const ext = filename.split('.').pop()?.toLowerCase() || 'pdf';
    // Backend sends filenames only — never display page/score we were not given.
    const page = typeof s === 'object' && s.page ? `Page ${s.page}` : '';
    const score = typeof s === 'object' && typeof s.score === 'number' ? `${s.score}% grounded` : '';
    const detail = [page, score].filter(Boolean).join(' · ');
    const badgeType = ext === 'docx' ? 'docx' : ext === 'md' ? 'md' : 'pdf';
    const iconLabel = badgeType === 'docx' ? 'DOC' : badgeType === 'md' ? 'MD' : 'PDF';

    return `
      <div class="source-citation-card source-chip" title="${escapeHTML(filename)}">
        <div class="source-icon-badge doc-type-icon ${badgeType}">${iconLabel}</div>
        <div class="source-meta-col">
          <span class="source-filename">${escapeHTML(filename)}</span>
          ${detail ? `<span class="source-detail">${detail}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');

  const moreBadge = remaining > 0 ? `<div class="source-more-badge">+${remaining} more source${remaining > 1 ? 's' : ''}</div>` : '';

  return `
    <div class="sources-container">
      <div class="sources-header-title">Sources (${sources.length})</div>
      <div class="sources-cards-row">
        ${cardsHtml}
        ${moreBadge}
      </div>
    </div>
  `;
}

async function executeChatMessage(question) {
  // Immediately switch from Welcome center box to top-down Active Chat view
  setViewMode('chat');
  
  renderChatMessage(question, 'user');
  const userTime = formatCurrentTime();

  state.streaming = true;
  if (el.stopBtn) el.stopBtn.hidden = false;

  const assistantRow = document.createElement('div');
  assistantRow.className = 'message-row assistant';
  assistantRow.innerHTML = `
    <div class="message-avatar-box">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
        <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M2 17L12 22L22 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M2 12L12 17L22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </div>
    <div class="message-body-col">
      <div class="message-meta-header">
        <span class="message-sender-name">RAG Chat</span>
        <span class="message-timestamp">${formatCurrentTime()}</span>
      </div>
      <div class="stream-status-box" id="activeStreamStatus">
        <div class="stream-spinner"></div>
        <span id="activeStreamMsg">Searching knowledge base…</span>
      </div>
      <div class="message-text message-content"></div>
    </div>
  `;
  el.activeMessages.appendChild(assistantRow);
  scrollBottom();

  const contentEl = assistantRow.querySelector('.message-content');
  const statusBox = assistantRow.querySelector('#activeStreamStatus');
  const statusMsg = assistantRow.querySelector('#activeStreamMsg');

  if (state.activeDocId && !isDocumentId(state.activeDocId)) {
    state.activeDocId = null;
    persistState();
    renderDocs();
  }
  const docParam = state.activeDocId ? `&documentId=${encodeURIComponent(state.activeDocId)}` : '';

  activeRequestController = new AbortController();
  const timeout = setTimeout(() => activeRequestController.abort(new DOMException('Stream timed out', 'TimeoutError')), 120_000);

  let fullText = '';
  let sources = [];
  let streamErrorMessage = null;

  try {
    const res = await fetch(apiUrl(`/chat?question=${encodeURIComponent(question)}${docParam}`), {
      signal: activeRequestController.signal,
      credentials: 'include',
      headers: { Accept: 'text/event-stream' },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) {
        handleAuthExpired();
        throw new DOMException('Sign in required', 'AbortError');
      }
      throw new Error(body.error || body.message || `Server returned ${res.status}`);
    }
    if (!res.body) throw new Error('The server returned an empty response stream');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        const t = line.trim();
        if (!t || !t.startsWith('data: ')) continue;
        const data = t.slice(6);
        if (data === '[DONE]') continue;

        try {
          const p = JSON.parse(data);
          if (p.type === 'error') {
            streamErrorMessage = p.message || 'The server reported a streaming error';
            throw new Error(streamErrorMessage);
          }
          if (p.type === 'status' && p.message && statusMsg) statusMsg.textContent = p.message;
          if (p.type === 'token' && p.content) {
            if (statusBox) statusBox.style.display = 'none';
            fullText += p.content;
            contentEl.innerHTML = renderMD(fullText);
            scrollBottom();
          }
          if (p.type === 'sources' && Array.isArray(p.documents)) {
            sources = p.documents;
          }
        } catch (err) {
          let serverError = false;
          try { serverError = JSON.parse(data)?.type === 'error'; } catch { /* malformed */ }
          if (serverError) throw err;
          console.warn('Skipped malformed SSE event', err);
        }
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError' && err.message === 'Sign in required') {
      // Session expired: login screen is up, no simulated answer needed.
      return;
    }

    // The server explicitly reported a failure — surface it as an error
    // message instead of masking it behind a simulated answer.
    if (streamErrorMessage) {
      if (statusBox) statusBox.style.display = 'none';
      const errorBox = document.createElement('div');
      errorBox.className = 'message-error';
      errorBox.textContent = streamErrorMessage;
      assistantRow.querySelector('.message-body-col').appendChild(errorBox);
      scrollBottom();
      return;
    }

    console.info('Backend live streaming unavailable', err);

    // Honest failure state — never fabricate an answer or sources.
    if (statusBox) statusBox.style.display = 'none';
    const errorBox = document.createElement('div');
    errorBox.className = 'message-error';
    errorBox.textContent = 'The backend is not responding. Start it (start-server.bat or `bun run dev` in Backend/) and try again.';
    assistantRow.querySelector('.message-body-col').appendChild(errorBox);
    scrollBottom();
    return;
  } finally {
    clearTimeout(timeout);
    state.streaming = false;
    if (el.stopBtn) el.stopBtn.hidden = true;
    activeRequestController = null;
    if (statusBox) statusBox.style.display = 'none';

    if (sources.length > 0) {
      const sourcesBlock = document.createElement('div');
      sourcesBlock.innerHTML = renderSourcesHTML(sources);
      assistantRow.querySelector('.message-body-col').appendChild(sourcesBlock.firstElementChild);
      scrollBottom();
    }

    // Save only real exchanges — a failed request leaves no fake history entry
    if (fullText) {
      const activeConv = state.history.find(c => c.id === state.activeConversationId);
      if (activeConv) {
        if (!activeConv.messages) activeConv.messages = [];
        activeConv.messages.push({ role: 'user', content: question, time: userTime });
        activeConv.messages.push({ role: 'assistant', content: fullText, time: formatCurrentTime(), sources });
        activeConv.title = question.slice(0, 30) + (question.length > 30 ? '…' : '');
        activeConv.time = formatCurrentTime();
        renderHistory();
      }
    }

    if (el.followUpInput) {
      el.followUpInput.focus();
    }
  }
}

// ==================== MARKDOWN RENDERER ====================
function renderMD(text) {
  if (!text) return '';
  let html = escapeHTML(text);

  // Strip provider citation markers (e.g. 【1†L1-L4】) — real sources are shown as chips below the answer
  html = html.replace(/【\d+†[^】]*】/g, '');

  // 1. Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="code-block"><code>$2</code></pre>');

  // 2. Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // 3. Bold & Italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // 4. Blockquotes
  html = html.replace(/^&gt;\s*(.+)$/gm, '<blockquote>$1</blockquote>');

  // 5. Headings
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // 6. Lists
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');

  // 7. Paragraphs
  html = html.replace(/\n\n+/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = '<p>' + html + '</p>';
  html = html.replace(/<p><\/p>/g, '');
  html = html.replace(/<p><br>/g, '<p>');

  return html;
}

// ==================== BOOTSTRAP ====================
(async () => {
  await bootstrapAuth();
  loadDocs();
  loadRemoteHistory();
  setViewMode('welcome');
})();

console.log('RAG Chat initialized');


// ==================== v2.1: Example chips (delegated, isolated) ====================
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.example-chip');
  if (!chip) return;
  const input = document.querySelector('#chatInput');
  if (!input) return;
  input.value = chip.dataset.q || '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const send = document.querySelector('#sendBtn');
  if (send && !send.disabled) send.click();
});
