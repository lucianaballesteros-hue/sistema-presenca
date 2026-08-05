import { state } from '../../state/store.js';
import { escapeHtml, showToast } from '../../shared/dom.js';
import { carregarObservacoes as buscarObservacoes, registrarObservacao } from '../../../backend/api/historicoRepo.js';

export const OBS_CATEGORIAS = [
  { id: 'transferencia_turma', label: 'Transferência de turma', icon: '↔', badge: 'badge-blue' },
  { id: 'reposicao_aula', label: 'Reposição de aula', icon: '↺', badge: 'badge-amber' },
  { id: 'erro_plataforma', label: 'Erro plataforma', icon: '⚠', badge: 'badge-red' },
  { id: 'pedido_cancelamento', label: 'Pedido cancelamento', icon: '✕', badge: 'badge-red' },
  { id: 'reclamacao_geral', label: 'Reclamação geral', icon: '!', badge: 'badge-pink' },
  { id: 'pedido_transferencia', label: 'Pedido transferência', icon: '→', badge: 'badge-purple' },
  { id: 'feedback', label: 'Feedback', icon: '★', badge: 'badge-green' },
];

export async function carregarObservacoes(alunoId) {
  const lista = document.getElementById('ma-obs-lista');
  if (!lista) return;
  const { data } = await buscarObservacoes(alunoId);
  if (!data || !data.length) {
    lista.innerHTML = '<div style="font-size:12px;color:var(--text-faded);padding:4px 0;">Nenhuma observação registrada.</div>';
    return;
  }
  lista.innerHTML = data.map(h => {
    const d = h.data_obs ? new Date(h.data_obs + 'T00:00:00').toLocaleDateString('pt-BR') : new Date(h.created_at).toLocaleDateString('pt-BR');
    const cat = OBS_CATEGORIAS.find(c => c.id === h.categoria);
    const catBadge = cat ? `<span class="badge ${cat.badge}" style="font-size:10px;margin-left:6px;">${cat.icon} ${cat.label}</span>` : '';
    return '<div style="padding:6px 0;border-bottom:1px solid var(--border-2);font-size:12px;color:var(--text);"><div style="display:flex;align-items:center;flex-wrap:wrap;margin-bottom:3px;"><span style="color:var(--text-faded);font-size:11px;">' + d + '</span>' + catBadge + '</div><div>' + escapeHtml(h.descricao) + '</div></div>';
  }).join('');
}

export function iniciarObservacao() {
  const texto = document.getElementById('obs-texto').value.trim();
  if (!texto) { showToast('Digite uma observação!', 'red'); return; }
  state.obsCategoriaSelecionada = null;
  document.getElementById('obs-cat-preview').textContent = '"' + texto + '"';
  document.getElementById('obs-confirm-btn').disabled = true;
  renderCategoriasObs();
  document.getElementById('obs-categoria-panel').style.display = 'block';
  document.getElementById('obs-add-btn').disabled = true;
}

function renderCategoriasObs() {
  document.getElementById('obs-cat-grid').innerHTML = OBS_CATEGORIAS.map(c =>
    `<button class="obs-cat-btn ${state.obsCategoriaSelecionada === c.id ? 'selected' : ''}" onclick="selecionarCategoriaObs('${c.id}')">
      <span class="icon">${c.icon}</span><span>${c.label}</span>
    </button>`
  ).join('');
}

export function selecionarCategoriaObs(id) {
  state.obsCategoriaSelecionada = id;
  document.getElementById('obs-confirm-btn').disabled = false;
  renderCategoriasObs();
}

export function cancelarObservacao() {
  document.getElementById('obs-categoria-panel').style.display = 'none';
  document.getElementById('obs-add-btn').disabled = false;
  state.obsCategoriaSelecionada = null;
}

export async function confirmarObservacao() {
  if (!state.obsCategoriaSelecionada) return;
  const texto = document.getElementById('obs-texto').value.trim();
  if (!texto) return;
  const hoje = new Date().toISOString().split('T')[0];
  const btn = document.getElementById('obs-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Salvando…';
  const { error } = await registrarObservacao({
    alunoId: state.alunoSelecionadoId,
    descricao: texto,
    dataObs: hoje,
    categoria: state.obsCategoriaSelecionada,
  });
  if (error) {
    showToast('Erro ao salvar observação.', 'red'); console.error(error);
    btn.disabled = false; btn.textContent = 'Salvar';
    return;
  }
  btn.textContent = 'Salvar';
  document.getElementById('obs-texto').value = '';
  document.getElementById('obs-categoria-panel').style.display = 'none';
  document.getElementById('obs-add-btn').disabled = false;
  state.obsCategoriaSelecionada = null;
  showToast('Observação salva!');
  carregarObservacoes(state.alunoSelecionadoId);
}
