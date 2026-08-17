import { state } from '../../state/store.js';
import { AULAS, calcAluno, aulasDaTurma } from '../../../backend/domain/attendance.js';
import { statusBadge, professorNome } from '../../../backend/domain/status.js';
import { escapeHtml, showToast, fecharModal } from '../../shared/dom.js';
import { confirmar } from '../../shared/confirm.js';
import { inserirAluno, atualizarAluno } from '../../../backend/api/alunosRepo.js';
import { registrarMovimentacao } from '../../../backend/api/historicoRepo.js';
import { moverPresencasDeTurma } from '../../../backend/api/presencasRepo.js';
import { carregarObservacoes } from './observacoes.js';
import { renderTabelaAlunos } from './alunosTable.js';
import { renderDash } from '../dashboard/dashboardView.js';
import { renderRel } from '../relatorios/relatoriosView.js';
import { abrirChamada, selecionarAula } from '../chamada/chamadaView.js';
import { goTab } from '../../shared/navigation.js';
import { renderConfiguracoes } from '../configuracoes/configuracoesView.js';

export function abrirModalAluno(id) {
  state.alunoSelecionadoId = id;
  const a = state.ALUNOS.find(x => x.id === id);
  const t = state.TURMAS.find(x => x.id === a.turma_id);
  const c = calcAluno(a);
  document.getElementById('ma-nome').innerHTML = a.experimental ? `<span class="nome-experimental">${escapeHtml(a.nome)}</span>` : escapeHtml(a.nome);
  document.getElementById('ma-status').innerHTML = statusBadge(c.freq, c.emAlerta, a.ativo);
  document.getElementById('ma-info').innerHTML = `
    <div class="info-item"><div class="info-label">Curso</div><div class="info-val">${escapeHtml(t?.curso) || '—'}</div></div>
    <div class="info-item"><div class="info-label">Turma</div><div class="info-val">${escapeHtml(t?.turma) || '—'}</div></div>
    <div class="info-item"><div class="info-label">Professor(a)</div><div class="info-val">${escapeHtml(professorNome(t))}</div></div>
    <div class="info-item"><div class="info-label">Frequência</div><div class="info-val">${c.freq !== null ? c.freq + '%' : '—'}</div></div>
    <div class="info-item"><div class="info-label">Presenças</div><div class="info-val" style="color:var(--green);">${c.p}</div></div>
    <div class="info-item"><div class="info-label">Faltas</div><div class="info-val" style="color:var(--red);">${c.f}</div></div>`;

  const aulasComRegistro = c.seq.map((v, i) => ({ v, i })).filter(x => x.v !== 'N');
  document.getElementById('ma-aulas').innerHTML = aulasComRegistro.length ? aulasComRegistro.map(({ v, i }) => {
    const bg = v === 'P' ? 'var(--green-soft)' : v === 'R' ? 'var(--amber-soft)' : 'var(--red-soft)';
    const tc = v === 'P' ? 'var(--green-soft-text)' : v === 'R' ? 'var(--amber-soft-text)' : 'var(--red-soft-text)';
    const label = v === 'P' ? 'Presente' : v === 'R' ? 'Gravação' : 'Falta';
    const clique = t ? ` style="background:${bg};color:${tc};cursor:pointer;" onclick="irParaAulaHistorico(${t.id},${i})" title="Aula ${i + 1}: ${label} — clique para ir até essa aula na turma"` : ` style="background:${bg};color:${tc};" title="Aula ${i + 1}: ${label}"`;
    return `<div class="aula-chip"${clique}>${i + 1}</div>`;
  }).join('') : `<div style="font-size:12px;color:var(--text-faded);">Nenhuma aula registrada ainda.</div>`;

  const hist = state.HISTORICO.filter(h => h.aluno_id === id);
  document.getElementById('ma-hist').innerHTML = hist.length ? `
    <div style="font-size:12px;color:var(--text-3);margin-bottom:.5rem;font-weight:500;">Histórico de movimentações</div>
    ${hist.map(h => `<div class="hist-item"><span style="font-size:10px;color:var(--text-faded);width:80px;flex-shrink:0;">${new Date(h.created_at).toLocaleDateString('pt-BR')}</span><span>${escapeHtml(h.descricao)}</span></div>`).join('')}` : '';

  const obsTexto = document.getElementById('obs-texto');
  if (obsTexto) obsTexto.value = '';
  carregarObservacoes(id);
  document.getElementById('modal-aluno').classList.add('open');
}

