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

  usuarioLogado: null,
  perfilLogado: null,

  turmaAtual: null,
  turmaEmEdicaoId: null,
  filtroCurso: '',
  paginaAlunos: 1,
  paginaTurmas: 1,

  alunoSelecionadoId: null,
  profSelecionadoId: null,

  chamadaAlterada: {},
  dotMenuContext: null,
  obsCategoriaSelecionada: null,
};
