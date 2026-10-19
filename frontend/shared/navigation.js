import { renderRel } from '../features/relatorios/relatoriosView.js';
import { renderMetricas } from '../features/metricas/metricasView.js';
import { renderProfessores } from '../features/professores/professoresView.js';
import { renderReposicoes } from '../features/reposicoes/reposicoesView.js';
import { renderConfiguracoes } from '../features/configuracoes/configuracoesView.js';

// Desliza a pílula de seleção do nav até embaixo do botão ativo — medindo a
// posição real do botão em vez de recalcular por índice, então continua
// certo mesmo se a aba "Professores" estiver escondida (não-admin) ou se o
// layout mudar em telas menores.
export function moverIndicadorNav() {
  const nav = document.getElementById('nav-bar');
  const indicador = document.getElementById('nav-indicator');
  const ativo = nav?.querySelector('.nav-btn.active');
  if (!nav || !indicador || !ativo) return;
  indicador.style.setProperty('--nav-x', ativo.offsetLeft + 'px');
  indicador.style.setProperty('--nav-w', ativo.offsetWidth + 'px');
}

// Abre/fecha um grupo do menu (Configurações → Geral / Usuários)
export function alternarGrupoNav(botao, aberto = botao.getAttribute('aria-expanded') !== 'true') {
  botao.setAttribute('aria-expanded', String(aberto));
}

export function goTab(tab) {
  document.querySelectorAll('.nav-btn[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  // Aba de dentro de um grupo: o grupo abre para mostrar onde a pessoa está
  const grupo = document.querySelector(`.nav-grupo:has(.nav-btn[data-tab="${tab}"]) .nav-grupo__titulo`);
  if (grupo) alternarGrupoNav(grupo, true);
  document.querySelectorAll('#app .screen').forEach(s => s.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  moverIndicadorNav();

  if (tab === 'turmas') {
    document.getElementById('dash-view').style.display = 'block';
    document.getElementById('chamada-view').style.display = 'none';
  }
  if (tab === 'relatorio') renderRel();
  if (tab === 'metricas') renderMetricas();
  if (tab === 'reposicoes') renderReposicoes();
  if (tab === 'professores') renderProfessores();
  if (tab === 'configuracoes') renderConfiguracoes();
}

window.addEventListener('resize', moverIndicadorNav);
