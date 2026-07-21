import { state } from '../../state/store.js';
import { calcAluno } from '../../domain/attendance.js';
import { ordemDia, corBadge } from '../../domain/status.js';
import { escapeHtml, escapeAttr } from '../../shared/dom.js';
import { goTab } from '../../shared/navigation.js';
import { renderTabelaAlunos } from '../alunos/alunosTable.js';

export function renderDash() {
  const ativos = state.ALUNOS.filter(a => a.ativo);
  const dados = ativos.map(a => calcAluno(a));
  const alertas = dados.filter(d => d.emAlerta).length;
  const irregulares = dados.filter(d => d.freq !== null && d.freq < 70).length;
  const turmasAtivas = state.TURMAS.filter(t => t.ativa !== false);
  const turmasInativas = state.TURMAS.filter(t => t.ativa === false);

  document.getElementById('stats-area').innerHTML = `
    <div class="stat-card"><div class="stat-label">Turmas</div><div class="stat-val">${turmasAtivas.length}</div></div>
    <div class="stat-card"><div class="stat-label">Alunos ativos</div><div class="stat-val">${ativos.length}</div></div>
    <div class="stat-card"><div class="stat-label">Irregulares (&lt;70%)</div><div class="stat-val amber">${irregulares}</div></div>
    <div class="stat-card"><div class="stat-label">Alertas (3 seguidas)</div><div class="stat-val red">${alertas}</div></div>`;

  const cursos = [...new Set(turmasAtivas.map(t => t.curso))];

  const minhasTurmas = turmasAtivas.filter(t => t.professor_id === state.perfilLogado?.id || t.professor === state.perfilLogado?.nome);
  document.getElementById('curso-pills').innerHTML =
    `<button class="cpill ${state.filtroCurso === '' ? 'active' : ''}" onclick="setCurso('')">Todos</button>` +
    (minhasTurmas.length > 0
      ? `<button class="cpill ${state.filtroCurso === '__minhas__' ? 'active' : ''}" onclick="setCurso('__minhas__')"> Suas Turmas <span style="background:rgba(255,255,255,.25);font-size:10px;padding:1px 6px;border-radius:99px;margin-left:4px;">${minhasTurmas.length}</span></button>`
      : '') +
    cursos.map(c => `<button class="cpill ${state.filtroCurso === c ? 'active' : ''}" onclick="setCurso('${escapeAttr(c)}')">${escapeHtml(c)}</button>`).join('') +
    `<button class="cpill ${state.filtroCurso === '__inativas__' ? 'active' : ''}" onclick="setCurso('__inativas__')">Turmas inativas <span style="background:rgba(255,255,255,.25);font-size:10px;padding:1px 6px;border-radius:99px;margin-left:4px;">${turmasInativas.length}</span></button>`;

  const buscaTurma = (document.getElementById('busca-turmas')?.value || '').toLowerCase();
  let filtradas = state.filtroCurso === '__inativas__'
    ? turmasInativas
    : state.filtroCurso === '__minhas__'
      ? minhasTurmas
      : state.filtroCurso
        ? turmasAtivas.filter(t => t.curso === state.filtroCurso)
        : turmasAtivas;
  if (buscaTurma) filtradas = filtradas.filter(t => t.turma.toLowerCase().includes(buscaTurma) || t.professor.toLowerCase().includes(buscaTurma));
  filtradas = filtradas.slice().sort((a, b) => {
    const da = ordemDia(a.turma), db = ordemDia(b.turma);
    if (da !== db) return da - db;
    return a.turma.localeCompare(b.turma, 'pt-BR');
  });

  document.getElementById('turmas-grid').innerHTML = filtradas.map(t => {
    const inativa = t.ativa === false;
    const al = state.ALUNOS.filter(a => a.ativo && a.turma_id === t.id);
    const at = al.filter(a => calcAluno(a).emAlerta).length;
    const horarioTag = t.horario_inicio
      ? `<span class="horario-tag" onclick="abrirModalEditarTurma(${t.id})" title="Clique para editar a turma">⏰ ${t.horario_inicio.slice(0, 5)}${t.dias_semana?.length ? ' · ' + t.dias_semana.map(d => d.charAt(0).toUpperCase() + d.slice(1, 3)).join(', ') : ''}</span>`
      : `<span class="horario-tag sem-horario" onclick="abrirModalEditarTurma(${t.id})" title="Configurar horário para notificação automática">+ Configurar horário</span>`;
    return `<div class="turma-card ${inativa ? 'turma-card-inativa' : ''}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <div style="width:9px;height:9px;border-radius:50%;background:${t.cor || '#3b82f6'};flex-shrink:0;"></div>
        <div style="font-size:13px;font-weight:600;flex:1;color:var(--text);">${escapeHtml(t.turma)}</div>
        <div class="turma-card-actions">
          <button class="inline-edit-btn" title="Editar turma" aria-label="Editar turma" onclick="abrirModalEditarTurma(${t.id})">✏</button>
          <button class="inline-edit-btn" title="${inativa ? 'Reativar turma' : 'Inativar turma'}" aria-label="${inativa ? 'Reativar turma' : 'Inativar turma'}" onclick="toggleTurmaAtiva(${t.id})">${inativa ? '▶' : '⏸'}</button>
        </div>
      </div>
      <div style="font-size:12px;color:var(--text-3);display:flex;flex-direction:column;gap:6px;">
        <span><span class="badge ${corBadge(t.curso)}">${escapeHtml(t.curso)}</span>${inativa ? ' <span class="badge badge-gray">Inativa</span>' : ''}</span>
        <span>Prof. ${escapeHtml(t.professor)}</span>
        <span>${al.length} alunos${at > 0 ? ` · <span style="color:var(--red);font-weight:600;cursor:pointer;border-bottom:1.5px dashed var(--red);padding-bottom:1px;" onclick="irParaAlertas(${t.id})">${at} alerta${at > 1 ? 's' : ''}</span>` : ''}</span>
        <div>${horarioTag}</div>
      </div>
      ${inativa
        ? `<button class="btn-chamada" onclick="toggleTurmaAtiva(${t.id})">Reativar turma</button>`
        : `<button class="btn-chamada" onclick="abrirChamada(${t.id})">Fazer chamada →</button>`}
    </div>`;
  }).join('') || '<div class="empty">Nenhuma turma encontrada.</div>';
}

export function setCurso(c) {
  state.filtroCurso = c;
  renderDash();
}

export function irParaAlertas(turmaId) {
  goTab('alunos');
  const fTurma = document.getElementById('f-turma-alunos');
  if (fTurma) fTurma.value = String(turmaId);
  const fStatus = document.getElementById('f-status-alunos');
  if (fStatus) fStatus.value = 'alerta';
  const busca = document.getElementById('busca-alunos');
  if (busca) busca.value = '';
  renderTabelaAlunos();
}
