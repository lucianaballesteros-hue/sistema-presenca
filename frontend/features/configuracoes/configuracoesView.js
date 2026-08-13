// "Configurações do sistema" — área restrita a admins (botão só aparece
// pra quem tem papel='admin', ver inicializarApp em auth.js) pra excluir
// permanentemente um curso, turma ou aluno do banco de dados. Diferente do
// resto do app, que sempre prefere inativar/cancelar (soft delete) mantendo
// histórico, isto aqui é DELETE de verdade — por isso a confirmação exige
// digitar o nome exato do item antes de liberar o botão.
import { state } from '../../state/store.js';
import { escapeHtml, showToast, fecharModal } from '../../shared/dom.js';
import { professorNome } from '../../../backend/domain/status.js';
import { excluirCurso } from '../../../backend/api/cursosRepo.js';
import { excluirTurma } from '../../../backend/api/turmasRepo.js';
import { excluirAluno } from '../../../backend/api/alunosRepo.js';
import { excluirPresencasDeAluno } from '../../../backend/api/presencasRepo.js';
import { excluirHistoricoDeAluno } from '../../../backend/api/historicoRepo.js';
import { excluirReposicoesDeAluno } from '../../../backend/api/reposicoesRepo.js';
import { renderDash } from '../dashboard/dashboardView.js';
import { renderTabelaAlunos } from '../alunos/alunosTable.js';
import { renderRel, popularFiltros } from '../relatorios/relatoriosView.js';

const TIPO_LABEL = { curso: 'Curso', turma: 'Turma', aluno: 'Aluno' };