// Leva da ficha do aluno direto para a chamada da turma, já na aula clicada
// no "Histórico por aula" — evita ter que sair do modal, achar a turma na
// aba Turmas e selecionar a aula manualmente.
export function irParaAulaHistorico(turmaId, aulaIndex) {
  const t = state.TURMAS.find(x => x.id === turmaId);
  if (!t) return;
  const aula = aulasDaTurma(t)[aulaIndex];
  fecharModal('modal-aluno');
  goTab('turmas');
  abrirChamada(turmaId);
  if (aula) selecionarAula(aula);
}

// Menu "⚙ Configurações" — reúne todas as ações que alteram o aluno numa
// lista flutuante (mesmo padrão visual do menu de pontos do relatório), em
// vez de espalhar botões pelo rodapé do modal.
export function abrirMenuAluno(e) {
  e.stopPropagation();
  const existing = document.getElementById('ma-acoes-menu');
  if (existing) { existing.remove(); return; }

  const a = state.ALUNOS.find(x => x.id === state.alunoSelecionadoId);
  if (!a) return;

  const divisor = '<div style="height:1px;background:var(--border-2);margin:4px 0;"></div>';
  const menu = document.createElement('div');
  menu.id = 'ma-acoes-menu';
  menu.className = 'dot-menu';
  menu.style.minWidth = '220px';
  menu.innerHTML = `
    <div class="dot-menu-item" onclick="fecharMenuAluno();abrirModalEditar();">Editar nome</div>
    <div class="dot-menu-item" onclick="fecharMenuAluno();abrirModalTransferir();">Transferir turma</div>
    <div class="dot-menu-item" onclick="fecharMenuAluno();abrirModalReposicao();">Criar reposição</div>
    ${divisor}
    <div class="dot-menu-item" onclick="fecharMenuAluno();toggleInativo();">${a.ativo ? 'Inativar aluno' : 'Reativar aluno'}</div>
    <div class="dot-menu-item" onclick="fecharMenuAluno();toggleExperimental();">${a.experimental ? 'Tornar matriculado' : 'Marcar como experimental'}</div>
    ${divisor}
    <div class="dot-menu-item" style="color:var(--red);" onclick="fecharMenuAluno();cancelarMatricula();">Cancelar matrícula</div>
  `;
  document.body.appendChild(menu);
  const rect = e.currentTarget.getBoundingClientRect();
  const left = Math.max(8, rect.right - 220);
  menu.style.left = left + 'px';
  menu.style.top = (rect.bottom + 4) + 'px';
}

export function fecharMenuAluno() {
  document.getElementById('ma-acoes-menu')?.remove();
}

export async function toggleInativo() {
  const a = state.ALUNOS.find(x => x.id === state.alunoSelecionadoId);
  const novoStatus = !a.ativo;
  if (!novoStatus) {
    const ok = await confirmar({
      titulo: `Inativar o(a) aluno(a) "${a.nome}"?`,
      mensagem: 'Ele(a) deixará de contar nas turmas e relatórios ativos, mas o histórico é mantido.',
      textoConfirmar: 'Inativar',
    });
    if (!ok) return;
  }
  await atualizarAluno(a.id, { ativo: novoStatus });
  await registrarMovimentacao(a.id, novoStatus ? 'Aluno(a) reativado' : 'Aluno(a) inativado');
  a.ativo = novoStatus;
  fecharModal('modal-aluno');
  showToast(novoStatus ? 'Aluno(a) reativado.' : 'Aluno(a) inativado.');
  renderTabelaAlunos(); renderDash();
}

