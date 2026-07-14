// =============================================
// TOGGLE TEMA CLARO/ESCURO
// =============================================
function toggleTema() {
  const atual = document.documentElement.getAttribute('data-theme');
  if (atual === 'dark') {
    document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('tema', 'claro'); } catch(e) {}
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    try { localStorage.setItem('tema', 'escuro'); } catch(e) {}
  }
}

// =============================================
// CONFIGURAÇÃO SUPABASE
// =============================================
const SUPABASE_URL = 'https://wrdguclwncirgzlpfgjq.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndyZGd1Y2x3bmNpcmd6bHBmZ2pxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNDYzNDMsImV4cCI6MjA5MDYyMjM0M30.gfWIeTfRZdNk7eZpb4kTTcrOt-Bpy1c7B5fEgh5LrCA';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const AULAS = ['Aula 1','Aula 2','Aula 3','Aula 4','Aula 5','Aula 6','Aula 7','Aula 8',
               'Aula 9','Aula 10','Aula 11','Aula 12','Aula 13','Aula 14','Aula 15','Aula 16',
               'Aula 17','Aula 18','Aula 19','Aula 20'];


const OBS_CATEGORIAS = [
  { id: 'transferencia_turma',  label: 'Transferência de turma', icon: '↔', badge: 'badge-blue' },
  { id: 'reposicao_aula',       label: 'Reposição de aula',      icon: '↺', badge: 'badge-amber' },
  { id: 'erro_plataforma',      label: 'Erro plataforma',        icon: '⚠', badge: 'badge-red' },
  { id: 'pedido_cancelamento',  label: 'Pedido cancelamento',    icon: '✕', badge: 'badge-red' },
  { id: 'reclamacao_geral',     label: 'Reclamação geral',       icon: '!', badge: 'badge-pink' },
  { id: 'pedido_transferencia', label: 'Pedido transferência',   icon: '→', badge: 'badge-purple' },
  { id: 'feedback',             label: 'Feedback',               icon: '★', badge: 'badge-green' },
];
let obsCategoriaSelecionada = null;

// =============================================
// ESTADO DA APLICAÇÃO
// =============================================
let TURMAS = [];
let ALUNOS = [];
let PRESENCAS = {};
let HISTORICO = [];
let PROFESSORES = [];
let usuarioLogado = null;
let perfilLogado = null;
let turmaAtual = null;
let filtroCurso = '';
let alunoSelecionadoId = null;
let profSelecionadoId = null;
let chamadaAlterada = {};
let dotMenuContext = null;

// Cores de avatar para professores
const PROF_COLORS = ['#1d4ed8','#059669','#7c3aed','#db2777','#d97706','#0891b2','#dc2626','#65a30d'];

// =============================================
// AUTH
// =============================================
async function doLogin() {
  const email = document.getElementById('inp-email').value.trim();
  const senha = document.getElementById('inp-senha').value;
  const btn = document.getElementById('btn-login');
  btn.disabled = true; btn.textContent = 'Entrando...';
  document.getElementById('login-err').style.display = 'none';

  const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });
  if (error) {
    document.getElementById('login-err').style.display = 'block';
    btn.disabled = false; btn.textContent = 'Entrar';
    return;
  }
  usuarioLogado = data.user;
  await carregarPerfil();
  await inicializarApp();
}

async function carregarPerfil() {
  const { data } = await sb.from('professores').select('*').eq('user_id', usuarioLogado.id).single();
  perfilLogado = data;
}

async function doLogout() {
  await sb.auth.signOut();
  usuarioLogado = null; perfilLogado = null;
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-page').style.display = 'flex';
  document.getElementById('inp-senha').value = '';
}

// =============================================
// INICIALIZAÇÃO
// =============================================
async function inicializarApp() {
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  const ini = perfilLogado?.nome ? perfilLogado.nome.substring(0,2).toUpperCase() : '--';
  document.getElementById('av').textContent = ini;
  document.getElementById('hname').textContent = perfilLogado?.nome || usuarioLogado.email;

  // Mostrar aba Professores apenas para admins
  if (perfilLogado?.papel === 'admin') {
    document.getElementById('nav-prof').style.display = '';
  }

  await carregarTurmas();
  await carregarAlunos();
  await Promise.all([carregarPresencas(), carregarHistorico(), carregarProfessores()]);

  popularFiltros();
  renderDash();
  renderTabelaAlunos();
  renderRel();
}

async function carregarTurmas() {
  let q = sb.from('turmas').select('*').order('turma');
  if (perfilLogado?.papel !== 'admin') q = q.eq('professor_id', perfilLogado?.id);
  const { data } = await q;
  TURMAS = data || [];
}

async function carregarAlunos() {
  ALUNOS = [];
  const turmaIds = new Set(TURMAS.map(t => t.id));
  const idsVistos = new Set();
  const PAGE_SIZE = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await sb.from('alunos').select('*').order('nome').range(from, from + PAGE_SIZE - 1);
    if (error) { console.error('Erro alunos:', error); break; }
    if (!data || data.length === 0) break;

    data.filter(a => turmaIds.has(a.turma_id) && !idsVistos.has(a.id)).forEach(a => {
      idsVistos.add(a.id);
      ALUNOS.push(a);
    });

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
}

async function carregarPresencas() {
  PRESENCAS = {};
  const turmaIds = new Set(TURMAS.map(t => t.id));
  const PAGE_SIZE = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await sb.from('presencas').select('*').range(from, from + PAGE_SIZE - 1);
    if (error) { console.error('Erro presencas:', error); break; }
    if (!data || data.length === 0) break;

    data.filter(p => turmaIds.has(p.turma_id)).forEach(p => {
      const key = `${p.turma_id}_${p.aula}`;
      if (!PRESENCAS[key]) PRESENCAS[key] = {};
      PRESENCAS[key][p.aluno_id] = p.status;
    });

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
}

async function carregarHistorico() {
  const alunoIds = ALUNOS.map(a => a.id);
  if (!alunoIds.length) { HISTORICO = []; return; }
  const { data } = await sb.from('historico').select('*').in('aluno_id', alunoIds).order('created_at', { ascending: false });
  HISTORICO = data || [];
}

async function carregarProfessores() {
  const { data } = await sb.from('professores').select('*').order('nome');
  PROFESSORES = data || [];
}

// =============================================
// HELPERS
// =============================================
function calcAluno(aluno) {
  const seq = AULAS.map(aula => {
    const k = `${aluno.turma_id}_${aula}`;
    return (PRESENCAS[k] && PRESENCAS[k][aluno.id]) || 'N';
  });
  const p = seq.filter(v => v === 'P' || v === 'R').length; // R conta como presença
  const r = seq.filter(v => v === 'R').length;               // reposições separadas
  const f = seq.filter(v => v === 'F').length;
  const freq = p + f > 0 ? Math.round((p / (p + f)) * 100) : null;
  let maxC = 0, cur = 0;
  seq.forEach(v => { if (v === 'F') { cur++; maxC = Math.max(maxC, cur); } else cur = 0; });
  // Alerta: 3+ faltas seguidas nas últimas 8 aulas com registro
  const registradas = seq.filter(v => v !== 'N');
  const ultimas8 = registradas.slice(-8);
  let consecU8 = 0, curU8 = 0;
  ultimas8.forEach(v => { if (v === 'F') { curU8++; consecU8 = Math.max(consecU8, curU8); } else curU8 = 0; });
  const emAlerta = consecU8 >= 3;
  return { seq, p, r, f, freq, maxConsec: maxC, emAlerta };
}

function freqBar(freq) {
  if (freq === null) return '<span style="font-size:11px;color:var(--text-faded);">—</span>';
  const c = freq >= 70 ? 'var(--green)' : freq >= 50 ? 'var(--amber)' : 'var(--red)';
  return `<div class="freq-wrap"><div class="fbar"><div class="fbar-fill" style="width:${freq}%;background:${c};"></div></div><span style="font-size:11px;font-weight:600;color:${c};">${freq}%</span></div>`;
}

function statusBadge(freq, emAlerta, ativo) {
  if (!ativo) return `<span class="badge badge-gray">Inativo</span>`;
  if (emAlerta) return `<span class="badge badge-red">⚠ Alerta</span>`;
  if (freq === null) return `<span class="badge badge-gray">Sem registro</span>`;
  if (freq >= 70) return `<span class="badge badge-green">Regular</span>`;
  return `<span class="badge badge-amber">Atenção</span>`;
}

function showToast(msg, type = 'green') {
  const t = document.getElementById('toast');
  t.className = `toast ${type}`; t.textContent = msg; t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 2800);
}

function corBadge(curso) {
  if (curso?.includes('Elas')) return 'badge-blue';
  if (curso?.includes('Master')) return 'badge-amber';
  if (curso?.includes('Evolution')) return 'badge-green';
  if (curso?.includes('Clube')) return 'badge-purple';
  return 'badge-gray';
}

function popularFiltros() {
  atualizarTurmasAlunos();
  const cursos = [...new Set(TURMAS.map(t => t.curso))].sort();
  const profs = [...new Set(TURMAS.map(t => t.professor))].sort();

  // Select simples na aba Alunos
  const elCursoAlunos = document.getElementById('f-curso-alunos');
  if (elCursoAlunos) {
    elCursoAlunos.innerHTML = '<option value="">Todos</option>' + cursos.map(c => `<option>${c}</option>`).join('');
  }

  // Multi-selects do relatório
  popularMultiPanel('curso-multi-panel', 'curso-multi-btn', 'curso-multi-label', cursos.map(c => ({ value: c, label: c })));
  popularMultiPanel('prof-multi-panel', 'prof-multi-btn', 'prof-multi-label', profs.map(p => ({ value: p, label: p })));
  popularMultiPanel('turma-rel-multi-panel', 'turma-rel-multi-btn', 'turma-rel-multi-label',
    TURMAS.map(t => ({ value: String(t.id), label: `${t.turma} (${t.curso})` }))
  );
}

function popularMultiPanel(panelId, btnId, labelId, options) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  panel.innerHTML = options.map(o =>
    `<label class="multi-check"><input type="checkbox" value="${String(o.value).replace(/"/g,'&quot;')}" onchange="onMultiCheck('${panelId}','${btnId}','${labelId}')">${o.label}</label>`
  ).join('');
}

