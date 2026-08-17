// "Configurações do sistema" — aba restrita a admins (só alcançável pelo
// menu de engrenagem, ver inicializarApp em auth.js) pra excluir
// permanentemente um curso, turma ou aluno do banco de dados. Diferente do
// resto do app, que sempre prefere inativar/cancelar (soft delete) mantendo
// histórico, isto aqui é DELETE de verdade — por isso a confirmação final
// exige digitar o nome exato do item antes de liberar o botão.
import { state } from '../../state/store.js';
import { escapeHtml, showToast, fecharModal } from '../../shared/dom.js';
import { professorNome, corBadge } from '../../../backend/domain/status.js';
import { excluirCurso, desvincularTurmasDoCurso, atualizarCurso, renomearTurmasDoCurso } from '../../../backend/api/cursosRepo.js';
import { excluirTurma, desvincularAlunosDaTurma } from '../../../backend/api/turmasRepo.js';
import { excluirAluno } from '../../../backend/api/alunosRepo.js';
import { excluirPresencasDeAluno } from '../../../backend/api/presencasRepo.js';
import { excluirHistoricoDeAluno } from '../../../backend/api/historicoRepo.js';
import { excluirReposicoesDeAluno } from '../../../backend/api/reposicoesRepo.js';
import { renderDash } from '../dashboard/dashboardView.js';
import { renderTabelaAlunos } from '../alunos/alunosTable.js';
import { renderRel, popularFiltros } from '../relatorios/relatoriosView.js';

const TIPO_LABEL = { curso: 'Curso', turma: 'Turma', aluno: 'Aluno' };

// Ativo/Ativa primeiro, "Todos" logo abaixo, resto por último — mesma ordem
// usada no filtro de status da aba Alunos.
const STATUS_OPCOES = {
  turma: [['ativa', 'Ativas'], ['', 'Todos'], ['inativa', 'Inativas']],
  aluno: [['ativo', 'Ativos'], ['', 'Todos'], ['inativo', 'Inativos'], ['experimental', 'Experimental']],
};

let tipoAtual = 'curso';
let itemPendente = null; // item selecionado para exclusão (aberto no modal de confirmação final)
let cursoEmEdicaoId = null;

// Botão de engrenagem no header abre este menu (mesmo padrão visual do
// dot-menu de relatórios/aluno) — "Geral" leva pra aba de exclusão abaixo;
// "Professores" reaproveita a tela cheia que já existia (tab-professores/
// renderProfessores), só que agora só é alcançável por aqui, não pela nav
// principal.
export function abrirMenuConfig(e) {
  e.stopPropagation();
  const existing = document.getElementById('config-menu');
  if (existing) { existing.remove(); return; }

  const menu = document.createElement('div');
  menu.id = 'config-menu';
  menu.className = 'dot-menu';
  menu.innerHTML = `
    <div class="dot-menu-item" onclick="fecharMenuConfig();goTab('configuracoes');">Geral</div>
    <div class="dot-menu-item" onclick="fecharMenuConfig();goTab('professores');">Professores</div>
  `;
  document.body.appendChild(menu);
  const rect = e.currentTarget.getBoundingClientRect();
  const left = Math.max(8, rect.right - 150);
  menu.style.left = left + 'px';
  menu.style.top = (rect.bottom + 6) + 'px';
}

export function fecharMenuConfig() {
  document.getElementById('config-menu')?.remove();
}

