import { state } from '../../state/store.js';
import { AULAS, aulasDaTurma, calcAluno } from '../../domain/attendance.js';
import { statusBadge } from '../../domain/status.js';
import { escapeHtml, showToast, fecharModal } from '../../shared/dom.js';
import { inserirAluno, atualizarAluno } from '../../api/alunosRepo.js';
import { registrarMovimentacao } from '../../api/historicoRepo.js';
import { moverPresencasDeTurma } from '../../api/presencasRepo.js';
import { carregarObservacoes } from './observacoes.js';
import { renderTabelaAlunos } from './alunosTable.js';
import { renderDash } from '../dashboard/dashboardView.js';
import { renderRel } from '../relatorios/relatoriosView.js';

export function abrirModalAluno(id) {
  state.alunoSelecionadoId = id;
  const a = state.ALUNOS.find(x => x.id === id);
  const t = state.TURMAS.find(x => x.id === a.turma_id);
  const c = calcAluno(a);
  document.getElementById('ma-nome').textContent = a.nome;
  document.getElementById('ma-status').innerHTML = statusBadge(c.freq, c.emAlerta, a.ativo);
  document.getElementById('ma-info').innerHTML = `
    <div class="info-item"><div class="info-label">Curso</div><div class="info-val">${escapeHtml(t?.curso) || '—'}</div></div>
    <div class="info-item"><div class="info-label">Turma</div><div class="info-val">${escapeHtml(t?.turma) || '—'}</div></div>
    <div class="info-item"><div class="info-label">Professor(a)</div><div class="info-val">${escapeHtml(t?.professor) || '—'}</div></div>
    <div class="info-item"><div class="info-label">Frequência</div><div class="info-val">${c.freq !== null ? c.freq + '%' : '—'}</div></div>
    <div class="info-item"><div class="info-label">Presenças</div><div class="info-val" style="color:var(--green);">${c.p}</div></div>
    <div class="info-item"><div class="info-label">Faltas</div><div class="info-val" style="color:var(--red);">${c.f}</div></div>`;

  const aulasTurma = aulasDaTurma(t);
  const aulasComRegistro = c.seq.map((v, i) => ({ v, i })).filter(x => x.v !== 'N').slice(-8);
  document.getElementById('ma-aulas').innerHTML = aulasComRegistro.map(({ v, i }) => {
    const au = aulasTurma[i];
    const bg = v === 'P' ? 'var(--green-soft)' : v === 'R' ? 'var(--amber-soft)' : v === 'F' ? 'var(--red-soft)' : 'var(--surface-3)';
    const tc = v === 'P' ? 'var(--green-soft-text)' : v === 'R' ? 'var(--amber-soft-text)' : v === 'F' ? 'var(--red-soft-text)' : 'var(--text-faded)';
    return `<div class="aula-item" style="background:${bg};"><div class="aula-item-label">${au}</div><div class="aula-item-val" style="color:${tc};">${v === 'P' ? 'Presente' : v === 'R' ? 'Gravação' : v === 'F' ? 'Falta' : '—'}</div></div>`;
  }).join('');

  const hist = state.HISTORICO.filter(h => h.aluno_id === id);
  document.getElementById('ma-hist').innerHTML = hist.length ? `
    <div style="font-size:12px;color:var(--text-3);margin-bottom:.5rem;font-weight:500;">Histórico de movimentações</div>
    ${hist.map(h => `<div class="hist-item"><span style="font-size:10px;color:var(--text-faded);width:80px;flex-shrink:0;">${new Date(h.created_at).toLocaleDateString('pt-BR')}</span><span>${escapeHtml(h.descricao)}</span></div>`).join('')}` : '';

  const btnIn = document.getElementById('ma-btn-inativar');
  const btnCancelar = document.getElementById('ma-btn-cancelar');
  btnIn.textContent = a.ativo ? 'Inativar aluno' : 'Reativar aluno';
  btnIn.className = 'btn-warning';
  btnCancelar.style.display = '';

  const obsTexto = document.getElementById('obs-texto');
  if (obsTexto) obsTexto.value = '';
  carregarObservacoes(id);
  document.getElementById('modal-aluno').classList.add('open');
}

export async function toggleInativo() {
  const a = state.ALUNOS.find(x => x.id === state.alunoSelecionadoId);
  const novoStatus = !a.ativo;
  if (!novoStatus && !confirm(`Inativar o aluno "${a.nome}"?\n\nEle deixará de contar nas turmas e relatórios ativos, mas o histórico é mantido.`)) return;
  await atualizarAluno(a.id, { ativo: novoStatus });
  await registrarMovimentacao(a.id, novoStatus ? 'Aluno reativado' : 'Aluno inativado');
  a.ativo = novoStatus;
  fecharModal('modal-aluno');
  showToast(novoStatus ? 'Aluno reativado.' : 'Aluno inativado.');
  renderTabelaAlunos(); renderDash();
}

export async function cancelarMatricula() {
  const a = state.ALUNOS.find(x => x.id === state.alunoSelecionadoId);
  const msg = a.ativo
    ? `Cancelar a matrícula de "${a.nome}"?\n\nO aluno será marcado como inativo com status de cancelamento.`
    : `Registrar cancelamento de matrícula para "${a.nome}"?\n\nO aluno já está inativo e será marcado como cancelado.`;
  if (!confirm(msg)) return;
  await atualizarAluno(a.id, { ativo: false });
  await registrarMovimentacao(a.id, 'Matrícula cancelada');
  a.ativo = false;
  fecharModal('modal-aluno');
  showToast('Matrícula cancelada.', 'red');
  renderTabelaAlunos(); renderDash();
}

