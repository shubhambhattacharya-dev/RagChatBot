/* ============================================
   RAG Space — Minimalist Frontend Application
   ============================================ */

// Configured API target
const configuredApi = typeof window.RAG_API_BASE === 'string'
  ? window.RAG_API_BASE.replace(/\/$/, '')
  : '';
const localBackend = `${location.protocol === 'file:' ? 'http:' : location.protocol}//${location.hostname || 'localhost'}:3000`;
const API = configuredApi || (location.port === '5500' ? localBackend : '');

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
  el.canvas3d = $('#bg3dCanvas');
}
initDOM();

// ==================== 3D GREEN AURORA & SHOOTING STARS CANVAS ENGINE ====================
function initMinimal3D() {
  if (!el.canvas3d) return;
  const ctx = el.canvas3d.getContext('2d');
  let w = (el.canvas3d.width = window.innerWidth);
  let h = (el.canvas3d.height = window.innerHeight);

  window.addEventListener('resize', () => {
    w = el.canvas3d.width = window.innerWidth;
    h = el.canvas3d.height = window.innerHeight;
  });

  const mouse = { x: w / 2, y: h / 2, targetX: w / 2, targetY: h / 2 };
  window.addEventListener('mousemove', (e) => {
    mouse.targetX = e.clientX;
    mouse.targetY = e.clientY;
  });

  // 1. 3D Starfield & Aurora Particles
  const numParticles = 160;
  const particles = [];
  for (let i = 0; i < numParticles; i++) {
    const isAurora = i % 3 === 0;
    particles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      z: Math.random() * 800 + 1,
      size: isAurora ? Math.random() * 2.5 + 1 : Math.random() * 1.2 + 0.4,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      alpha: Math.random() * 0.6 + 0.2,
      color: isAurora
        ? (i % 6 === 0 ? '#4ade80' : i % 6 === 3 ? '#00ffaa' : '#10b981')
        : '#3b82f6',
    });
  }

  // 2. 3D Top-Sky Shooting Stars (Meteors & Comets) Engine
  const comets = [];
  function spawnComet() {
    if (comets.length < 7 && Math.random() < 0.07) {
      const fromTop = Math.random() > 0.3;
      comets.push({
        x: fromTop ? Math.random() * (w * 1.2) - w * 0.2 : -30,
        y: fromTop ? -30 : Math.random() * (h * 0.4),
        z: Math.random() * 600 + 80,
        length: Math.random() * 160 + 80,
        speed: Math.random() * 16 + 10,
        angle: Math.PI / 3.8 + (Math.random() - 0.5) * 0.15,
        alpha: 1,
        color: Math.random() > 0.4 ? '#4ade80' : Math.random() > 0.5 ? '#00ffaa' : '#3b82f6',
      });
    }
  }

  function render() {
    ctx.clearRect(0, 0, w, h);

    mouse.x += (mouse.targetX - mouse.x) * 0.03;
    mouse.y += (mouse.targetY - mouse.y) * 0.03;

    const offsetX = (mouse.x - w / 2) * 0.04;
    const offsetY = (mouse.y - h / 2) * 0.04;

    const gifLayer = document.getElementById('gif3dLayer');
    if (gifLayer) {
      const rx = ((mouse.y - h / 2) / (h / 2)) * -6;
      const ry = ((mouse.x - w / 2) / (w / 2)) * 6;
      gifLayer.style.transform = `perspective(1200px) rotateX(${rx}deg) rotateY(${ry}deg)`;
    }

    // Draw Particles
    particles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;

      if (p.x < 0) p.x = w;
      if (p.x > w) p.x = 0;
      if (p.y < 0) p.y = h;
      if (p.y > h) p.y = 0;

      const px = p.x + offsetX * (400 / p.z);
      const py = p.y + offsetY * (400 / p.z);

      ctx.beginPath();
      ctx.arc(px, py, p.size, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha;
      ctx.shadowBlur = p.size * 3;
      ctx.shadowColor = p.color;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    });

    // Render & Update Top-Sky 3D Shooting Stars
    spawnComet();
    for (let i = comets.length - 1; i >= 0; i--) {
      const c = comets[i];
      c.x += Math.cos(c.angle) * c.speed;
      c.y += Math.sin(c.angle) * c.speed;
      c.alpha -= 0.012;

      const k = 400 / c.z;
      const cx = c.x + offsetX * k;
      const cy = c.y + offsetY * k;
      const tailX = cx - Math.cos(c.angle) * c.length * k;
      const tailY = cy - Math.sin(c.angle) * c.length * k;

      if (c.alpha <= 0 || cx > w + 150 || cy > h + 150) {
        comets.splice(i, 1);
        continue;
      }

      // Trail Gradient
      const grad = ctx.createLinearGradient(cx, cy, tailX, tailY);
      grad.addColorStop(0, `rgba(255, 255, 255, ${c.alpha})`);
      grad.addColorStop(0.3, c.color === '#4ade80' ? `rgba(74, 222, 128, ${c.alpha * 0.9})` : `rgba(59, 130, 246, ${c.alpha * 0.9})`);
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

      // Draw Trail
      ctx.strokeStyle = grad;
      ctx.lineWidth = Math.max(1.2, 3 * k);
      ctx.shadowBlur = 12;
      ctx.shadowColor = c.color;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(tailX, tailY);
      ctx.stroke();

      // Glowing Meteor Star Head
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1.5, 3 * k), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${c.alpha})`;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    requestAnimationFrame(render);
  }

  render();
}
initMinimal3D();

// ==================== 3D CARD TILT ENGINE ====================
function init3DTilt() {
  document.addEventListener('mousemove', (e) => {
    const cards = document.querySelectorAll('.tilt-card');
    cards.forEach((card) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (
        x >= 0 &&
        x <= rect.width &&
        y >= 0 &&
        y <= rect.height
      ) {
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        const rotateX = ((y - centerY) / centerY) * -5;
        const rotateY = ((x - centerX) / centerX) * 5;

        card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
      } else {
        card.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg)';
      }
    });
  });
}
init3DTilt();

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
  const item = el.fileList.querySelector(`[data-name="${file.name}"]`);
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
      const r = await fetch(`${API}/document/${docId}`);
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
    const r = await fetch(`${API}/documents`);
    if (!r.ok) throw new Error('Failed to load documents');
    state.docs = await r.json();
    renderDocs();
  } catch {
    // Silent fail if offline
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
      renderDocs();
      toast(`Scope: ${doc.filename}`, 'success', 1500);
    });

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
      `⚠️ ${err.message}. Ensure backend is running.`,
      'error'
    );
  } finally {
    state.streaming = false;
    el.sendBtn.disabled = !el.input.value.trim();
  }
}

async function streamResponse(question, typingEl) {
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
        if (p.type === 'status' && p.message) {
          if (statusMsg) statusMsg.textContent = p.message;
        }
        if (p.type === 'token' && p.content) {
          if (statusCard) statusCard.style.display = 'none';
          text += p.content;
          content.innerHTML = renderMD(text);
          scrollBottom();
        }
        if (p.type === 'sources' && p.documents) {
          sources = p.documents;
        }
      } catch {
        /* skip malformed */
      }
    }
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
function addHistoryItem(question) {
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
    el.messages.scrollTo({ top: 0, behavior: 'smooth' });
  });
  el.historyList.appendChild(item);
}

// ==================== CLEAR ====================
el.clearBtn.addEventListener('click', () => {
  $$('.message', el.messages).forEach((m) => m.remove());
  state.messages = [];
  location.reload();
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
console.log('✨ RAG ChatBot application initialized');
