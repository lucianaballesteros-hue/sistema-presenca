import { state } from '../state/store.js';

export const AULAS = Array.from({ length: 32 }, (_, i) => `Aula ${i + 1}`);

export function aulasDaTurma(turma) {
  const n = turma?.total_aulas;
  return (n && n > 0 && n <= AULAS.length) ? AULAS.slice(0, n) : AULAS;
}

// Última aula da turma que já tem algum registro de presença — usado no
// dashboard (acompanhar o andamento de cada turma em tempo real) e na
// criação de reposições (achar uma turma que ainda vai passar pela aula que
// falta repor).
export function ultimaAulaRegistrada(turma) {
  if (!turma) return null;
  let ultima = null;
  aulasDaTurma(turma).forEach(au => {
    const key = `${turma.id}_${au}`;
    if (state.PRESENCAS[key] && Object.values(state.PRESENCAS[key]).some(v => v)) ultima = au;
  });
  return ultima;
}

// Calcula presenças/faltas/frequência/sequência de faltas de um aluno a
// partir do cache local de presenças (state.PRESENCAS), sem chamadas à rede.
export function calcAluno(aluno) {
  const turma = state.TURMAS.find(t => t.id === aluno.turma_id);
  const seq = aulasDaTurma(turma).map(aula => {
    const k = `${aluno.turma_id}_${aula}`;
    return (state.PRESENCAS[k] && state.PRESENCAS[k][aluno.id]) || 'N';
  });
  const p = seq.filter(v => v === 'P' || v === 'R').length; // R conta como presença
  const r = seq.filter(v => v === 'R').length;               // reposições separadas
  const f = seq.filter(v => v === 'F').length;
  const freq = p + f > 0 ? Math.round((p / (p + f)) * 100) : null;

  let maxC = 0, cur = 0;
  seq.forEach(v => { if (v === 'F') { cur++; maxC = Math.max(maxC, cur); } else cur = 0; });

  // Alerta: 3+ faltas seguidas nas últimas 8 aulas com registro
  const registradas = seq.filter(v => v !== 'N');
  const ultimas8 = registradas.slice(-8);
  let consecU8 = 0, curU8 = 0;
  ultimas8.forEach(v => { if (v === 'F') { curU8++; consecU8 = Math.max(consecU8, curU8); } else curU8 = 0; });
  const emAlerta = consecU8 >= 3;

  return { seq, p, r, f, freq, maxConsec: maxC, emAlerta };
}