function toggleSenha(inputId, btn) {
  const inp = document.getElementById(inputId);
  if (inp.type === 'password') { inp.type = 'text'; btn.textContent = '🙈'; }
  else { inp.type = 'password'; btn.textContent = '👁'; }
}

// =============================================
// NAVEGAÇÃO
// =============================================
function goTab(tab) {
  const tabs = ['turmas','alunos','relatorio','metricas','professores'];
  document.querySelectorAll('.nav-btn').forEach((b, i) => b.classList.toggle('active', tabs[i] === tab));
  document.querySelectorAll('#app .screen').forEach(s => s.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  if (tab === 'turmas') { document.getElementById('dash-view').style.display = 'block'; document.getElementById('chamada-view').style.display = 'none'; }
  if (tab === 'relatorio') renderRel();
  if (tab === 'metricas') renderMetricas();
  if (tab === 'professores') renderProfessores();
}

// =============================================
// DASHBOARD / TURMAS
// =============================================
function renderDash() {
  const ativos = ALUNOS.filter(a => a.ativo);
  const dados = ativos.map(a => calcAluno(a));
  const alertas = dados.filter(d => d.emAlerta).length;
  const irregulares = dados.filter(d => d.freq !== null && d.freq < 70).length;

  document.getElementById('stats-area').innerHTML = `
    <div class="stat-card"><div class="stat-label">Turmas</div><div class="stat-val">${TURMAS.length}</div></div>
    <div class="stat-card"><div class="stat-label">Alunos ativos</div><div class="stat-val">${ativos.length}</div></div>
    <div class="stat-card"><div class="stat-label">Irregulares (&lt;70%)</div><div class="stat-val amber">${irregulares}</div></div>
    <div class="stat-card"><div class="stat-label">Alertas (3 seguidas)</div><div class="stat-val red">${alertas}</div></div>`;

  const cursos = [...new Set(TURMAS.map(t => t.curso))];

  const minhasTurmas = TURMAS.filter(t => t.professor_id === perfilLogado?.id || t.professor === perfilLogado?.nome);
  document.getElementById('curso-pills').innerHTML =
    `<button class="cpill ${filtroCurso === '' ? 'active' : ''}" onclick="setCurso('')">Todos</button>` +
    (minhasTurmas.length > 0
      ? `<button class="cpill ${filtroCurso === '__minhas__' ? 'active' : ''}" onclick="setCurso('__minhas__')"> Suas Turmas <span style="background:rgba(255,255,255,.25);font-size:10px;padding:1px 6px;border-radius:99px;margin-left:4px;">${minhasTurmas.length}</span></button>`
      : '') +
    cursos.map(c => `<button class="cpill ${filtroCurso === c ? 'active' : ''}" onclick="setCurso('${c.replace(/'/g, "\\'")}')">${c}</button>`).join('');

  const buscaTurma = (document.getElementById('busca-turmas')?.value || '').toLowerCase();
  let filtradas = filtroCurso === '__minhas__'
    ? TURMAS.filter(t => t.professor_id === perfilLogado?.id || t.professor === perfilLogado?.nome)
    : filtroCurso
      ? TURMAS.filter(t => t.curso === filtroCurso)
      : TURMAS;
  if (buscaTurma) filtradas = filtradas.filter(t => t.turma.toLowerCase().includes(buscaTurma) || t.professor.toLowerCase().includes(buscaTurma));
  filtradas = filtradas.slice().sort((a, b) => {
    const da = ordemDia(a.turma), db = ordemDia(b.turma);
    if (da !== db) return da - db;
    return a.turma.localeCompare(b.turma, 'pt-BR');
  });
  document.getElementById('turmas-grid').innerHTML = filtradas.map(t => {
    const al = ALUNOS.filter(a => a.ativo && a.turma_id === t.id);
    const at = al.filter(a => calcAluno(a).emAlerta).length;
    const horarioTag = t.horario_inicio
      ? `<span class="horario-tag" onclick="abrirModalHorario(${t.id})" title="Clique para editar o horário">⏰ ${t.horario_inicio.slice(0,5)}${t.dias_semana?.length ? ' · ' + t.dias_semana.map(d => d.charAt(0).toUpperCase() + d.slice(1,3)).join(', ') : ''}</span>`
      : `<span class="horario-tag sem-horario" onclick="abrirModalHorario(${t.id})" title="Configurar horário para notificação automática">+ Configurar horário</span>`;
    return `<div class="turma-card">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <div style="width:9px;height:9px;border-radius:50%;background:${t.cor || '#3b82f6'};flex-shrink:0;"></div>
        <div class="inline-edit-wrap" style="flex:1;">
          <div id="titulo-${t.id}" style="font-size:13px;font-weight:600;flex:1;color:var(--text);">${t.turma}</div>
          <button class="inline-edit-btn" title="Editar nome" onclick="editarTituloTurma(${t.id})">✏</button>
        </div>
      </div>
      <div style="font-size:12px;color:var(--text-3);display:flex;flex-direction:column;gap:6px;">
        <span><span class="badge ${corBadge(t.curso)}">${t.curso}</span></span>
        <div class="inline-edit-wrap">
          <span id="prof-${t.id}">Prof. ${t.professor}</span>
          <button class="inline-edit-btn" title="Editar professor" onclick="editarProfTurma(${t.id})">✏</button>
        </div>
        <span>${al.length} alunos${at > 0 ? ` · <span style="color:var(--red);font-weight:600;cursor:pointer;border-bottom:1.5px dashed var(--red);padding-bottom:1px;" onclick="irParaAlertas(${t.id})">${at} alerta${at > 1 ? 's' : ''}</span>` : ''}</span>
        <div>${horarioTag}</div>
      </div>
      <button class="btn-chamada" onclick="abrirChamada(${t.id})">Fazer chamada →</button>
    </div>`;
  }).join('') || '<div class="empty">Nenhuma turma encontrada.</div>';
}

function ordemDia(nomeTurma) {
  const dias = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];
  const idx = dias.findIndex(d => (nomeTurma || '').includes(d));
  return idx === -1 ? 99 : idx;
}

function setCurso(c) { filtroCurso = c; renderDash(); }

// =============================================
// CHAMADA
// =============================================
function abrirChamada(tId) {
  turmaAtual = TURMAS.find(t => t.id === tId);
  chamadaAlterada = {};
  document.getElementById('dash-view').style.display = 'none';
  document.getElementById('chamada-view').style.display = 'block';
  document.getElementById('ch-titulo').textContent = turmaAtual.turma + ' — ' + turmaAtual.curso;
  document.getElementById('ch-sub').textContent = 'Prof. ' + turmaAtual.professor;
  const sel = document.getElementById('aula-sel');
  sel.innerHTML = AULAS.map(a => `<option>${a}</option>`).join('');
  renderChamada();
}

function voltarDash() {
  document.getElementById('chamada-view').style.display = 'none';
  document.getElementById('dash-view').style.display = 'block';
}

function renderChamada() {
  const aula = document.getElementById('aula-sel').value;
  const key = `${turmaAtual.id}_${aula}`;
  if (!PRESENCAS[key]) PRESENCAS[key] = {};
  const alunos = ALUNOS.filter(a => a.ativo && a.turma_id === turmaAtual.id);
  let p = 0, r = 0, f = 0, s = 0;
  alunos.forEach(a => { const v = PRESENCAS[key][a.id]; if (v === 'P') p++; else if (v === 'R') r++; else if (v === 'F') f++; else s++; });
  document.getElementById('ch-counters').innerHTML =
    `<span style="color:var(--green);">✓ ${p} presentes</span><span style="color:var(--red);">✗ ${f} faltas</span><span style="color:var(--amber);">↺ ${r} gravações</span><span>○ ${s} sem registro</span>`;
  document.getElementById('alunos-list').innerHTML = alunos.map((a, i) => {
    const v = PRESENCAS[key][a.id] || '';
    return `<div class="aluno-row">
      <div class="aluno-num">${i + 1}</div>
      <div class="aluno-nome">${a.nome}</div>
      <div class="pbtns">
        <button class="pbtn pbtn-p ${v === 'P' ? 'on' : ''}" onclick="marcar(${a.id},'P')">✓ Presente</button>
        <button class="pbtn pbtn-f ${v === 'F' ? 'on' : ''}" onclick="marcar(${a.id},'F')">✗ Falta</button>
        <button class="pbtn pbtn-r ${v === 'R' ? 'on' : ''}" onclick="marcar(${a.id},'R')">↺ Gravação</button>
      </div>
    </div>`;
  }).join('') || '<div class="empty">Nenhum aluno nesta turma.</div>';
}

async function marcar(alunoId, val) {
  const aula = document.getElementById('aula-sel').value;
  const key = `${turmaAtual.id}_${aula}`;
  if (!PRESENCAS[key]) PRESENCAS[key] = {};
  const atual = PRESENCAS[key][alunoId];
  const novoVal = atual === val ? null : val;
  PRESENCAS[key][alunoId] = novoVal;
  renderChamada();

  const statusEl = document.getElementById('chamada-status');
  if (statusEl) statusEl.textContent = 'Salvando...';

  try {
    if (novoVal) {
      await sb.from('presencas').upsert(
        { turma_id: turmaAtual.id, aluno_id: alunoId, aula, status: novoVal },
        { onConflict: 'turma_id,aluno_id,aula' }
      );
    } else {
      await sb.from('presencas').delete()
        .eq('turma_id', turmaAtual.id).eq('aluno_id', alunoId).eq('aula', aula);
    }
    if (statusEl) { statusEl.textContent = '✓ Salvo'; setTimeout(() => { statusEl.textContent = ''; }, 1500); }
    renderDash();
    renderTabelaAlunos();
  } catch(err) {
    console.error('Erro ao salvar presença:', err);
    if (statusEl) statusEl.textContent = '';
    showToast('Erro ao salvar. Tente novamente.', 'red');
  }
}

