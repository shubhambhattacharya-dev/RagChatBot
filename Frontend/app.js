/* ============================================
   RAG ChatBot — Frontend Application
   ============================================ */

const API = 'http://localhost:3000';

// ==================== STATE ====================
const state = {
  docs: [],
  history: [],
  messages: [],
  streaming: false,
  activeDocId: null,
};

// ==================== DOM ====================
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];

const el = {};
function initDOM() {
  el.sidebar = $('#sidebar');
  el.overlay = $('#sidebarOverlay');
  el.menuBtn = $('#mobileMenuBtn');
  el.messages = $('#messages');
  el.input = $('#chatInput');
  el.sendBtn = $('#sendBtn');
  el.fileInput = $('#fileInput');
  el.dropZone = $('#dropZone');
  el.fileList = $('#fileList');
  el.docList = $('#docList');
  el.docsCount = $('#docsCount');
  el.historyList = $('#historyList');
  el.clearBtn = $('#clearChat');
  el.welcome = $('#welcomeScreen');
  el.toast = $('#toastContainer');
  el.attachBtn = $('#attachBtn');
  el.statusDot = $('#statusDot');
  el.statusLabel = $('#statusLabel');
}
initDOM();

// ==================== UTILITIES ====================
function escapeHTML(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function scrollBottom() {
  requestAnimationFrame(() => {
    el.messages.scrollTop = el.messages.scrollHeight;
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ==================== TOAST ====================
function toast(msg, type = 'success', duration = 3000) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  el.toast.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 250);
  }, duration);
}

// ==================== HEALTH ====================
async function checkHealth() {
  try {
    const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      el.statusDot.className = 'status-dot connected';
      el.statusLabel.textContent = 'Connected';
    } else throw new Error();
  } catch {
    el.statusDot.className = 'status-dot disconnected';
    el.statusLabel.textContent = 'Backend offline';
  }
}
checkHealth();
setInterval(checkHealth, 15000);

// ==================== TEXTAREA ====================
el.input.addEventListener('input', () => {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 160) + 'px';
  el.sendBtn.disabled = !el.input.value.trim() || state.streaming;
});

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ==================== SIDEBAR MOBILE ====================
el.menuBtn.addEventListener('click', () => toggleSidebar(true));
el.overlay.addEventListener('click', () => toggleSidebar(false));

function toggleSidebar(open) {
  el.sidebar.classList.toggle('open', open);
  el.overlay.classList.toggle('visible', open);
  document.body.style.overflow = open ? 'hidden' : '';
}

// ==================== UPLOAD ====================
// Drop zone
el.dropZone.addEventListener('click', () => el.fileInput.click());

el.dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  el.dropZone.classList.add('drag-over');
});

el.dropZone.addEventListener('dragleave', () => {
  el.dropZone.classList.remove('drag-over');
});

el.dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropZone.classList.remove('drag-over');
  handleFiles([...e.dataTransfer.files]);
});

el.fileInput.addEventListener('change', () => {
  handleFiles([...el.fileInput.files]);
  el.fileInput.value = '';
});

// Attach button also opens file picker
el.attachBtn.addEventListener('click', () => el.fileInput.click());

async function handleFiles(files) {
  const validFiles = files.filter((f) =>
    /\.(pdf|docx|txt|md)$/i.test(f.name)
  );

  if (validFiles.length !== files.length) {
    toast('Some file types not supported. Use PDF, DOCX, TXT, MD.', 'error');
  }

  for (const file of validFiles) {
    addFileItem(file, 'uploading');
    try {
      const res = await uploadFile(file);
      updateFileItem(file, 'processing');
      toast(`${file.name} uploaded`, 'success', 2000);
      pollStatus(res.documentId || res.id, file);
    } catch (err) {
      updateFileItem(file, 'error');
      toast(`${file.name}: ${err.message}`, 'error');
    }
  }
}

async function uploadFile(file) {
  const fd = new FormData();
  fd.append('file', file);

  const res = await fetch(`${API}/upload`, { method: 'POST', body: fd });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || body.message || 'Upload failed');
  return body;
}

function addFileItem(file, status) {
  const existing = el.fileList.querySelector(`[data-name="${file.name}"]`);
  if (existing) existing.remove();

  const icon = { pdf: '📕', docx: '📘', txt: '📄', md: '📝' };
  const ext = file.name.split('.').pop() || '';
  const item = document.createElement('div');
  item.className = 'file-item';
  item.dataset.name = file.name;
  item.innerHTML = `
    <span class="file-icon">${icon[ext] || '📄'}</span>
    <span class="file-name">${escapeHTML(file.name)}</span>
    <span class="file-status ${status}">${statusText(status)}</span>
    ${status === 'uploading' ? `<div class="file-progress"><div class="file-progress-bar" style="width:40%"></div></div>` : ''}
  `;
  el.fileList.appendChild(item);
}

