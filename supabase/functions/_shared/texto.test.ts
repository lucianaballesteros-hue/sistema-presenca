/**
 * Testes do casamento de nomes entre as três plataformas.
 *
 *     node --test supabase/functions/_shared/texto.test.ts
 *
 * O que mais importa aqui é o que a função **recusa**. Vincular o aluno
 * errado mistura o histórico de presença de duas pessoas, e isso não dá para
 * desfazer olhando o banco depois.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  chaveTurma, melhorCorrespondencia, normalizaChave, parecenca,
  similaridade, tokensContidos,
} from "./texto.ts";

/* ------------------------------------------------------------------ *
 * Normalização
 * ------------------------------------------------------------------ */

test("normalizaChave tira acento, caixa e pontuação", () => {
  assert.equal(normalizaChave("ELAS Quinta 14:00 ON 2/26"), "elas quinta 14 00 on 2 26");
  assert.equal(normalizaChave("João  D'Ávila"), "joao d avila");
  assert.equal(normalizaChave(null), "");
});

test("chaveTurma iguala ano de dois e quatro dígitos", () => {
  // A divergência real entre Sponte e Presença: "2/26" × "2/2026".
  assert.equal(
    chaveTurma("ELAS Quarta 14:00 PR 2/26"),
    chaveTurma("ELAS Quarta 14:00 PR 2/2026"),
  );
});

test("chaveTurma iguala hora com e sem zero à esquerda", () => {
  // Sponte escreve "9:00"; o Presença, "09:00".
  assert.equal(
    chaveTurma("ELAS Terça 9:00 ON 2/26"),
    chaveTurma("ELAS Terça 09:00 ON 2/26"),
  );
});

test("chaveTurma expande o dia abreviado", () => {
  assert.equal(chaveTurma("MAST Qua 18:30"), chaveTurma("MAST Quarta 18:30"));
  assert.equal(chaveTurma("Seg"), "segunda");
});

test("semestre diferente nunca casa", () => {
  // Caso real: 0,92 de similaridade de texto entre a turma do 1º e a do 2º
  // semestre. Só o número separa as duas, e é ele que importa.
  assert.ok(parecenca("ELAS Quarta 14:00 PR 1/26", "ELAS Quarta 14:00 PR 2/26") < 0.9);
});

test("ano diferente nunca casa", () => {
  // 0,96 de similaridade de texto entre a turma de 2026 e a de 2027.
  assert.ok(parecenca("EVOL Terça 14:00 PR 1/27", "EVOL Terça 14:00 PR 1/26") < 0.9);
});

test("meia hora de diferença é outra turma", () => {
  assert.ok(parecenca("EVOL Quarta 14:00 PR 1/26", "EVOL Quarta 14:30 PR 1/26") < 0.9);
});

test("padronizar a escrita não aproxima turmas diferentes", () => {
  // O risco de normalizar demais: quarta e quinta às 18:30 continuam duas.
  assert.ok(parecenca("MAST Qua 18:30 2/26", "MAST Qui 18:30 2/26") < 0.9);
  assert.ok(parecenca("ELAS Terça 09:00 2/26", "ELAS Terça 19:00 2/26") < 0.9);
});

/* ------------------------------------------------------------------ *
 * Similaridade
 * ------------------------------------------------------------------ */

test("nome idêntico vale 1", () => {
  assert.equal(similaridade("Ismael dos Santos", "ismael dos santos"), 1);
});

test("typo de uma letra continua alto", () => {
  // Caso real da planilha: Cecconelo × Cecconello.
  assert.ok(parecenca("Ana Cecconelo", "Ana Cecconello") >= 0.9);
});

test("nome abreviado casa com o completo", () => {
  assert.ok(tokensContidos("Paulo Monteiro", "Paulo Monteiro Lopes Neto"));
  assert.ok(parecenca("Paulo Monteiro", "Paulo Monteiro Lopes Neto") >= 0.9);
});

test("um token só não basta para conter", () => {
  // Senão qualquer "Maria" casaria com qualquer outra Maria.
  assert.equal(tokensContidos("Maria", "Maria Aparecida Souza"), false);
});

test("pessoas diferentes ficam abaixo do corte", () => {
  assert.ok(parecenca("Maria Silva", "Maria Souza") < 0.9);
});

/* ------------------------------------------------------------------ *
 * Escolha — o lado que precisa errar para menos
 * ------------------------------------------------------------------ */

const TURMAS = [
  { id: 43, turma: "ELAS Terça 14:00 PR 2/26" },
  { id: 46, turma: "ELAS Quarta 14:00 PR 2/2026" },
  { id: 47, turma: "ELAS Quinta 09:00 PR 2/26" },
  { id: 48, turma: "ELAS Quinta 14:00 ON 2/26" },
];

test("acha a turma apesar do ano escrito diferente", () => {
  const { escolhido } = melhorCorrespondencia(
    TURMAS, "ELAS Quarta 14:00 PR 2/26", (t) => t.turma);
  assert.equal(escolhido?.id, 46);
});

test("turmas que diferem só no dia e hora não se confundem", () => {
  // "ELAS Quinta 09:00 PR" e "ELAS Quinta 14:00 ON" são muito parecidas como
  // texto e completamente diferentes como turma.
  const { escolhido } = melhorCorrespondencia(
    TURMAS, "ELAS Quinta 11:00 PR 2/26", (t) => t.turma);
  assert.equal(escolhido, null);
});

test("nome sem correspondente não inventa turma", () => {
  const { escolhido, ambiguos } = melhorCorrespondencia(
    TURMAS, "Clube Elas", (t) => t.turma);
  assert.equal(escolhido, null);
  assert.deepEqual(ambiguos, []);
});

test("empate exato devolve os candidatos, não um deles", () => {
  const duplicadas = [
    { id: 1, turma: "Master Segunda 19:00" },
    { id: 2, turma: "MASTER segunda 19:00" },
  ];
  const { escolhido, ambiguos } = melhorCorrespondencia(
    duplicadas, "Master Segunda 19:00", (t) => t.turma);
  assert.equal(escolhido, null);
  assert.equal(ambiguos.length, 2);
});

test("lista vazia não quebra", () => {
  const { escolhido } = melhorCorrespondencia([], "qualquer", (x) => x);
  assert.equal(escolhido, null);
});
