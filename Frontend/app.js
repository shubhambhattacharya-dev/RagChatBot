/* ============================================
   RAG Space — Minimalist Frontend Application
   ============================================ */

// Production is same-origin: Fastify serves this folder and API requests stay relative.
// When opened by a local static server, the backend is expected on port 3001.
// Set window.RAG_API_BASE before app.js only when intentionally using another API host.
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
let activeRequestController = null;

function apiUrl(path) {
  return `${API}${path}`;
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

function humanizeError(error, fallback) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return 'The server took too long to respond. Please try again.';
  }
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
    return 'Cannot reach the application server. Refresh the page and try again.';
  }
  return error?.message || fallback;
}

// ==================== STATE ====================
const state = {
  docs: [],
  history: [],
  messages: [],
  streaming: false,
  activeDocId: null,
};

function loadPersistedState() {
  try {
    state.history = [];
    state.activeDocId = localStorage.getItem(DOC_SCOPE_STORAGE_KEY) || null;
  } catch {
    state.history = [];
    state.activeDocId = null;
  }
}

function persistState() {
  try {
    if (state.activeDocId) localStorage.setItem(DOC_SCOPE_STORAGE_KEY, state.activeDocId);
    else localStorage.removeItem(DOC_SCOPE_STORAGE_KEY);
  } catch {
    // Storage can be disabled or full; the app remains usable in memory.
  }
}

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
  el.stopBtn = $('#stopBtn');
  el.statusDot = $('#statusDot');
  el.statusLabel = $('#statusLabel');
}
initDOM();
loadPersistedState();

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
    const r = await fetchWithTimeout(apiUrl('/health'), {}, 4000);
    if (r.ok) {
      el.statusDot.className = 'status-dot connected';
      el.statusLabel.textContent = 'Connected';
    } else throw new Error();
  } catch {
    el.statusDot.className = 'status-dot disconnected';
    el.statusLabel.textContent = 'Offline';
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
el.sendBtn.addEventListener('click', sendMessage);

// ==================== SIDEBAR MOBILE ====================
el.menuBtn.addEventListener('click', () => toggleSidebar(true));
el.overlay.addEventListener('click', () => toggleSidebar(false));

function toggleSidebar(open) {
  el.sidebar.classList.toggle('open', open);
  el.overlay.classList.toggle('visible', open);
  document.body.style.overflow = open ? 'hidden' : '';
}

// ==================== UPLOAD ====================
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

el.attachBtn.addEventListener('click', () => el.fileInput.click());
el.stopBtn.addEventListener('click', () => activeRequestController?.abort(new DOMException('Stopped by user', 'AbortError')));

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

  const res = await fetchWithTimeout(apiUrl('/upload'), { method: 'POST', body: fd }, 120_000);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.message || 'Upload failed');
  return body;
}

function addFileItem(file, status) {
  const existing = [...el.fileList.querySelectorAll('.file-item')]
    .find((item) => item.dataset.name === file.name);
  if (existing) existing.remove();

  const icon = { pdf: '📄', docx: '📄', txt: '📄', md: '📝' };
  const ext = file.name.split('.').pop() || '';
  const item = document.createElement('div');
  item.className = 'file-item tilt-card';
  item.dataset.name = file.name;
  item.innerHTML = `
    <span class="file-icon">${icon[ext] || '📄'}</span>
    <span class="file-name">${escapeHTML(file.name)}</span>
    <span class="file-status ${status}">${statusText(status)}</span>
  `;
  el.fileList.appendChild(item);
}

function updateFileItem(file, status) {
  const item = [...el.fileList.querySelectorAll('.file-item')]
    .find((element) => element.dataset.name === file.name);
  if (!item) return;
  const statusEl = item.querySelector('.file-status');
  statusEl.className = `file-status ${status}`;
  statusEl.textContent = statusText(status);
}

function statusText(s) {
  return { uploading: 'Uploading…', processing: 'Indexing…', ready: 'Ready ✓', error: 'Failed' }[s] || s;
}

