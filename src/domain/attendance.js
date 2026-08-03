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

// Próxima aula que a turma ainda vai dar (a aula seguinte à última já
// registrada). Usada para sugerir automaticamente, na criação de uma
// reposição, outras turmas do mesmo curso que estão "no ponto certo" para
// receber o aluno na aula que ele perdeu.
export function proximaAula(turma) {
  const aulas = aulasDaTurma(turma);
  const ultima = ultimaAulaRegistrada(turma);
  if (!ultima) return aulas[0] || null;
  const idx = aulas.indexOf(ultima);
  return aulas[idx + 1] || null;
}

const DIA_SEMANA_INDICE = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };

// Data (YYYY-MM-DD) da próxima ocorrência do horário fixo da turma
// (dias_semana + horario_inicio) a partir de agora. Não sabemos em que data
// exata cada "Aula N" aconteceu (não é uma coluna do banco) — por isso a
// sugestão de data é sempre "a próxima vez que essa turma se encontra",
// nunca uma data retroativa.
export function proximaDataTurma(turma, agora = new Date()) {
  if (!turma?.dias_semana?.length) return null;
  const diasAlvo = turma.dias_semana.map(d => DIA_SEMANA_INDICE[d]).filter(v => v !== undefined);
  if (!diasAlvo.length) return null;
  const [h, m] = (turma.horario_inicio || '00:00').slice(0, 5).split(':').map(Number);

  for (let offset = 0; offset < 14; offset++) {
    const dt = new Date(agora);
    dt.setDate(dt.getDate() + offset);
    if (!diasAlvo.includes(dt.getDay())) continue;
    if (offset === 0) {
      const horarioHoje = new Date(agora);
      horarioHoje.setHours(h, m, 0, 0);
      if (agora >= horarioHoje) continue; // já passou o horário de hoje, pula pra próxima ocorrência
    }
    dt.setHours(0, 0, 0, 0);
    return dt.toISOString().split('T')[0];
  }
  return null;
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
