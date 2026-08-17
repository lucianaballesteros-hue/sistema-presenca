import { sb } from './supabaseClient.js';
import { state } from '../../frontend/state/store.js';

const PAGE_SIZE = 1000;

// Carrega todos os alunos das turmas visíveis para o usuário logado, paginando
// em blocos de 1000 (limite de linhas por página do Supabase/PostgREST).
// Monta a lista numa variável local e só escreve em state.ALUNOS no final —
// nunca no meio da paginação — para que a função fique segura mesmo que duas
// chamadas concorrentes rodem ao mesmo tempo (ver guarda em inicializarApp,
// que é a defesa principal contra isso). Escrever em state.ALUNOS a cada
// página, como antes, deixava a lista vulnerável: duas chamadas concorrentes
// (cada uma com seu próprio controle local de "já vi esse id") empurravam
// para o MESMO array compartilhado, duplicando todo aluno na tela.
export async function carregarAlunos() {
  const turmaIds = new Set(state.TURMAS.map(t => t.id));
  const idsVistos = new Set();
  const alunos = [];
  let from = 0;

  while (true) {
    const { data, error } = await sb.from('alunos').select('*').order('nome').range(from, from + PAGE_SIZE - 1);
    if (error) { console.error('Erro alunos:', error); break; }
    if (!data || data.length === 0) break;

    data.filter(a => turmaIds.has(a.turma_id) && !idsVistos.has(a.id)).forEach(a => {
      idsVistos.add(a.id);
      alunos.push(a);
    });

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  state.ALUNOS = alunos;
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

export async function excluirAluno(id) {
  return sb.from('alunos').delete().eq('id', id);
}
