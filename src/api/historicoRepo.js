import { sb } from './supabaseClient.js';
import { state } from '../state/store.js';

export async function carregarHistorico() {
  const alunoIds = state.ALUNOS.map(a => a.id);
  if (!alunoIds.length) { state.HISTORICO = []; return; }
  const { data } = await sb.from('historico').select('*').in('aluno_id', alunoIds).order('created_at', { ascending: false });
  state.HISTORICO = data || [];
}

export async function registrarMovimentacao(alunoId, descricao) {
  return sb.from('historico').insert({ aluno_id: alunoId, descricao });
}

export async function registrarMovimentacoesEmLote(entries) {
  return sb.from('historico').insert(entries);
}

export async function carregarObservacoes(alunoId) {
  return sb.from('historico').select('*').eq('aluno_id', alunoId).eq('tipo', 'observacao').order('created_at', { ascending: false });
}

export async function registrarObservacao({ alunoId, descricao, dataObs, categoria }) {
  return sb.from('historico').insert({
    aluno_id: alunoId,
    descricao,
    tipo: 'observacao',
    data_obs: dataObs,
    categoria,
  });
}
