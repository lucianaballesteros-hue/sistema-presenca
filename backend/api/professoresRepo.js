import { sb } from './supabaseClient.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config/env.js';
import { state } from '../../frontend/state/store.js';

export async function carregarProfessores() {
  const { data } = await sb.from('professores').select('*').order('nome');
  state.PROFESSORES = data || [];
}

// Cria a conta de autenticação do professor via REST (signup público), sem
// afetar a sessão do admin que está logado no momento (sb.auth.signUp trocaria
// a sessão atual pela do novo usuário, então usamos fetch direto).
export async function criarContaAuth(email, senha) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ email, password: senha }),
  });
  return res.json();
}

export async function criarPerfilProfessor(payload) {
  return sb.from('professores').insert(payload).select().single();
}

export async function atualizarProfessor(id, updates) {
  return sb.from('professores').update(updates).eq('id', id);
}

// Trocar a senha de OUTRA pessoa exige a service_role key do Supabase, que
// nunca pode existir no navegador — por isso o único fluxo válido no cliente
// é pedir ao próprio Supabase Auth para mandar um e-mail de redefinição.
export async function enviarResetSenha(email) {
  return sb.auth.resetPasswordForEmail(email, {
    redirectTo: location.origin + location.pathname,
  });
}