function updateFileItem(file, status) {
  const item = el.fileList.querySelector(`[data-name="${file.name}"]`);
  if (!item) return;
  const statusEl = item.querySelector('.file-status');
  statusEl.className = `file-status ${status}`;
  statusEl.textContent = statusText(status);
  // Remove progress bar
  const bar = item.querySelector('.file-progress');
  if (bar) bar.remove();
}

function statusText(s) {
  return { uploading: 'Uploading…', processing: 'Processing…', ready: 'Ready ✓', error: 'Failed' }[s] || s;
}

async function pollStatus(docId, file) {
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    try {
      const r = await fetch(`${API}/document/${docId}`);
      const doc = await r.json();
      if (doc.status === 'READY' || doc.status === 'ready') {
        updateFileItem(file, 'ready');
        state.docs.push(doc);
        await loadDocs(); // refresh doc list + auto-select
        return;
      }
      if (doc.status === 'FAILED' || doc.status === 'failed') {
        updateFileItem(file, 'error');
        toast(`Failed to process ${file.name}`, 'error');
        return;
      }
    } catch {
      // Retry silently
    }
  }
  updateFileItem(file, 'error');
  toast(`${file.name} timed out`, 'error');
}

// ==================== DOCUMENTS ====================
async function loadDocs() {
  try {
    const r = await fetch(`${API}/documents`);
    if (!r.ok) throw new Error('Failed to load documents');
    state.docs = await r.json();
    renderDocs();
  } catch {
    // Backend offline — silent
  }
}

function renderDocs() {
  el.docsCount.textContent = state.docs.length;
  el.docList.innerHTML = '';

  if (state.docs.length === 0) {
    el.docList.innerHTML =
      '<div class="doc-list-empty">No documents yet — upload one above</div>';
    return;
  }

  // Auto-select the first READY doc if nothing selected yet
  if (!state.activeDocId) {
    const first = state.docs.find((d) => d.status === 'READY');
    if (first) state.activeDocId = first.id;
  }

  for (const doc of state.docs) {
    const item = document.createElement('div');
    item.className = `doc-item${doc.id === state.activeDocId ? ' active' : ''}`;
    item.dataset.id = doc.id;
    item.title = doc.filename;
    item.innerHTML = `
      <span class="doc-icon">${doc.status === 'READY' ? '📕' : '⏳'}</span>
      <span class="doc-name">${escapeHTML(doc.filename)}</span>
      <span class="doc-status ${doc.status === 'READY' ? 'ready' : doc.status === 'FAILED' ? 'error' : 'processing'}">${
        doc.status === 'READY' ? 'Ready' : doc.status === 'FAILED' ? 'Failed' : 'Indexing…'
      }</span>
      <button class="doc-delete" title="Delete document" data-id="${doc.id}">
        <svg width="11" height="11" viewBox="0 0 15 15" fill="none">
          <path d="M2 4H13M4.5 4V2.5C4.5 2.22 4.72 2 5 2H10C10.28 2 10.5 2.22 10.5 2.5V4M11.5 4V12.5C11.5 12.78 11.28 13 11 13H4C3.72 13 3.5 12.78 3.5 12.5V4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    `;

    // Click body = select active document
    item.addEventListener('click', (e) => {
      if (e.target.closest('.doc-delete')) return;
      state.activeDocId = doc.id;
      renderDocs();
      toast(`Searching: ${doc.filename}`, 'success', 1500);
    });

    // Delete button
    item.querySelector('.doc-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${doc.filename}"?`)) return;
      try {
        const r = await fetch(`${API}/document/${doc.id}`, { method: 'DELETE' });
        if (!r.ok) throw new Error('Delete failed');
        if (state.activeDocId === doc.id) state.activeDocId = null;
        await loadDocs();
        toast('Document deleted', 'success', 2000);
      } catch (err) {
        toast(`Delete failed: ${err.message}`, 'error');
      }
    });

    el.docList.appendChild(item);
  }
}

// ==================== CHAT ====================
async function sendMessage() {
  const text = el.input.value.trim();
  if (!text || state.streaming) return;

  el.input.value = '';
  el.input.style.height = 'auto';
  el.sendBtn.disabled = true;

  removeWelcome();
  addMessageBubble(text, 'user');

  const typing = addTypingBubble();
  state.streaming = true;

  try {
    await streamResponse(text, typing);
  } catch (err) {
    typing.remove();
    addMessageBubble(
      `⚠️ ${err.message}. Check that the backend is running.`,
      'error'
    );
  } finally {
    state.streaming = false;
    el.sendBtn.disabled = !el.input.value.trim();
  }
}

