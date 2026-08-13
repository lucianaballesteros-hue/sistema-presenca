import { sb } from './supabaseClient.js';

// Duas consultas simples + junção no JS, em vez do "embedded select" do
// PostgREST (`select('*, reposicao_opcoes(*)')`) — este projeto não usa
// PostgREST embedding em nenhum outro repositório (ver turmasRepo/alunosRepo),
// e o embedding depende do PostgREST já ter recarregado o cache do schema
// com a FK entre as duas tabelas, o que pode falhar silenciosamente logo
// após rodar a migração e fazer a lista parecer vazia mesmo com dados no banco.
export async function carregarReposicoes() {
  const { data: reposicoes, error } = await sb
    .from('reposicoes')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) { console.error('Erro reposicoes:', error); return []; }

  const { data: opcoes, error: errOpc } = await sb.from('reposicao_opcoes').select('*');
  if (errOpc) console.error('Erro reposicao_opcoes:', errOpc);

  return (reposicoes || []).map(r => ({
    ...r,
    reposicao_opcoes: (opcoes || []).filter(o => o.reposicao_id === r.id),
  }));
}

// opcoes: [{ turmaDestinoId, data, observacao }, ...]
export async function criarReposicao({ alunoId, turmaOrigemId, aula, criadoPor, opcoes }) {
  const { data: rep, error } = await sb
    .from('reposicoes')
    .insert({ aluno_id: alunoId, turma_origem_id: turmaOrigemId, aula, criado_por: criadoPor })
    .select('*')
    .single();
  if (error) return { error };

  const rows = opcoes.map(o => ({
    reposicao_id: rep.id,
    turma_destino_id: o.turmaDestinoId,
    data: o.data,
    observacao: o.observacao || null,
  }));
  const { data: opcoesInseridas, error: errOpc } = await sb.from('reposicao_opcoes').insert(rows).select('*');
  if (errOpc) {
    await sb.from('reposicoes').delete().eq('id', rep.id);
    return { error: errOpc };
  }

  return { data: { ...rep, reposicao_opcoes: opcoesInseridas } };
}

// Apaga TODAS as reposições (e respectivas opções) de um aluno — usado só na
// exclusão permanente do aluno (configuracoesView.js). reposicao_opcoes não
// tem aluno_id direto, então precisa passar por reposicoes primeiro.
export async function excluirReposicoesDeAluno(alunoId) {
  const { data: reps, error: errSel } = await sb.from('reposicoes').select('id').eq('aluno_id', alunoId);
  if (errSel) return { error: errSel };
  const ids = (reps || []).map(r => r.id);
  if (!ids.length) return { error: null };

  const { error: errOpc } = await sb.from('reposicao_opcoes').delete().in('reposicao_id', ids);
  if (errOpc) return { error: errOpc };

  return sb.from('reposicoes').delete().eq('aluno_id', alunoId);
}

export async function cancelarReposicao(id) {
  return sb.from('reposicoes').update({ status: 'cancelada' }).eq('id', id);
}

export async function concluirReposicao(id) {
  return sb.from('reposicoes').update({ status: 'concluida' }).eq('id', id);
}

export async function buscarOpcaoReposicao(id) {
  const { data } = await sb.from('reposicao_opcoes').select('*').eq('id', id).single();
  return data;
}

// Avisa a equipe em tempo real quando um aluno confirma um horário de
// reposição, sem precisar ficar com a aba "Reposições" aberta/atualizando.
// Requer que a tabela `reposicoes` esteja na publicação `supabase_realtime`
// (já incluído em sql/reposicoes.sql).
let canalReposicoes = null;

export function assinarMudancasReposicoes(onAgendada) {
  if (canalReposicoes) sb.removeChannel(canalReposicoes);
  canalReposicoes = sb
    .channel('reposicoes-mudancas')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'reposicoes' }, (payload) => {
      if (payload.old.status !== 'agendada' && payload.new.status === 'agendada') {
        onAgendada(payload.new);
      }
    })
    .subscribe();
  return canalReposicoes;
}
