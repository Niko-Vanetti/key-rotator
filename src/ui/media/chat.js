(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  const newSessionBtn = document.getElementById('newSessionBtn');
  const activeAccountEl = document.getElementById('activeAccount');
  const chatTitleEl = document.getElementById('chatTitle');
  const sessionListEl = document.getElementById('sessionList');
  const searchInput = document.getElementById('searchInput');

  let streamingEl = null;
  let sending = false;
  let sessions = [];
  let activeId = null;
  let filter = '';

  // ---------- helpers ----------
  function relTime(ms) {
    const s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h';
    const d = Math.floor(h / 24);
    return d + 'd';
  }

  function clearWelcome() {
    const w = messagesEl.querySelector('.welcome');
    if (w) w.remove();
  }
  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function addBubble(role, text) {
    clearWelcome();
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.textContent = text || '';
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
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
      streamingEl.classList.remove('streaming');
      if (!streamingEl.textContent) streamingEl.remove();
      streamingEl = null;
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
      name.className = 'name';
      name.textContent = s.name;
      const ago = document.createElement('span');
      ago.className = 'ago';
      ago.textContent = relTime(s.mtime);
      item.appendChild(name);
      item.appendChild(ago);
      item.addEventListener('click', () => {
        if (sending) return;
        vscode.postMessage({ type: 'selectSession', id: s.id });
      });
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
    addBubble('user', text);
    inputEl.value = '';
    autoGrow();
    setSending(true);
    streamingEl = addBubble('assistant', '');
    streamingEl.classList.add('streaming');
    vscode.postMessage({ type: 'send', text });
  }

  // ---------- events ----------
  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener('click', send);
  newSessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
  searchInput.addEventListener('input', () => {
    filter = searchInput.value.trim().toLowerCase();
    renderSessions();
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'sessions':
        sessions = msg.sessions || [];
        activeId = msg.activeId ?? activeId;
        renderSessions();
        setActiveTitle();
        break;
      case 'history':
        // Render an existing conversation (or clear for a new one).
        activeId = msg.activeId ?? null;
        messagesEl.innerHTML = '';
        streamingEl = null;
        if (!msg.messages || msg.messages.length === 0) {
          if (!activeId) addNotice('info', 'Nueva conversación. Escribe para empezar.');
        } else {
          for (const m of msg.messages) addBubble(m.role, m.text);
        }
        renderSessions();
        setActiveTitle();
        setSending(false);
        break;
      case 'meta':
        activeAccountEl.textContent = msg.activeAccount || '—';
        break;
      case 'delta':
        if (streamingEl) {
          streamingEl.textContent += msg.text;
          scrollToBottom();
        }
        break;
      case 'switch':
        if (streamingEl) {
          streamingEl.remove();
          streamingEl = null;
        }
        addNotice('switch', '↻ Cambiando a ' + msg.label + ' (' + msg.reason + ') — continúo la conversación…');
        streamingEl = addBubble('assistant', '');
        streamingEl.classList.add('streaming');
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
