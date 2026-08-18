import { sb } from './supabaseClient.js';
import { state } from '../../frontend/state/store.js';

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

// .select() é necessário pra detectar exclusão barrada por RLS — ver mesmo
// comentário em excluirAluno (alunosRepo.js).
export async function excluirTurma(id) {
  return sb.from('turmas').delete().eq('id', id).select();
}

// Desvincula (não apaga) os alunos dessa turma — eles continuam existindo
// normalmente, só ficam sem turma (alunos.turma_id = null) até alguém
// transferir cada um pra uma turma nova. Chamado antes de excluirTurma()
// quando a turma ainda tem alunos: excluir a turma nunca deve levar os
// alunos (e o histórico/presença deles) junto.
export async function desvincularAlunosDaTurma(turmaId) {
  return sb.from('alunos').update({ turma_id: null }).eq('turma_id', turmaId);
}
