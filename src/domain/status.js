import { state } from '../state/store.js';

export function freqBar(freq) {
  if (freq === null) return '<span style="font-size:11px;color:var(--text-faded);">—</span>';
  const c = freq >= 70 ? 'var(--green)' : freq >= 50 ? 'var(--amber)' : 'var(--red)';
  return `<div class="freq-wrap"><div class="fbar"><div class="fbar-fill" style="width:${freq}%;background:${c};"></div></div><span style="font-size:11px;font-weight:600;color:${c};">${freq}%</span></div>`;
}

export function statusBadge(freq, emAlerta, ativo) {
  if (!ativo) return `<span class="badge badge-gray">Inativo</span>`;
  if (emAlerta) return `<span class="badge badge-red">⚠ Alerta</span>`;
  if (freq === null) return `<span class="badge badge-gray">Sem registro</span>`;
  if (freq >= 70) return `<span class="badge badge-green">Regular</span>`;
  return `<span class="badge badge-amber">Atenção</span>`;
}

export function corBadge(curso) {
  if (curso?.includes('Elas')) return 'badge-blue';
  if (curso?.includes('Master')) return 'badge-amber';
  if (curso?.includes('Evolution')) return 'badge-green';
  if (curso?.includes('Clube')) return 'badge-purple';
  return 'badge-gray';
}

// 'cancelado' (encerramento definitivo) vs 'inativo' (afastamento temporário),
// inferido a partir da última movimentação de histórico do aluno.
export function statusInativo(alunoId) {
  const hist = state.HISTORICO
    .filter(h => h.aluno_id === alunoId && (h.descricao?.includes('inativad') || h.descricao?.includes('cancelad')))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return (hist.length && hist[0].descricao?.includes('cancelad')) ? 'cancelado' : 'inativo';
}

export function ordemDia(nomeTurma) {
  const dias = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];
  const idx = dias.findIndex(d => (nomeTurma || '').includes(d));
  return idx === -1 ? 99 : idx;
}
