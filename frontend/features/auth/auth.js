import { sb } from '../../../backend/api/supabaseClient.js';
import { state } from '../../state/store.js';
import { estaEmRecuperacaoSenha } from './recovery.js';
import { carregarTurmas } from '../../../backend/api/turmasRepo.js';
import { carregarAlunos } from '../../../backend/api/alunosRepo.js';
import { carregarPresencas } from '../../../backend/api/presencasRepo.js';
import { carregarHistorico } from '../../../backend/api/historicoRepo.js';
import { carregarProfessores } from '../../../backend/api/professoresRepo.js';
import { popularFiltros, renderRel } from '../relatorios/relatoriosView.js';
import { renderDash } from '../dashboard/dashboardView.js';
import { renderTabelaAlunos } from '../alunos/alunosTable.js';
import { iniciarNotificacoesReposicoes } from '../reposicoes/reposicoesView.js';

export async function doLogin() {
  const email = document.getElementById('inp-email').value.trim();
  const senha = document.getElementById('inp-senha').value;
  const btn = document.getElementById('btn-login');
  btn.disabled = true; btn.textContent = 'Entrando...';
  document.getElementById('login-err').style.display = 'none';

  const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });
  if (error) {
    document.getElementById('login-err').style.display = 'block';
    btn.disabled = false; btn.textContent = 'Entrar';
    return;
  }
  state.usuarioLogado = data.user;
  await carregarPerfil();
  await inicializarApp();
}

export async function carregarPerfil() {
  const { data } = await sb.from('professores').select('*').eq('user_id', state.usuarioLogado.id).single();
  state.perfilLogado = data;
}

export async function doLogout() {
  await sb.auth.signOut();
  state.usuarioLogado = null;
  state.perfilLogado = null;
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-page').style.display = 'flex';
  document.getElementById('inp-senha').value = '';
  const btn = document.getElementById('btn-login');
  btn.disabled = false; btn.textContent = 'Entrar';
}

export async function inicializarApp() {
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('app-loading').classList.add('visible');
  const ini = state.perfilLogado?.nome ? state.perfilLogado.nome.substring(0, 2).toUpperCase() : '--';
  document.getElementById('av').textContent = ini;
  document.getElementById('hname').textContent = state.perfilLogado?.nome || state.usuarioLogado.email;

  // Mostrar aba Professores apenas para admins
  if (state.perfilLogado?.papel === 'admin') {
    document.getElementById('nav-prof').classList.remove('hidden');
  }

  try {
    await carregarTurmas();
    await carregarAlunos();
    await Promise.all([carregarPresencas(), carregarHistorico(), carregarProfessores()]);

    popularFiltros();
    renderDash();
    renderTabelaAlunos();
    renderRel();
    iniciarNotificacoesReposicoes();
  } finally {
    document.getElementById('app-loading').classList.remove('visible');
    document.getElementById('app').classList.remove('hidden');
  }
}

// Retoma a sessão automaticamente se o navegador ainda tiver um token válido.
export function restoreSession() {
  sb.auth.getSession().then(async ({ data }) => {
    if (estaEmRecuperacaoSenha()) return; // já tratado pela tela de recuperação
    if (data.session) {
      state.usuarioLogado = data.session.user;
      await carregarPerfil();
      await inicializarApp();
    }
  });
}
