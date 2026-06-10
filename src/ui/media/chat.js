(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  const newSessionBtn = document.getElementById('newSessionBtn');
  const activeAccountEl = document.getElementById('activeAccount');
  const activeModelEl = document.getElementById('activeModel');
  const chatTitleEl = document.getElementById('chatTitle');
  const sessionListEl = document.getElementById('sessionList');
  const searchInput = document.getElementById('searchInput');
  const modelSelect = document.getElementById('modelSelect');
  const effortSelect = document.getElementById('effortSelect');

  let streamingEl = null;
  let streamingRaw = '';
  let sending = false;
  let sessions = [];
  let activeId = null;
  let filter = '';

  // ---------- minimal markdown (CSP-safe, no external libs) ----------
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, (_, c) => '<code>' + escapeHtml(c) + '</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  }
  function renderMarkdown(src) {
    const lines = src.split('\n');
    let html = '';
    let inCode = false, code = '', inUl = false, inOl = false;
    const closeLists = () => { if (inUl) { html += '</ul>'; inUl = false; } if (inOl) { html += '</ol>'; inOl = false; } };
    for (const raw of lines) {
      if (raw.trimStart().startsWith('```')) {
        if (inCode) { html += '<pre><code>' + escapeHtml(code) + '</code></pre>'; code = ''; inCode = false; }
        else { closeLists(); inCode = true; }
        continue;
      }
      if (inCode) { code += raw + '\n'; continue; }
      const h = raw.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeLists(); html += '<h' + (h[1].length + 2) + '>' + inline(escapeHtml(h[2])) + '</h' + (h[1].length + 2) + '>'; continue; }
      const ul = raw.match(/^\s*[-*]\s+(.*)$/);
      if (ul) { if (!inUl) { closeLists(); html += '<ul>'; inUl = true; } html += '<li>' + inline(escapeHtml(ul[1])) + '</li>'; continue; }
      const ol = raw.match(/^\s*\d+\.\s+(.*)$/);
      if (ol) { if (!inOl) { closeLists(); html += '<ol>'; inOl = true; } html += '<li>' + inline(escapeHtml(ol[1])) + '</li>'; continue; }
      if (raw.trim() === '') { closeLists(); continue; }
      closeLists();
      html += '<p>' + inline(escapeHtml(raw)) + '</p>';
    }
    if (inCode) html += '<pre><code>' + escapeHtml(code) + '</code></pre>';
    closeLists();
    return html;
  }

  // ---------- helpers ----------
  function relTime(ms) {
    const s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60); if (m < 60) return m + 'm';
    const h = Math.floor(m / 60); if (h < 24) return h + 'h';
    return Math.floor(h / 24) + 'd';
  }
  function clearWelcome() { const w = messagesEl.querySelector('.welcome'); if (w) w.remove(); }
  function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  function addMessage(role, text, asMarkdown) {
    clearWelcome();
    const row = document.createElement('div');
    row.className = 'msg ' + role;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = role === 'user' ? 'Tú' : 'Claude';
    const body = document.createElement('div');
    body.className = 'body';
    if (asMarkdown) body.innerHTML = renderMarkdown(text || '');
    else body.textContent = text || '';
    row.appendChild(who);
    row.appendChild(body);
    messagesEl.appendChild(row);
    scrollToBottom();
    return body;
  }
  function addNotice(kind, text) {
    clearWelcome();
    const el = document.createElement('div');
    el.className = 'notice ' + kind;
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }
  function setSending(state) {
    sending = state;
    sendBtn.disabled = state;
    inputEl.disabled = state;
    if (!state) inputEl.focus();
  }
  function finalizeStreaming() {
    if (streamingEl) {
      streamingEl.parentElement.classList.remove('streaming');
      if (streamingRaw) streamingEl.innerHTML = renderMarkdown(streamingRaw);
      else streamingEl.parentElement.remove();
      streamingEl = null;
      streamingRaw = '';
    }
  }
  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
  }

  // ---------- session sidebar ----------
  function renderSessions() {
    sessionListEl.innerHTML = '';
    const list = sessions.filter((s) => s.name.toLowerCase().includes(filter));
    if (list.length === 0) {
      const e = document.createElement('div');
      e.className = 'session-empty';
      e.textContent = sessions.length === 0 ? 'Sin sesiones con nombre todavía.' : 'Sin coincidencias.';
      sessionListEl.appendChild(e);
      return;
    }
    for (const s of list) {
      const item = document.createElement('div');
      item.className = 'session-item' + (s.id === activeId ? ' active' : '');
      const name = document.createElement('span');
      name.className = 'name'; name.textContent = s.name;
      const ago = document.createElement('span');
      ago.className = 'ago'; ago.textContent = relTime(s.mtime);
      item.appendChild(name); item.appendChild(ago);
      item.addEventListener('click', () => { if (!sending) vscode.postMessage({ type: 'selectSession', id: s.id }); });
      sessionListEl.appendChild(item);
    }
  }
  function setActiveTitle() {
    const s = sessions.find((x) => x.id === activeId);
    chatTitleEl.textContent = s ? s.name : 'Nueva conversación';
  }

  // ---------- chat ----------
  function send() {
    if (sending) return;
    const text = inputEl.value.trim();
    if (!text) return;
    addMessage('user', text, false);
    inputEl.value = ''; autoGrow();
    setSending(true);
    streamingRaw = '';
    streamingEl = addMessage('assistant', '', false);
    streamingEl.parentElement.classList.add('streaming');
    vscode.postMessage({ type: 'send', text });
  }

  // ---------- events ----------
  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  sendBtn.addEventListener('click', send);
  newSessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
  searchInput.addEventListener('input', () => { filter = searchInput.value.trim().toLowerCase(); renderSessions(); });
  modelSelect.addEventListener('change', () => vscode.postMessage({ type: 'setModel', value: modelSelect.value }));
  effortSelect.addEventListener('change', () => vscode.postMessage({ type: 'setEffort', value: effortSelect.value }));

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'config':
        if (typeof msg.model === 'string') modelSelect.value = [...modelSelect.options].some((o) => o.value === msg.model) ? msg.model : '';
        if (typeof msg.effort === 'string') effortSelect.value = msg.effort;
        break;
      case 'sessions':
        sessions = msg.sessions || [];
        activeId = msg.activeId ?? activeId;
        renderSessions(); setActiveTitle();
        break;
      case 'history':
        activeId = msg.activeId ?? null;
        messagesEl.innerHTML = ''; streamingEl = null; streamingRaw = '';
        if (!msg.messages || msg.messages.length === 0) {
          if (!activeId) addNotice('info', 'Nueva conversación. Escribe para empezar.');
        } else {
          for (const m of msg.messages) addMessage(m.role, m.text, m.role === 'assistant');
        }
        renderSessions(); setActiveTitle(); setSending(false);
        break;
      case 'meta':
        activeAccountEl.textContent = msg.activeAccount || '—';
        break;
      case 'model':
        if (msg.model) activeModelEl.textContent = msg.model;
        break;
      case 'delta':
        if (streamingEl) { streamingRaw += msg.text; streamingEl.textContent = streamingRaw; scrollToBottom(); }
        break;
      case 'switch':
        if (streamingEl) { streamingEl.parentElement.remove(); streamingEl = null; streamingRaw = ''; }
        addNotice('switch', '↻ Cambiando a ' + msg.label + ' (' + msg.reason + ') — continúo…');
        streamingRaw = '';
        streamingEl = addMessage('assistant', '', false);
        streamingEl.parentElement.classList.add('streaming');
        break;
      case 'info':
        addNotice('info', msg.text);
        break;
      case 'turnError':
        finalizeStreaming();
        addNotice('error', '⚠ ' + msg.text);
        setSending(false);
        break;
      case 'done':
        finalizeStreaming();
        setSending(false);
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
  inputEl.focus();
})();
