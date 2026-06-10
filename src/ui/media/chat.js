(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  const resetBtn = document.getElementById('resetBtn');
  const activeAccountEl = document.getElementById('activeAccount');

  let streamingEl = null; // the assistant bubble currently being filled
  let sending = false;

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

  function send() {
    if (sending) return;
    const text = inputEl.value.trim();
    if (!text) return;
    addBubble('user', text);
    inputEl.value = '';
    autoGrow();
    setSending(true);
    // Prepare an empty assistant bubble that deltas will fill.
    streamingEl = addBubble('assistant', '');
    streamingEl.classList.add('streaming');
    vscode.postMessage({ type: 'send', text });
  }

  function finalizeStreaming() {
    if (streamingEl) {
      streamingEl.classList.remove('streaming');
      // Drop an empty assistant bubble (e.g. error before any output).
      if (!streamingEl.textContent) streamingEl.remove();
      streamingEl = null;
    }
  }

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
  }

  inputEl.addEventListener('input', autoGrow);

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  sendBtn.addEventListener('click', send);

  resetBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'reset' });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
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
        // Account rotated mid-turn. Discard the failed attempt's bubble whole
        // (its partial text was an error/limit message, not real output), show
        // a notice, then open a fresh bubble for the retry's output.
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
      case 'cleared':
        messagesEl.innerHTML = '';
        addNotice('info', 'Nueva conversación iniciada.');
        setSending(false);
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
  inputEl.focus();
})();
