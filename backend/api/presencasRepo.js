import { sb } from './supabaseClient.js';
import { state } from '../../frontend/state/store.js';

const PAGE_SIZE = 1000;

export async function carregarPresencas() {
  state.PRESENCAS = {};
  const turmaIds = new Set(state.TURMAS.map(t => t.id));
  let from = 0;

  while (true) {
    const { data, error } = await sb.from('presencas').select('*').range(from, from + PAGE_SIZE - 1);
    if (error) { console.error('Erro presencas:', error); break; }
    if (!data || data.length === 0) break;

    data.filter(p => turmaIds.has(p.turma_id)).forEach(p => {
      const key = `${p.turma_id}_${p.aula}`;
      if (!state.PRESENCAS[key]) state.PRESENCAS[key] = {};
      state.PRESENCAS[key][p.aluno_id] = p.status;
    });

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
}

export async function salvarPresenca(turmaId, alunoId, aula, status) {
  return sb.from('presencas').upsert(
    { turma_id: turmaId, aluno_id: alunoId, aula, status },
    { onConflict: 'turma_id,aluno_id,aula' }
  );
}

export async function removerPresenca(turmaId, alunoId, aula) {
  return sb.from('presencas').delete().eq('turma_id', turmaId).eq('aluno_id', alunoId).eq('aula', aula);
}

export async function moverPresencasDeTurma(alunoId, deTurmaId, paraTurmaId) {
  return sb.from('presencas').update({ turma_id: paraTurmaId }).eq('aluno_id', alunoId).eq('turma_id', deTurmaId);
}