async function streamResponse(question, typingEl) {
  // Scope search to the active document when one is selected
  const docParam = state.activeDocId ? `&documentId=${state.activeDocId}` : '';
  const res = await fetch(`${API}/chat?question=${encodeURIComponent(question)}${docParam}`);

  if (!res.ok) {
    typingEl.remove();
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server returned ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let sources = [];

  typingEl.remove();

  // Create message shell
  const bubble = document.createElement('div');
  bubble.className = 'message assistant';
  bubble.innerHTML = `
    <div class="message-role">Assistant</div>
    <div class="message-content"></div>
  `;
  const content = bubble.querySelector('.message-content');
  el.messages.appendChild(bubble);
  scrollBottom();

  // Stream tokens
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
        if (p.type === 'token' && p.content) {
          text += p.content;
          content.innerHTML = renderMD(text) + '<span class="stream-cursor"></span>';
          scrollBottom();
        }
        if (p.type === 'warning' && p.message) {
          text += `\n\n> ⚠️ ${p.message}`;
        }
        if (p.type === 'error' && p.message) {
          text += `\n\n> ❌ ${p.message}`;
        }
        if (p.type === 'sources' && p.chunks) sources = p.chunks;
      } catch {
        /* skip malformed */
      }
    }
  }

  // Final render (sources hidden — retrieval happens under the hood)
  const html = renderMD(text);
  content.innerHTML = html;

  state.messages.push({ role: 'user', content: question });
  state.messages.push({ role: 'assistant', content: text, sources });
  addHistoryItem(question);
}

// ==================== UI HELPERS ====================
function removeWelcome() {
  if (el.welcome) {
    el.welcome.remove();
    el.welcome = null;
  }
}

function addMessageBubble(text, role) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  div.innerHTML = `
    <div class="message-role">${role === 'user' ? 'You' : 'Assistant'}</div>
    <div class="message-content">${role === 'user' ? escapeHTML(text) : renderMD(text)}</div>
  `;
  el.messages.appendChild(div);
  scrollBottom();
  return div;
}

function addTypingBubble() {
  const div = document.createElement('div');
  div.className = 'typing-indicator';
  div.innerHTML = `<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>`;
  el.messages.appendChild(div);
  scrollBottom();
  return div;
}

// ==================== HISTORY ====================
function addHistoryItem(question) {
  const empty = el.historyList.querySelector('.empty-state');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = 'file-item';
  item.style.cursor = 'pointer';
  item.innerHTML = `
    <span style="font-size:12px;">💬</span>
    <span class="file-name" style="font-size:11px;">${escapeHTML(question.slice(0, 50))}${question.length > 50 ? '…' : ''}</span>
  `;
  item.addEventListener('click', () => {
    // Scroll to top — simple interaction
    el.messages.scrollTo({ top: 0, behavior: 'smooth' });
  });
  el.historyList.appendChild(item);
}

// ==================== CLEAR ====================
el.clearBtn.addEventListener('click', () => {
  $$('.message', el.messages).forEach((m) => m.remove());
  $$('.typing-indicator', el.messages).forEach((m) => m.remove());
  state.messages = [];

  if (!el.welcome) {
    const w = document.querySelector('.welcome-screen');
    if (w) { el.welcome = w; return; }
    el.messages.innerHTML = `
      <div class="welcome-screen" id="welcomeScreen">
        <div class="welcome-graphic">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <rect x="4" y="4" width="40" height="40" rx="10" fill="#5e6ad2" opacity="0.12"/>
            <path d="M16 28L20 32L32 18" stroke="#5e6ad2" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <h2 class="welcome-title">Ready to explore your documents</h2>
        <p class="welcome-desc">Upload a PDF, Word doc, or text file. I'll help you find answers instantly.</p>
        <div class="welcome-tips">
          <div class="tip-card">
            <div class="tip-icon">📄</div>
            <div class="tip-text">Upload any document to get started</div>
          </div>
          <div class="tip-card">
            <div class="tip-icon">💬</div>
            <div class="tip-text">Ask natural language questions</div>
          </div>
          <div class="tip-card">
            <div class="tip-icon">🔗</div>
            <div class="tip-text">Answers include source citations</div>
          </div>
        </div>
      </div>
    `;
    el.welcome = $('#welcomeScreen');
  }
});

// ==================== MARKDOWN RENDERER ====================
function renderMD(text) {
  if (!text) return '';
  let html = escapeHTML(text);

  // Code blocks
  html = html.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    '<pre><code>$2</code></pre>'
  );

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Links
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" style="color:var(--brand)">$1</a>'
  );

  // Line breaks + paragraphs
  html = html.replace(/\n\n+/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = '<p>' + html + '</p>';
  html = html.replace(/<p><br>/g, '<p>');
  html = html.replace(/<p><\/p>/g, '');

  return html;
}

// ==================== BOOT ====================
loadDocs();
console.log('🚀 RAG ChatBot UI ready — Linear-inspired design');
console.log(`📡 API target: ${API}`);