export function abrirModalEditar() {
  const a = state.ALUNOS.find(x => x.id === state.alunoSelecionadoId);
  document.getElementById('edit-nome').value = a.nome;
  fecharModal('modal-aluno');
  document.getElementById('modal-editar').classList.add('open');
}

export async function salvarEdicao() {
  const novoNome = document.getElementById('edit-nome').value.trim();
  if (!novoNome) return;
  const a = state.ALUNOS.find(x => x.id === state.alunoSelecionadoId);
  await atualizarAluno(a.id, { nome: novoNome });
  await registrarMovimentacao(a.id, `Nome alterado para "${novoNome}"`);
  a.nome = novoNome;
  fecharModal('modal-editar');
  showToast('Nome atualizado!');
  renderTabelaAlunos(); renderDash();
}

export function abrirModalTransferir() {
  const a = state.ALUNOS.find(x => x.id === state.alunoSelecionadoId);
  const t = state.TURMAS.find(x => x.id === a.turma_id);
  document.getElementById('transf-info').innerHTML = `<strong>${escapeHtml(a.nome)}</strong><br><span style="color:var(--text-3);">Turma atual: ${escapeHtml(t?.turma)} · ${escapeHtml(t?.curso)} · Prof. ${escapeHtml(t?.professor)}</span>`;
  const outras = state.TURMAS.filter(x => x.id !== a.turma_id);
  document.getElementById('transf-sel').innerHTML = outras.map(x => `<option value="${x.id}">${escapeHtml(x.turma)} — ${escapeHtml(x.curso)} (Prof. ${escapeHtml(x.professor)})</option>`).join('');
  fecharModal('modal-aluno');
  document.getElementById('modal-transferir').classList.add('open');
}

export async function confirmarTransferencia() {
  const a = state.ALUNOS.find(x => x.id === state.alunoSelecionadoId);
  const antigoTId = a.turma_id;
  const tAntiga = state.TURMAS.find(x => x.id === antigoTId);
  const novoTId = parseInt(document.getElementById('transf-sel').value);
  const tNova = state.TURMAS.find(x => x.id === novoTId);

  // 1) Move o aluno para a nova turma
  const { error: errAluno } = await atualizarAluno(a.id, { turma_id: novoTId });
  if (errAluno) { showToast('Erro ao transferir aluno.', 'red'); console.error(errAluno); return; }

  // 2) Move TODAS as presenças do aluno da turma antiga para a nova
  const { error: errPres } = await moverPresencasDeTurma(a.id, antigoTId, novoTId);
  if (errPres) {
    // reverte o aluno para não deixar estado inconsistente
    await atualizarAluno(a.id, { turma_id: antigoTId });
    showToast('Erro ao mover o histórico de presença. Transferência cancelada.', 'red');
    console.error(errPres);
    return;
  }

  // 3) Registra a movimentação
  await registrarMovimentacao(a.id, `Transferido de "${tAntiga?.turma} (${tAntiga?.curso})" para "${tNova?.turma} (${tNova?.curso})" (histórico de presença mantido)`);

  // 4) Atualiza o cache local (PRESENCAS) sem recarregar a página
  AULAS.forEach(aula => {
    const keyAntiga = `${antigoTId}_${aula}`;
    const keyNova = `${novoTId}_${aula}`;
    if (state.PRESENCAS[keyAntiga] && state.PRESENCAS[keyAntiga][a.id] !== undefined) {
      if (!state.PRESENCAS[keyNova]) state.PRESENCAS[keyNova] = {};
      state.PRESENCAS[keyNova][a.id] = state.PRESENCAS[keyAntiga][a.id];
      delete state.PRESENCAS[keyAntiga][a.id];
    }
  });

  a.turma_id = novoTId;
  fecharModal('modal-transferir');
  showToast(`${a.nome} transferido para ${tNova?.turma}!`, 'blue');
  renderTabelaAlunos(); renderDash(); renderRel();
}

export function abrirModalNovoAluno() {
  document.getElementById('novo-nome').value = '';
  document.getElementById('novo-turma').innerHTML = state.TURMAS.map(t => `<option value="${t.id}">${escapeHtml(t.turma)} — ${escapeHtml(t.curso)} (Prof. ${escapeHtml(t.professor)})</option>`).join('');
  document.getElementById('modal-novo').classList.add('open');
}

export async function salvarNovoAluno() {
  const nome = document.getElementById('novo-nome').value.trim();
  if (!nome) { showToast('Digite o nome do aluno.', 'red'); return; }
  const turmaId = parseInt(document.getElementById('novo-turma').value);
  const { data, error } = await inserirAluno({ nome, turma_id: turmaId, ativo: true });
  if (error) { showToast('Erro ao adicionar aluno.', 'red'); return; }
  await registrarMovimentacao(data.id, 'Aluno adicionado ao sistema');
  state.ALUNOS.push(data);
  fecharModal('modal-novo');
  showToast(`${nome} adicionado com sucesso!`);
  renderTabelaAlunos(); renderDash();
}
