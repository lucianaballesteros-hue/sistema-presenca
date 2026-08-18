import { sb } from './supabaseClient.js';
import { state } from '../../frontend/state/store.js';
import { showToast } from '../../frontend/shared/dom.js';

export async function carregarCursos() {
  const { data, error } = await sb.from('cursos').select('*').order('nome');
  if (error) { console.error('Erro cursos:', error); state.CURSOS = []; return; }
  state.CURSOS = data || [];
}

export async function inserirCurso(nome) {
  return sb.from('cursos').insert({ nome }).select().single();
}

export async function atualizarCurso(id, nome) {
  return sb.from('cursos').update({ nome }).eq('id', id);
}

// turmas.curso é texto solto (não uma FK pro id do curso — ver comentário em
// sincronizarCursosComTurmas), então renomear um curso só na tabela `cursos`
// deixaria toda turma que já usava o nome antigo "presa" nele: some da opção
// no <select> (que lista state.CURSOS) e, pior, no próximo login
// sincronizarCursosComTurmas() recriaria o nome antigo como um curso novo
// (órfão), porque pra ela essas turmas continuam citando um curso que "não
// existe". Por isso todo rename precisa vir acompanhado desta função,
// chamada ANTES de atualizarCurso — mesmo princípio do professor/professor_id
// em turmaModals.js: o texto solto nunca pode ficar dessincronizado da fonte
// oficial.
export async function renomearTurmasDoCurso(nomeAntigo, nomeNovo) {
  return sb.from('turmas').update({ curso: nomeNovo }).eq('curso', nomeAntigo);
}

// .select() é necessário pra detectar exclusão barrada por RLS — ver mesmo
// comentário em excluirAluno (alunosRepo.js).
export async function excluirCurso(id) {
  return sb.from('cursos').delete().eq('id', id).select();
}

// Desvincula (não apaga) as turmas que usam esse curso — elas continuam
// existindo normalmente, só ficam sem curso (turmas.curso = null) até
// alguém escolher um novo curso pra elas em "Editar turma". Chamado antes de
// excluirCurso() quando o curso ainda tem turmas: excluir o curso nunca deve
// levar as turmas junto.
export async function desvincularTurmasDoCurso(nomeCurso) {
  return sb.from('turmas').update({ curso: null }).eq('curso', nomeCurso);
}

// A tabela `cursos` foi criada depois que `turmas.curso` já existia como
// texto livre, então turmas antigas (inclusive inativas) podem citar cursos
// que nunca viraram uma linha na tabela — some do <select>, que só lista
// state.CURSOS. Preenche essa lacuna uma vez por login: qualquer nome de
// curso presente em state.TURMAS que ainda não exista em state.CURSOS
// (comparando sem diferenciar maiúsculas/minúsculas) é cadastrado.
export async function sincronizarCursosComTurmas() {
  const existentes = new Set(state.CURSOS.map(c => c.nome.trim().toLowerCase()));
  const faltantes = new Map(); // chave minúscula -> primeira grafia encontrada
  for (const t of state.TURMAS) {
    const nome = (t.curso || '').trim();
    if (!nome) continue;
    const chave = nome.toLowerCase();
    if (!existentes.has(chave) && !faltantes.has(chave)) faltantes.set(chave, nome);
  }
  if (!faltantes.size) return;

  const { data, error } = await sb.from('cursos').insert([...faltantes.values()].map(nome => ({ nome }))).select();
  if (error) {
    console.error('Erro ao sincronizar cursos:', error);
    showToast('Não foi possível sincronizar todos os cursos (verifique as permissões do banco).', 'red');
    return;
  }
  state.CURSOS.push(...(data || []));
  state.CURSOS.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}