// =============================================
// TABELA DE ALUNOS
// =============================================
function renderTabelaAlunos() {
  const busca = (document.getElementById('busca-alunos') || {}).value?.toLowerCase() || '';
  const fCurso = document.getElementById('f-curso-alunos')?.value || '';
  const fStatus = document.getElementById('f-status-alunos')?.value || '';
  const fTurmaAlunos = document.getElementById('f-turma-alunos')?.value || '';
  let lista = ALUNOS.map(a => ({ ...a, ...calcAluno(a), turma: TURMAS.find(t => t.id === a.turma_id) }));
  if (busca) lista = lista.filter(a => a.nome.toLowerCase().includes(busca));
  if (fCurso) lista = lista.filter(a => a.turma?.curso === fCurso);
  if (fTurmaAlunos) lista = lista.filter(a => String(a.turma_id) === fTurmaAlunos);
  if (fStatus === 'ativo') lista = lista.filter(a => a.ativo);
  else if (fStatus === 'inativo') lista = lista.filter(a => !a.ativo);
  else if (fStatus === 'cancelado') lista = lista.filter(a => !a.ativo && statusInativo(a.id) === 'cancelado');
  else if (fStatus === 'alerta') lista = lista.filter(a => a.ativo && a.emAlerta);
  else if (fStatus === 'irregular') lista = lista.filter(a => a.ativo && a.freq !== null && a.freq < 70);

  document.getElementById('tbody-alunos').innerHTML = lista.map(a => `
    <tr class="clickable ${a.emAlerta && a.ativo ? 'row-alerta' : ''} ${!a.ativo ? 'row-inativo' : ''}" onclick="abrirModalAluno(${a.id})">
      <td>${a.nome}${!a.ativo ? ' <span class="badge badge-gray" style="font-size:10px;">Inativo</span>' : ''}</td>
      <td><span class="badge ${corBadge(a.turma?.curso)}" style="font-size:10px;">${a.turma?.curso || '—'}</span></td>
      <td style="color:var(--text-3);">${a.turma?.turma || '—'}</td>
      <td style="text-align:center;color:var(--green);font-weight:600;">${a.p - a.r}</td>
      <td style="text-align:center;color:var(--amber);font-weight:600;">${a.r > 0 ? a.r : '—'}</td>
      <td style="text-align:center;color:var(--red);font-weight:600;">${a.f}</td>
      <td style="text-align:center;">${a.maxConsec > 0 ? `<span class="badge ${a.emAlerta ? 'badge-red' : 'badge-gray'}">${a.maxConsec}</span>` : '—'}</td>
      <td>${freqBar(a.freq)}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">Nenhum aluno encontrado.</td></tr>';
  document.getElementById('alunos-count').textContent = `${lista.length} aluno${lista.length !== 1 ? 's' : ''} · Clique para ver detalhes, editar ou transferir`;
}

// =============================================
// MODAL ALUNO
// =============================================
function abrirModalAluno(id) {
  alunoSelecionadoId = id;
  const a = ALUNOS.find(x => x.id === id);
  const t = TURMAS.find(x => x.id === a.turma_id);
  const c = calcAluno(a);
  document.getElementById('ma-nome').textContent = a.nome;
  document.getElementById('ma-status').innerHTML = statusBadge(c.freq, c.emAlerta, a.ativo);
  document.getElementById('ma-info').innerHTML = `
    <div class="info-item"><div class="info-label">Curso</div><div class="info-val">${t?.curso || '—'}</div></div>
    <div class="info-item"><div class="info-label">Turma</div><div class="info-val">${t?.turma || '—'}</div></div>
    <div class="info-item"><div class="info-label">Professor(a)</div><div class="info-val">${t?.professor || '—'}</div></div>
    <div class="info-item"><div class="info-label">Frequência</div><div class="info-val">${c.freq !== null ? c.freq + '%' : '—'}</div></div>
    <div class="info-item"><div class="info-label">Presenças</div><div class="info-val" style="color:var(--green);">${c.p}</div></div>
    <div class="info-item"><div class="info-label">Faltas</div><div class="info-val" style="color:var(--red);">${c.f}</div></div>`;
  const _aulasCom = c.seq.map((v,i) => ({v,i})).filter(x => x.v !== 'N').slice(-8);
document.getElementById('ma-aulas').innerHTML = _aulasCom.map(({v,i}) => {
    const au = AULAS[i];
    const bg = v === 'P' ? 'var(--green-soft)' : v === 'R' ? 'var(--amber-soft)' : v === 'F' ? 'var(--red-soft)' : 'var(--surface-3)';
    const tc = v === 'P' ? 'var(--green-soft-text)' : v === 'R' ? 'var(--amber-soft-text)' : v === 'F' ? 'var(--red-soft-text)' : 'var(--text-faded)';
    return `<div class="aula-item" style="background:${bg};"><div class="aula-item-label">${au}</div><div class="aula-item-val" style="color:${tc};">${v === 'P' ? 'Presente' : v === 'R' ? 'Gravação' : v === 'F' ? 'Falta' : '—'}</div></div>`;
  }).join('');
  const hist = HISTORICO.filter(h => h.aluno_id === id);
  document.getElementById('ma-hist').innerHTML = hist.length ? `
    <div style="font-size:12px;color:var(--text-3);margin-bottom:.5rem;font-weight:500;">Histórico de movimentações</div>
    ${hist.map(h => `<div class="hist-item"><span style="font-size:10px;color:var(--text-faded);width:80px;flex-shrink:0;">${new Date(h.created_at).toLocaleDateString('pt-BR')}</span><span>${h.descricao}</span></div>`).join('')}` : '';
  const btnIn = document.getElementById('ma-btn-inativar');
  const btnCancelar = document.getElementById('ma-btn-cancelar');
  btnIn.textContent = a.ativo ? 'Inativar aluno' : 'Reativar aluno';
  btnIn.className = a.ativo ? 'btn-warning' : 'btn-warning';
  btnIn.style.background = a.ativo ? '' : '';
  btnCancelar.style.display = '';
  const today = new Date().toISOString().split('T')[0];
  const obsData = document.getElementById('obs-data');
  if (obsData) obsData.value = today;
  const obsTexto = document.getElementById('obs-texto');
  if (obsTexto) obsTexto.value = '';
  carregarObservacoes(id);
  document.getElementById('modal-aluno').classList.add('open');
}

function fecharModal(id) { document.getElementById(id).classList.remove('open'); }

async function toggleInativo() {
  const a = ALUNOS.find(x => x.id === alunoSelecionadoId);
  const novoStatus = !a.ativo;
  await sb.from('alunos').update({ ativo: novoStatus }).eq('id', a.id);
  await sb.from('historico').insert({ aluno_id: a.id, descricao: novoStatus ? 'Aluno reativado' : 'Aluno inativado' });
  a.ativo = novoStatus;
  fecharModal('modal-aluno');
  showToast(novoStatus ? 'Aluno reativado.' : 'Aluno inativado.');
  renderTabelaAlunos(); renderDash();
}

async function cancelarMatricula() {
  const a = ALUNOS.find(x => x.id === alunoSelecionadoId);
  const msg = a.ativo
    ? `Cancelar a matrícula de "${a.nome}"?\n\nO aluno será marcado como inativo com status de cancelamento.`
    : `Registrar cancelamento de matrícula para "${a.nome}"?\n\nO aluno já está inativo e será marcado como cancelado.`;
  if (!confirm(msg)) return;
  await sb.from('alunos').update({ ativo: false }).eq('id', a.id);
  await sb.from('historico').insert({ aluno_id: a.id, descricao: 'Matrícula cancelada' });
  a.ativo = false;
  fecharModal('modal-aluno');
  showToast('Matrícula cancelada.', 'red');
  renderTabelaAlunos(); renderDash();
}

function statusInativo(alunoId) {
  const hist = HISTORICO
    .filter(h => h.aluno_id === alunoId && (h.descricao?.includes('inativad') || h.descricao?.includes('cancelad')))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return (hist.length && hist[0].descricao?.includes('cancelad')) ? 'cancelado' : 'inativo';
}

function abrirModalEditar() {
  const a = ALUNOS.find(x => x.id === alunoSelecionadoId);
  document.getElementById('edit-nome').value = a.nome;
  fecharModal('modal-aluno');
  document.getElementById('modal-editar').classList.add('open');
}

async function salvarEdicao() {
  const novoNome = document.getElementById('edit-nome').value.trim();
  if (!novoNome) return;
  const a = ALUNOS.find(x => x.id === alunoSelecionadoId);
  await sb.from('alunos').update({ nome: novoNome }).eq('id', a.id);
  await sb.from('historico').insert({ aluno_id: a.id, descricao: `Nome alterado para "${novoNome}"` });
  a.nome = novoNome;
  fecharModal('modal-editar');
  showToast('Nome atualizado!');
  renderTabelaAlunos(); renderDash();
}

function abrirModalTransferir() {
  const a = ALUNOS.find(x => x.id === alunoSelecionadoId);
  const t = TURMAS.find(x => x.id === a.turma_id);
  document.getElementById('transf-info').innerHTML = `<strong>${a.nome}</strong><br><span style="color:var(--text-3);">Turma atual: ${t?.turma} · ${t?.curso} · Prof. ${t?.professor}</span>`;
  const outras = TURMAS.filter(x => x.id !== a.turma_id);
  document.getElementById('transf-sel').innerHTML = outras.map(x => `<option value="${x.id}">${x.turma} — ${x.curso} (Prof. ${x.professor})</option>`).join('');
  fecharModal('modal-aluno');
  document.getElementById('modal-transferir').classList.add('open');
}

async function confirmarTransferencia() {
  const a = ALUNOS.find(x => x.id === alunoSelecionadoId);
  const antigoTId = a.turma_id;
  const tAntiga = TURMAS.find(x => x.id === antigoTId);
  const novoTId = parseInt(document.getElementById('transf-sel').value);
  const tNova = TURMAS.find(x => x.id === novoTId);

  // 1) Move o aluno para a nova turma
  const { error: errAluno } = await sb.from('alunos').update({ turma_id: novoTId }).eq('id', a.id);
  if (errAluno) { showToast('Erro ao transferir aluno.', 'red'); console.error(errAluno); return; }

  // 2) Move TODAS as presenças do aluno da turma antiga para a nova
  const { error: errPres } = await sb.from('presencas')
    .update({ turma_id: novoTId })
    .eq('aluno_id', a.id)
    .eq('turma_id', antigoTId);
  if (errPres) {
    // reverte o aluno para não deixar estado inconsistente
    await sb.from('alunos').update({ turma_id: antigoTId }).eq('id', a.id);
    showToast('Erro ao mover o histórico de presença. Transferência cancelada.', 'red');
    console.error(errPres);
    return;
  }

  // 3) Registra a movimentação
  await sb.from('historico').insert({ aluno_id: a.id, descricao: `Transferido de "${tAntiga?.turma} (${tAntiga?.curso})" para "${tNova?.turma} (${tNova?.curso})" (histórico de presença mantido)` });

  // 4) Atualiza o cache local (PRESENCAS) sem recarregar a página
  AULAS.forEach(aula => {
    const keyAntiga = `${antigoTId}_${aula}`;
    const keyNova = `${novoTId}_${aula}`;
    if (PRESENCAS[keyAntiga] && PRESENCAS[keyAntiga][a.id] !== undefined) {
      if (!PRESENCAS[keyNova]) PRESENCAS[keyNova] = {};
      PRESENCAS[keyNova][a.id] = PRESENCAS[keyAntiga][a.id];
      delete PRESENCAS[keyAntiga][a.id];
    }
  });

  a.turma_id = novoTId;
  fecharModal('modal-transferir');
  showToast(`${a.nome} transferido para ${tNova?.turma}!`, 'blue');
  renderTabelaAlunos(); renderDash(); renderRel();
}

function abrirModalNovoAluno() {
  document.getElementById('novo-nome').value = '';
  document.getElementById('novo-turma').innerHTML = TURMAS.map(t => `<option value="${t.id}">${t.turma} — ${t.curso} (Prof. ${t.professor})</option>`).join('');
  document.getElementById('modal-novo').classList.add('open');
}

async function salvarNovoAluno() {
  const nome = document.getElementById('novo-nome').value.trim();
  if (!nome) { showToast('Digite o nome do aluno.', 'red'); return; }
  const turmaId = parseInt(document.getElementById('novo-turma').value);
  const { data, error } = await sb.from('alunos').insert({ nome, turma_id: turmaId, ativo: true }).select().single();
  if (error) { showToast('Erro ao adicionar aluno.', 'red'); return; }
  await sb.from('historico').insert({ aluno_id: data.id, descricao: 'Aluno adicionado ao sistema' });
  ALUNOS.push(data);
  fecharModal('modal-novo');
  showToast(`${nome} adicionado com sucesso!`);
  renderTabelaAlunos(); renderDash();
}

// =============================================
// PROFESSORES
// =============================================
function profColor(id) {
  return PROF_COLORS[(id || 0) % PROF_COLORS.length];
}

function profIniciais(nome) {
  if (!nome) return '??';
  const parts = nome.trim().split(' ').filter(Boolean);
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function toggleSenhaMask(id, senha) {
  const el = document.getElementById('senha-mask-' + id);
  if (!el) return;
  el.textContent = el.textContent.includes('•') ? senha : '•'.repeat(senha.length || 8);
}

function renderProfessores() {
  const busca = (document.getElementById('busca-prof')?.value || '').toLowerCase();
  let lista = PROFESSORES;
  if (busca) lista = lista.filter(p => p.nome?.toLowerCase().includes(busca) || p.email?.toLowerCase().includes(busca));

  const admins = PROFESSORES.filter(p => p.papel === 'admin').length;
  const profs = PROFESSORES.filter(p => p.papel !== 'admin').length;

  document.getElementById('prof-stats').innerHTML = `
    <div class="stat-card"><div class="stat-label">Total de usuários</div><div class="stat-val">${PROFESSORES.length}</div></div>
    <div class="stat-card"><div class="stat-label">Admins</div><div class="stat-val">${admins}</div></div>
    <div class="stat-card"><div class="stat-label">Professores</div><div class="stat-val">${profs}</div></div>`;

  if (!lista.length) {
    document.getElementById('prof-grid').innerHTML = '<div class="empty">Nenhum professor encontrado.</div>';
    return;
  }

  document.getElementById('prof-grid').innerHTML = lista.map(p => {
    const turmasDoProf = TURMAS.filter(t => t.professor === p.nome);
    const cor = profColor(p.id);
    const ini = profIniciais(p.nome);
    const papelBadge = p.papel === 'admin'
      ? '<span class="badge badge-blue">Admin</span>'
      : '<span class="badge badge-gray">Professor</span>';
    const euBadge = p.user_id === usuarioLogado?.id
      ? '<span class="badge badge-green">Você</span>'
      : '';
    return `
      <div class="prof-card">
        <div class="prof-av" style="background:${cor};">${ini}</div>
        <div class="prof-info">
          <div class="prof-nome">${p.nome || '—'}</div>
          <div class="prof-email">${p.email || '—'}</div>
          <div style="font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:4px;margin-top:1px;">
          <span id="senha-mask-${p.id}">${'•'.repeat((p.senha||'').length || 8)}</span>
          <button onclick="toggleSenhaMask(${p.id},'${(p.senha||'').replace(/'/g,"\\'")}')"
          style="background:none;border:none;cursor:pointer;color:var(--text-faded);font-size:11px;padding:0 2px;">👁</button>
          </div>
          <div class="prof-meta">
            ${papelBadge}
            ${euBadge}
            <span style="font-size:11px;color:var(--text-faded);">${turmasDoProf.length} turma${turmasDoProf.length !== 1 ? 's' : ''}</span>
          </div>
        </div>
        <div class="prof-actions">
          <button class="btn-edit-prof" onclick="abrirModalEditarProf(${p.id})">✏ Editar</button>
        </div>
      </div>`;
  }).join('');
}

function abrirModalNovoProf() {
  document.getElementById('np-nome').value = '';
  document.getElementById('np-email').value = '';
  document.getElementById('np-senha').value = 'Teste1234';
  document.getElementById('np-papel').value = 'admin';
  document.getElementById('np-erro').style.display = 'none';
  document.getElementById('np-btn').disabled = false;
  document.getElementById('np-btn').textContent = 'Criar professor';
  document.getElementById('modal-novo-prof').classList.add('open');
}

async function salvarNovoProf() {
  const nome = document.getElementById('np-nome').value.trim();
  const email = document.getElementById('np-email').value.trim();
  const senha = document.getElementById('np-senha').value;
  const papel = document.getElementById('np-papel').value;
  const erroEl = document.getElementById('np-erro');
  const btn = document.getElementById('np-btn');

  erroEl.style.display = 'none';
  if (!nome) { erroEl.textContent = 'Digite o nome.'; erroEl.style.display = 'block'; return; }
  if (!email || !email.includes('@')) { erroEl.textContent = 'Digite um e-mail válido.'; erroEl.style.display = 'block'; return; }
  if (!senha || senha.length < 6) { erroEl.textContent = 'A senha deve ter pelo menos 6 caracteres.'; erroEl.style.display = 'block'; return; }

  btn.disabled = true;
  btn.textContent = 'Criando...';

  try {
    // Cria usuário via REST sem afetar a sessão atual
    const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY
      },
      body: JSON.stringify({ email, password: senha })
    });

    const authData = await res.json();

    if (authData.error || authData.msg) {
      const msg = authData.error?.message || authData.msg || 'Erro ao criar usuário.';
      erroEl.textContent = msg.includes('already registered') ? 'Este e-mail já está cadastrado.' : msg;
      erroEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Criar professor';
      return;
    }

    const newUserId = authData.user?.id || authData.id;
    if (!newUserId) {
      erroEl.textContent = 'Erro inesperado ao criar usuário. Tente novamente.';
      erroEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Criar professor';
      return;
    }

    // Insere na tabela professores
    const { data: profData, error: profError } = await sb
  .from('professores')
  .insert({ nome, email, papel, user_id: newUserId, senha })
  .select()
  .single();


    if (profError) {
      erroEl.textContent = 'Usuário criado, mas erro ao salvar perfil: ' + profError.message;
      erroEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Criar professor';
      return;
    }

    PROFESSORES.push(profData);
    fecharModal('modal-novo-prof');
    showToast(`Professor ${nome} criado com sucesso!`);
    renderProfessores();
    popularFiltros();

  } catch(err) {
    console.error('Erro ao criar professor:', err);
    erroEl.textContent = 'Erro de conexão. Tente novamente.';
    erroEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Criar professor';
  }
}

function abrirModalEditarProf(id) {
  const p = PROFESSORES.find(x => x.id === id);
  if (!p) return;
  profSelecionadoId = id;
  document.getElementById('ep-nome').value = p.nome || '';
  document.getElementById('ep-email').value = p.email || '';
  document.getElementById('ep-senha').value = p.senha || '';
  document.getElementById('ep-senha').type = 'password';
  document.getElementById('ep-papel').value = p.papel || 'professor';
  document.getElementById('ep-erro').style.display = 'none';
  document.getElementById('modal-editar-prof').classList.add('open');
}

async function salvarEdicaoProf() {
  const p = PROFESSORES.find(x => x.id === profSelecionadoId);
  if (!p) return;
  const novoNome  = document.getElementById('ep-nome').value.trim();
  const novoEmail = document.getElementById('ep-email').value.trim();
  const novaSenha = document.getElementById('ep-senha').value;
  const novoPapel = document.getElementById('ep-papel').value;
  const erroEl    = document.getElementById('ep-erro');
  erroEl.style.display = 'none';

  if (!novoNome)  { erroEl.textContent = 'Digite o nome.'; erroEl.style.display = 'block'; return; }
  if (!novoEmail || !novoEmail.includes('@')) { erroEl.textContent = 'Digite um e-mail válido.'; erroEl.style.display = 'block'; return; }
  if (novaSenha && novaSenha.length < 6) { erroEl.textContent = 'A senha deve ter pelo menos 6 caracteres.'; erroEl.style.display = 'block'; return; }


const updates = { nome: novoNome, papel: novoPapel, email: novoEmail };
if (novaSenha) updates.senha = novaSenha;

const { error } = await sb.from('professores').update(updates).eq('id', p.id);
if (error) { erroEl.textContent = 'Erro ao salvar: ' + error.message; erroEl.style.display = 'block'; return; }

  let senhaOk = true;
  if (novaSenha && p.user_id) {
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${p.user_id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        },
        body: JSON.stringify({ password: novaSenha })
      });
      if (!res.ok) {
        senhaOk = false;
        erroEl.textContent = 'Dados salvos! Mas a senha requer a chave de serviço (service_role) do Supabase para ser alterada diretamente. Use "✉ Enviar reset de senha" como alternativa.';
        erroEl.style.display = 'block';
      }
    } catch(err) {
      senhaOk = false;
      erroEl.textContent = 'Dados salvos, mas erro ao alterar senha. Tente o botão "✉ Enviar reset de senha".';
      erroEl.style.display = 'block';
    }
  }

p.nome  = novoNome;
p.email = novoEmail;
p.papel = novoPapel;
if (novaSenha) p.senha = novaSenha;

  if (senhaOk || !novaSenha) {
    fecharModal('modal-editar-prof');
    showToast('Professor atualizado!');
  } else {
    showToast('Dados salvos com aviso — veja o modal.', 'blue');
  }
  renderProfessores(); renderDash(); renderTabelaAlunos(); renderRel();
}

async function enviarResetSenha() {
  const p = PROFESSORES.find(x => x.id === profSelecionadoId);
  if (!p?.email) { showToast('E-mail do professor não encontrado.', 'red'); return; }
  const { error } = await sb.auth.resetPasswordForEmail(p.email, {
    redirectTo: location.origin + location.pathname
  });
  if (error) {
    showToast('Erro ao enviar e-mail de reset.', 'red');
  } else {
    showToast(`E-mail de redefinição enviado para ${p.email}!`, 'blue');
  }
}

// =============================================
// MULTI-SELECT GENÉRICO (RELATÓRIO)
// =============================================
function getMultiSelecionados(panelId) {
  return [...document.querySelectorAll(`#${panelId} input:checked`)].map(i => i.value);
}

