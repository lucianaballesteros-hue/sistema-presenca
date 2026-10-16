import { sb } from '../../../backend/api/supabaseClient.js';
import { state } from '../../state/store.js';
import { estaEmRecuperacaoSenha } from './recovery.js';
import { moverIndicadorNav } from '../../shared/navigation.js';
import { ehAdmin } from '../../shared/permissoes.js';
import { carregarTurmas } from '../../../backend/api/turmasRepo.js';
import { carregarAlunos } from '../../../backend/api/alunosRepo.js';
import { carregarPresencas } from '../../../backend/api/presencasRepo.js';
import { carregarHistorico } from '../../../backend/api/historicoRepo.js';
import { carregarProfessores } from '../../../backend/api/professoresRepo.js';
import { carregarCursos, sincronizarCursosComTurmas } from '../../../backend/api/cursosRepo.js';
import { popularFiltros, renderRel } from '../relatorios/relatoriosView.js';
import { renderDash } from '../dashboard/dashboardView.js';
import { renderTabelaAlunos } from '../alunos/alunosTable.js';
import { iniciarNotificacoesReposicoes } from '../reposicoes/reposicoesView.js';

let autoLoginTimer = null;

// Alguém está digitando à mão neste momento?
//
// O auto-login abaixo existe para o gerenciador de senhas, que preenche os
// dois campos de uma vez. Quem digita manualmente e pausa 400ms no meio da
// senha caía nele: o login disparava com a senha incompleta, falhava, e
// "E-mail ou senha incorretos" aparecia — de novo a cada pausa, enquanto a
// pessoa ainda estava escrevendo. Além do incômodo, eram várias tentativas
// de autenticação falhas por login, o que convida o Supabase a limitar.
//
// `keydown` só acontece com tecla de verdade; autofill não dispara. É o que
// separa os dois casos.
let digitandoAMao = false;

// Login automático quando o navegador preenche e-mail/senha sozinho
// (autofill do gerenciador de senhas). Espera os campos ficarem estáveis por
// 400ms antes de logar — evita disparar no meio da digitação manual (ex.:
// com a senha ainda incompleta). Nunca dispara durante a tela de
// recuperação/troca de senha (estaEmRecuperacaoSenha()), mesmo que os campos
// escondidos do login ainda tenham valor — é o mesmo tipo de corrida que já
// causava as duas telas aparecerem juntas.
function agendarAutoLogin() {
  clearTimeout(autoLoginTimer);
  if (estaEmRecuperacaoSenha()) return;
  // Digitação manual: quem entra pelo teclado decide quando enviar, no Enter
  // ou no botão. Tentar por conta própria só produz erro no meio da frase.
  if (digitandoAMao) return;
  // Os campos de e-mail/senha continuam no DOM (só escondidos) depois do
  // login, e o gerenciador de senhas do navegador pode re-preenchê-los
  // sozinho a qualquer momento (ex.: ao focar outro campo em algum modal),
  // disparando este listener de novo. Sem essa checagem, isso chamava
  // doLogin() -> inicializarApp() no meio do uso normal do app, recarregando
  // tudo e reabrindo a tela cheia de "Carregando..." sem o usuário ter feito
  // login de fato. Só faz sentido auto-logar enquanto a tela de login está
  // realmente visível.
  if (document.getElementById('login-page').style.display === 'none') return;
  const email = document.getElementById('inp-email').value.trim();
  const senha = document.getElementById('inp-senha').value;
  if (!email || !senha) return;
  autoLoginTimer = setTimeout(() => {
    const aindaEmail = document.getElementById('inp-email').value.trim();
    const aindaSenha = document.getElementById('inp-senha').value;
    if (aindaEmail === email && aindaSenha === senha && !estaEmRecuperacaoSenha()) {
      doLogin();
    }
  }, 400);
}

