import { sb } from './supabaseClient.js';
import { state } from '../../frontend/state/store.js';
import { turmaAtiva } from '../domain/status.js';
import { ehAdmin } from '../../frontend/shared/permissoes.js';

// Professor enxerga TODAS as turmas do sistema, não só as que estão no nome
// dele — a equipe se cobre entre si (dar aula, lançar chamada, marcar
// reposição em turma de colega), então limitar por professor_id só atrapalha.
// O que ele não enxerga é turma INATIVA: turma encerrada é assunto de
// coordenação e some por completo do lado dele — não chega nem a entrar em
// state.TURMAS, então nenhuma tela, filtro ou exportação tem como mostrá-la
// por engano. Como alunos/presenças são carregados a partir dos ids de
// state.TURMAS, os alunos dessas turmas encerradas também ficam de fora.
//
// A posse por professor_id continua existindo pra exibição e pra pill
// "Suas Turmas" — só não restringe mais o que se pode ver.
export async function carregarTurmas() {
  const { data } = await sb.from('turmas').select('*').order('turma');
  const todas = data || [];
  state.TURMAS = ehAdmin() ? todas : todas.filter(turmaAtiva);
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