function onMultiCheck(panelId, btnId, labelId) {
  const selecionados = getMultiSelecionados(panelId);
  const label = document.getElementById(labelId);
  const btn = document.getElementById(btnId);
  if (!label || !btn) return;
  if (selecionados.length === 0) {
    label.textContent = labelId.includes('turma') ? 'Todas' : 'Todos';
    btn.classList.remove('active');
  } else {
    const texts = [...document.querySelectorAll(`#${panelId} input:checked`)].map(i => i.closest('label')?.textContent?.trim() || i.value);
    label.textContent = texts.join(', ');
    btn.classList.add('active');
  }
  renderRel();
}

function toggleMultiDropdown(e, panelId) {
  e.stopPropagation();
  document.querySelectorAll('.multi-select-panel.open').forEach(p => {
    if (p.id !== panelId) p.classList.remove('open');
  });
  document.getElementById(panelId)?.classList.toggle('open');
}

// Fechar ao clicar fora
document.addEventListener('click', function(e) {
  if (!e.target.closest('#dot-menu')) {
    const menu = document.getElementById('dot-menu');
    if (menu) { menu.remove(); dotMenuContext = null; }
  }
  document.querySelectorAll('.multi-select-panel.open').forEach(p => p.classList.remove('open'));
});

// =============================================
// MÉTRICAS / DASHBOARD PEDAGÓGICO
// =============================================
function renderMetricas() {
  const ativos   = ALUNOS.filter(a => a.ativo);
  const inativos = ALUNOS.filter(a => !a.ativo);
  const cursos   = [...new Set(TURMAS.map(t => t.curso))].sort();
  const dash     = '<span style="color:var(--text-very-faded);">—</span>';

  const cancelados = inativos.filter(a => statusInativo(a.id) === 'cancelado');
  const soInativos = inativos.filter(a => statusInativo(a.id) === 'inativo');

  const dadosAtivos = ativos.map(a => calcAluno(a));
  const comFreq   = dadosAtivos.filter(d => d.freq !== null);
  const freqMedia = comFreq.length > 0 ? Math.round(comFreq.reduce((s,d)=>s+d.freq,0)/comFreq.length) : null;
  const regulares = dadosAtivos.filter(d => !d.emAlerta && d.freq !== null && d.freq >= 70).length;
  const atencao   = dadosAtivos.filter(d => !d.emAlerta && d.freq !== null && d.freq < 70).length;
  const alertas   = dadosAtivos.filter(d => d.emAlerta).length;
  const semReg    = dadosAtivos.filter(d => d.freq === null).length;
  const totalRep  = dadosAtivos.reduce((s, d) => s + d.r, 0);
  const alunosRep = dadosAtivos.filter(d => d.r > 0).length;

  const transferidos = HISTORICO.filter(h => h.descricao?.includes('Transferido')).length;
  const novos        = HISTORICO.filter(h => h.descricao?.includes('adicionado ao sistema')).length;
  const reativacoes  = HISTORICO.filter(h => h.descricao?.includes('reativado')).length;

  const total    = ativos.length + inativos.length;
  const txEvasao = total > 0 ? ((inativos.length/total)*100).toFixed(1) : '0';

  function pct(n) { return ativos.length > 0 ? Math.round((n/ativos.length)*100) : 0; }
  function fbar(val, color) {
    return `<div class="metr-bar-wrap"><div class="metr-bar"><div class="metr-bar-fill" style="width:${val||0}%;background:${color};"></div></div><span style="font-weight:600;color:${color};font-size:11px;">${val !== null ? val+'%' : '—'}</span></div>`;
  }
  function numBadge(n, cls) { return n > 0 ? `<span class="badge ${cls}">${n}</span>` : dash; }

  // ── VISÃO GERAL ──────────────────────────────────────────────
  const fColor = freqMedia !== null ? (freqMedia >= 75 ? 'var(--green)' : 'var(--amber)') : 'var(--text-faded)';
  document.getElementById('metr-visao-geral').innerHTML = `
    <thead><tr><th>Métrica</th><th style="text-align:center;">Valor</th><th>Descrição</th></tr></thead>
    <tbody>
      <tr><td style="font-weight:500;">🏫 Total de turmas</td><td style="text-align:center;font-weight:700;font-size:15px;">${TURMAS.length}</td><td style="color:var(--text-3);font-size:11px;">Turmas cadastradas no sistema</td></tr>
      <tr><td style="font-weight:500;">👥 Alunos ativos</td><td style="text-align:center;font-weight:700;font-size:15px;">${ativos.length}</td><td style="color:var(--text-3);font-size:11px;">Matrículas ativas no momento</td></tr>
      <tr><td style="font-weight:500;">📊 Frequência média</td><td style="text-align:center;">${fbar(freqMedia, fColor)}</td><td style="color:var(--text-3);font-size:11px;">Média geral de presença dos alunos ativos com registro</td></tr>
      <tr><td style="font-weight:500;">⚠️ Em alerta</td><td style="text-align:center;">${numBadge(alertas,'badge-red')}</td><td style="color:var(--text-3);font-size:11px;">3 faltas seguidas nas últimas 8 aulas com registro (${pct(alertas)}% dos ativos)</td></tr>
      <tr><td style="font-weight:500;">❌ Matrículas canceladas</td><td style="text-align:center;">${numBadge(cancelados.length,'badge-red')}</td><td style="color:var(--text-3);font-size:11px;">Alunos que encerraram o curso definitivamente</td></tr>
      <tr><td style="font-weight:500;">⏸ Inativos (temporários)</td><td style="text-align:center;">${numBadge(soInativos.length,'badge-amber')}</td><td style="color:var(--text-3);font-size:11px;">Alunos afastados temporariamente, podem retornar</td></tr>
    </tbody>`;

  // ── DIMENSIONAMENTO POR CURSO ────────────────────────────────
  document.getElementById('metr-tabela-curso').innerHTML = `
    <thead><tr>
      <th>Curso</th><th style="text-align:center;">Turmas</th><th style="text-align:center;">Alunos ativos</th>
      <th style="text-align:center;">Média / turma</th><th style="text-align:center;">Freq. média</th>
      <th style="text-align:center;">Regulares</th><th style="text-align:center;">Atenção</th>
      <th style="text-align:center;">Alerta</th><th style="text-align:center;">Cancelados</th><th style="text-align:center;">Inativos</th>
    </tr></thead>
    <tbody>${cursos.map(c => {
      const tC   = TURMAS.filter(t => t.curso === c);
      const aC   = ALUNOS.filter(a => a.ativo && tC.some(t => t.id === a.turma_id));
      const iC   = inativos.filter(a => tC.some(t => t.id === a.turma_id));
      const canC = iC.filter(a => statusInativo(a.id) === 'cancelado');
      const inaC = iC.filter(a => statusInativo(a.id) === 'inativo');
      const media = tC.length > 0 ? (aC.length/tC.length).toFixed(1) : '—';
      const dc   = aC.map(a => calcAluno(a));
      const comF = dc.filter(d => d.freq !== null);
      const fM   = comF.length > 0 ? Math.round(comF.reduce((s,d)=>s+d.freq,0)/comF.length) : null;
      const reg  = dc.filter(d => !d.emAlerta && d.freq !== null && d.freq >= 70).length;
      const at   = dc.filter(d => !d.emAlerta && d.freq !== null && d.freq < 70).length;
      const al   = dc.filter(d => d.emAlerta).length;
      const fc   = fM !== null ? (fM >= 75 ? 'var(--green)' : 'var(--amber)') : 'var(--text-faded)';
      return `<tr>
        <td><span class="badge ${corBadge(c)}">${c}</span></td>
        <td style="text-align:center;font-weight:600;">${tC.length}</td>
        <td style="text-align:center;font-weight:600;">${aC.length}</td>
        <td style="text-align:center;color:var(--text-3);">${media}</td>
        <td style="text-align:center;">${fbar(fM,fc)}</td>
        <td style="text-align:center;">${numBadge(reg,'badge-green')}</td>
        <td style="text-align:center;">${numBadge(at,'badge-amber')}</td>
        <td style="text-align:center;">${numBadge(al,'badge-red')}</td>
        <td style="text-align:center;">${numBadge(canC.length,'badge-red')}</td>
        <td style="text-align:center;">${numBadge(inaC.length,'badge-amber')}</td>
      </tr>`;
    }).join('')}</tbody>`;

  // ── FREQUÊNCIA E DESEMPENHO ──────────────────────────────────
  document.getElementById('metr-frequencia').innerHTML = `
    <thead><tr><th>Status</th><th style="text-align:center;">Alunos</th><th style="text-align:center;">% dos ativos</th><th>Critério</th></tr></thead>
    <tbody>
      <tr><td style="font-weight:500;">✅ Presença física (P)</td><td style="text-align:center;">${numBadge(dadosAtivos.filter(d=>d.p-d.r>0||d.r===0&&d.p>0).length,'badge-green')}</td><td style="text-align:center;">${fbar(pct(regulares),'var(--green)')}</td><td style="color:var(--text-3);font-size:11px;">Presença registrada normalmente na aula</td></tr>
      <tr><td style="font-weight:500;">🟡 Gravações (R)</td><td style="text-align:center;">${alunosRep > 0 ? `<span class="badge badge-amber">${alunosRep}</span>` : dash}</td><td style="text-align:center;">${fbar(pct(alunosRep),'var(--amber)')}</td><td style="color:var(--text-3);font-size:11px;">Assistiram via plataforma · conta como presença · ${totalRep} registros no total</td></tr>
      <tr><td style="font-weight:500;">✅ Regulares (≥70%)</td><td style="text-align:center;">${numBadge(regulares,'badge-green')}</td><td style="text-align:center;">${fbar(pct(regulares),'var(--green)')}</td><td style="color:var(--text-3);font-size:11px;">freq ≥ 70% (P+R) e sem alerta</td></tr>
      <tr><td style="font-weight:500;">🟠 Atenção (&lt;70%)</td><td style="text-align:center;">${numBadge(atencao,'badge-amber')}</td><td style="text-align:center;">${fbar(pct(atencao),'var(--amber)')}</td><td style="color:var(--text-3);font-size:11px;">freq &lt; 70% e sem 3 faltas seguidas</td></tr>
      <tr><td style="font-weight:500;">🔴 Em alerta</td><td style="text-align:center;">${numBadge(alertas,'badge-red')}</td><td style="text-align:center;">${fbar(pct(alertas),'var(--red)')}</td><td style="color:var(--text-3);font-size:11px;">3 faltas seguidas nas últimas 8 aulas com registro</td></tr>
      <tr><td style="font-weight:500;">⬜ Sem registro</td><td style="text-align:center;">${semReg > 0 ? `<span class="badge badge-gray">${semReg}</span>` : dash}</td><td style="text-align:center;">${fbar(pct(semReg),'var(--text-faded)')}</td><td style="color:var(--text-3);font-size:11px;">Nenhuma aula lançada ainda</td></tr>
    </tbody>`;

  // ── EVASÃO E MOVIMENTAÇÃO ────────────────────────────────────
  document.getElementById('metr-movimentacao').innerHTML = `
    <thead><tr><th>Evento</th><th style="text-align:center;">Quantidade</th><th>Descrição</th></tr></thead>
    <tbody>
      <tr><td style="font-weight:500;">➕ Novos alunos</td><td style="text-align:center;font-weight:700;font-size:15px;">${novos}</td><td style="color:var(--text-3);font-size:11px;">Total de alunos adicionados ao sistema</td></tr>
      <tr><td style="font-weight:500;">🔄 Transferências</td><td style="text-align:center;font-weight:700;font-size:15px;">${transferidos}</td><td style="color:var(--text-3);font-size:11px;">Movimentações internas entre turmas ou cursos</td></tr>
      <tr><td style="font-weight:500;">❌ Matrículas canceladas</td><td style="text-align:center;">${numBadge(cancelados.length,'badge-red')}</td><td style="color:var(--text-3);font-size:11px;">Alunos que encerraram o curso · taxa de evasão: ${txEvasao}% do total</td></tr>
      <tr><td style="font-weight:500;">⏸ Inativos (temporários)</td><td style="text-align:center;">${numBadge(soInativos.length,'badge-amber')}</td><td style="color:var(--text-3);font-size:11px;">Alunos afastados temporariamente, podem retornar</td></tr>
      <tr><td style="font-weight:500;">↩️ Reativações</td><td style="text-align:center;">${reativacoes > 0 ? `<span class="badge badge-green">${reativacoes}</span>` : dash}</td><td style="color:var(--text-3);font-size:11px;">Alunos que retornaram após afastamento ou cancelamento</td></tr>
    </tbody>`;
}

