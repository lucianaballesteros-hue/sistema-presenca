// Checagem de aluno duplicado (mesmo nome em QUALQUER turma do sistema, não
// só na turma selecionada) — usada tanto no modal "Novo aluno" quanto na
// importação por planilha, pra manter as duas telas com a mesma regra de
// comparação (case/acento-insensível).

import { state } from '../state/store.js';

export function normalizarNome(s) {
  return (s || '').toString().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

export function alunoJaExiste(nome) {
  const alvo = normalizarNome(nome);
  return Boolean(alvo && state.ALUNOS.some(a => normalizarNome(a.nome) === alvo));
}
