// Quem pode o quê, num lugar só. Antes essa decisão estava espalhada como
// `state.perfilLogado?.papel === 'admin'` solto em cada tela, o que torna
// fácil esquecer um botão pra trás ao mudar a regra.
//
// IMPORTANTE: isto é regra de INTERFACE, não de segurança. Qualquer usuário
// autenticado consegue chamar as mesmas funções pelo console do navegador —
// quem de fato impede uma escrita indevida é o Row Level Security das
// tabelas no Supabase (ver seção 15 do ARQUITETURA.md).

import { state } from '../state/store.js';

export function ehAdmin() {
  return state.perfilLogado?.papel === 'admin';
}

// Inativar/reativar turma é decisão de coordenação, não do professor: o
// professor dá aula em todas as turmas ativas, mas não encerra nenhuma nem
// enxerga as já encerradas.
export function podeGerenciarTurmasInativas() {
  return ehAdmin();
}