// =============================================
// RELATÓRIOS
// =============================================
function renderRel() {
  const fCursos = getMultiSelecionados('curso-multi-panel');
  const fProfs = getMultiSelecionados('prof-multi-panel');
  const fTipos = getMultiSelecionados('tipo-multi-panel');
  const fTurmasRel = getMultiSelecionados('turma-rel-multi-panel');
  const fStatus = getMultiSelecionados('status-multi-panel');
  let turmas = TURMAS;
  if (fCursos.length > 0) turmas = turmas.filter(t => fCursos.includes(t.curso));
  if (fProfs.length > 0) turmas = turmas.filter(t => fProfs.includes(t.professor));
  if (fTurmasRel.length > 0) turmas = turmas.filter(t => fTurmasRel.includes(String(t.id)));
  let html = '';
  turmas.forEach(t => {
    let lista = ALUNOS.filter(a => a.turma_id === t.id).map(a => ({ ...a, ...calcAluno(a) }));
    if (fTipos.length > 0) {
      lista = lista.filter(a =>
        (fTipos.includes('alerta') && a.ativo && a.emAlerta) ||
        (fTipos.includes('irregular') && a.ativo && a.freq !== null && a.freq < 70)
      );
    }
    if (fStatus.length > 0) {
      lista = lista.filter(a => {
        const isRegular   = a.ativo && !a.emAlerta && a.freq !== null && a.freq >= 70;
        const isAtencao   = a.ativo && !a.emAlerta && a.freq !== null && a.freq < 70;
        const isAlerta    = a.ativo && a.emAlerta;
        const isCancelado = !a.ativo && statusInativo(a.id) === 'cancelado';
        return (fStatus.includes('regular')       && isRegular)   ||
               (fStatus.includes('atencao')       && isAtencao)   ||
               (fStatus.includes('alerta-status') && isAlerta)    ||
               (fStatus.includes('cancelado')     && isCancelado);
      });
    }
    if (!lista.length) return;
    const ativos = lista.filter(a => a.ativo);
    const totalP = ativos.reduce((s, a) => s + a.p, 0), totalF = ativos.reduce((s, a) => s + a.f, 0);
    const fMedia = totalP + totalF > 0 ? Math.round((totalP / (totalP + totalF)) * 100) : null;
    const at = ativos.filter(a => a.emAlerta).length;
    html += `<div style="margin-bottom:1.5rem;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:.75rem;flex-wrap:wrap;">
        <div style="width:9px;height:9px;border-radius:50%;background:${t.cor || '#3b82f6'};flex-shrink:0;"></div>
        <span style="font-size:14px;font-weight:600;color:var(--text);">${t.turma}</span>
        <span style="font-size:12px;color:var(--text-3);">· ${t.curso} · Prof. ${t.professor} · ${ativos.length} ativos · freq. média ${fMedia !== null ? fMedia + '%' : '—'}${at > 0 ? ` · <span style="color:var(--red);font-weight:600;">${at} alerta${at > 1 ? 's' : ''}</span>` : ''}</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th style="width:32%;">Aluno</th>
          <th style="width:11%;">Histórico</th>
          <th style="width:6%;text-align:center;">P</th>
          <th style="width:6%;text-align:center;">R</th>
          <th style="width:6%;text-align:center;">F</th>
          <th style="width:10%;text-align:center;">Consec.</th>
          <th style="width:12%;">Freq.</th>
          <th style="width:12%;">Status</th>
        </tr></thead>
        <tbody>${lista.map(a => `<tr class="clickable ${a.emAlerta && a.ativo ? 'row-alerta' : ''} ${!a.ativo ? 'row-inativo' : ''}" onclick="abrirModalAluno(${a.id})">
          <td>${a.nome}${!a.ativo ? ' <span class="badge badge-gray" style="font-size:10px;">Inativo</span>' : ''}</td>
          <td><div class="dots" style="cursor:pointer;">${(() => { const _c = a.seq.map((v,i)=>({v,i})).filter(x=>x.v!=='N').slice(-8); return _c.map(({v,i}) => `<div class="dot ${v==='P'?'dot-p':v==='R'?'dot-r':v==='F'?'dot-f':'dot-n'}" style="cursor:pointer;transition:transform .1s;" onmouseenter="this.style.transform='scale(1.3)'" onmouseleave="this.style.transform='scale(1)'" onclick="event.stopPropagation();abrirDotMenu(event,${a.id},${t.id},${i})" title="Aula ${i+1}: ${v==='P'?'Presente':v==='R'?'Gravação':v==='F'?'Falta':'Sem registro'}"></div>`).join(''); })()}</div></td>
          <td style="text-align:center;color:var(--green);font-weight:600;">${a.p - a.r}</td>
          <td style="text-align:center;color:var(--amber);font-weight:600;">${a.r > 0 ? a.r : '—'}</td>
          <td style="text-align:center;color:var(--red);font-weight:600;">${a.f}</td>
          <td style="text-align:center;">${a.maxConsec > 0 ? `<span class="badge ${a.emAlerta ? 'badge-red' : 'badge-gray'}">${a.maxConsec}</span>` : '—'}</td>
          <td>${freqBar(a.freq)}</td>
          <td>${statusBadge(a.freq, a.emAlerta, a.ativo)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
  });
  document.getElementById('rel-area').innerHTML = html || '<div class="empty">Nenhuma turma encontrada com os filtros selecionados.</div>';
}

function atualizarTurmasAlunos() {
  const fCurso = document.getElementById('f-curso-alunos')?.value || '';
  let turmasFilt = TURMAS;
  if (fCurso) turmasFilt = turmasFilt.filter(t => t.curso === fCurso);
  const ft = document.getElementById('f-turma-alunos');
  if (ft) ft.innerHTML = '<option value="">Todas</option>' + turmasFilt.map(t => '<option value="'+t.id+'">'+t.turma+' - '+t.curso+'</option>').join('');
}

async function carregarObservacoes(alunoId) {
  const lista = document.getElementById('ma-obs-lista');
  if (!lista) return;
  const { data } = await sb.from('historico').select('*').eq('aluno_id', alunoId).eq('tipo', 'observacao').order('created_at', { ascending: false });
  if (!data || !data.length) {
    lista.innerHTML = '<div style="font-size:12px;color:var(--text-faded);padding:4px 0;">Nenhuma observação registrada.</div>';
    return;
  }
  lista.innerHTML = data.map(h => {
    const d = h.data_obs ? new Date(h.data_obs + 'T00:00:00').toLocaleDateString('pt-BR') : new Date(h.created_at).toLocaleDateString('pt-BR');
    const cat = OBS_CATEGORIAS.find(c => c.id === h.categoria);
    const catBadge = cat ? `<span class="badge ${cat.badge}" style="font-size:10px;margin-left:6px;">${cat.icon} ${cat.label}</span>` : '';
    return '<div style="padding:6px 0;border-bottom:1px solid var(--border-2);font-size:12px;color:var(--text);"><div style="display:flex;align-items:center;flex-wrap:wrap;margin-bottom:3px;"><span style="color:var(--text-faded);font-size:11px;">'+d+'</span>'+catBadge+'</div><div>'+h.descricao+'</div></div>';
  }).join('');
}

function iniciarObservacao() {
  const texto = document.getElementById('obs-texto').value.trim();
  if (!texto) { showToast('Digite uma observação!', 'red'); return; }
  obsCategoriaSelecionada = null;
  document.getElementById('obs-cat-preview').textContent = '"' + texto + '"';
  document.getElementById('obs-confirm-btn').disabled = true;
  renderCategoriasObs();
  document.getElementById('obs-categoria-panel').style.display = 'block';
  document.getElementById('obs-add-btn').disabled = true;
}

function renderCategoriasObs() {
  document.getElementById('obs-cat-grid').innerHTML = OBS_CATEGORIAS.map(c =>
    `<button class="obs-cat-btn ${obsCategoriaSelecionada === c.id ? 'selected' : ''}" onclick="selecionarCategoriaObs('${c.id}')">
      <span class="icon">${c.icon}</span><span>${c.label}</span>
    </button>`
  ).join('');
}

function selecionarCategoriaObs(id) {
  obsCategoriaSelecionada = id;
  document.getElementById('obs-confirm-btn').disabled = false;
  renderCategoriasObs();
}

function cancelarObservacao() {
  document.getElementById('obs-categoria-panel').style.display = 'none';
  document.getElementById('obs-add-btn').disabled = false;
  obsCategoriaSelecionada = null;
}

async function confirmarObservacao() {
  if (!obsCategoriaSelecionada) return;
  const texto = document.getElementById('obs-texto').value.trim();
  if (!texto) return;
  const hoje = new Date().toISOString().split('T')[0];
  const { error } = await sb.from('historico').insert({
    aluno_id: alunoSelecionadoId,
    descricao: texto,
    tipo: 'observacao',
    data_obs: hoje,
    categoria: obsCategoriaSelecionada
  });
  if (error) { showToast('Erro ao salvar observação.', 'red'); console.error(error); return; }
  document.getElementById('obs-texto').value = '';
  document.getElementById('obs-categoria-panel').style.display = 'none';
  document.getElementById('obs-add-btn').disabled = false;
  obsCategoriaSelecionada = null;
  showToast('Observação salva!');
  carregarObservacoes(alunoSelecionadoId);
}

// =============================================
// EDIÇÃO INLINE DE TURMA
// =============================================
function editarTituloTurma(tId) {
  const t = TURMAS.find(x => x.id === tId);
  const el = document.getElementById('titulo-' + tId);
  if (!el) return;
  const input = document.createElement('input');
  input.className = 'inline-input';
  input.value = t.turma;
  el.replaceWith(input);
  input.focus(); input.select();
  async function salvar() {
    const novo = input.value.trim();
    if (novo && novo !== t.turma) {
      await sb.from('turmas').update({ turma: novo }).eq('id', tId);
      t.turma = novo;
      showToast('Nome da turma atualizado!');
    }
    renderDash(); renderTabelaAlunos(); renderRel();
  }
  input.onblur = salvar;
  input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } if (e.key === 'Escape') { input.onblur = null; renderDash(); } };
}

