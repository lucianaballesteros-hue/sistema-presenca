import { sb } from './supabaseClient.js';
import { state } from '../../frontend/state/store.js';

export async function carregarCursos() {
  const { data, error } = await sb.from('cursos').select('*').order('nome');
  if (error) { console.error('Erro cursos:', error); state.CURSOS = []; return; }
  state.CURSOS = data || [];
}

export async function inserirCurso(nome) {
  return sb.from('cursos').insert({ nome }).select().single();
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
  if (error) { console.error('Erro ao sincronizar cursos:', error); return; }
  state.CURSOS.push(...(data || []));
  state.CURSOS.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}