export async function toggleExperimental() {
  const a = state.ALUNOS.find(x => x.id === state.alunoSelecionadoId);
  const novoStatus = !a.experimental;
  await atualizarAluno(a.id, { experimental: novoStatus });
  await registrarMovimentacao(a.id, novoStatus ? 'Marcado(a) como aluno(a) experimental' : 'Deixou de ser aluno(a) experimental (matriculado)');
  a.experimental = novoStatus;
  fecharModal('modal-aluno');
  showToast(novoStatus ? 'Aluno(a) marcado como experimental.' : 'Aluno(a) agora está matriculado.');
  renderTabelaAlunos(); renderDash(); renderRel();
}

export async function cancelarMatricula() {
  const a = state.ALUNOS.find(x => x.id === state.alunoSelecionadoId);
  const ok = await confirmar({
    titulo: a.ativo ? `Cancelar a matrícula de "${a.nome}"?` : `Registrar cancelamento de matrícula para "${a.nome}"?`,
    mensagem: a.ativo
      ? 'O aluno(a) será marcado como inativo com status de cancelamento.'
      : 'O aluno(a) já está inativo e será marcado como cancelado.',
    textoConfirmar: 'Cancelar matrícula',
    perigo: true,
  });
  if (!ok) return;
  await atualizarAluno(a.id, { ativo: false });
  await registrarMovimentacao(a.id, 'Matrícula cancelada');
  a.ativo = false;
  fecharModal('modal-aluno');
  showToast('Matrícula cancelada.', 'red');
  renderTabelaAlunos(); renderDash();
}
 
// `id` é opcional: quando chamado a partir do menu do modal do aluno (que já
// deixou state.alunoSelecionadoId marcado), não precisa passar nada. Quando
// chamado direto de uma linha de tabela (ex.: Configurações), passa o id do
// aluno da linha clicada.
export function abrirModalEditar(id) {
  if (id != null) state.alunoSelecionadoId = id;
  const a = state.ALUNOS.find(x => x.id === state.alunoSelecionadoId);
  document.getElementById('edit-nome').value = a.nome;
  const btnSalvar = document.getElementById('edit-btn-salvar');
  btnSalvar.disabled = false;
  btnSalvar.textContent = 'Salvar';
  fecharModal('modal-aluno');
  document.getElementById('modal-editar').classList.add('open');
}

export async function salvarEdicao() {
  const novoNome = document.getElementById('edit-nome').value.trim();
  if (!novoNome) return;
  const a = state.ALUNOS.find(x => x.id === state.alunoSelecionadoId);
  const btnSalvar = document.getElementById('edit-btn-salvar');
  btnSalvar.disabled = true;
  btnSalvar.textContent = 'Salvando…';
  await atualizarAluno(a.id, { nome: novoNome });
  await registrarMovimentacao(a.id, `Nome alterado para "${novoNome}"`);
  a.nome = novoNome;
  fecharModal('modal-editar');
  showToast('Nome atualizado!');
  renderTabelaAlunos(); renderDash(); renderConfiguracoes();
}

export function abrirModalTransferir() {
  const a = state.ALUNOS.find(x => x.id === state.alunoSelecionadoId);
  const t = state.TURMAS.find(x => x.id === a.turma_id);
  document.getElementById('transf-info').innerHTML = `<strong>${escapeHtml(a.nome)}</strong><br><span style="color:var(--text-3);">Turma atual: ${escapeHtml(t?.turma)} · ${escapeHtml(t?.curso)} · Prof. ${escapeHtml(professorNome(t))}</span>`;
  const outras = state.TURMAS.filter(x => x.id !== a.turma_id);
  document.getElementById('transf-sel').innerHTML = outras.map(x => `<option value="${x.id}">${escapeHtml(x.turma)} — ${escapeHtml(x.curso) || 'sem curso'} (Prof. ${escapeHtml(professorNome(x))})</option>`).join('');
  const btnConfirmar = document.getElementById('transf-btn-confirmar');
  btnConfirmar.disabled = false;
  btnConfirmar.textContent = 'Confirmar transferência';
  fecharModal('modal-aluno');
  document.getElementById('modal-transferir').classList.add('open');
}