function editarProfTurma(tId) {
  const t = TURMAS.find(x => x.id === tId);
  const el = document.getElementById('prof-' + tId);
  if (!el) return;
  const input = document.createElement('input');
  input.className = 'inline-input-sm';
  input.value = t.professor;
  input.style.width = '140px';
  el.replaceWith(input);
  input.focus(); input.select();
  async function salvar() {
    const novo = input.value.trim();
    if (novo && novo !== t.professor) {
      await sb.from('turmas').update({ professor: novo }).eq('id', tId);
      t.professor = novo;
      showToast('Professor atualizado!');
    }
    renderDash(); renderTabelaAlunos(); renderRel();
  }
  input.onblur = salvar;
  input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } if (e.key === 'Escape') { input.onblur = null; renderDash(); } };
}

// =============================================
// DOT MENU — EDIÇÃO DE PRESENÇA NO RELATÓRIO
// =============================================
function abrirDotMenu(e, alunoId, turmaId, aulaIdx) {
  e.stopPropagation();
  const existing = document.getElementById('dot-menu');
  if (existing) {
    existing.remove();
    if (dotMenuContext?.alunoId === alunoId && dotMenuContext?.aulaIdx === aulaIdx) {
      dotMenuContext = null; return;
    }
  }
  const key = `${turmaId}_${AULAS[aulaIdx]}`;
  const atual = (PRESENCAS[key] && PRESENCAS[key][alunoId]) || null;
  dotMenuContext = { alunoId, turmaId, aulaIdx };
  const opcoes = [
    { val: 'P', label: '✓ Presente',  cls: 'dot-menu-p' },
    { val: 'R', label: '↺ Gravação',  cls: 'dot-menu-r' },
    { val: 'F', label: '✗ Falta',     cls: 'dot-menu-f' },
    { val: null, label: '— Limpar',   cls: 'dot-menu-n' },
  ];
  const menu = document.createElement('div');
  menu.id = 'dot-menu';
  menu.className = 'dot-menu';
  menu.innerHTML = opcoes.map(o =>
    `<div class="dot-menu-item ${o.cls} ${atual === o.val ? 'dot-menu-active' : ''}" onclick="event.stopPropagation();selecionarStatusDot(${o.val === null ? 'null' : "'" + o.val + "'"})">${o.label}${atual === o.val ? ' ✔' : ''}</div>`
  ).join('');
  document.body.appendChild(menu);
  const rect = e.target.getBoundingClientRect();
  let left = rect.left, top = rect.bottom + 4;
  if (left + 140 > window.innerWidth) left = window.innerWidth - 148;
  menu.style.left = left + 'px';
  menu.style.top  = top  + 'px';
}