// Botão de engrenagem no header abre este menu (mesmo padrão visual do
// dot-menu de relatórios/aluno) em vez de ir direto pro modal — "Geral" é a
// zona de exclusão abaixo; "Professores" reaproveita a tela cheia que já
// existia (tab-professores/renderProfessores), só que agora só é alcançável
// por aqui, não pela nav principal.
export function abrirMenuConfig(e) {
  e.stopPropagation();
  const existing = document.getElementById('config-menu');
  if (existing) { existing.remove(); return; }

  const menu = document.createElement('div');
  menu.id = 'config-menu';
  menu.className = 'dot-menu';
  menu.innerHTML = `
    <div class="dot-menu-item" onclick="fecharMenuConfig();abrirModalConfiguracoes();">Geral</div>
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

export function abrirModalConfiguracoes() {
  document.getElementById('cfg-tipo').value = 'curso';
  atualizarTipoExclusao();
  document.getElementById('modal-configuracoes').classList.add('open');
}

export function atualizarTipoExclusao() {
  const tipo = document.getElementById('cfg-tipo').value;
  document.getElementById('cfg-item-label').textContent = TIPO_LABEL[tipo];

  const itens = itensDoTipo(tipo);
  document.getElementById('cfg-item').innerHTML = itens.length
    ? itens.map(it => `<option value="${it.id}">${escapeHtml(it.label)}</option>`).join('')
    : '<option value="">Nenhum item cadastrado</option>';

  atualizarItemExclusao();
}

// Lista "achatada" de opções pro <select>, já com o rótulo pronto — usada
// tanto pra popular o <select> quanto (de novo, é barato) pra recuperar o
// item selecionado sem precisar guardar estado extra em nenhum outro lugar.
function itensDoTipo(tipo) {
  if (tipo === 'curso') {
    return [...state.CURSOS]
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
      .map(c => ({ id: c.id, nome: c.nome, label: c.nome }));
  }
  if (tipo === 'turma') {
    return [...state.TURMAS]
      .sort((a, b) => a.turma.localeCompare(b.turma, 'pt-BR'))
      .map(t => ({
        id: t.id,
        nome: t.turma,
        label: `${t.turma} — ${t.curso} (Prof. ${professorNome(t)})${t.ativa === false ? ' [inativa]' : ''}`,
      }));
  }
  return [...state.ALUNOS]
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
    .map(a => {
      const t = state.TURMAS.find(x => x.id === a.turma_id);
      return {
        id: a.id,
        nome: a.nome,
        label: `${a.nome} — ${t ? `${t.turma} (${t.curso})` : 'sem turma'}${!a.ativo ? ' [inativo]' : ''}`,
      };
    });
}

function itemSelecionado() {
  const tipo = document.getElementById('cfg-tipo').value;
  const id = parseInt(document.getElementById('cfg-item').value);
  if (!id) return null;
  const item = itensDoTipo(tipo).find(it => it.id === id);
  return item ? { tipo, ...item } : null;
}

// Impede exclusões que deixariam o banco inconsistente: um curso ainda
// citado por turmas, ou uma turma que ainda tem alunos. Sem isso, apagar um
// curso "some" da lista só até sincronizarCursosComTurmas() recriá-lo no
// próximo login (ele lê o texto turmas.curso, que continuaria existindo).
function motivoBloqueio(item) {
  if (item.tipo === 'curso') {
    const n = state.TURMAS.filter(t => t.curso === item.nome).length;
    if (n) return `Não é possível excluir: ${n} turma(s) ainda usam este curso. Troque o curso dessas turmas primeiro.`;
  }
  if (item.tipo === 'turma') {
    const n = state.ALUNOS.filter(a => a.turma_id === item.id).length;
    if (n) return `Não é possível excluir: ${n} aluno(s) ainda estão nesta turma. Transfira ou remova esses alunos primeiro.`;
  }
  return null;
}

// Só informativo (não bloqueia) — mostra o que mais some junto quando o
// item é um aluno, já que aluno excluído leva presença/histórico/reposição
// junto (ver excluirAlunoCompleto).
function avisoInformativo(item) {
  if (item.tipo !== 'aluno') return null;
  const presencas = Object.values(state.PRESENCAS).reduce((n, doAula) => n + (doAula[item.id] !== undefined ? 1 : 0), 0);
  const historico = state.HISTORICO.filter(h => h.aluno_id === item.id).length;
  const partes = [];
  if (presencas) partes.push(`${presencas} registro(s) de presença`);
  if (historico) partes.push(`${historico} registro(s) de histórico`);
  return partes.length ? `Isso também apaga ${partes.join(' e ')} deste aluno.` : null;
}

export function atualizarItemExclusao() {
  const bloqueioEl = document.getElementById('cfg-bloqueio');
  const infoEl = document.getElementById('cfg-info');
  const campoConfirm = document.getElementById('cfg-confirm-field');
  const btn = document.getElementById('cfg-btn-excluir');

  document.getElementById('cfg-confirm-input').value = '';
  btn.disabled = true;
  bloqueioEl.style.display = 'none';
  infoEl.style.display = 'none';

  const item = itemSelecionado();
  if (!item) { campoConfirm.style.display = 'none'; return; }

  const bloqueio = motivoBloqueio(item);
  if (bloqueio) {
    bloqueioEl.textContent = bloqueio;
    bloqueioEl.style.display = 'block';
    campoConfirm.style.display = 'none';
    return;
  }

  const aviso = avisoInformativo(item);
  if (aviso) { infoEl.textContent = aviso; infoEl.style.display = 'block'; }

  document.getElementById('cfg-confirm-label').textContent = `Digite "${item.nome}" para confirmar`;
  campoConfirm.style.display = 'block';
}

export function verificarTextoExclusao() {
  const item = itemSelecionado();
  const btn = document.getElementById('cfg-btn-excluir');
  if (!item || motivoBloqueio(item)) { btn.disabled = true; return; }
  const digitado = document.getElementById('cfg-confirm-input').value.trim();
  btn.disabled = digitado !== item.nome;
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
  const item = itemSelecionado();
  if (!item || motivoBloqueio(item)) return;
  const digitado = document.getElementById('cfg-confirm-input').value.trim();
  if (digitado !== item.nome) return;

  const btn = document.getElementById('cfg-btn-excluir');
  btn.disabled = true;
  btn.textContent = 'Excluindo…';

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
  fecharModal('modal-configuracoes');
  showToast(`${TIPO_LABEL[item.tipo]} "${item.nome}" excluído(a) permanentemente.`, 'red');
  renderDash(); renderTabelaAlunos(); renderRel(); popularFiltros();
}
