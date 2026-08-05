import { sb } from './supabaseClient.js';
import { state } from '../../frontend/state/store.js';

const PAGE_SIZE = 1000;

// Carrega todos os alunos das turmas visíveis para o usuário logado, paginando
// em blocos de 1000 (limite de linhas por página do Supabase/PostgREST).
export async function carregarAlunos() {
  state.ALUNOS = [];
  const turmaIds = new Set(state.TURMAS.map(t => t.id));
  const idsVistos = new Set();
  let from = 0;

  while (true) {
    const { data, error } = await sb.from('alunos').select('*').order('nome').range(from, from + PAGE_SIZE - 1);
    if (error) { console.error('Erro alunos:', error); break; }
    if (!data || data.length === 0) break;

    data.filter(a => turmaIds.has(a.turma_id) && !idsVistos.has(a.id)).forEach(a => {
      idsVistos.add(a.id);
      state.ALUNOS.push(a);
    });

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
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
