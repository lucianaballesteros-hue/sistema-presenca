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