export function renderConfiguracoes() {
  document.getElementById('cfg-stats').innerHTML = `
    <div class="stat-card"><div class="stat-label">Cursos</div><div class="stat-val">${state.CURSOS.length}</div></div>
    <div class="stat-card"><div class="stat-label">Turmas</div><div class="stat-val">${state.TURMAS.length}</div></div>
    <div class="stat-card"><div class="stat-label">Alunos</div><div class="stat-val">${state.ALUNOS.length}</div></div>`;

  const cursos = [...new Set(state.TURMAS.map(t => t.curso).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  document.getElementById('cfg-f-curso').innerHTML = '<option value="">Todos os cursos</option>' + cursos.map(c => `<option>${escapeHtml(c)}</option>`).join('');

  renderListaExclusao();
}

export function selecionarTipoExclusao(tipo) {
  tipoAtual = tipo;
  document.querySelectorAll('#cfg-tipo-tabs .preset-btn').forEach(b => b.classList.toggle('ativo', b.dataset.tipo === tipo));
  document.getElementById('cfg-busca').value = '';
  document.getElementById('cfg-f-curso').value = '';

  document.getElementById('cfg-f-curso-wrap').style.display = tipo === 'curso' ? 'none' : 'flex';
  const statusWrap = document.getElementById('cfg-f-status-wrap');
  if (tipo === 'curso') {
    statusWrap.style.display = 'none';
  } else {
    statusWrap.style.display = 'flex';
    const sel = document.getElementById('cfg-f-status');
    sel.innerHTML = STATUS_OPCOES[tipo].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    sel.value = STATUS_OPCOES[tipo][0][0];
  }

  renderListaExclusao();
}

function theadPorTipo(tipo) {
  if (tipo === 'curso') return '<tr><th>Curso</th><th style="width:160px;">Turmas usando</th><th style="width:190px;"></th></tr>';
  if (tipo === 'turma') return '<tr><th>Turma</th><th style="width:150px;">Curso</th><th style="width:160px;">Professor(a)</th><th style="width:80px;text-align:center;">Alunos</th><th style="width:90px;">Status</th><th style="width:190px;"></th></tr>';
  return '<tr><th>Aluno</th><th style="width:150px;">Curso</th><th style="width:160px;">Turma</th><th style="width:100px;">Status</th><th style="width:190px;"></th></tr>';
}

function botaoExcluir(tipo, id) {
  return `<button class="btn-danger" onclick="pedirExclusao('${tipo}',${id})">Excluir</button>`;
}

// Par "Editar" + "Excluir" usado nas 3 tabelas (curso/turma/aluno) — o editar
// sempre abre o mesmo modal já usado no resto do sistema (dashboard pra
// turma, aba Alunos pro aluno), então essa tela não duplica lógica de
// edição, só dá mais um ponto de entrada pra ela.
function acoesLinha(tipo, id, fnEditar) {
  return `<div style="display:flex;gap:6px;justify-content:flex-end;"><button class="btn-edit-prof" onclick="${fnEditar}(${id})" aria-label="Editar ${TIPO_LABEL[tipo].toLowerCase()}"><span class="icon-mask icon-editar"></span> Editar</button>${botaoExcluir(tipo, id)}</div>`;
}

function crachaCurso(curso) {
  return curso ? `<span class="badge ${corBadge(curso)}">${escapeHtml(curso)}</span>` : '<span class="badge badge-gray">Sem curso</span>';
}

function linhaCurso(c) {
  const nTurmas = state.TURMAS.filter(t => t.curso === c.nome).length;
  return `<tr>
    <td>${escapeHtml(c.nome)}</td>
    <td>${nTurmas ? `<span class="badge badge-gray">${nTurmas} turma${nTurmas > 1 ? 's' : ''}</span>` : '<span class="badge badge-green">Nenhuma</span>'}</td>
    <td style="text-align:right;">${acoesLinha('curso', c.id, 'abrirModalEditarCurso')}</td>
  </tr>`;
}

// Abre o modal de renomear curso já avisando, de cara, quantas turmas vão
// ser atualizadas junto — pra quem está editando entender o impacto antes
// mesmo de mexer no nome (ver salvarEdicaoCurso pra como isso é aplicado).
export function abrirModalEditarCurso(id) {
  const c = state.CURSOS.find(x => x.id === id);
  if (!c) return;
  cursoEmEdicaoId = id;
  const nTurmas = state.TURMAS.filter(t => t.curso === c.nome).length;
  document.getElementById('ec-aviso').textContent = nTurmas
    ? `Alterar o nome atualiza automaticamente ${nTurmas === 1 ? 'a turma que usa' : `as ${nTurmas} turmas que usam`} este curso — em todas as telas do sistema.`
    : 'Nenhuma turma usa este curso no momento.';
  document.getElementById('ec-nome').value = c.nome;
  document.getElementById('ec-erro').style.display = 'none';
  const btn = document.getElementById('ec-btn-salvar');
  btn.disabled = false;
  btn.textContent = 'Salvar alterações';
  document.getElementById('modal-editar-curso').classList.add('open');
}

export function verificarNomeCursoEdicao() {
  const erroEl = document.getElementById('ec-erro');
  const btn = document.getElementById('ec-btn-salvar');
  const nome = document.getElementById('ec-nome').value.trim();

  if (!nome) { erroEl.style.display = 'none'; btn.disabled = true; return; }
  const colide = state.CURSOS.some(c => c.id !== cursoEmEdicaoId && c.nome.toLowerCase() === nome.toLowerCase());
  if (colide) {
    erroEl.textContent = 'Já existe um curso com esse nome.';
    erroEl.style.display = 'block';
    btn.disabled = true;
    return;
  }
  erroEl.style.display = 'none';
  btn.disabled = false;
}

export async function salvarEdicaoCurso() {
  const curso = state.CURSOS.find(c => c.id === cursoEmEdicaoId);
  if (!curso) return;
  const nomeNovo = document.getElementById('ec-nome').value.trim();
  const erroEl = document.getElementById('ec-erro');
  if (!nomeNovo) return;
  const colide = state.CURSOS.some(c => c.id !== cursoEmEdicaoId && c.nome.toLowerCase() === nomeNovo.toLowerCase());
  if (colide) {
    erroEl.textContent = 'Já existe um curso com esse nome.';
    erroEl.style.display = 'block';
    return;
  }

  const nomeAntigo = curso.nome;
  if (nomeNovo === nomeAntigo) { fecharModal('modal-editar-curso'); return; }

  const btn = document.getElementById('ec-btn-salvar');
  btn.disabled = true;
  btn.textContent = 'Salvando…';

  // Renomeia as turmas ANTES do curso em si — turmas.curso é texto solto
  // (não uma FK pro curso, ver comentário em renomearTurmasDoCurso), então
  // se isso desse errado DEPOIS do curso já renomeado, o app ficaria com um
  // curso "novo" e turmas ainda citando o nome antigo — exatamente a
  // dessincronização que essa função existe pra evitar.
  const turmasAfetadas = state.TURMAS.filter(t => t.curso === nomeAntigo);
  if (turmasAfetadas.length) {
    const { error: errTurmas } = await renomearTurmasDoCurso(nomeAntigo, nomeNovo);
    if (errTurmas) {
      showToast('Erro ao atualizar as turmas deste curso: ' + (errTurmas.message || 'tente novamente.'), 'red');
      console.error(errTurmas);
      btn.disabled = false; btn.textContent = 'Salvar alterações';
      return;
    }
  }

  const { error } = await atualizarCurso(curso.id, nomeNovo);
  if (error) {
    showToast('Erro ao salvar: ' + (error.message || 'tente novamente.'), 'red');
    console.error(error);
    // Reverte o rename das turmas pra não deixar o app inconsistente (mesmo
    // princípio de rollback usado em confirmarTransferencia, no modal de
    // transferir aluno de turma).
    if (turmasAfetadas.length) await renomearTurmasDoCurso(nomeNovo, nomeAntigo);
    btn.disabled = false; btn.textContent = 'Salvar alterações';
    return;
  }

  curso.nome = nomeNovo;
  turmasAfetadas.forEach(t => { t.curso = nomeNovo; });
  if (state.filtroCurso === nomeAntigo) state.filtroCurso = nomeNovo;

  btn.textContent = 'Salvar alterações';
  fecharModal('modal-editar-curso');
  showToast(`Curso renomeado para "${nomeNovo}"${turmasAfetadas.length ? ` — ${turmasAfetadas.length} turma(s) atualizada(s)` : ''}.`);
  renderDash(); renderTabelaAlunos(); renderRel(); popularFiltros();
  renderConfiguracoes();
}

function linhaTurma(t) {
  const nAlunos = state.ALUNOS.filter(a => a.turma_id === t.id).length;
  const statusBadge = t.ativa === false ? '<span class="badge badge-gray">Inativa</span>' : '<span class="badge badge-green">Ativa</span>';
  return `<tr>
    <td>${escapeHtml(t.turma)}</td>
    <td>${crachaCurso(t.curso)}</td>
    <td style="color:var(--text-3);">Prof. ${escapeHtml(professorNome(t))}</td>
    <td style="text-align:center;">${nAlunos}</td>
    <td>${statusBadge}</td>
    <td style="text-align:right;">${acoesLinha('turma', t.id, 'abrirModalEditarTurma')}</td>
  </tr>`;
}

function linhaAluno(a) {
  const t = state.TURMAS.find(x => x.id === a.turma_id);
  const statusBadge = !a.ativo ? '<span class="badge badge-gray">Inativo</span>' : a.experimental ? '<span class="badge badge-yellow">Experimental</span>' : '<span class="badge badge-green">Ativo</span>';
  return `<tr>
    <td>${escapeHtml(a.nome)}</td>
    <td>${t ? crachaCurso(t.curso) : '<span class="badge badge-gray">Sem curso</span>'}</td>
    <td style="color:var(--text-3);">${t ? escapeHtml(t.turma) : 'Sem turma'}</td>
    <td>${statusBadge}</td>
    <td style="text-align:right;">${acoesLinha('aluno', a.id, 'abrirModalEditar')}</td>
  </tr>`;
}

export function renderListaExclusao() {
  const busca = (document.getElementById('cfg-busca')?.value || '').toLowerCase();
  const fCurso = document.getElementById('cfg-f-curso')?.value || '';
  const fStatus = tipoAtual !== 'curso' ? (document.getElementById('cfg-f-status')?.value || '') : '';

  document.getElementById('cfg-thead').innerHTML = theadPorTipo(tipoAtual);

  let corpo, total;
  if (tipoAtual === 'curso') {
    let lista = [...state.CURSOS].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    if (busca) lista = lista.filter(c => c.nome.toLowerCase().includes(busca));
    total = lista.length;
    corpo = lista.map(linhaCurso).join('') || '<tr><td colspan="3" class="empty">Nenhum curso encontrado.</td></tr>';
  } else if (tipoAtual === 'turma') {
    let lista = [...state.TURMAS].sort((a, b) => a.turma.localeCompare(b.turma, 'pt-BR'));
    if (busca) lista = lista.filter(t => t.turma.toLowerCase().includes(busca));
    if (fCurso) lista = lista.filter(t => t.curso === fCurso);
    if (fStatus === 'ativa') lista = lista.filter(t => t.ativa !== false);
    else if (fStatus === 'inativa') lista = lista.filter(t => t.ativa === false);
    total = lista.length;
    corpo = lista.map(linhaTurma).join('') || '<tr><td colspan="6" class="empty">Nenhuma turma encontrada.</td></tr>';
  } else {
    let lista = [...state.ALUNOS].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    if (busca) lista = lista.filter(a => a.nome.toLowerCase().includes(busca));
    if (fCurso) lista = lista.filter(a => state.TURMAS.find(t => t.id === a.turma_id)?.curso === fCurso);
    if (fStatus === 'ativo') lista = lista.filter(a => a.ativo);
    else if (fStatus === 'inativo') lista = lista.filter(a => !a.ativo);
    else if (fStatus === 'experimental') lista = lista.filter(a => a.experimental);
    total = lista.length;
    corpo = lista.map(linhaAluno).join('') || '<tr><td colspan="5" class="empty">Nenhum aluno encontrado.</td></tr>';
  }

  document.getElementById('cfg-tbody').innerHTML = corpo;
  const label = TIPO_LABEL[tipoAtual].toLowerCase();
  document.getElementById('cfg-count').textContent = `${total} ${label}${total !== 1 ? 's' : ''} encontrado${total !== 1 ? 's' : ''}`;
}

function buscarItem(tipo, id) {
  if (tipo === 'curso') { const c = state.CURSOS.find(x => x.id === id); return c ? { tipo, id, nome: c.nome } : null; }
  if (tipo === 'turma') { const t = state.TURMAS.find(x => x.id === id); return t ? { tipo, id, nome: t.turma } : null; }
  const a = state.ALUNOS.find(x => x.id === id);
  return a ? { tipo, id, nome: a.nome } : null;
}

// Só informativo (não bloqueia mais nenhuma exclusão — ver comentário em
// confirmarExclusaoConfig sobre por que curso/turma agora desvinculam em vez
// de travar). Mostra o que mais é afetado por cada tipo de exclusão:
// - curso: quantas turmas usam esse nome e vão ficar sem curso definido.
// - turma: quantos alunos estão nela e vão ficar sem turma.
// - aluno: quanto de presença/histórico é apagado junto (ver excluirAlunoCompleto).
function avisoInformativo(item) {
  if (item.tipo === 'curso') {
    const n = state.TURMAS.filter(t => t.curso === item.nome).length;
    return n ? `${n} turma(s) usam este curso e vão ficar sem curso definido — pode ser trocado depois em "Editar turma".` : null;
  }
  if (item.tipo === 'turma') {
    const n = state.ALUNOS.filter(a => a.turma_id === item.id).length;
    return n ? `${n} aluno(s) estão nesta turma e vão ficar sem turma — cada um pode ser transferido depois pelo menu do aluno.` : null;
  }
  const presencas = Object.values(state.PRESENCAS).reduce((n, doAula) => n + (doAula[item.id] !== undefined ? 1 : 0), 0);
  const historico = state.HISTORICO.filter(h => h.aluno_id === item.id).length;
  const partes = [];
  if (presencas) partes.push(`${presencas} registro(s) de presença`);
  if (historico) partes.push(`${historico} registro(s) de histórico`);
  return partes.length ? `Isso também apaga ${partes.join(' e ')} deste aluno.` : null;
}

export function pedirExclusao(tipo, id) {
  const item = buscarItem(tipo, id);
  if (!item) return;
  itemPendente = item;

  document.getElementById('cfg-excluir-titulo').textContent = `Excluir ${TIPO_LABEL[tipo].toLowerCase()} "${item.nome}"?`;
  const infoEl = document.getElementById('cfg-excluir-info');
  const aviso = avisoInformativo(item);
  infoEl.textContent = aviso || '';
  infoEl.style.display = aviso ? 'block' : 'none';
  document.getElementById('cfg-excluir-confirm-label').textContent = `Digite "${item.nome}" para confirmar`;
  document.getElementById('cfg-excluir-confirm-input').value = '';
  const btn = document.getElementById('cfg-excluir-btn');
  btn.disabled = true;
  btn.textContent = 'Excluir permanentemente';
  document.getElementById('modal-excluir-item').classList.add('open');
}

export function verificarTextoExclusaoItem() {
  const btn = document.getElementById('cfg-excluir-btn');
  if (!itemPendente) { btn.disabled = true; return; }
  const digitado = document.getElementById('cfg-excluir-confirm-input').value.trim();
  btn.disabled = digitado !== itemPendente.nome;
}

// Aluno não tem "delete" simples: presença/histórico/reposição (+ suas
// opções) são registros à parte que só existem em função dele, então saem
// junto — nessa ordem, pra nunca tentar apagar o aluno antes de limpar o
// que ainda aponta pra ele.
async function excluirAlunoCompleto(alunoId) {
  const { error: errRep } = await excluirReposicoesDeAluno(alunoId);
  if (errRep) return errRep;
  const { error: errPres } = await excluirPresencasDeAluno(alunoId);
  if (errPres) return errPres;
  const { error: errHist } = await excluirHistoricoDeAluno(alunoId);
  if (errHist) return errHist;
  const { error: errAluno } = await excluirAluno(alunoId);
  if (errAluno) return errAluno;
  return null;
}

export async function confirmarExclusaoConfig() {
  const item = itemPendente;
  if (!item) return;
  const digitado = document.getElementById('cfg-excluir-confirm-input').value.trim();
  if (digitado !== item.nome) return;

  const btn = document.getElementById('cfg-excluir-btn');
  btn.disabled = true;
  btn.textContent = 'Excluindo…';

  // Excluir um curso ou uma turma nunca leva o que está "dentro" dele junto
  // — diferente do aluno (que é sempre o "fim da linha" dos dados dele).
  // Por isso, antes do DELETE em si, desvincula quem ainda aponta pro item:
  // turmas ficam sem curso, alunos ficam sem turma. Nessa ordem (desvincular
  // primeiro) porque, se turmas/alunos tiverem uma FK apontando pro registro
  // sendo apagado, o banco rejeitaria o DELETE enquanto a referência existir.
  if (item.tipo === 'curso') {
    const { error: errDesv } = await desvincularTurmasDoCurso(item.nome);
    if (errDesv) {
      showToast('Erro ao desvincular as turmas deste curso: ' + (errDesv.message || 'tente novamente.'), 'red');
      console.error(errDesv);
      btn.disabled = false; btn.textContent = 'Excluir permanentemente';
      return;
    }
    state.TURMAS.filter(t => t.curso === item.nome).forEach(t => { t.curso = null; });
  } else if (item.tipo === 'turma') {
    const { error: errDesv } = await desvincularAlunosDaTurma(item.id);
    if (errDesv) {
      showToast('Erro ao desvincular os alunos desta turma: ' + (errDesv.message || 'tente novamente.'), 'red');
      console.error(errDesv);
      btn.disabled = false; btn.textContent = 'Excluir permanentemente';
      return;
    }
    state.ALUNOS.filter(a => a.turma_id === item.id).forEach(a => { a.turma_id = null; });
  }

  const error = item.tipo === 'curso' ? (await excluirCurso(item.id)).error
    : item.tipo === 'turma' ? (await excluirTurma(item.id)).error
    : await excluirAlunoCompleto(item.id);

  if (error) {
    showToast('Erro ao excluir: ' + (error.message || 'tente novamente.'), 'red');
    console.error(error);
    btn.disabled = false;
    btn.textContent = 'Excluir permanentemente';
    return;
  }

  if (item.tipo === 'curso') {
    state.CURSOS = state.CURSOS.filter(c => c.id !== item.id);
  } else if (item.tipo === 'turma') {
    state.TURMAS = state.TURMAS.filter(t => t.id !== item.id);
  } else {
    state.ALUNOS = state.ALUNOS.filter(a => a.id !== item.id);
    state.HISTORICO = state.HISTORICO.filter(h => h.aluno_id !== item.id);
    Object.values(state.PRESENCAS).forEach(doAula => { delete doAula[item.id]; });
  }

  btn.textContent = 'Excluir permanentemente';
  fecharModal('modal-excluir-item');
  itemPendente = null;
  showToast(`${TIPO_LABEL[item.tipo]} "${item.nome}" excluído(a) permanentemente.`, 'red');
  renderDash(); renderTabelaAlunos(); renderRel(); popularFiltros();
  renderConfiguracoes();
}
