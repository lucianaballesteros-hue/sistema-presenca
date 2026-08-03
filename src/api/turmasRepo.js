import { sb } from './supabaseClient.js';
import { state } from '../state/store.js';

// Professores só enxergam as próprias turmas; admins enxergam todas.
export async function carregarTurmas() {
  let query = sb.from('turmas').select('*').order('turma');
  if (state.perfilLogado?.papel !== 'admin') {
    query = query.eq('professor_id', state.perfilLogado?.id);
  }
  const { data } = await query;
  state.TURMAS = data || [];
}

export async function inserirTurma(payload) {
  return sb.from('turmas').insert(payload).select().single();
}

export async function atualizarTurma(id, updates) {
  return sb.from('turmas').update(updates).eq('id', id);
}
