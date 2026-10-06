// Estado mutável central da aplicação. Todo módulo que precisa ler ou
// escrever o estado importa este objeto (`state.TURMAS`, `state.ALUNOS`, ...)
// em vez de manter variáveis globais soltas — assim fica claro, num único
// lugar, o que compõe o estado da aplicação.
export const state = {
  TURMAS: [],
  ALUNOS: [],
  PRESENCAS: {},
  HISTORICO: [],
  PROFESSORES: [],
  CURSOS: [],
  // Carregado já no login (não só ao abrir a aba Reposições): a chamada
  // precisa saber quem vem repor aula em cada turma.
  REPOSICOES: [],

  usuarioLogado: null,
  perfilLogado: null,

  turmaAtual: null,
  turmaEmEdicaoId: null,
  filtroCurso: '',
  metricasFoco: 'geral',

  alunoSelecionadoId: null,
  profSelecionadoId: null,

  chamadaAlterada: {},
  dotMenuContext: null,
  obsCategoriaSelecionada: null,
};
