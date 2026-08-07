// Ponto de entrada da aplicação. Inicializa os módulos e expõe a "API
// pública" que o HTML chama via atributos onclick/onchange/oninput inline —
// o projeto não usa um framework de front-end nem passo de build, então os
// elementos gerados por template string (cards, linhas de tabela, botões de
// presença, etc.) continuam disparando funções pelo nome global, exatamente
// como antes. A diferença é que agora essa lista de nomes é o único lugar
// onde "global" é declarado — o resto do código é só import/export normal.
// Os estilos (styles/*.css) são carregados via <link> no index.html, e não
// por import aqui: módulos ES nativos no navegador não importam CSS.
import { state } from './state/store.js';
import { toggleSenha, fecharModal, wireModalBackdrops } from './shared/dom.js';
import { responderConfirm } from './shared/confirm.js';
import { goTab } from './shared/navigation.js';
import { startUpdateNotifier } from './shared/updateNotifier.js';

import { toggleTema } from './features/theme/theme.js';
import { doLogin, doLogout, restoreSession, wireAutoLogin } from './features/auth/auth.js';
import { abrirRecuperarSenha, voltarParaLogin, enviarLinkRecuperacao, salvarNovaSenhaRecuperacao } from './features/auth/recovery.js';

import { renderDash, setCurso, irParaAlertas, mostrarMaisTurmas } from './features/dashboard/dashboardView.js';
import {
  abrirModalNovaTurma, selecionarCorNovaTurma, salvarNovaTurma,
  abrirModalEditarTurma, selecionarCorEditarTurma, salvarEditarTurma,
  toggleTurmaAtiva, marcarPresetAtivo, aplicarPreset, limparHorario,
} from './features/dashboard/turmaModals.js';

import { abrirChamada, voltarDash, renderChamada, marcar } from './features/chamada/chamadaView.js';

import { renderTabelaAlunos, atualizarTurmasAlunos, mostrarMaisAlunos } from './features/alunos/alunosTable.js';
import {
  abrirModalAluno, abrirMenuAluno, fecharMenuAluno, toggleInativo, toggleExperimental, cancelarMatricula,
  abrirModalEditar, salvarEdicao, abrirModalTransferir, confirmarTransferencia,
  abrirModalNovoAluno, toggleNovoExperimental, salvarNovoAluno,
} from './features/alunos/alunoModal.js';
import { iniciarObservacao, cancelarObservacao, confirmarObservacao, selecionarCategoriaObs } from './features/alunos/observacoes.js';

import { renderProfessores } from './features/professores/professoresView.js';
import {
  abrirModalNovoProf, salvarNovoProf, abrirModalEditarProf, salvarEdicaoProf, enviarResetSenha,
} from './features/professores/professorModal.js';

import {
  renderRel, onMultiCheck, toggleMultiDropdown, abrirDotMenu, selecionarStatusDot,
} from './features/relatorios/relatoriosView.js';
import { exportarExcel } from './features/relatorios/exportExcel.js';

import { renderMetricas } from './features/metricas/metricasView.js';

import {
  abrirModalReposicao, atualizarOpcaoReposicao, adicionarOpcaoReposicao,
  removerOpcaoReposicao, salvarReposicao, copiarLinkReposicao, abrirPaginaReposicaoGerada,
  renderSugestoesReposicao, usarSugestaoReposicao,
} from './features/reposicoes/reposicaoModal.js';
import {
  renderReposicoes, aplicarFiltroReposicoes, copiarLinkReposicaoLista,
  cancelarReposicaoAcao, concluirReposicaoAcao,
} from './features/reposicoes/reposicoesView.js';

// "API pública": tudo que o HTML (estático ou gerado via innerHTML) invoca
// por nome precisa existir em `window`. Ver comentário no topo do arquivo.
Object.assign(window, {
  toggleTema,
  doLogin, doLogout, abrirRecuperarSenha, voltarParaLogin, enviarLinkRecuperacao, salvarNovaSenhaRecuperacao,
  goTab,
  renderDash, setCurso, irParaAlertas, mostrarMaisTurmas,
  abrirModalNovaTurma, selecionarCorNovaTurma, salvarNovaTurma,
  abrirModalEditarTurma, selecionarCorEditarTurma, salvarEditarTurma,
  toggleTurmaAtiva, marcarPresetAtivo, aplicarPreset, limparHorario,
  abrirChamada, voltarDash, renderChamada, marcar,
  renderTabelaAlunos, atualizarTurmasAlunos, mostrarMaisAlunos,
  abrirModalAluno, abrirMenuAluno, fecharMenuAluno, toggleInativo, toggleExperimental, cancelarMatricula,
  abrirModalEditar, salvarEdicao, abrirModalTransferir, confirmarTransferencia,
  abrirModalNovoAluno, toggleNovoExperimental, salvarNovoAluno,
  iniciarObservacao, cancelarObservacao, confirmarObservacao, selecionarCategoriaObs,
  renderProfessores,
  abrirModalNovoProf, salvarNovoProf, abrirModalEditarProf, salvarEdicaoProf, enviarResetSenha,
  renderRel, onMultiCheck, toggleMultiDropdown, abrirDotMenu, selecionarStatusDot,
  exportarExcel,
  renderMetricas,
  abrirModalReposicao, atualizarOpcaoReposicao, adicionarOpcaoReposicao,
  removerOpcaoReposicao, salvarReposicao, copiarLinkReposicao, abrirPaginaReposicaoGerada,
  renderSugestoesReposicao, usarSugestaoReposicao,
  renderReposicoes, aplicarFiltroReposicoes, copiarLinkReposicaoLista,
  cancelarReposicaoAcao, concluirReposicaoAcao,
  toggleSenha, fecharModal,
  responderConfirm,
});

// Fecha modal ao clicar fora do card.
wireModalBackdrops();

// Fecha o menu de pontos, o menu de ações do aluno e os painéis de
// multi-select ao clicar fora deles.
document.addEventListener('click', (e) => {
  if (!e.target.closest('#dot-menu')) {
    const menu = document.getElementById('dot-menu');
    if (menu) { menu.remove(); state.dotMenuContext = null; }
  }
  if (!e.target.closest('#ma-acoes-menu')) fecharMenuAluno();
  document.querySelectorAll('.multi-select-panel.open').forEach(p => p.classList.remove('open'));
});

// Retoma sessão existente (se houver) e liga o aviso de nova versão publicada.
restoreSession();
startUpdateNotifier();
wireAutoLogin();
