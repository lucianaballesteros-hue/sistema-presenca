import { state } from '../../state/store.js';
import { calcAluno, ultimaAulaRegistrada } from '../../../backend/domain/attendance.js';
import { ordemDia, corBadge, professorNome, turmaAtiva, turmasAtivas } from '../../../backend/domain/status.js';
import { escapeHtml, escapeAttr } from '../../shared/dom.js';
import { goTab } from '../../shared/navigation.js';
import { ehAdmin, podeGerenciarTurmasInativas } from '../../shared/permissoes.js';
import { renderTabelaAlunos } from '../alunos/alunosTable.js';

export function renderDash() {
  const ativos = state.ALUNOS.filter(a => a.ativo);
  const dados = ativos.map(a => calcAluno(a));
  const alertas = dados.filter(d => d.emAlerta).length;
  const irregulares = dados.filter(d => d.freq !== null && d.freq < 70).length;
  // Para professor, state.TURMAS já vem sem nenhuma turma inativa
  // (carregarTurmas() as descarta) — então turmasInativas fica vazia e a pill
  // correspondente nem é desenhada. Ver turmasRepo.js.
  const ativas = turmasAtivas();
  const turmasInativas = state.TURMAS.filter(t => !turmaAtiva(t));

  document.getElementById('stats-area').innerHTML = `
    <div class="stat-card"><div class="stat-label">Turmas</div><div class="stat-val">${ativas.length}</div></div>
    <div class="stat-card"><div class="stat-label">Alunos ativos</div><div class="stat-val">${ativos.length}</div></div>
    <div class="stat-card"><div class="stat-label">Irregulares (&lt;70%)</div><div class="stat-val amber">${irregulares}</div></div>
    <div class="stat-card"><div class="stat-label">Alertas (3 últimas faltas)</div><div class="stat-val red">${alertas}</div></div>`;

  // Três filtros que se somam, no mesmo formato da aba Alunos: "Mostrar"
  // escolhe o grupo (todas / suas / inativas), "Curso" recorta dentro dele e
  // a busca procura por turma ou professor. Antes tudo era uma fileira só de
  // pílulas, misturando curso com situação — e não dava para ver, por
  // exemplo, só as suas turmas de um curso.
  //
  // Vínculo de posse é sempre por professor_id (nunca por nome) — ver
  // professorNome() em backend/domain/status.js para o motivo.
  const minhasTurmas = ativas.filter(t => t.professor_id === state.perfilLogado?.id);
  const grupos = [
    { valor: '', rotulo: 'Todas', turmas: ativas },
    minhasTurmas.length > 0 && { valor: '__minhas__', rotulo: `Suas turmas (${minhasTurmas.length})`, turmas: minhasTurmas },
    // Professores não acompanham turmas encerradas — só admin vê esse grupo.
    ehAdmin() && { valor: '__inativas__', rotulo: `Inativas (${turmasInativas.length})`, turmas: turmasInativas },
  ].filter(Boolean);
  const grupo = grupos.find(g => g.valor === state.filtroGrupoTurmas) || grupos[0];
  state.filtroGrupoTurmas = grupo.valor;
  preencherFiltro('f-grupo-turmas', grupos.map(g => [g.valor, g.rotulo]), grupo.valor);
  document.getElementById('filtro-grupo-turmas').classList.toggle('hidden', grupos.length < 2);

  const cursos = [...new Set(grupo.turmas.map(t => t.curso).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  if (!cursos.includes(state.filtroCurso)) state.filtroCurso = '';
  preencherFiltro('f-curso-turmas', [['', 'Todos'], ...cursos.map(c => [c, c])], state.filtroCurso);

  const buscaTurma = (document.getElementById('busca-turmas')?.value || '').toLowerCase();
  let filtradas = state.filtroCurso ? grupo.turmas.filter(t => t.curso === state.filtroCurso) : grupo.turmas;
  if (buscaTurma) filtradas = filtradas.filter(t => t.turma.toLowerCase().includes(buscaTurma) || professorNome(t).toLowerCase().includes(buscaTurma));
  document.getElementById('turmas-total').textContent = `${filtradas.length} ${filtradas.length === 1 ? 'turma' : 'turmas'}`;
  filtradas = filtradas.slice().sort((a, b) => {
    const da = ordemDia(a.turma), db = ordemDia(b.turma);
    if (da !== db) return da - db;
    return a.turma.localeCompare(b.turma, 'pt-BR');
  });

  document.getElementById('turmas-grid').innerHTML = filtradas.map(t => {
    const inativa = t.ativa === false;
    const al = state.ALUNOS.filter(a => a.ativo && a.turma_id === t.id);
    const at = al.filter(a => calcAluno(a).emAlerta).length;
    const ultimaAula = ultimaAulaRegistrada(t);
    const horarioTag = t.horario_inicio
      ? `<span class="horario-tag" onclick="event.stopPropagation();abrirModalEditarTurma(${t.id})" title="Clique para editar a turma"><span class="icon-mask icon-relogio"></span>${t.horario_inicio.slice(0, 5)}${t.dias_semana?.length ? ' · ' + t.dias_semana.map(d => d.charAt(0).toUpperCase() + d.slice(1, 3)).join(', ') : ''}</span>`
      : `<span class="horario-tag sem-horario" onclick="event.stopPropagation();abrirModalEditarTurma(${t.id})" title="Configurar horário para notificação automática">+ Configurar horário</span>`;
    return `<div class="turma-card ${inativa ? 'turma-card-inativa' : ''}" onclick="abrirChamada(${t.id})">
      <div class="turma-card__topo">
        <span class="turma-card__cor" style="background:${t.cor || '#3b82f6'};"></span>
        <div class="turma-card__selos">${t.curso ? `<span class="badge ${corBadge(t.curso)}">${escapeHtml(t.curso)}</span>` : '<span class="badge badge-gray">Sem curso</span>'}${inativa ? '<span class="badge badge-gray">Inativa</span>' : ''}</div>
        <div class="turma-card-actions">
          <button class="inline-edit-btn" title="Editar turma" aria-label="Editar turma" onclick="event.stopPropagation();abrirModalEditarTurma(${t.id})"><span class="icon-mask icon-editar"></span></button>
          ${podeGerenciarTurmasInativas() ? `<button class="inline-edit-btn" title="${inativa ? 'Reativar turma' : 'Inativar turma'}" aria-label="${inativa ? 'Reativar turma' : 'Inativar turma'}" onclick="event.stopPropagation();toggleTurmaAtiva(event, ${t.id})">${inativa ? '<span class="icon-mask icon-ativar"></span>' : '<span class="icon-mask icon-pausa"></span>'}</button>` : ''}
        </div>
      </div>
      <div class="turma-card__nome" title="${escapeHtml(t.turma)}">${escapeHtml(t.turma)}</div>
      <div class="turma-card__info">
        <span class="turma-card__linha">Prof. ${escapeHtml(professorNome(t))}</span>
        <span class="turma-card__linha">${al.length} alunos${at > 0 ? ` · <span class="turma-card__alerta" onclick="event.stopPropagation();irParaAlertas(${t.id})">${at} alerta${at > 1 ? 's' : ''}</span>` : ''}</span>
        <div class="turma-card__selos">${ultimaAula ? `<span class="badge badge-blue" title="Última aula com presença registrada">Última aula: ${ultimaAula}</span>` : `<span class="badge badge-gray" title="Nenhuma presença registrada ainda">Sem aulas registradas</span>`}${horarioTag}</div>
      </div>
      <button class="btn-chamada" onclick="event.stopPropagation();abrirChamada(${t.id})">Acessar turma <span class="icon-mask icon-seta-direita"></span></button>
    </div>`;
  }).join('') || '<div class="empty">Nenhuma turma encontrada.</div>';
}

export function setCurso(c) {
  state.filtroCurso = c;
  renderDash();
}

export function setGrupoTurmas(g) {
  state.filtroGrupoTurmas = g;
  renderDash();
}

// Reescreve as opções de um <select> de filtro só quando mudaram — o
// renderDash roda a cada letra digitada na busca.
function preencherFiltro(id, opcoes, valor) {
  const sel = document.getElementById(id);
  const html = opcoes.map(([v, r]) => `<option value="${escapeAttr(v)}">${escapeHtml(r)}</option>`).join('');
  if (sel.dataset.opcoes !== html) {
    sel.innerHTML = html;
    sel.dataset.opcoes = html;
  }
  sel.value = valor;
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