export async function confirmarTransferencia() {
  const a = state.ALUNOS.find(x => x.id === state.alunoSelecionadoId);
  const antigoTId = a.turma_id;
  const tAntiga = state.TURMAS.find(x => x.id === antigoTId);
  const novoTId = parseInt(document.getElementById('transf-sel').value);
  const tNova = state.TURMAS.find(x => x.id === novoTId);

  const btn = document.getElementById('transf-btn-confirmar');
  btn.disabled = true;
  btn.textContent = 'Transferindo…';

  // 1) Move o aluno para a nova turma
  const { error: errAluno } = await atualizarAluno(a.id, { turma_id: novoTId });
  if (errAluno) {
    showToast('Erro ao transferir aluno.', 'red'); console.error(errAluno);
    btn.disabled = false; btn.textContent = 'Confirmar transferência';
    return;
  }

  // 2) Move TODAS as presenças do aluno da turma antiga para a nova
  const { error: errPres } = await moverPresencasDeTurma(a.id, antigoTId, novoTId);
  if (errPres) {
    // reverte o aluno para não deixar estado inconsistente
    await atualizarAluno(a.id, { turma_id: antigoTId });
    showToast('Erro ao mover o histórico de presença. Transferência cancelada.', 'red');
    console.error(errPres);
    btn.disabled = false; btn.textContent = 'Confirmar transferência';
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
  document.getElementById('novo-turma').innerHTML = state.TURMAS.filter(t => t.ativa !== false).map(t => `<option value="${t.id}">${escapeHtml(t.turma)} — ${escapeHtml(t.curso) || 'sem curso'} (Prof. ${escapeHtml(professorNome(t))})</option>`).join('');
  document.getElementById('novo-experimental-btn').classList.remove('active');
  document.getElementById('novo-nome-aviso').style.display = 'none';
  const btnAdicionar = document.getElementById('novo-btn-adicionar');
  btnAdicionar.disabled = false;
  btnAdicionar.textContent = 'Adicionar';
  document.getElementById('modal-novo').classList.add('open');
}

// Aviso (não bloqueia) se já existir um aluno com esse nome nessa turma —
// pega o caso comum de duplicação por erro humano: reabrir o modal e
// adicionar de novo sem perceber que já tinha adicionado, ou duas pessoas
// cadastrando o mesmo aluno em abas/dispositivos diferentes ao mesmo tempo
// (esse segundo caso o sistema não tem como travar sozinho, já que cada aba
// só conhece o que carregou; o aviso é a defesa possível do lado do cliente).
export function verificarAlunoDuplicado() {
  const nome = document.getElementById('novo-nome').value.trim().toLowerCase();
  const turmaId = parseInt(document.getElementById('novo-turma').value);
  const aviso = document.getElementById('novo-nome-aviso');
  const existe = nome && turmaId && state.ALUNOS.some(a => a.turma_id === turmaId && a.nome.trim().toLowerCase() === nome);
  aviso.textContent = existe ? 'Já existe um(a) aluno(a) com esse nome nessa turma. Confira antes de adicionar de novo.' : '';
  aviso.style.display = existe ? 'block' : 'none';
}

export function toggleNovoExperimental() {
  document.getElementById('novo-experimental-btn').classList.toggle('active');
}

export async function salvarNovoAluno() {
  const nome = document.getElementById('novo-nome').value.trim();
  if (!nome) { showToast('Digite o nome do aluno.', 'red'); return; }
  const turmaId = parseInt(document.getElementById('novo-turma').value);
  const experimental = document.getElementById('novo-experimental-btn').classList.contains('active');
  const btn = document.getElementById('novo-btn-adicionar');
  btn.disabled = true;
  btn.textContent = 'Adicionando…';
  const { data, error } = await inserirAluno({ nome, turma_id: turmaId, ativo: true, experimental });
  if (error) {
    console.error('Erro ao adicionar aluno:', error);
    showToast('Erro ao adicionar aluno.', 'red');
    btn.disabled = false; btn.textContent = 'Adicionar';
    return;
  }
  await registrarMovimentacao(data.id, experimental ? 'Aluno adicionado ao sistema (experimental)' : 'Aluno adicionado ao sistema');
  state.ALUNOS.push(data);
  fecharModal('modal-novo');
  showToast(`${nome} adicionado com sucesso!`);
  renderTabelaAlunos(); renderDash();
}
