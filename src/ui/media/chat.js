(function () {
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages');
  const inputEl = $('input');
  const sendBtn = $('sendBtn');
  const activeAccountEl = $('activeAccount');
  const activeModelEl = $('activeModel');
  const chatTitleEl = $('chatTitle');
  const modelSelect = $('modelSelect');
  const effortSelect = $('effortSelect');
  const claudeControls = $('claudeControls');
  const webControls = $('webControls');
  const webModelSelect = $('webModelSelect');
  const webToggles = $('webToggles');
  const acctBtn = $('acctBtn');
  const acctMenu = $('acctMenu');
  const acctList = $('acctList');
  const plusBtn = $('plusBtn');
  const plusMenu = $('plusMenu');
  const slashMenu = $('slashMenu');

  let streamingEl = null, streamingRaw = '', sending = false, activeId = null;
  let slashCommands = [], slashItems = [], slashSel = -1;

  // ---------- markdown (CSP-safe) ----------
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function inline(s) {
    return s.replace(/`([^`]+)`/g, (_, c) => '<code>' + esc(c) + '</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  }
  function renderMarkdown(src) {
    const lines = src.split('\n'); let html = '', inCode = false, code = '', inUl = false, inOl = false;
    const closeLists = () => { if (inUl) { html += '</ul>'; inUl = false; } if (inOl) { html += '</ol>'; inOl = false; } };
    for (const raw of lines) {
      if (raw.trimStart().startsWith('```')) {
        if (inCode) { html += '<pre><code>' + esc(code) + '</code></pre>'; code = ''; inCode = false; }
        else { closeLists(); inCode = true; } continue;
      }
      if (inCode) { code += raw + '\n'; continue; }
      const h = raw.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeLists(); const n = h[1].length + 2; html += '<h' + n + '>' + inline(esc(h[2])) + '</h' + n + '>'; continue; }
      const ul = raw.match(/^\s*[-*]\s+(.*)$/);
      if (ul) { if (!inUl) { closeLists(); html += '<ul>'; inUl = true; } html += '<li>' + inline(esc(ul[1])) + '</li>'; continue; }
      const ol = raw.match(/^\s*\d+\.\s+(.*)$/);
      if (ol) { if (!inOl) { closeLists(); html += '<ol>'; inOl = true; } html += '<li>' + inline(esc(ol[1])) + '</li>'; continue; }
      if (raw.trim() === '') { closeLists(); continue; }
      closeLists(); html += '<p>' + inline(esc(raw)) + '</p>';
    }
    if (inCode) html += '<pre><code>' + esc(code) + '</code></pre>'; closeLists(); return html;
  }

  // ---------- helpers ----------
  const clearWelcome = () => { const w = messagesEl.querySelector('.welcome'); if (w) w.remove(); };
  const scrollToBottom = () => { messagesEl.scrollTop = messagesEl.scrollHeight; };
  function buildMessageEl(role, text, asMarkdown) {
    const row = document.createElement('div'); row.className = 'msg ' + role;
    const who = document.createElement('div'); who.className = 'who'; who.textContent = role === 'user' ? 'Tú' : 'Claude';
    const body = document.createElement('div'); body.className = 'body';
    if (asMarkdown) body.innerHTML = renderMarkdown(text || ''); else body.textContent = text || '';
    row.appendChild(who); row.appendChild(body);
    return { row, body };
  }
  function addMessage(role, text, asMarkdown) {
    clearWelcome();
    const { row, body } = buildMessageEl(role, text, asMarkdown);
    messagesEl.appendChild(row); scrollToBottom(); return body;
  }

  // ---------- loading screen + progressive history ----------
  let allMessages = [];
  let renderedStart = 0;
  const INITIAL_CHUNK = 60, RAF_BATCH = 15, EARLIER_CHUNK = 100;

  function showLoading(title) {
    messagesEl.innerHTML = '';
    streamingEl = null; streamingRaw = '';
    const box = document.createElement('div');
    box.className = 'loading-box';
    box.innerHTML = '<div class="spinner"></div><div class="loading-text">Cargando ' + (title ? '“' + title + '”' : 'chat') + '…</div><div class="loading-sub">Leyendo historial local (no gasta tokens)</div>';
    messagesEl.appendChild(box);
    inputEl.disabled = true; sendBtn.disabled = true;
  }

  function addLoadEarlierBtn() {
    const btn = document.createElement('button');
    btn.id = 'loadEarlier';
    btn.className = 'load-earlier';
    btn.textContent = '⬆ Cargar ' + Math.min(EARLIER_CHUNK, renderedStart) + ' mensajes anteriores (' + renderedStart + ' ocultos)';
    btn.addEventListener('click', () => {
      const from = Math.max(0, renderedStart - EARLIER_CHUNK);
      const frag = document.createDocumentFragment();
      for (let i = from; i < renderedStart; i++) {
        const m = allMessages[i];
        frag.appendChild(buildMessageEl(m.role, m.text, m.role === 'assistant').row);
      }
      btn.after(frag);
      renderedStart = from;
      if (renderedStart === 0) btn.remove();
      else btn.textContent = '⬆ Cargar ' + Math.min(EARLIER_CHUNK, renderedStart) + ' mensajes anteriores (' + renderedStart + ' ocultos)';
    });
    messagesEl.appendChild(btn);
  }

  function renderHistory(messages) {
    messagesEl.innerHTML = '';
    streamingEl = null; streamingRaw = '';
    allMessages = messages || [];
    if (allMessages.length === 0) {
      if (!activeId) addNotice('info', 'Nueva conversación. Escribe para empezar.');
      setSending(false);
      return;
    }
    renderedStart = Math.max(0, allMessages.length - INITIAL_CHUNK);
    if (renderedStart > 0) addLoadEarlierBtn();
    // Progressive render in rAF batches so the webview never freezes.
    let i = renderedStart;
    const step = () => {
      const end = Math.min(i + RAF_BATCH, allMessages.length);
      const frag = document.createDocumentFragment();
      for (; i < end; i++) {
        const m = allMessages[i];
        frag.appendChild(buildMessageEl(m.role, m.text, m.role === 'assistant').row);
      }
      messagesEl.appendChild(frag);
      scrollToBottom();
      if (i < allMessages.length) requestAnimationFrame(step);
      else setSending(false);
    };
    requestAnimationFrame(step);
  }
  function addNotice(kind, text) {
    clearWelcome(); const el = document.createElement('div'); el.className = 'notice ' + kind; el.textContent = text;
    messagesEl.appendChild(el); scrollToBottom();
  }
  function setSending(s) { sending = s; sendBtn.disabled = s; inputEl.disabled = s; if (!s) inputEl.focus(); }
  function finalizeStreaming() {
    if (streamingEl) {
      streamingEl.parentElement.classList.remove('streaming');
      if (streamingRaw) streamingEl.innerHTML = renderMarkdown(streamingRaw); else streamingEl.parentElement.remove();
      streamingEl = null; streamingRaw = '';
    }
  }
  function autoGrow() { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px'; }

  // ---------- menus ----------
  function closeMenus() { acctMenu.classList.add('hidden'); plusMenu.classList.add('hidden'); }
  document.addEventListener('click', (e) => {
    if (!acctMenu.contains(e.target) && e.target !== acctBtn) acctMenu.classList.add('hidden');
    if (!plusMenu.contains(e.target) && e.target !== plusBtn) plusMenu.classList.add('hidden');
  });
  acctBtn.addEventListener('click', (e) => { e.stopPropagation(); plusMenu.classList.add('hidden'); acctMenu.classList.toggle('hidden'); });
  plusBtn.addEventListener('click', (e) => { e.stopPropagation(); acctMenu.classList.add('hidden'); plusMenu.classList.toggle('hidden'); });
  acctMenu.addEventListener('click', (e) => {
    const act = e.target.getAttribute && e.target.getAttribute('data-act');
    if (act) { vscode.postMessage({ type: act }); closeMenus(); }
  });
  plusMenu.addEventListener('click', (e) => {
    const act = e.target.getAttribute && e.target.getAttribute('data-act');
    if (act) { vscode.postMessage({ type: act }); closeMenus(); }
  });
  function renderAccounts(accounts) {
    acctList.innerHTML = '';
    (accounts || []).forEach((a) => {
      const b = document.createElement('button');
      b.className = 'menu-item' + (a.active ? ' active' : '');
      b.textContent = (a.active ? '● ' : '○ ') + a.label;
      b.addEventListener('click', () => { vscode.postMessage({ type: 'switchAccount', id: a.id }); closeMenus(); });
      acctList.appendChild(b);
    });
  }

  // ---------- slash autocomplete ----------
  function currentSlashQuery() {
    const v = inputEl.value;
    const m = v.match(/^\/(\S*)$/); // single token at start, like native
    return m ? m[1] : null;
  }
  function updateSlash() {
    const q = currentSlashQuery();
    if (q === null || slashCommands.length === 0) { slashMenu.classList.add('hidden'); slashSel = -1; return; }
    const ql = q.toLowerCase();
    slashItems = slashCommands.filter((c) => c.toLowerCase().includes(ql)).slice(0, 50);
    if (slashItems.length === 0) { slashMenu.classList.add('hidden'); slashSel = -1; return; }
    slashSel = 0;
    slashMenu.innerHTML = '';
    slashItems.forEach((c, i) => {
      const it = document.createElement('div');
      it.className = 'slash-item' + (i === 0 ? ' sel' : '');
      const cmd = document.createElement('span'); cmd.className = 'cmd'; cmd.textContent = c;
      it.appendChild(cmd);
      it.addEventListener('mousedown', (e) => { e.preventDefault(); acceptSlash(i); });
      slashMenu.appendChild(it);
    });
    slashMenu.classList.remove('hidden');
  }
  function moveSlash(d) {
    if (slashMenu.classList.contains('hidden')) return;
    const items = slashMenu.querySelectorAll('.slash-item');
    if (!items.length) return;
    items[slashSel] && items[slashSel].classList.remove('sel');
    slashSel = (slashSel + d + items.length) % items.length;
    items[slashSel].classList.add('sel');
    items[slashSel].scrollIntoView({ block: 'nearest' });
  }
  function acceptSlash(i) {
    const idx = i != null ? i : slashSel;
    if (idx < 0 || idx >= slashItems.length) return;
    inputEl.value = '/' + slashItems[idx] + ' ';
    slashMenu.classList.add('hidden'); slashSel = -1; inputEl.focus(); autoGrow();
  }

  // ---------- chat ----------
  function send() {
    if (sending) return;
    const text = inputEl.value.trim();
    if (!text) return;
    addMessage('user', text, false);
    inputEl.value = ''; autoGrow(); slashMenu.classList.add('hidden');
    setSending(true); streamingRaw = '';
    streamingEl = addMessage('assistant', '', false);
    streamingEl.parentElement.classList.add('streaming');
    vscode.postMessage({ type: 'send', text });
  }

  // ---------- events ----------
  inputEl.addEventListener('input', () => { autoGrow(); updateSlash(); });
  inputEl.addEventListener('keydown', (e) => {
    const slashOpen = !slashMenu.classList.contains('hidden');
    if (slashOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); moveSlash(e.key === 'ArrowDown' ? 1 : -1); return; }
    if (slashOpen && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) { e.preventDefault(); acceptSlash(); return; }
    if (slashOpen && e.key === 'Escape') { slashMenu.classList.add('hidden'); slashSel = -1; return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  sendBtn.addEventListener('click', send);
  modelSelect.addEventListener('change', () => vscode.postMessage({ type: 'setModel', value: modelSelect.value }));
  effortSelect.addEventListener('change', () => vscode.postMessage({ type: 'setEffort', value: effortSelect.value }));
  webModelSelect.addEventListener('change', () => {
    const opt = webModelSelect.options[webModelSelect.selectedIndex];
    if (opt) activeModelEl.textContent = opt.textContent;
    vscode.postMessage({ type: 'setWebModel', value: webModelSelect.value });
  });

  function renderWebControls(msg) {
    if (!msg.web) {
      webControls.classList.add('hidden');
      claudeControls.classList.remove('hidden');
      return;
    }
    // Web account (DeepSeek, …): swap in its in-chat models + feature toggles.
    claudeControls.classList.add('hidden');
    webControls.classList.remove('hidden');
    webModelSelect.innerHTML = '';
    (msg.models || []).forEach((m) => {
      const o = document.createElement('option');
      o.value = m.id; o.textContent = m.label;
      webModelSelect.appendChild(o);
    });
    if (msg.selectedModel) webModelSelect.value = msg.selectedModel;
    const selOpt = webModelSelect.options[webModelSelect.selectedIndex];
    if (selOpt) activeModelEl.textContent = selOpt.textContent;
    webToggles.innerHTML = '';
    (msg.toggles || []).forEach((t) => {
      const chip = document.createElement('button');
      chip.className = 'toggle-chip';
      chip.textContent = t.label;
      chip.dataset.id = t.id;
      chip.dataset.on = '0';
      chip.addEventListener('click', () => {
        const on = chip.dataset.on === '1' ? false : true;
        chip.dataset.on = on ? '1' : '0';
        chip.classList.toggle('on', on);
        vscode.postMessage({ type: 'setWebToggle', id: t.id, on });
      });
      webToggles.appendChild(chip);
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'config':
        if (typeof msg.effort === 'string') effortSelect.value = msg.effort;
        break;
      case 'models': {
        // Copilot-style: dropdown populated with the models the API key supports.
        modelSelect.innerHTML = '';
        (msg.models || []).forEach((m) => {
          const o = document.createElement('option');
          o.value = m.id; o.textContent = m.label;
          modelSelect.appendChild(o);
        });
        if (msg.selected) modelSelect.value = msg.selected;
        break;
      }
      case 'webControls': renderWebControls(msg); break;
      case 'accounts': renderAccounts(msg.accounts); break;
      case 'slash': slashCommands = msg.commands || []; break;
      case 'loading':
        showLoading(msg.title);
        break;
      case 'history':
        activeId = msg.activeId ?? null;
        renderHistory(msg.messages);
        break;
      case 'meta':
        activeAccountEl.textContent = msg.activeAccount || '—';
        break;
      case 'title': chatTitleEl.textContent = msg.title || 'Nueva conversación'; break;
      case 'model': if (msg.model) activeModelEl.textContent = msg.model; break;
      case 'usage': {
        // Show when the usage limit resets (from claude's rate_limit_event).
        const usageBadge = document.getElementById('usageBadge');
        const resetsAt = msg.info && msg.info.resetsAt;
        if (usageBadge && typeof resetsAt === 'number') {
          const remMs = resetsAt * 1000 - Date.now();
          if (remMs > 0) {
            const h = Math.floor(remMs / 3600000), m = Math.ceil((remMs % 3600000) / 60000);
            usageBadge.textContent = 'límite resetea en ' + (h > 0 ? h + 'h ' : '') + m + 'm';
            usageBadge.classList.remove('hidden');
          }
        }
        break;
      }
      case 'insert': inputEl.value += (msg.text || ''); autoGrow(); inputEl.focus(); break;
      case 'delta': if (streamingEl) { streamingRaw += msg.text; streamingEl.textContent = streamingRaw; scrollToBottom(); } break;
      case 'switch':
        if (streamingEl) { streamingEl.parentElement.remove(); streamingEl = null; streamingRaw = ''; }
        addNotice('switch', '↻ Cambiando a ' + msg.label + ' (' + msg.reason + ') — continúo…');
        streamingRaw = ''; streamingEl = addMessage('assistant', '', false); streamingEl.parentElement.classList.add('streaming');
        break;
      case 'info': addNotice('info', msg.text); break;
      case 'turnError':
        // Drop the partial bubble — its text was an error notice, not a reply.
        if (streamingEl) { streamingEl.parentElement.remove(); streamingEl = null; streamingRaw = ''; }
        addNotice('error', '⚠ ' + msg.text);
        setSending(false);
        break;
      case 'done': finalizeStreaming(); setSending(false); break;
    }
  });

  vscode.postMessage({ type: 'ready' });
  inputEl.focus();
})();
