// Redesenho central da interface depois de qualquer alteração de dado.
//
// Antes, cada ação chamava na mão a lista de telas que ela achava que
// precisava atualizar (`renderTabelaAlunos(); renderDash();` e variações), e
// esse conjunto quase nunca estava completo — na prática, quem inativava,
// cancelava ou excluía um aluno estando DENTRO de uma turma não via nada
// mudar, porque nenhuma dessas listas incluía `renderChamada()`. Só saindo e
// voltando na tela o dado aparecia certo. O mesmo valia pra aba Métricas, que
// só se redesenha ao entrar.
//
// Agora existe um lugar só que sabe quais telas estão à vista e redesenha
// todas elas. Toda ação que muda aluno/turma/presença termina chamando
// atualizarTelas() — se um dia entrar uma tela nova no sistema, basta
// acrescentá-la aqui e todas as ações passam a atualizá-la juntas.
//
// Tudo aqui é redesenho a partir do `state` que já está em memória: nenhuma
// dessas funções vai à rede, então chamar todas de uma vez é barato e pode
// acontecer a cada clique.

import { state } from '../state/store.js';
import { renderDash } from '../features/dashboard/dashboardView.js';
import { renderChamada } from '../features/chamada/chamadaView.js';
import { renderTabelaAlunos } from '../features/alunos/alunosTable.js';
import { renderRel, popularFiltros } from '../features/relatorios/relatoriosView.js';
import { renderMetricas } from '../features/metricas/metricasView.js';
import { renderProfessores } from '../features/professores/professoresView.js';
import { renderConfiguracoes } from '../features/configuracoes/configuracoesView.js';
import { aplicarFiltroReposicoes } from '../features/reposicoes/reposicoesView.js';

function abaAtiva(nome) {
  return Boolean(document.getElementById('tab-' + nome)?.classList.contains('active'));
}

// A chamada não é uma aba: ela abre por cima do dashboard, dentro da aba
// "Turmas" (abrirChamada/voltarDash trocam o display dos dois blocos).
function chamadaAberta() {
  const view = document.getElementById('chamada-view');
  return Boolean(state.turmaAtual) && Boolean(view) && view.style.display !== 'none';
}

// `filtros: true` só quando a alteração mexe no conjunto de turmas/cursos
// (criar, editar, excluir, inativar turma, importar planilha, renomear
// professor). popularFiltros() recria o HTML dos multiselects do Relatório, o
// que apaga o que o usuário tiver marcado neles — por isso não entra no
// caminho comum de "mudou um aluno".
//
// `chamada: false` só em quem já cuidou da própria tela de chamada na mão:
// marcar() atualiza a linha clicada sem redesenhar a lista, de propósito, pra
// não matar a animação do indicador no meio (ver comentário lá).
export function atualizarTelas({ filtros = false, chamada = true } = {}) {
  if (filtros) popularFiltros();

  // Dashboard, tabela de alunos e relatório ficam em abas diferentes, mas são
  // baratos e sempre alcançáveis — redesenhar os três evita que a aba vizinha
  // fique com dado velho esperando a próxima visita.
  renderDash();
  renderTabelaAlunos();
  renderRel();

  if (chamada && chamadaAberta()) renderChamada();
  if (abaAtiva('metricas')) renderMetricas();
  if (abaAtiva('professores')) renderProfessores();
  if (abaAtiva('configuracoes')) renderConfiguracoes();
  // A aba Reposições recarrega do banco ao ser aberta (renderReposicoes é
  // async); aqui só reaplica o filtro em cima do cache que já está em
  // memória, que é o suficiente pra refletir mudança de aluno na hora.
  if (abaAtiva('reposicoes')) aplicarFiltroReposicoes();
}