async function selecionarStatusDot(novoVal) {
  const { alunoId, turmaId, aulaIdx } = dotMenuContext;
  const aula = AULAS[aulaIdx];
  const key = `${turmaId}_${aula}`;
  if (!PRESENCAS[key]) PRESENCAS[key] = {};
  const atual = PRESENCAS[key][alunoId] || null;

  const menu = document.getElementById('dot-menu');
  if (menu) menu.remove();
  dotMenuContext = null;

  if (novoVal === atual) return; // nada mudou

  PRESENCAS[key][alunoId] = novoVal;

  try {
    let saveError = null;
    if (novoVal) {
      const { error } = await sb.from('presencas').upsert(
        { turma_id: turmaId, aluno_id: alunoId, aula, status: novoVal },
        { onConflict: 'turma_id,aluno_id,aula' }
      );
      saveError = error;
    } else {
      const { error } = await sb.from('presencas').delete()
        .eq('turma_id', turmaId).eq('aluno_id', alunoId).eq('aula', aula);
      saveError = error;
    }
    if (saveError) throw saveError;
    showToast('Presença atualizada!', 'green');
    renderRel(); renderDash(); renderTabelaAlunos();
  } catch(err) {
    console.error('Erro ao salvar dot:', err);
    PRESENCAS[key][alunoId] = atual; // reverte
    renderRel();
    showToast('Erro ao salvar. Tente novamente.', 'red');
  }
}
// =============================================
// IR PARA ALERTAS DA TURMA
// =============================================
function irParaAlertas(turmaId) {
  goTab('alunos');
  const fTurma = document.getElementById('f-turma-alunos');
  if (fTurma) fTurma.value = String(turmaId);
  const fStatus = document.getElementById('f-status-alunos');
  if (fStatus) fStatus.value = 'alerta';
  const busca = document.getElementById('busca-alunos');
  if (busca) busca.value = '';
  renderTabelaAlunos();
}

