import { sb } from './supabaseClient.js';
import { state } from '../../frontend/state/store.js';

export async function carregarHistorico() {
  const alunoIds = state.ALUNOS.map(a => a.id);
  if (!alunoIds.length) { state.HISTORICO = []; return; }
  const { data } = await sb.from('historico').select('*').in('aluno_id', alunoIds).order('created_at', { ascending: false });
  state.HISTORICO = data || [];
}

// Coloca as linhas recém-gravadas no topo de state.HISTORICO (que vem do banco
// ordenado do mais novo pro mais antigo), do mesmo jeito que as ações já
// atualizam `a.ativo`/`a.nome` na mão depois de salvar — sem isso a
// movimentação nova só aparecia no modal do aluno depois de recarregar a
// página. O autor aqui é só pra exibir na hora: o que fica gravado no banco é
// preenchido pelo trigger de sql/historico_autor.sql, que não confia no
// navegador.
function espelharNoCache(entries) {
  const agora = new Date().toISOString();
  const usuarioNome = state.perfilLogado?.nome || state.usuarioLogado?.email || null;
  state.HISTORICO.unshift(...entries.map(e => ({
    ...e,
    created_at: agora,
    usuario_id: state.usuarioLogado?.id || null,
    usuario_nome: usuarioNome,
  })));
}

export async function registrarMovimentacao(alunoId, descricao) {
  const res = await sb.from('historico').insert({ aluno_id: alunoId, descricao });
  if (!res.error) espelharNoCache([{ aluno_id: alunoId, descricao }]);
  return res;
}

export async function registrarMovimentacoesEmLote(entries) {
  const res = await sb.from('historico').insert(entries);
  if (!res.error) espelharNoCache(entries);
  return res;
}

export async function excluirHistoricoDeAluno(alunoId) {
  return sb.from('historico').delete().eq('aluno_id', alunoId);
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