async function pollStatus(docId, file) {
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    try {
      const r = await fetchWithTimeout(apiUrl(`/document/${encodeURIComponent(docId)}`), {}, 10_000);
      if (!r.ok) throw new Error('Unable to retrieve document status');
      const doc = await r.json();
      if (doc.status === 'READY' || doc.status === 'ready') {
        updateFileItem(file, 'ready');
        state.docs.push(doc);
        await loadDocs();
        return;
      }
      if (doc.status === 'FAILED' || doc.status === 'failed') {
        updateFileItem(file, 'error');
        toast(`Failed to process ${file.name}`, 'error');
        return;
      }
    } catch {
      // Retry
    }
  }
  updateFileItem(file, 'error');
  toast(`${file.name} timed out`, 'error');
}

// ==================== DOCUMENTS ====================
async function loadDocs() {
  try {
    const r = await fetchWithTimeout(apiUrl('/documents'), {}, 10_000);
    if (!r.ok) throw new Error('Failed to load documents');
    state.docs = await r.json();
    renderDocs();
  } catch (err) {
    toast(humanizeError(err, 'Unable to load documents'), 'error');
  }
}

async function loadRemoteHistory() {
  try {
    const r = await fetchWithTimeout(apiUrl('/conversations'), { credentials: 'same-origin' }, 10_000);
    if (!r.ok) throw new Error('Unable to load conversation history');
    const conversations = await r.json();
    state.history = Array.isArray(conversations) ? conversations.map((conversation) => ({
      question: conversation.messages?.find((message) => message.role === 'user')?.content || 'Conversation',
      timestamp: Date.parse(conversation.updatedAt || conversation.createdAt) || Date.now(),
      messages: (conversation.messages || []).map((message) => ({
        role: message.role,
        content: message.content,
        sources: Array.isArray(message.sources) ? message.sources : [],
      })),
    })) : [];
    persistState();
    renderHistory();
  } catch (err) {
    console.warn('Remote history unavailable', err);
  }
}

function renderDocs() {
  el.docsCount.textContent = state.docs.length;
  el.docList.innerHTML = '';

  if (state.docs.length === 0) {
    el.docList.innerHTML =
      '<div class="doc-list-empty" style="font-size:11px; color:var(--text-tertiary); text-align:center; padding:10px;">No documents indexed</div>';
    return;
  }

  if (!state.activeDocId) {
    const first = state.docs.find((d) => d.status === 'READY');
    if (first) state.activeDocId = first.id;
  }

  for (const doc of state.docs) {
    const item = document.createElement('div');
    item.className = `doc-item tilt-card${doc.id === state.activeDocId ? ' active' : ''}`;
    item.dataset.id = doc.id;
    item.title = doc.filename;
    item.innerHTML = `
      <span class="doc-icon">${doc.status === 'READY' ? '📄' : '⏳'}</span>
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

    item.addEventListener('click', (e) => {
      if (e.target.closest('.doc-delete')) return;
      state.activeDocId = doc.id;
      persistState();
      renderDocs();
      toast(`Scope: ${doc.filename}`, 'success', 1500);
    });

    item.querySelector('.doc-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${doc.filename}"?`)) return;
      try {
        const r = await fetchWithTimeout(apiUrl(`/document/${encodeURIComponent(doc.id)}`), { method: 'DELETE' }, 15_000);
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
      `⚠️ ${humanizeError(err, 'Unable to send your message')}`,
      'error'
    );
  } finally {
    state.streaming = false;
    el.sendBtn.disabled = !el.input.value.trim();
  }
}

