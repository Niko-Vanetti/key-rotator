const vscode = acquireVsCodeApi();

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
});

// Un solo pegado: el código de ejemplo (o la key sola) va tal cual al host,
// que extrae proveedor/endpoint/modelo/key/params y crea la cuenta.
document.getElementById('addBtn').addEventListener('click', () => {
  const text = document.getElementById('pasteBox').value.trim();
  const label = document.getElementById('newLabel').value.trim();
  if (!text) {
    vscode.postMessage({ type: 'error', message: 'Pega el código de ejemplo o tu API key en la caja.' });
    return;
  }
  vscode.postMessage({ type: 'addFromPaste', text, label: label || undefined });
});

window.addEventListener('message', (e) => {
  if (e.data?.type === 'pasteResult' && e.data.ok) {
    document.getElementById('pasteBox').value = '';
    document.getElementById('newLabel').value = '';
    document.getElementById('detectHint').textContent = e.data.summary || '';
  }
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
  }
});

vscode.postMessage({ type: 'ready' });
