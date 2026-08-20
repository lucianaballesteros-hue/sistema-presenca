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
import { enhanceSelect } from './shared/customSelect.js';
import { onLineChartMove, onLineChartLeave, onBarHover, onDonutHover, hideChartTooltip } from './shared/charts.js';

import { toggleTema } from './features/theme/theme.js';
import { doLogin, doLogout, restoreSession, wireAutoLogin } from './features/auth/auth.js';
import { abrirRecuperarSenha, voltarParaLogin, enviarLinkRecuperacao, salvarNovaSenhaRecuperacao } from './features/auth/recovery.js';

import { renderDash, setCurso, irParaAlertas } from './features/dashboard/dashboardView.js';
import {
  abrirModalNovaTurma, selecionarCorNovaTurma, salvarNovaTurma,
  abrirModalEditarTurma, selecionarCorEditarTurma, salvarEditarTurma,
  toggleTurmaAtiva, marcarPresetAtivo, aplicarPreset, limparHorario,
  verificarTurmaDuplicada,
} from './features/dashboard/turmaModals.js';
import { abrirModalNovoCurso, salvarNovoCurso } from './features/dashboard/cursoModals.js';

import { abrirChamada, voltarDash, renderChamada, selecionarAula, marcar } from './features/chamada/chamadaView.js';

import { renderTabelaAlunos, atualizarTurmasAlunos } from './features/alunos/alunosTable.js';
import {
  abrirModalAluno, abrirMenuAluno, fecharMenuAluno, toggleInativo, toggleExperimental, cancelarMatricula,
  abrirModalEditar, salvarEdicao, abrirModalTransferir, confirmarTransferencia,
  abrirModalNovoAluno, toggleNovoExperimental, salvarNovoAluno, irParaAulaHistorico,
  verificarAlunoDuplicado,
  toggleNovoTurmaPainel, fecharNovoTurmaPainel, filtrarNovoTurmaBusca, filtrarNovoTurmaCurso, selecionarNovaTurmaOpcao,
} from './features/alunos/alunoModal.js';
import { iniciarObservacao, cancelarObservacao, confirmarObservacao, selecionarCategoriaObs } from './features/alunos/observacoes.js';
import {
  importarPlanilhaSelecionada, atualizarLinhaImportacao, atualizarFiltroCursoImportacao,
  cancelarImportacaoPlanilha, confirmarImportacaoPlanilha,
} from './features/alunos/importarPlanilha.js';

import { renderProfessores } from './features/professores/professoresView.js';
import {
  abrirModalNovoProf, salvarNovoProf, abrirModalEditarProf, salvarEdicaoProf, enviarResetSenha,
} from './features/professores/professorModal.js';

import {
  renderRel, onMultiCheck, toggleMultiDropdown, abrirDotMenu, selecionarStatusDot,
} from './features/relatorios/relatoriosView.js';
import { exportarExcel } from './features/relatorios/exportExcel.js';

import { renderMetricas, setFocoMetricas } from './features/metricas/metricasView.js';

import {
  abrirMenuConfig, fecharMenuConfig, renderConfiguracoes,
  selecionarTipoExclusao, renderListaExclusao, pedirExclusao,
  verificarTextoExclusaoItem, confirmarExclusaoConfig,
  abrirModalEditarCurso, verificarNomeCursoEdicao, salvarEdicaoCurso,
} from './features/configuracoes/configuracoesView.js';

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
  renderDash, setCurso, irParaAlertas,
  abrirModalNovaTurma, selecionarCorNovaTurma, salvarNovaTurma,
  abrirModalEditarTurma, selecionarCorEditarTurma, salvarEditarTurma,
  toggleTurmaAtiva, marcarPresetAtivo, aplicarPreset, limparHorario, verificarTurmaDuplicada,
  abrirModalNovoCurso, salvarNovoCurso,
  abrirChamada, voltarDash, renderChamada, selecionarAula, marcar,
  renderTabelaAlunos, atualizarTurmasAlunos,
  abrirModalAluno, abrirMenuAluno, fecharMenuAluno, toggleInativo, toggleExperimental, cancelarMatricula,
  abrirModalEditar, salvarEdicao, abrirModalTransferir, confirmarTransferencia,
  abrirModalNovoAluno, toggleNovoExperimental, salvarNovoAluno, irParaAulaHistorico, verificarAlunoDuplicado,
  toggleNovoTurmaPainel, fecharNovoTurmaPainel, filtrarNovoTurmaBusca, filtrarNovoTurmaCurso, selecionarNovaTurmaOpcao,
  iniciarObservacao, cancelarObservacao, confirmarObservacao, selecionarCategoriaObs,
  importarPlanilhaSelecionada, atualizarLinhaImportacao, atualizarFiltroCursoImportacao,
  cancelarImportacaoPlanilha, confirmarImportacaoPlanilha,
  renderProfessores,
  abrirModalNovoProf, salvarNovoProf, abrirModalEditarProf, salvarEdicaoProf, enviarResetSenha,
  renderRel, onMultiCheck, toggleMultiDropdown, abrirDotMenu, selecionarStatusDot,
  exportarExcel,
  renderMetricas, setFocoMetricas,
  abrirMenuConfig, fecharMenuConfig, renderConfiguracoes,
  selecionarTipoExclusao, renderListaExclusao, pedirExclusao,
  verificarTextoExclusaoItem, confirmarExclusaoConfig,
  abrirModalEditarCurso, verificarNomeCursoEdicao, salvarEdicaoCurso,
  onLineChartMove, onLineChartLeave, onBarHover, onDonutHover, hideChartTooltip,
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

// Troca a apresentação dos <select> nativos marcados por data-custom-select
// por um botão + painel no estilo liquid glass (ver customSelect.js).
document.querySelectorAll('select[data-custom-select]').forEach(enhanceSelect);

// Fecha o menu de pontos, o menu de ações do aluno e os painéis de
// multi-select ao clicar fora deles.
// Usa e.composedPath() em vez de e.target.closest(): alguns cliques (ex.: nas
// pills de curso do seletor de turma do modal "Novo aluno") disparam um
// re-render que troca o innerHTML do próprio container clicado ANTES de o
// clique terminar de borbulhar até aqui — isso desconecta e.target da árvore
// do documento (seu parentElement vira null), e e.target.closest(...) nunca
// mais acha o painel, fechando-o por engano mesmo o clique tendo sido dentro
// dele. composedPath() é calculado no início do disparo do evento, então
// continua correto mesmo depois de o alvo ser removido/substituído.
document.addEventListener('click', (e) => {
  const caminho = e.composedPath();
  const dentro = (id) => caminho.includes(document.getElementById(id));

  if (!dentro('dot-menu')) {
    const menu = document.getElementById('dot-menu');
    if (menu) { menu.remove(); state.dotMenuContext = null; }
  }
  if (!dentro('ma-acoes-menu')) fecharMenuAluno();
  if (!dentro('config-menu')) fecharMenuConfig();
  if (!dentro('novo-turma-picker')) fecharNovoTurmaPainel();
  document.querySelectorAll('.multi-select-panel.open').forEach(p => p.classList.remove('open'));
});

// Retoma sessão existente (se houver) e liga o aviso de nova versão publicada.
restoreSession();
startUpdateNotifier();
wireAutoLogin();
