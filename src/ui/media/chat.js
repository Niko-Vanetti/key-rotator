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
  const mediaViewer = $('mediaViewer');
  const viewerImage = $('viewerImage');

  let streamingEl = null, streamingRaw = '', sending = false, activeId = null;
  let slashCommands = [], slashItems = [], slashSel = -1;
  const pendingMedia = new Map();
  let viewerItems = [], viewerIndex = 0;

  // ---------- markdown (CSP-safe) ----------
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function inline(s) {
    return s.replace(/`([^`]+)`/g, (_, c) => '<code>' + esc(c) + '</code>')
      // Imágenes generadas: ![alt](data:image/... | https://...). Solo se
      // aceptan esos dos orígenes, que son los que permite la CSP.
      .replace(/!\[([^\]]*)\]\((data:image\/[^)]+|https:\/\/[^)]+)\)/g,
        (_, alt, src) => '<img alt="' + alt + '" src="' + src + '" />')
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
  // Name shown on assistant bubbles — updated from the active account (so a
  // DeepSeek web account doesn't get labeled "Claude").
  let assistantName = 'Claude';
  const clearWelcome = () => { const w = messagesEl.querySelector('.welcome'); if (w) w.remove(); };
  const scrollToBottom = () => { messagesEl.scrollTop = messagesEl.scrollHeight; };
  function buildMessageEl(role, text, asMarkdown, attachments) {
    const row = document.createElement('div'); row.className = 'msg ' + role;
    const who = document.createElement('div'); who.className = 'who'; who.textContent = role === 'user' ? 'Tú' : assistantName;
    const body = document.createElement('div'); body.className = 'body';
    if (asMarkdown) body.innerHTML = renderMarkdown(text || ''); else body.textContent = text || '';
    row.appendChild(who); row.appendChild(body);
    body.querySelectorAll('img').forEach((img) => {
      img.tabIndex = 0;
      img.addEventListener('click', () => openMediaViewer([{ id: '', name: img.alt || 'Imagen', previewUri: img.src }], 0));
      img.addEventListener('keydown', (e) => { if (e.key === 'Enter') img.click(); });
    });
    if (attachments && attachments.length) {
      const gallery = document.createElement('div');
      gallery.className = 'message-attachments';
      attachments.forEach((a) => gallery.appendChild(renderAttachmentTile(a, false)));
      row.appendChild(gallery);
    }
    return { row, body };
  }
  function addMessage(role, text, asMarkdown, attachments) {
    clearWelcome();
    const { row, body } = buildMessageEl(role, text, asMarkdown, attachments);
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
        frag.appendChild(buildMessageEl(m.role, m.text, m.role === 'assistant', m.attachments).row);
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
        frag.appendChild(buildMessageEl(m.role, m.text, m.role === 'assistant', m.attachments).row);
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
  // Mientras responde, el botón pasa a "Detener"; el input NUNCA se bloquea
  // (lo que escribas se encola).
  function setSending(s) {
    sending = s;
    sendBtn.textContent = s ? '■' : '↑';
    sendBtn.classList.toggle('stopping', s);
    const label = s ? 'Detener la respuesta' : 'Enviar mensaje';
    sendBtn.title = label;
    sendBtn.setAttribute('aria-label', label);
    sendBtn.disabled = false;
    inputEl.disabled = false;
    if (!s) inputEl.focus();
  }
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
    const item = e.target.closest ? e.target.closest('[data-act],[data-mode]') : null;
    if (!item) return;
    const mode = item.getAttribute('data-mode');
    if (mode) {
      acctMenu.querySelectorAll('.mode-item').forEach((b) => {
        const on = b.getAttribute('data-mode') === mode;
        b.classList.toggle('active', on);
        const bold = b.querySelector('b');
        if (bold) bold.textContent = (on ? '● ' : '○ ') + bold.textContent.replace(/^[●○]\s*/, '');
      });
      applyMode(mode);
      vscode.postMessage({ type: 'setMode', value: mode });
      closeMenus();
      return;
    }
    const act = item.getAttribute('data-act');
    if (act) { vscode.postMessage({ type: act }); closeMenus(); }
  });
  plusMenu.addEventListener('click', (e) => {
    const act = e.target.getAttribute && e.target.getAttribute('data-act');
    if (act) { vscode.postMessage({ type: act }); closeMenus(); }
  });
  function renderAccounts(accounts) {
    if (!acctList) return;
    acctList.innerHTML = '';
    (accounts || []).forEach((a) => {
      const b = document.createElement('button');
      b.className = 'menu-item' + (a.active ? ' active' : '');
      b.textContent = (a.active ? '● ' : '○ ') + a.label;
      b.addEventListener('click', () => { vscode.postMessage({ type: 'switchAccount', id: a.id }); closeMenus(); });
      acctList.appendChild(b);
    });
  }

  // En modo agencia el modelo y el esfuerzo los decide el director: se
  // bloquean los selectores para que no haya dos fuentes de verdad.
  function applyMode(mode) {
    const agency = mode === 'agency';
    const images = mode === 'images';
    const ctl = document.getElementById('claudeControls');
    // En agencia manda el director; en imágenes hay su propio selector.
    if (ctl) ctl.classList.toggle('locked', agency);
    if (ctl) ctl.classList.toggle('hidden', images);
    [modelSelect, effortSelect].forEach((el) => {
      if (!el) return;
      el.disabled = agency;
      el.title = agency ? 'En modo agencia lo decide el director (elígelo en Administrar modelos)' : '';
    });
    const imgCtl = document.getElementById('imageControls');
    if (imgCtl) imgCtl.classList.toggle('hidden', !images);
    const research = document.getElementById('researchBtn');
    if (research) research.classList.toggle('hidden', images);
    if (inputEl) {
      inputEl.placeholder = images
        ? 'Describe la imagen…  (adjunta una imagen para editarla)'
        : 'Escribe un mensaje…  ( / para comandos · Enter envía )';
    }
  }

  // Catálogo de modelos de imagen (solo aparece en modo imágenes).
  function renderImageModels(models, selected) {
    const sel = document.getElementById('imageModelSelect');
    if (!sel) return;
    sel.innerHTML = '';
    (models || []).forEach((m) => {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.label;
      o.title = m.note || '';
      sel.appendChild(o);
    });
    if (selected) sel.value = selected;
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

  // ---------- attachments (web chat file upload) ----------
  const attachBar = $('attachBar');
  const formatBytes = (size) => size < 1024 ? size + ' B' : size < 1048576 ? (size / 1024).toFixed(1) + ' KB' : (size / 1048576).toFixed(1) + ' MB';
  function renderAttachmentTile(attachment, pending) {
    const tile = document.createElement('div');
    tile.className = 'attachment-tile';
    tile.dataset.id = attachment.id || '';
    const preview = document.createElement('button');
    preview.className = 'attachment-preview';
    preview.type = 'button';
    preview.title = attachment.kind === 'image' ? 'Ver imagen' : attachment.name;
    if (attachment.kind === 'image' && attachment.previewUri) {
      const img = document.createElement('img');
      img.src = attachment.previewUri;
      img.alt = '';
      preview.appendChild(img);
      preview.addEventListener('click', () => {
        const images = [...(pending ? pendingMedia.values() : [attachment])].filter((a) => a.kind === 'image' && a.previewUri);
        openMediaViewer(images, Math.max(0, images.findIndex((a) => a.id === attachment.id)));
      });
    } else {
      preview.textContent = (attachment.kind || 'file').slice(0, 4).toUpperCase();
      preview.disabled = true;
    }
    const info = document.createElement('span');
    info.className = 'attachment-info';
    const name = document.createElement('span');
    name.className = 'attachment-name';
    name.textContent = attachment.name;
    const size = document.createElement('span');
    size.className = 'attachment-size';
    size.textContent = formatBytes(attachment.size || 0) + ' · ' + (attachment.kind || 'archivo');
    info.append(name, size);
    tile.append(preview, info);
    if (pending) {
      const remove = document.createElement('button');
      remove.className = 'attachment-remove';
      remove.title = 'Quitar';
      remove.setAttribute('aria-label', 'Quitar ' + attachment.name);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        vscode.postMessage({ type: 'removeWebFile', value: attachment.id });
        pendingMedia.delete(attachment.id);
        tile.remove();
        if (!attachBar.children.length) attachBar.classList.add('hidden');
      });
      tile.appendChild(remove);
    }
    return tile;
  }
  function addAttachChip(attachment) {
    if (!attachment || !attachment.id) return;
    attachBar.classList.remove('hidden');
    pendingMedia.set(attachment.id, attachment);
    attachBar.appendChild(renderAttachmentTile(attachment, true));
  }
  function clearAttachChips() {
    pendingMedia.clear();
    attachBar.innerHTML = '';
    attachBar.classList.add('hidden');
  }

  function paintViewer() {
    const item = viewerItems[viewerIndex];
    if (!item) return;
    viewerImage.src = item.previewUri;
    viewerImage.alt = item.name || 'Imagen';
    $('viewerTitle').textContent = item.name || 'Vista previa';
    $('viewerMeta').textContent = formatBytes(item.size || 0);
    $('viewerPrev').disabled = viewerItems.length < 2;
    $('viewerNext').disabled = viewerItems.length < 2;
    $('viewerOpen').disabled = !item.id;
    $('viewerReveal').disabled = !item.id;
  }
  function openMediaViewer(items, index) {
    viewerItems = (items || []).filter((a) => a && a.previewUri);
    if (!viewerItems.length) return;
    viewerIndex = Math.max(0, Math.min(index || 0, viewerItems.length - 1));
    paintViewer();
    mediaViewer.classList.remove('hidden');
    $('viewerClose').focus();
  }
  function closeMediaViewer() {
    mediaViewer.classList.add('hidden');
    viewerImage.removeAttribute('src');
  }
  function moveViewer(delta) {
    if (!viewerItems.length) return;
    viewerIndex = (viewerIndex + delta + viewerItems.length) % viewerItems.length;
    paintViewer();
  }
  $('viewerClose').addEventListener('click', closeMediaViewer);
  $('viewerPrev').addEventListener('click', () => moveViewer(-1));
  $('viewerNext').addEventListener('click', () => moveViewer(1));
  $('viewerOpen').addEventListener('click', () => {
    const item = viewerItems[viewerIndex];
    if (item?.id) vscode.postMessage({ type: 'openAttachment', id: item.id });
  });
  $('viewerReveal').addEventListener('click', () => {
    const item = viewerItems[viewerIndex];
    if (item?.id) vscode.postMessage({ type: 'revealAttachment', id: item.id });
  });
  document.addEventListener('keydown', (e) => {
    if (mediaViewer.classList.contains('hidden')) return;
    if (e.key === 'Escape') closeMediaViewer();
    if (e.key === 'ArrowLeft') moveViewer(-1);
    if (e.key === 'ArrowRight') moveViewer(1);
  });

  // ---------- chat ----------
  // Mensajes escritos mientras el agente responde: se encolan y salen solos
  // cuando termina el turno (se muestran atenuados con "en cola").
  const queue = [];
  function renderQueue() {
    let bar = $('queueBar');
    if (!bar) return;
    bar.innerHTML = '';
    bar.classList.toggle('hidden', queue.length === 0);
    queue.forEach((q, i) => {
      const chip = document.createElement('div');
      chip.className = 'queue-chip';
      chip.innerHTML = '<span>🕐 en cola: ' + q.replace(/</g, '&lt;').slice(0, 80) + '</span>';
      const x = document.createElement('button');
      x.textContent = '✕'; x.title = 'Quitar de la cola';
      x.addEventListener('click', () => { queue.splice(i, 1); renderQueue(); });
      chip.appendChild(x);
      bar.appendChild(chip);
    });
  }
  function flushQueue() {
    if (sending || queue.length === 0) return;
    const next = queue.shift();
    renderQueue();
    dispatch(next);
  }
  function dispatch(text) {
    setSending(true); streamingRaw = '';
    streamingEl = addMessage('assistant', '', false);
    streamingEl.parentElement.classList.add('streaming');
    setStatus('Conectando…');
    vscode.postMessage({ type: 'send', text });
  }

  // ---------- indicador de actividad en vivo ----------
  // Una sola línea que se REEMPLAZA (no se apila) + cronómetro, para que nunca
  // parezca congelado mientras el modelo piensa o usa herramientas.
  let statusEl = null, statusTimer = null, statusStart = 0, statusText = '';
  function setStatus(text) {
    if (!text) { clearStatus(); return; }
    statusText = text;
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.className = 'status-line';
      statusStart = Date.now();
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = setInterval(paintStatus, 1000);
    }
    // Siempre al final del hilo, justo antes de la burbuja en curso.
    const anchor = streamingEl ? streamingEl.parentElement : null;
    if (anchor && anchor.parentElement === messagesEl) messagesEl.insertBefore(statusEl, anchor);
    else messagesEl.appendChild(statusEl);
    paintStatus();
    scrollToBottom();
  }
  function paintStatus() {
    if (!statusEl) return;
    const secs = Math.floor((Date.now() - statusStart) / 1000);
    const clock = secs >= 60 ? Math.floor(secs / 60) + 'm ' + (secs % 60) + 's' : secs + 's';
    statusEl.innerHTML =
      '<span class="spinner"></span><span class="status-text"></span><span class="status-time"></span>';
    statusEl.querySelector('.status-text').textContent = statusText;
    statusEl.querySelector('.status-time').textContent = clock;
  }
  function clearStatus() {
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (statusEl) { statusEl.remove(); statusEl = null; }
    statusText = '';
  }
  function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    const atts = [...pendingMedia.values()];
    addMessage('user', text, false, atts);
    inputEl.value = ''; autoGrow(); slashMenu.classList.add('hidden');
    clearAttachChips();
    if (sending) { queue.push(text); renderQueue(); return; }
    dispatch(text);
  }
  function stop() {
    vscode.postMessage({ type: 'stop' });
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
  sendBtn.addEventListener('click', () => (sending ? stop() : send()));

  // Investigación profunda: interruptor explícito. Apagado = responde directo.
  const researchBtn = $('researchBtn');
  if (researchBtn) {
    researchBtn.addEventListener('click', () => {
      const on = !researchBtn.classList.contains('on');
      researchBtn.classList.toggle('on', on);
      vscode.postMessage({ type: 'setResearch', on });
    });
  }

  // ---------- pegar una imagen con Ctrl+V ----------
  // El portapapeles trae la imagen como bytes (no como ruta), así que se manda
  // en base64 y el host la guarda en un archivo temporal para adjuntarla.
  inputEl.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind !== 'file' || !it.type.startsWith('image/')) continue;
      const file = it.getAsFile();
      if (!file) continue;
      e.preventDefault(); // no pegar también la basura de texto del portapapeles
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        vscode.postMessage({ type: 'pasteImage', data: b64, mime: file.type, name: file.name || '' });
      };
      reader.readAsDataURL(file);
      return;
    }
  });

  // ---------- arrastrar y soltar archivos sobre el chat ----------
  // VS Code entrega rutas por 'text/uri-list' (explorador u SO); File.path es
  // el respaldo. El host convierte las URIs a rutas reales y las adjunta.
  const dropZone = document.body;
  ['dragenter', 'dragover'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('dropping');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (ev === 'dragleave' && e.relatedTarget) return; // sigue dentro
      dropZone.classList.remove('dropping');
    })
  );
  dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    const items = [];
    const uriList = dt.getData('text/uri-list') || dt.getData('resourceurls') || '';
    if (uriList) {
      // 'resourceurls' llega como JSON array de strings
      try {
        const arr = JSON.parse(uriList);
        if (Array.isArray(arr)) arr.forEach((u) => items.push(String(u)));
      } catch {
        uriList.split(/\r?\n/).forEach((u) => { if (u && !u.startsWith('#')) items.push(u.trim()); });
      }
    }
    if (items.length === 0 && dt.files && dt.files.length) {
      for (const f of dt.files) if (f.path) items.push(f.path);
    }
    if (items.length > 0) {
      vscode.postMessage({ type: 'dropFiles', paths: items });
      return;
    }
    // Sin ruta (imagen arrastrada del navegador o de otra app): van los bytes.
    const imgs = [...(dt.files || [])].filter((f) => f.type.startsWith('image/'));
    if (imgs.length > 0) {
      for (const f of imgs) {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result || '');
          vscode.postMessage({
            type: 'pasteImage',
            data: dataUrl.slice(dataUrl.indexOf(',') + 1),
            mime: f.type,
            name: f.name || '',
          });
        };
        reader.readAsDataURL(f);
      }
      return;
    }
    addNotice('info', 'No pude leer lo que soltaste. Usa el botón ＋ para adjuntarlo.');
  });
  modelSelect.addEventListener('change', () => vscode.postMessage({ type: 'setModel', value: modelSelect.value }));
  {
    const imgSel = $('imageModelSelect');
    if (imgSel) imgSel.addEventListener('change', () => vscode.postMessage({ type: 'setImageModel', value: imgSel.value }));
  }
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
    const onMap = msg.onToggles || {};
    (msg.toggles || []).forEach((t) => {
      const chip = document.createElement('button');
      chip.className = 'toggle-chip';
      chip.textContent = t.label;
      chip.dataset.id = t.id;
      const initOn = onMap[t.id] === true;
      chip.dataset.on = initOn ? '1' : '0';
      if (initOn) chip.classList.add('on');
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
      case 'webAttach': addAttachChip(msg.attachment); break;
      case 'accounts': renderAccounts(msg.accounts); break;
      case 'mode': applyMode(msg.mode); break;
      case 'imageModels': renderImageModels(msg.models, msg.selected); break;
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
        if (msg.assistantName) assistantName = msg.assistantName;
        break;
      case 'title': chatTitleEl.textContent = msg.title || 'Nueva conversación'; break;
      case 'model':
        if (msg.model) {
          activeModelEl.textContent = msg.model;
          // En modo agencia el "modelo" es quién habla (rol · modelo): que la
          // burbuja lleve ese nombre y no el del modelo del panel.
          assistantName = msg.model;
          if (streamingEl) {
            const who = streamingEl.parentElement.querySelector('.who');
            if (who) who.textContent = msg.model;
          }
        }
        break;
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
      case 'status': setStatus(msg.text); break;
      case 'turnError':
        // Drop the partial bubble — its text was an error notice, not a reply.
        if (streamingEl) { streamingEl.parentElement.remove(); streamingEl = null; streamingRaw = ''; }
        addNotice('error', '⚠ ' + msg.text);
        clearStatus();
        setSending(false);
        flushQueue();
        break;
      case 'done': finalizeStreaming(); clearStatus(); setSending(false); flushQueue(); break;
    }
  });

  vscode.postMessage({ type: 'ready' });
  inputEl.focus();
})();
