const vscode = acquireVsCodeApi();

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
});

const newApiKey = document.getElementById('newApiKey');
let detectTimer;
newApiKey.addEventListener('input', () => {
  clearTimeout(detectTimer);
  const value = newApiKey.value.trim();
  if (value.length < 6) return;
  detectTimer = setTimeout(() => {
    vscode.postMessage({ type: 'detectProvider', apiKey: value });
  }, 400);
});

document.getElementById('addBtn').addEventListener('click', () => {
  const label = document.getElementById('newLabel').value.trim();
  const apiKey = document.getElementById('newApiKey').value.trim();
  const provider = document.getElementById('newProvider').value.trim();
  const envVar = document.getElementById('newEnvVar').value.trim();
  const endpoint = document.getElementById('newEndpoint').value.trim();

  if (!label || !apiKey || !provider || !envVar) {
    vscode.postMessage({ type: 'error', message: 'Completá nombre, API key, proveedor y variable de entorno.' });
    return;
  }

  vscode.postMessage({ type: 'addAccount', account: { label, apiKey, provider, envVar, endpoint: endpoint || undefined } });

  document.getElementById('newLabel').value = '';
  document.getElementById('newApiKey').value = '';
  document.getElementById('newProvider').value = '';
  document.getElementById('newEnvVar').value = '';
  document.getElementById('newEndpoint').value = '';
  document.getElementById('detectHint').textContent = '';
});

function renderAccounts(accounts) {
  const list = document.getElementById('accountList');
  list.innerHTML = '';
  if (accounts.length === 0) {
    list.innerHTML = '<div class="empty">No hay cuentas configuradas todavía.</div>';
    return;
  }

  for (const acc of accounts) {
    const card = document.createElement('div');
    card.className = 'account-card';
    card.innerHTML = `
      <div class="meta">
        <span class="label">${acc.label}</span>
        <span class="sub">${acc.provider} · prioridad ${acc.priority} · ${acc.switchMode}</span>
      </div>
      <span class="badge ${acc.status}">${acc.status}</span>
      <div class="actions">
        <button data-action="toggleMode" data-id="${acc.id}">${acc.switchMode === 'auto' ? 'Auto' : 'Confirmar'}</button>
        <button data-action="delete" data-id="${acc.id}">Eliminar</button>
      </div>
    `;
    list.appendChild(card);
  }

  list.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', () => vscode.postMessage({ type: 'deleteAccount', id: btn.dataset.id }));
  });
  list.querySelectorAll('button[data-action="toggleMode"]').forEach((btn) => {
    btn.addEventListener('click', () => vscode.postMessage({ type: 'toggleSwitchMode', id: btn.dataset.id }));
  });
}

function renderHistory(history) {
  const tbody = document.querySelector('#historyTable tbody');
  const empty = document.getElementById('historyEmpty');
  tbody.innerHTML = '';
  empty.style.display = history.length === 0 ? 'block' : 'none';

  for (const h of history) {
    const tr = document.createElement('tr');
    const date = new Date(h.timestamp).toLocaleString();
    tr.innerHTML = `<td>${date}</td><td>${h.fromLabel ?? '—'}</td><td>${h.toLabel}</td><td>${h.provider}</td><td>${h.reason}</td>`;
    tbody.appendChild(tr);
  }
}

function renderStats(stats, accounts, history) {
  const container = document.getElementById('statsByProvider');
  container.innerHTML = '';
  if (stats.length === 0) {
    container.innerHTML = '<div class="empty">Todavía no hay rotaciones registradas.</div>';
  } else {
    const max = Math.max(...stats.map((s) => s.totalRotations));
    for (const s of stats) {
      const row = document.createElement('div');
      row.className = 'bar-row';
      const pct = max === 0 ? 0 : (s.totalRotations / max) * 100;
      row.innerHTML = `
        <span class="bar-label">${s.provider}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <span class="bar-value">${s.totalRotations}</span>
      `;
      container.appendChild(row);
    }
  }

  const stableContainer = document.getElementById('mostStable');
  if (accounts.length === 0) {
    stableContainer.innerHTML = '<div class="empty">—</div>';
    return;
  }

  const awayCounts = {};
  for (const acc of accounts) awayCounts[acc.id] = 0;
  for (const h of history) {
    if (h.reason === 'rate-limit' && h.fromAccountId && h.fromAccountId in awayCounts) {
      awayCounts[h.fromAccountId] += 1;
    }
  }

  let best = accounts[0];
  for (const acc of accounts) {
    if (awayCounts[acc.id] < awayCounts[best.id]) best = acc;
  }

  stableContainer.innerHTML = `<div>${best.label} (${best.provider}) — ${awayCounts[best.id]} rate limit(s) reportado(s)</div>`;
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'state':
      renderAccounts(msg.accounts);
      renderHistory(msg.history);
      renderStats(msg.stats, msg.accounts, msg.history);
      break;
    case 'detection':
      document.getElementById('newProvider').value = msg.result.provider;
      document.getElementById('newEnvVar').value = msg.result.envVar;
      document.getElementById('detectHint').textContent =
        msg.result.source === 'pattern'
          ? `Detectado: ${msg.result.displayName} ✓`
          : msg.result.source === 'ai'
          ? `Identificado via IA: ${msg.result.displayName}`
          : 'No se pudo identificar el proveedor automáticamente.';
      break;
  }
});

vscode.postMessage({ type: 'ready' });
