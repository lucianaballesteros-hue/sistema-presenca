import { sb } from './supabaseClient.js';
import { state } from '../../frontend/state/store.js';
import { buscarTodasAsPaginas } from './paginacao.js';

// `turmasProntas`: como em carregarAlunos — a busca sai junto com a das
// turmas, e só o filtro final espera por elas.
export async function carregarPresencas(turmasProntas) {
  const { data, error } = await buscarTodasAsPaginas((de, ate, count) =>
    sb.from('presencas').select('*', { count })
      .order('turma_id').order('aluno_id').order('aula').range(de, ate));
  if (error) console.error('Erro presencas:', error);
  await turmasProntas;

  const turmaIds = new Set(state.TURMAS.map(t => t.id));
  const presencas = {};
  data.filter(p => turmaIds.has(p.turma_id)).forEach(p => {
    const key = `${p.turma_id}_${p.aula}`;
    if (!presencas[key]) presencas[key] = {};
    presencas[key][p.aluno_id] = p.status;
  });
  state.PRESENCAS = presencas;
}

export async function salvarPresenca(turmaId, alunoId, aula, status) {
  return sb.from('presencas').upsert(
    { turma_id: turmaId, aluno_id: alunoId, aula, status },
    { onConflict: 'turma_id,aluno_id,aula' }
  );
}

export async function buscarPresenca(turmaId, alunoId, aula) {
  return sb.from('presencas').select('status').eq('turma_id', turmaId).eq('aluno_id', alunoId).eq('aula', aula).maybeSingle();
}

export async function removerPresenca(turmaId, alunoId, aula) {
  return sb.from('presencas').delete().eq('turma_id', turmaId).eq('aluno_id', alunoId).eq('aula', aula);
}

// Grava o status, ou apaga o registro quando não há status ("sem registro") —
// usado para devolver uma presença ao valor anterior depois de uma falha.
export async function gravarPresenca(turmaId, alunoId, aula, status) {
  return status ? salvarPresenca(turmaId, alunoId, aula, status) : removerPresenca(turmaId, alunoId, aula);
}

export async function moverPresencasDeTurma(alunoId, deTurmaId, paraTurmaId) {
  return sb.from('presencas').update({ turma_id: paraTurmaId }).eq('aluno_id', alunoId).eq('turma_id', deTurmaId);
}

export async function excluirPresencasDeAluno(alunoId) {
  return sb.from('presencas').delete().eq('aluno_id', alunoId);
}
