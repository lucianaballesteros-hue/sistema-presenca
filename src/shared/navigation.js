import { renderRel } from '../features/relatorios/relatoriosView.js';
import { renderMetricas } from '../features/metricas/metricasView.js';
import { renderProfessores } from '../features/professores/professoresView.js';

const TABS = ['turmas', 'alunos', 'relatorio', 'metricas', 'professores'];

export function goTab(tab) {
  document.querySelectorAll('.nav-btn').forEach((b, i) => b.classList.toggle('active', TABS[i] === tab));
  document.querySelectorAll('#app .screen').forEach(s => s.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');

  if (tab === 'turmas') {
    document.getElementById('dash-view').style.display = 'block';
    document.getElementById('chamada-view').style.display = 'none';
  }
  if (tab === 'relatorio') renderRel();
  if (tab === 'metricas') renderMetricas();
  if (tab === 'professores') renderProfessores();
}