export function wireAutoLogin() {
  for (const id of ['inp-email', 'inp-senha']) {
    const campo = document.getElementById(id);

    campo.addEventListener('keydown', (e) => {
      // Tab e Enter navegam, não escrevem: não contam como digitar.
      if (e.key !== 'Tab' && e.key !== 'Enter') digitandoAMao = true;
    });

    campo.addEventListener('input', () => {
      // A mensagem fala da tentativa anterior. Assim que a pessoa mexe em
      // algo, ela deixa de valer — mantê-la na tela faz parecer que o novo
      // valor também está errado, antes mesmo de ser enviado.
      const erro = document.getElementById('login-err');
      if (erro) erro.style.display = 'none';
      agendarAutoLogin();
    });
  }
}

export async function doLogin() {
  const email = document.getElementById('inp-email').value.trim();
  const senha = document.getElementById('inp-senha').value;
  const btn = document.getElementById('btn-login');
  btn.disabled = true; btn.textContent = 'Entrando...';
  document.getElementById('login-err').style.display = 'none';

  const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });
  if (error) {
    // Antes era sempre "E-mail ou senha incorretos", para qualquer falha.
    // Isso manda a pessoa procurar o problema no lugar errado quando ele é
    // outro — limite de tentativas e internet fora são os dois casos que
    // mais acontecem, e nenhum se resolve trocando a senha.
    const m = (error.message || '').toLowerCase();
    const el = document.getElementById('login-err');
    el.textContent =
      m.includes('rate') || m.includes('many')
        ? 'Muitas tentativas seguidas. Espere um minuto e tente de novo.'
        : m.includes('not confirmed')
        ? 'Este e-mail ainda não foi confirmado.'
        : m.includes('fetch') || m.includes('network')
        ? 'Sem conexão com o servidor. Verifique sua internet.'
        : 'E-mail ou senha incorretos.';
    el.style.display = 'block';
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

// Evita que duas chamadas concorrentes carreguem os dados em paralelo — ex.:
// restoreSession() ainda está esperando getSession() responder quando o
// gerenciador de senhas do navegador preenche os campos escondidos do login
// e agendarAutoLogin() dispara doLogin() sozinho, ou o usuário reabre a aba
// duas vezes rápido. Cada carregarX() é uma função independente sem noção
// da outra chamada em andamento, então duas em paralelo duplicavam alunos
// (e arriscavam duplicar turmas/cursos) até a página ser recarregada — às
// vezes de forma permanente, se a corrida também alcançava um INSERT (ver
// sincronizarCursosComTurmas). Reaproveitar a mesma promessa em vez de
// rodar tudo de novo fecha essa janela por completo dentro da mesma aba.
let cargaEmAndamento = null;

export function inicializarApp() {
  if (cargaEmAndamento) return cargaEmAndamento;
  cargaEmAndamento = executarCargaInicial().finally(() => { cargaEmAndamento = null; });
  return cargaEmAndamento;
}

async function executarCargaInicial() {
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('app-loading').classList.add('visible');
  const ini = state.perfilLogado?.nome ? state.perfilLogado.nome.substring(0, 2).toUpperCase() : '--';
  document.getElementById('av').textContent = ini;
  document.getElementById('hname').textContent = state.perfilLogado?.nome || state.usuarioLogado.email;

  // Botão de Configurações (Geral / Professores) só aparece para admins
  if (ehAdmin()) {
    document.getElementById('btn-config').classList.remove('hidden');
    // O cadastro online fica em páginas à parte e é restrito a admin —
    // mesma razão de Configurações: professor não precisa de CPF e
    // telefone de 500 pessoas para dar aula.
    document.getElementById('nav-cadastro')?.classList.remove('hidden');
  }

  try {
    await carregarTurmas();
    await carregarAlunos();
    await Promise.all([carregarPresencas(), carregarHistorico(), carregarProfessores(), carregarCursos()]);
    await sincronizarCursosComTurmas();

    popularFiltros();
    renderDash();
    renderTabelaAlunos();
    renderRel();
    iniciarNotificacoesReposicoes();
  } finally {
    document.getElementById('app-loading').classList.remove('visible');
    document.getElementById('app').classList.remove('hidden');
    moverIndicadorNav();
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