async function streamResponse(question, typingEl) {
  const docParam = state.activeDocId ? `&documentId=${state.activeDocId}` : '';
  activeRequestController = new AbortController();
  const timeout = setTimeout(() => activeRequestController.abort(new DOMException('Stream timed out', 'TimeoutError')), 120_000);
  el.stopBtn.hidden = false;

  try {
    const res = await fetch(apiUrl(`/chat?question=${encodeURIComponent(question)}${docParam}`), {
      signal: activeRequestController.signal,
      headers: { Accept: 'text/event-stream' },
    });

    if (!res.ok) {
      typingEl.remove();
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || body.message || `Server returned ${res.status}`);
    }
    if (!res.body) throw new Error('The server returned an empty response stream');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    let sources = [];
    typingEl.remove();

  // Create message shell
  const bubble = document.createElement('div');
  bubble.className = 'message message-assistant tilt-card';
  bubble.innerHTML = `
    <div class="avatar avatar-ai">AI</div>
    <div class="bubble">
      <div class="status-stream-card" id="streamStatus">
        <div class="status-spinner"></div>
        <span id="statusMsg">Searching pgvector database...</span>
      </div>
      <div class="message-content"></div>
    </div>
  `;
  const content = bubble.querySelector('.message-content');
  const statusCard = bubble.querySelector('#streamStatus');
  const statusMsg = bubble.querySelector('#statusMsg');
  
  el.messages.appendChild(bubble);
  scrollBottom();

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
          if (p.type === 'error') throw new Error(p.message || 'The server reported a streaming error');
          if (p.type === 'status' && p.message && statusMsg) statusMsg.textContent = p.message;
          if (p.type === 'token' && p.content) {
            if (statusCard) statusCard.style.display = 'none';
            text += p.content;
            content.innerHTML = renderMD(text);
            scrollBottom();
          }
          if (p.type === 'sources' && Array.isArray(p.documents)) sources = p.documents;
        } catch (err) {
          let serverError = false;
          try { serverError = JSON.parse(data)?.type === 'error'; } catch { /* malformed event */ }
          if (serverError) throw err;
          console.warn('Skipped malformed SSE event');
        }
      }
    }

    if (buf.trim().startsWith('data: ')) {
      try {
        const p = JSON.parse(buf.trim().slice(6));
        if (p.type === 'token' && p.content) text += p.content;
        if (p.type === 'sources' && Array.isArray(p.documents)) sources = p.documents;
      } catch { /* Ignore an incomplete final event. */ }
    }

  if (statusCard) statusCard.style.display = 'none';
  content.innerHTML = renderMD(text);

  if (sources.length) {
    const sourcesCard = document.createElement('div');
    sourcesCard.className = 'sources-card';
    sourcesCard.innerHTML = `
      <div class="sources-label">RETRIEVED SOURCES</div>
      <div class="source-chips">
        ${sources.map((name) => `<span class="source-chip">📄 ${escapeHTML(name)}</span>`).join('')}
      </div>
    `;
    bubble.querySelector('.bubble').appendChild(sourcesCard);
    scrollBottom();
  }

  state.messages.push({ role: 'user', content: question });
  state.messages.push({ role: 'assistant', content: text, sources });
  state.history.push({
    question,
    timestamp: Date.now(),
    messages: [
      { role: 'user', content: question },
      { role: 'assistant', content: text, sources },
    ],
  });
  persistState();
  addHistoryItem(question);
  } finally {
    clearTimeout(timeout);
    el.stopBtn.hidden = true;
    activeRequestController = null;
  }
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
  div.className = `message message-${role} tilt-card`;
  div.innerHTML = `
    <div class="avatar avatar-${role}">${role === 'user' ? 'U' : 'AI'}</div>
    <div class="bubble">
      <div class="message-content">${role === 'user' ? escapeHTML(text) : renderMD(text)}</div>
    </div>
  `;
  el.messages.appendChild(div);
  scrollBottom();
  return div;
}

function addTypingBubble() {
  const div = document.createElement('div');
  div.className = 'message message-assistant tilt-card';
  div.innerHTML = `
    <div class="avatar avatar-ai">AI</div>
    <div class="bubble">
      <div class="status-stream-card">
        <div class="status-spinner"></div>
        <span>Searching pgvector database...</span>
      </div>
    </div>
  `;
  el.messages.appendChild(div);
  scrollBottom();
  return div;
}

// ==================== HISTORY ====================
function addHistoryItem(entry) {
  const question = typeof entry === 'string' ? entry : entry.question;
  const empty = el.historyList.querySelector('.empty-state');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = 'history-item tilt-card';
  item.style.cursor = 'pointer';
  item.style.padding = '8px 10px';
  item.style.fontSize = '11.5px';
  item.style.display = 'flex';
  item.style.alignItems = 'center';
  item.style.gap = '6px';
  item.style.borderRadius = 'var(--r-md)';
  item.style.background = 'var(--bg-surface)';
  item.style.border = '1px solid var(--border-subtle)';
  item.style.marginBottom = '4px';
  
  item.innerHTML = `
    <span style="color:var(--accent-blue);">💬</span>
    <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHTML(question.slice(0, 40))}${question.length > 40 ? '…' : ''}</span>
  `;
  item.addEventListener('click', () => {
    if (entry.messages?.length) {
      $$('.message', el.messages).forEach((m) => m.remove());
      removeWelcome();
      entry.messages.forEach((message) => addMessageBubble(message.content, message.role));
    }
  });
  el.historyList.appendChild(item);
}