// =============================================
// EXPORTAR EXCEL
// =============================================
async function exportarExcel() {
  const btn = document.getElementById('btn-exportar');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Gerando...'; }

  try {
    const wb = XLSX.utils.book_new();
    const resumoRows = [
      ['Relatório de Frequência — Todas as Turmas'],
      ['Gerado em: ' + new Date().toLocaleString('pt-BR')],
      [],
      ['Turma', 'Curso', 'Professor', 'Aluno', 'Status', 'Presenças', 'Faltas', '% Frequência', 'Faltas Consecutivas', 'Situação']
    ];

    TURMAS.forEach(t => {
      ALUNOS.filter(a => a.turma_id === t.id).forEach(a => {
        const c = calcAluno(a);
        const situacao = !a.ativo ? 'Inativo' : c.emAlerta ? '⚠ Alerta' : c.freq === null ? 'Sem registro' : c.freq >= 70 ? 'Regular' : 'Atenção';
        resumoRows.push([t.turma, t.curso, t.professor, a.nome, a.ativo ? 'Ativo' : 'Inativo', c.p, c.f, c.freq !== null ? c.freq / 100 : null, c.maxConsec, situacao]);
      });
    });

    const wsResumo = XLSX.utils.aoa_to_sheet(resumoRows);
    for (let r = 4; r < resumoRows.length; r++) {
      const cell = XLSX.utils.encode_cell({ r, c: 7 });
      if (wsResumo[cell] && typeof wsResumo[cell].v === 'number') wsResumo[cell].z = '0%';
    }
    wsResumo['!cols'] = [{wch:20},{wch:16},{wch:18},{wch:35},{wch:8},{wch:10},{wch:8},{wch:13},{wch:18},{wch:12}];
    XLSX.utils.book_append_sheet(wb, wsResumo, 'Resumo Geral');

    const nomesUsados = new Set();
    TURMAS.forEach(t => {
      const alunosDaTurma = ALUNOS.filter(a => a.turma_id === t.id);
      if (!alunosDaTurma.length) return;
      const aulasComDados = AULAS.filter(aula => {
        const key = `${t.id}_${aula}`;
        return PRESENCAS[key] && Object.keys(PRESENCAS[key]).length > 0;
      });
      const aulasCols = aulasComDados.length > 0 ? aulasComDados : AULAS;
      const header = ['Aluno', 'Status', ...aulasCols, 'Presenças', 'Faltas', '% Freq.', 'Faltas Consec.'];
      const rows = [
        [t.turma + ' — ' + t.curso + ' — Prof. ' + t.professor],
        ['Gerado em: ' + new Date().toLocaleString('pt-BR')],
        [],
        header
      ];
      alunosDaTurma.forEach(a => {
        const row = [a.nome, a.ativo ? 'Ativo' : 'Inativo'];
        aulasCols.forEach(aula => {
          const key = `${t.id}_${aula}`;
          row.push((PRESENCAS[key] && PRESENCAS[key][a.id]) || '');
        });
        const c = calcAluno(a);
        row.push(c.p, c.f, c.freq !== null ? c.freq / 100 : null, c.maxConsec);
        rows.push(row);
      });
      const ws = XLSX.utils.aoa_to_sheet(rows);
      const pctColIdx = 2 + aulasCols.length + 2;
      for (let r = 4; r < rows.length; r++) {
        const cell = XLSX.utils.encode_cell({ r, c: pctColIdx });
        if (ws[cell] && typeof ws[cell].v === 'number') ws[cell].z = '0%';
      }
      ws['!cols'] = [{wch:35},{wch:8},...aulasCols.map(() => ({wch:7})),{wch:10},{wch:8},{wch:10},{wch:14}];

      let nomeAba = (t.turma || t.curso || 'Turma').substring(0, 31);
      if (nomesUsados.has(nomeAba)) {
        let contador = 2;
        while (nomesUsados.has(nomeAba.substring(0, 28) + ' ' + contador)) contador++;
        nomeAba = nomeAba.substring(0, 28) + ' ' + contador;
      }
      nomesUsados.add(nomeAba);
      XLSX.utils.book_append_sheet(wb, ws, nomeAba);
    });

    const alertaRows = [
      ['Alunos em Alerta — 3 ou mais faltas consecutivas'],
      ['Gerado em: ' + new Date().toLocaleString('pt-BR')],
      [],
      ['Turma', 'Curso', 'Professor', 'Aluno', 'Faltas Consecutivas', 'Total Faltas', '% Frequência']
    ];
    TURMAS.forEach(t => {
      ALUNOS.filter(a => a.ativo && a.turma_id === t.id).forEach(a => {
        const c = calcAluno(a);
        if (c.emAlerta) alertaRows.push([t.turma, t.curso, t.professor, a.nome, c.maxConsec, c.f, c.freq !== null ? c.freq / 100 : null]);
      });
    });
    const wsAlerta = XLSX.utils.aoa_to_sheet(alertaRows);
    for (let r = 4; r < alertaRows.length; r++) {
      const cell = XLSX.utils.encode_cell({ r, c: 6 });
      if (wsAlerta[cell] && typeof wsAlerta[cell].v === 'number') wsAlerta[cell].z = '0%';
    }
    wsAlerta['!cols'] = [{wch:20},{wch:16},{wch:18},{wch:35},{wch:18},{wch:12},{wch:13}];
    XLSX.utils.book_append_sheet(wb, wsAlerta, 'Alertas');

    XLSX.writeFile(wb, 'frequencia_' + new Date().toISOString().slice(0,10) + '.xlsx');
    showToast('Excel gerado com sucesso!', 'green');

  } catch(err) {
    console.error('Erro ao exportar Excel:', err);
    showToast('Erro ao gerar Excel. Veja o console.', 'red');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬇ Exportar Excel'; }
  }
}

// =============================================
// HORÁRIO DE TURMA
// =============================================
let horarioTurmaAtualId = null;

function abrirModalHorario(tId) {
  const t = TURMAS.find(x => x.id === tId);
  if (!t) return;
  horarioTurmaAtualId = tId;

  document.getElementById('ht-turma-nome').textContent = t.turma;
  document.getElementById('ht-turma-sub').textContent = `${t.curso} · Prof. ${t.professor}`;
  document.getElementById('ht-erro').style.display = 'none';
  document.getElementById('ht-btn-limpar').style.display = t.horario_inicio ? '' : 'none';

  // Preenche selects de hora (00-23) e minuto (de 5 em 5)
  const selHora = document.getElementById('ht-hora');
  const selMin  = document.getElementById('ht-minuto');
  selHora.innerHTML = Array.from({length: 24}, (_, h) =>
    `<option value="${String(h).padStart(2,'0')}">${String(h).padStart(2,'0')}</option>`).join('');
  selMin.innerHTML = ['00','05','10','15','20','25','30','35','40','45','50','55']
    .map(m => `<option value="${m}">${m}</option>`).join('');

  // Valores salvos (ou padrão 19:00)
  const [h, m] = (t.horario_inicio ? t.horario_inicio.slice(0,5) : '19:00').split(':');
  selHora.value = h;
  selMin.value = m;

  // Marcar dias salvos
  const diasSalvos = t.dias_semana || [];
  document.querySelectorAll('#ht-dias-grid .dia-check').forEach(label => {
    const val = label.dataset.dia;
    const check = label.querySelector('input');
    const selecionado = diasSalvos.includes(val);
    check.checked = selecionado;
    label.classList.toggle('selecionado', selecionado);
    label.onclick = function() {
      const c = this.querySelector('input');
      c.checked = !c.checked;
      this.classList.toggle('selecionado', c.checked);
    };
  });

  marcarPresetAtivo();
  document.getElementById('modal-horario-turma').classList.add('open');
}

function aplicarPreset(horario) {
  const [h, m] = horario.split(':');
  document.getElementById('ht-hora').value = h;
  document.getElementById('ht-minuto').value = m;
  marcarPresetAtivo();
}

function marcarPresetAtivo() {
  const atual = document.getElementById('ht-hora').value + ':' + document.getElementById('ht-minuto').value;
  document.querySelectorAll('#ht-presets .preset-btn').forEach(b => {
    b.classList.toggle('ativo', b.textContent === atual);
  });
}

async function salvarHorarioTurma() {
  const t = TURMAS.find(x => x.id === horarioTurmaAtualId);
  if (!t) return;

  const horario = document.getElementById('ht-hora').value + ':' + document.getElementById('ht-minuto').value;
  const diasSelecionados = [...document.querySelectorAll('#ht-dias-grid .dia-check input:checked')].map(i => i.value);
  const erroEl = document.getElementById('ht-erro');
  erroEl.style.display = 'none';

  if (!horario) { erroEl.textContent = 'Selecione um horário de início.'; erroEl.style.display = 'block'; return; }
  if (!diasSelecionados.length) { erroEl.textContent = 'Selecione pelo menos um dia de aula.'; erroEl.style.display = 'block'; return; }

  const { error } = await sb.from('turmas').update({
    horario_inicio: horario + ':00',
    dias_semana: diasSelecionados
  }).eq('id', t.id);

  if (error) { erroEl.textContent = 'Erro ao salvar: ' + error.message; erroEl.style.display = 'block'; return; }

  t.horario_inicio = horario + ':00';
  t.dias_semana = diasSelecionados;

  fecharModal('modal-horario-turma');
  showToast('Horário configurado! Notificações automáticas ativas.', 'green');
  renderDash();
}

async function limparHorarioTurma() {
  const t = TURMAS.find(x => x.id === horarioTurmaAtualId);
  if (!t) return;
  if (!confirm(`Remover o horário configurado da turma "${t.turma}"?\n\nAs notificações automáticas serão desativadas para esta turma.`)) return;

  const { error } = await sb.from('turmas').update({ horario_inicio: null, dias_semana: null }).eq('id', t.id);
  if (error) { showToast('Erro ao remover horário.', 'red'); return; }

  t.horario_inicio = null;
  t.dias_semana = null;

  fecharModal('modal-horario-turma');
  showToast('Horário removido. Notificações desativadas para esta turma.', 'blue');
  renderDash();
}

// =============================================
// AUTO-LOGIN (sessão ativa)
// =============================================
sb.auth.getSession().then(async ({ data }) => {
  if (data.session) {
    usuarioLogado = data.session.user;
    await carregarPerfil();
    await inicializarApp();
  }
});

// =============================================
// NOTIFICADOR DE ATUALIZAÇÃO
// =============================================
(function(){
  const currentVersion = document.querySelector('meta[name="app-version"]')?.content || '0';
  function showBanner(){ document.getElementById('update-banner').classList.add('visible'); }
  async function check(){
    try{
      const html = await fetch(location.href + '?_t=' + Date.now(), {cache:'no-store'}).then(r => r.text());
      const match = html.match(/<meta name="app-version" content="([^"]+)"/);
      if(match && match[1] !== currentVersion) { showBanner(); clearInterval(timer); }
    }catch(_){}
  }
  const timer = setInterval(check, 30000);
})();
