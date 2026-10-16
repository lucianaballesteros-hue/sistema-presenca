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
//
// As duas tabelas apontam uma pra outra: `reposicao_opcoes.reposicao_id` ->
// `reposicoes.id`, e `reposicoes.opcao_escolhida_id` -> `reposicao_opcoes.id`
// (preenchida quando o aluno confirma um horário pelo link público). Esse
// ciclo travava a exclusão nos dois sentidos: apagar a opção primeiro esbarra
// na reposição que ainda aponta pra ela, e apagar a reposição primeiro
// esbarra nas opções que ainda apontam pra ela. Era exatamente isso que
// impedia excluir um aluno que já tinha reposição agendada/concluída (as
// "abertas", sem escolha feita, passavam) — o DELETE do aluno vinha depois e
// morria com erro de chave estrangeira. Por isso o passo zero aqui é soltar a
// escolha (`opcao_escolhida_id = null`): sem o ciclo, a ordem
// opções -> reposições passa limpo.
export async function excluirReposicoesDeAluno(alunoId) {
  const { data: reps, error: errSel } = await sb.from('reposicoes').select('id').eq('aluno_id', alunoId);
  if (errSel) return { error: errSel };
  const ids = (reps || []).map(r => r.id);
  if (!ids.length) return { error: null };

  const { error: errSolta } = await sb.from('reposicoes').update({ opcao_escolhida_id: null }).eq('aluno_id', alunoId);
  if (errSolta) return { error: errSolta };

  // Mesmo padrão .select() dos outros DELETEs do projeto: RLS que bloqueia um
  // DELETE não devolve erro, devolve sucesso com data vazio (ver
  // erroSeNadaApagado em configuracoesView.js). Sem essa checagem, um bloqueio
  // aqui reapareceria lá na frente como um erro de chave estrangeira do DELETE
  // do aluno — mensagem que não diz nada pra quem está usando o sistema.
  const { data: opcoes, error: errOpcSel } = await sb.from('reposicao_opcoes').select('id').in('reposicao_id', ids);
  if (errOpcSel) return { error: errOpcSel };
  if (opcoes?.length) {
    const { data: opcoesApagadas, error: errOpc } = await sb.from('reposicao_opcoes').delete().in('reposicao_id', ids).select();
    if (errOpc) return { error: errOpc };
    if (!opcoesApagadas?.length) {
      return { error: { message: 'As opções de reposição deste aluno não puderam ser apagadas — as permissões do banco (RLS) bloquearam.' } };
    }
  }

  const { data: repsApagadas, error: errRep } = await sb.from('reposicoes').delete().eq('aluno_id', alunoId).select();
  if (errRep) return { error: errRep };
  if (!repsApagadas?.length) {
    return { error: { message: 'As reposições deste aluno não puderam ser apagadas — as permissões do banco (RLS) bloquearam.' } };
  }
  return { error: null };
}

export async function cancelarReposicao(id) {
  return sb.from('reposicoes').update({ status: 'cancelada' }).eq('id', id);
}

// 'concluida' ao marcar o aluno na chamada da turma escolhida; de volta a
// 'agendada' se a marcação for desfeita (ver marcarReposicao em chamadaView.js).
export async function atualizarStatusReposicao(id, status) {
  return sb.from('reposicoes').update({ status }).eq('id', id);
}

// Repassa toda mudança na tabela `reposicoes` (aluno confirmou horário pelo
// link, outra pessoa marcou a reposição na chamada, cancelou...) para o painel
// se atualizar sem recarregar a página. Quem decide o que mostrar é
// iniciarNotificacoesReposicoes() (reposicoesView.js) — `payload.old` não serve
// pra isso, porque sem REPLICA IDENTITY FULL ele só traz a chave primária.
// Requer que a tabela `reposicoes` esteja na publicação `supabase_realtime`
// (já incluído em sql/reposicoes.sql).
let canalReposicoes = null;

export function assinarMudancasReposicoes(onMudanca) {
  if (canalReposicoes) sb.removeChannel(canalReposicoes);
  canalReposicoes = sb
    .channel('reposicoes-mudancas')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'reposicoes' }, (payload) => {
      onMudanca(payload.new);
    })
    .subscribe();
  return canalReposicoes;
}