function renderHistory() {
  el.historyList.innerHTML = '';
  if (!state.history.length) {
    el.historyList.innerHTML = '<div class="empty-state">No conversations recorded</div>';
    return;
  }
  state.history.forEach((entry) => addHistoryItem(entry));
}

// ==================== CLEAR ====================
el.clearBtn.addEventListener('click', () => {
  if (state.streaming) return;
  $$('.message', el.messages).forEach((m) => m.remove());
  state.messages = [];
  state.history = [];
  persistState();
  el.historyList.innerHTML = '<div class="empty-state">No conversations yet</div>';
  state.activeDocId = null;
  if (!el.welcome) {
    el.messages.insertAdjacentHTML('afterbegin', `
      <div class="welcome-screen" id="welcomeScreen">
        <h1>Ask your documents anything</h1>
      </div>`);
    el.welcome = $('#welcomeScreen');
  }
  el.input.focus();
  fetchWithTimeout(apiUrl('/conversations'), { method: 'DELETE', credentials: 'same-origin' }, 10_000)
    .catch((err) => console.warn('Unable to clear remote history', err));
});

// ==================== MARKDOWN RENDERER ====================
function renderMD(text) {
  if (!text) return '';
  let html = escapeHTML(text);

  // 1. Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="code-block"><code>$2</code></pre>');

  // 2. Markdown Tables
  html = html.replace(/(?:^|\n)(\|.*\|(?:\n\|.*\|)+)(?=\n|$)/g, (match, tableContent) => {
    const rows = tableContent.trim().split('\n').map((row) => row.trim());
    if (rows.length < 2) return match;

    const parseRow = (r) => r.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    const headers = parseRow(rows[0]);
    const isSeparator = /^\|?[\s\-:|]+\|?$/.test(rows[1]);
    const dataRows = isSeparator ? rows.slice(2) : rows.slice(1);

    const headHtml = `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`;
    const bodyHtml = `<tbody>${dataRows.map((r) => `<tr>${parseRow(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>`;

    return `<div class="table-wrapper"><table class="minimal-table">${headHtml}${bodyHtml}</table></div>`;
  });

  // 3. Horizontal Rules
  html = html.replace(/^---$/gm, '<hr class="minimal-hr" />');

  // 4. Error & warning blockquotes in light green
  html = html.replace(/^&gt;\s*([⚠️❌].*)$/gm, '<blockquote class="error-quote">$1</blockquote>');

  // 5. Standard Blockquotes
  html = html.replace(/^&gt;\s*(.+)$/gm, '<blockquote class="minimal-quote">$1</blockquote>');

  // 6. Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

  // 7. Bold & Italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // 8. Headings
  html = html.replace(/^###\s+(.+)$/gm, '<h3 class="md-h3">$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2 class="md-h2">$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1 class="md-h1">$1</h1>');

  // 9. Lists
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li class="md-li-num">$1</li>');
  html = html.replace(/^[-*]\s+(.+)$/gm, '<li class="md-li-bullet">$1</li>');

  // 10. Line breaks & Paragraphs
  html = html.replace(/\n\n+/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = '<p>' + html + '</p>';
  html = html.replace(/<p><br>/g, '<p>');
  html = html.replace(/<p><\/p>/g, '');
  html = html.replace(/<\/div><br>/g, '</div>');
  html = html.replace(/<\/table><br>/g, '</table>');
  html = html.replace(/<hr class="minimal-hr" \/><br>/g, '<hr class="minimal-hr" />');

  return html;
}

// ==================== BOOT ====================
loadDocs();
loadRemoteHistory();
renderHistory();
console.log('✨ RAG ChatBot application initialized');
