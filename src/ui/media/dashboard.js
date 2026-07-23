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

  // El MODELO, su veredicto de viabilidad GUARDADO y las acciones.
  const ICON = { recomendado: '✅', usable: '⚠️', 'no-viable': '⛔', 'no-concluyente': '❔' };
  for (const acc of accounts) {
    const v = acc.viability;
    const text = v ? `${ICON[v.verdict] || ''} ${v.verdict}: ${v.summary}` : 'sin probar todavía';
    const cls = v ? 'sub verdict ' + v.verdict : 'sub verdict';
    const card = document.createElement('div');
    card.className = 'account-card';
    card.innerHTML = `
      <div class="meta">
        <span class="label">${acc.label}</span>
        <span class="${cls}" id="verdict-${acc.id}">${text}</span>
      </div>
      <div class="actions">
        <button data-action="test" data-id="${acc.id}">Probar</button>
        <button data-action="delete" data-id="${acc.id}">Eliminar</button>
      </div>
    `;
    list.appendChild(card);
  }

  list.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', () => vscode.postMessage({ type: 'deleteAccount', id: btn.dataset.id }));
  });
  list.querySelectorAll('button[data-action="test"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = document.getElementById('verdict-' + btn.dataset.id);
      if (v) v.textContent = '⏳ probando… (puede tardar hasta ~1 min)';
      btn.disabled = true;
      vscode.postMessage({ type: 'testModel', id: btn.dataset.id });
    });
  });
}

// Resultado del análisis de viabilidad de un modelo (llega del host).
function showVerdict(msg) {
  const v = document.getElementById('verdict-' + msg.id);
  if (v) {
    const icons = { recomendado: '✅', usable: '⚠️', 'no-viable': '⛔', 'no-concluyente': '❔' };
    v.textContent = `${icons[msg.verdict] || ''} ${msg.verdict}: ${msg.summary}`;
    v.className = 'sub verdict ' + msg.verdict;
  }
  const btn = document.querySelector('button[data-action="test"][data-id="' + msg.id + '"]');
  if (btn) btn.disabled = false;
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

// ---------- Director de la agencia ----------
function renderDirector(accounts, selected) {
  const sel = document.getElementById('directorSelect');
  if (!sel) return;
  sel.innerHTML = '';
  const opts = [{ id: 'auto', label: 'Automático (el mejor disponible)' }].concat(
    (accounts || []).map((a) => ({ id: a.label, label: a.label }))
  );
  for (const o of opts) {
    const el = document.createElement('option');
    el.value = o.id;
    el.textContent = o.label;
    sel.appendChild(el);
  }
  sel.value = selected || 'auto';
}
{
  const sel = document.getElementById('directorSelect');
  if (sel) sel.addEventListener('change', () => vscode.postMessage({ type: 'setDirector', value: sel.value }));
}

// ---------- MCP + Skills ----------
function renderList(containerId, items, kind) {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = '';
  if (!items || items.length === 0) {
    box.innerHTML = '<div class="empty">Nada configurado todavía.</div>';
    return;
  }
  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'account-card';
    card.innerHTML =
      '<div class="meta"><span class="label">' + it.name + '</span>' +
      (it.detail ? '<span class="sub">' + it.detail + '</span>' : '') + '</div>' +
      '<div class="actions">' +
      '<button data-act="edit">Ver / editar</button>' +
      '<button data-act="del">Eliminar</button></div>';
    card.querySelector('[data-act="edit"]').addEventListener('click', () =>
      vscode.postMessage({ type: kind === 'mcp' ? 'editMcp' : 'editSkill', name: it.name })
    );
    card.querySelector('[data-act="del"]').addEventListener('click', () =>
      vscode.postMessage({ type: kind === 'mcp' ? 'deleteMcp' : 'deleteSkill', name: it.name })
    );
    box.appendChild(card);
  }
}

const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
on('syncMcpBtn', () => vscode.postMessage({ type: 'syncMcp' }));
on('syncSkillsBtn', () => vscode.postMessage({ type: 'syncSkills' }));
on('importSkillsBtn', () => vscode.postMessage({ type: 'importSkills' }));

// Arrastrar una carpeta de skills sobre la pestaña Skills.
{
  const zone = document.getElementById('skillDrop');
  if (zone) {
    ['dragenter', 'dragover'].forEach((ev) =>
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add('over');
      })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (ev === 'dragleave' && e.relatedTarget && zone.contains(e.relatedTarget)) return;
        zone.classList.remove('over');
      })
    );
    zone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      const paths = [];
      const raw = dt.getData('text/uri-list') || dt.getData('resourceurls') || '';
      if (raw) {
        try {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) arr.forEach((u) => paths.push(String(u)));
        } catch {
          raw.split(/\r?\n/).forEach((u) => { if (u && !u.startsWith('#')) paths.push(u.trim()); });
        }
      }
      if (paths.length === 0 && dt.files && dt.files.length) {
        for (const f of dt.files) if (f.path) paths.push(f.path);
      }
      // Sin ruta usable, se abre el selector de carpetas del sistema.
      vscode.postMessage({ type: 'importSkills', paths });
    });
  }
}
on('addMcpBtn', () => {
  const text = document.getElementById('mcpBox').value.trim();
  if (!text) { vscode.postMessage({ type: 'error', message: 'Pega la configuración del servidor MCP.' }); return; }
  vscode.postMessage({ type: 'addMcp', text });
  document.getElementById('mcpBox').value = '';
});
on('addSkillBtn', () => {
  const name = document.getElementById('skillName').value.trim();
  const text = document.getElementById('skillBox').value.trim();
  if (!name || !text) { vscode.postMessage({ type: 'error', message: 'Escribe el nombre y el contenido de la skill.' }); return; }
  vscode.postMessage({ type: 'addSkill', name, text });
  document.getElementById('skillName').value = '';
  document.getElementById('skillBox').value = '';
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'state':
      renderAccounts(msg.accounts);
      renderDirector(msg.accounts, msg.director);
      renderHistory(msg.history);
      renderStats(msg.stats, msg.accounts, msg.history);
      break;
    case 'mcpState':
      renderList('mcpList', msg.servers, 'mcp');
      break;
    case 'skillState':
      renderList('skillList', msg.skills, 'skill');
      break;
    case 'modelVerdict':
      showVerdict(msg);
      break;
  }
});

vscode.postMessage({ type: 'ready' });
