import { state } from '../../frontend/state/store.js';

export function freqBar(freq) {
  if (freq === null) return '<span style="font-size:11px;color:var(--text-faded);">—</span>';
  const c = freq >= 70 ? 'var(--green)' : freq >= 50 ? 'var(--amber)' : 'var(--red)';
  return `<div class="freq-wrap"><div class="fbar"><div class="fbar-fill" style="width:${freq}%;background:${c};"></div></div><span style="font-size:11px;font-weight:600;color:${c};">${freq}%</span></div>`;
}

export function statusBadge(freq, emAlerta, ativo) {
  if (!ativo) return `<span class="badge badge-gray">Inativo</span>`;
  if (emAlerta) return `<span class="badge badge-red">Alerta</span>`;
  if (freq === null) return `<span class="badge badge-gray">Sem registro</span>`;
  if (freq >= 70) return `<span class="badge badge-green">Regular</span>`;
  return `<span class="badge badge-amber">Atenção</span>`;
}

// Identidade visual de cada curso — fonte única usada tanto pelos badges
// (tabelas, cards de turma) quanto pelo seletor de foco do dashboard de
// Métricas, pra a mesma palavra-chave render sempre a mesma cor em todo canto
// do sistema. `grad` só existe nos cursos com dashboard de foco dedicado.
const TEMAS_CURSO = [
  { chave: 'Elas', badge: 'badge-blue', cor: 'var(--primary)', corSoft: 'var(--primary-soft)', corSoftText: 'var(--primary-soft-text)', grad: 'var(--grad-blue)' },
  { chave: 'Master', badge: 'badge-amber', cor: 'var(--amber)', corSoft: 'var(--amber-soft)', corSoftText: 'var(--amber-soft-text)', grad: 'var(--grad-amber)' },
  { chave: 'Evolution', badge: 'badge-green', cor: 'var(--green)', corSoft: 'var(--green-soft)', corSoftText: 'var(--green-soft-text)', grad: 'var(--grad-green)' },
  { chave: 'Clube', badge: 'badge-purple' },
];

export function temaCurso(curso) {
  return TEMAS_CURSO.find(t => curso?.includes(t.chave));
}

export function corBadge(curso) {
  return temaCurso(curso)?.badge || 'badge-gray';
}

// Cursos com dashboard de foco dedicado na página de Métricas (os que têm
// uma cor "cheia" definida acima, não só um badge).
export const FOCOS_METRICAS = TEMAS_CURSO.filter(t => t.grad);

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

// Nome do professor de uma turma, sempre resolvido pelo vínculo real
// (turma.professor_id -> professores.id), nunca pelo texto solto salvo em
// turma.professor. Isso evita nomes desatualizados quando um professor é
// renomeado, e nunca deve ser usado para decidir permissão/posse — só para
// exibição. O texto salvo em turma.professor só serve de fallback caso o
// vínculo esteja ausente.
export function professorNome(turma) {
  return state.PROFESSORES.find(p => p.id === turma?.professor_id)?.nome || turma?.professor || '—';
}
