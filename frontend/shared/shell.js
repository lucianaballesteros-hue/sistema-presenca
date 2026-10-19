// Casca visual do painel, no mesmo padrão da Gestão de Reuniões: a barra
// lateral (ocultar/mostrar; em janela estreita, um painel sobreposto que
// desliza da esquerda), o efeito de borda de rolagem do cabeçalho e a
// posição do menu da conta.
//
// É só apresentação: não chama nenhuma função do sistema nem mexe em dado.
// Por isso é carregado num <script type="module"> próprio, à parte do
// main.js — se algo falhar aqui, o sistema continua funcionando igual.

const app = document.getElementById('app');
const barra = document.getElementById('barra-lateral');
const btnBarra = document.getElementById('btn-barra-lateral');
const veu = document.getElementById('veu');
const principal = document.getElementById('principal');
const cabecalho = document.getElementById('cabecalho');
const btnConta = document.getElementById('btn-conta');
const menuConta = document.getElementById('menu-conta');

// Mesmo corte do estrutura.css: abaixo dele a barra vira painel sobreposto.
const janelaEstreita = matchMedia('(max-width: 899px)');
const CHAVE_BARRA_OCULTA = 'presenca:barra-lateral-oculta';
const temPopover = typeof HTMLElement !== 'undefined' && Object.prototype.hasOwnProperty.call(HTMLElement.prototype, 'popover');

if (app && barra && btnBarra) iniciarBarra();
if (cabecalho) iniciarBordaDeRolagem();
if (btnConta && menuConta) iniciarMenuConta();

// ---------- Barra lateral ----------

function iniciarBarra() {
  app.toggleAttribute('data-barra-oculta', lerPreferenciaBarra());

  btnBarra.addEventListener('click', alternarBarra);
  veu?.addEventListener('click', () => fecharBarraSobreposta(true));

  // No celular, escolher uma seção fecha o painel (os botões continuam
  // chamando goTab pelo onclick deles; aqui só se fecha a barra). Abrir ou
  // fechar um grupo (Configurações) não conta como escolher uma seção.
  barra.addEventListener('click', evento => {
    if (janelaEstreita.matches && evento.target.closest('.nav-btn:not(.nav-grupo__titulo)')) fecharBarraSobreposta(false);
  });

  document.addEventListener('keydown', evento => {
    if (evento.key === 'Escape' && janelaEstreita.matches && app.hasAttribute('data-barra-aberta')) {
      fecharBarraSobreposta(true);
    }
  });

  janelaEstreita.addEventListener('change', () => {
    app.removeAttribute('data-barra-aberta');
    sincronizarBarra();
  });

  sincronizarBarra();
}

function alternarBarra() {
  if (janelaEstreita.matches) {
    const abrir = !app.hasAttribute('data-barra-aberta');
    app.toggleAttribute('data-barra-aberta', abrir);
    sincronizarBarra();
    // (duas buscas: com "a, b" numa só, vinha sempre o primeiro botão da
    // lista, não o da aba aberta)
    if (abrir) (barra.querySelector('.nav-btn.active') || barra.querySelector('.nav-btn'))?.focus();
    return;
  }
  const ocultar = !app.hasAttribute('data-barra-oculta');
  app.toggleAttribute('data-barra-oculta', ocultar);
  salvarPreferenciaBarra(ocultar);
  sincronizarBarra();
}

function fecharBarraSobreposta(devolverFoco) {
  app.removeAttribute('data-barra-aberta');
  sincronizarBarra();
  if (devolverFoco) btnBarra.focus();
}

// Uma fonte da verdade para o estado visível: botão, leitor de tela e ordem
// de foco concordam (barra escondida fica inerte).
function sincronizarBarra() {
  const sobreposta = janelaEstreita.matches && app.hasAttribute('data-barra-aberta');
  const visivel = janelaEstreita.matches ? sobreposta : !app.hasAttribute('data-barra-oculta');
  btnBarra.setAttribute('aria-expanded', String(visivel));
  btnBarra.title = visivel ? 'Ocultar barra lateral' : 'Mostrar barra lateral';
  barra.inert = !visivel;
  if (principal) principal.inert = sobreposta; // com o painel aberto, o foco fica nele
}

function lerPreferenciaBarra() {
  try { return localStorage.getItem(CHAVE_BARRA_OCULTA) === '1'; } catch { return false; }
}

function salvarPreferenciaBarra(oculta) {
  try {
    if (oculta) localStorage.setItem(CHAVE_BARRA_OCULTA, '1');
    else localStorage.removeItem(CHAVE_BARRA_OCULTA);
  } catch { /* armazenamento bloqueado: a preferência vale só nesta visita */ }
}

// ---------- Cabeçalho ----------

// O efeito de vidro só aparece quando há conteúdo passando por baixo.
function iniciarBordaDeRolagem() {
  const atualizar = () => cabecalho.classList.toggle('rolado', window.scrollY > 4);
  window.addEventListener('scroll', atualizar, { passive: true });
  atualizar();
}

// ---------- Menu da conta ----------

function iniciarMenuConta() {
  if (temPopover) {
    menuConta.addEventListener('beforetoggle', evento => {
      if (evento.newState === 'open') posicionarMenuConta();
    });
    window.addEventListener('resize', () => {
      if (menuConta.matches(':popover-open')) posicionarMenuConta();
    });
    return;
  }

  // Navegador sem popover: abre e fecha por classe, fecha ao clicar fora.
  btnConta.addEventListener('click', evento => {
    evento.stopPropagation();
    posicionarMenuConta();
    menuConta.classList.toggle('aberto');
  });
  menuConta.addEventListener('click', evento => {
    if (evento.target.closest('[popovertargetaction="hide"]')) menuConta.classList.remove('aberto');
  });
  document.addEventListener('click', evento => {
    if (!menuConta.contains(evento.target)) menuConta.classList.remove('aberto');
  });
}

function posicionarMenuConta() {
  const r = btnConta.getBoundingClientRect();
  menuConta.style.top = `${Math.round(r.bottom + 8)}px`;
  menuConta.style.right = `${Math.max(8, Math.round(document.documentElement.clientWidth - r.right))}px`;
}
