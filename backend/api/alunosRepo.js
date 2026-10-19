import { sb } from './supabaseClient.js';
import { state } from '../../frontend/state/store.js';
import { buscarTodasAsPaginas } from './paginacao.js';

// Carrega todos os alunos das turmas visíveis para o usuário logado (as
// páginas de 1000 saem em paralelo — ver paginacao.js). Monta a lista numa
// variável local e só escreve em state.ALUNOS no final, para que a função
// fique segura mesmo que duas chamadas concorrentes rodem ao mesmo tempo (ver
// guarda em inicializarApp, que é a defesa principal contra isso).
//
// `turmasProntas`: a busca dos alunos não depende das turmas, só o filtro
// final — então a carga inicial dispara as duas juntas e passa aqui a
// promessa das turmas, que só é esperada na hora de filtrar.
export async function carregarAlunos(turmasProntas) {
  const { data, error } = await buscarTodasAsPaginas((de, ate, count) =>
    sb.from('alunos').select('*', { count }).order('nome').order('id').range(de, ate));
  if (error) console.error('Erro alunos:', error);
  await turmasProntas;

  const turmaIds = new Set(state.TURMAS.map(t => t.id));
  const idsVistos = new Set();
  state.ALUNOS = data.filter(a => {
    if (!turmaIds.has(a.turma_id) || idsVistos.has(a.id)) return false;
    idsVistos.add(a.id);
    return true;
  });
}

export async function inserirAluno(payload) {
  return sb.from('alunos').insert(payload).select().single();
}

export async function atualizarAluno(id, updates) {
  return sb.from('alunos').update(updates).eq('id', id);
}

export async function atualizarAlunosEmLote(ids, updates) {
  return sb.from('alunos').update(updates).in('id', ids);
}

// .select() no fim é o que permite detectar exclusão bloqueada por RLS: sem
// ele, um DELETE que a política de segurança barra não gera erro nenhum — só
// afeta 0 linhas silenciosamente — e o chamador não teria como diferenciar
// isso de uma exclusão bem-sucedida (ver erroSeNadaApagado em
// configuracoesView.js, que é quem realmente checa data.length).
export async function excluirAluno(id) {
  return sb.from('alunos').delete().eq('id', id).select();
}
