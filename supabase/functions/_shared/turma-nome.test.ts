/**
 * Testes da convenção de nome de turma.
 *
 *     node --test supabase/functions/_shared/turma-nome.test.ts
 *
 * O que está em jogo: o nome é a única chave entre Sponte, Presença e
 * LeagueInvest. Gerar fora do padrão cria mais uma das 32 turmas que hoje
 * não casam entre as plataformas — e o estrago só aparece semanas depois,
 * na hora de matricular alguém.
 *
 * Os nomes usados aqui foram copiados da aba "Parâmetros" da planilha.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { chaveTurma } from "./texto.ts";
import {
  codigoDaModalidade, diaParaNumero, lerNomeTurma, modalidadePorCodigo,
  montarNomeTurma, numeroParaDia,
} from "./turma-nome.ts";

/* ------------------------------------------------------------------ *
 * Montar
 * ------------------------------------------------------------------ */

test("monta no formato que a escola usa", () => {
  assert.equal(
    montarNomeTurma({
      programa: "ELAS", dia: "Quarta", horario: "14:00",
      modalidade: "PR", semestre: 2, ano: 2026,
    }),
    "ELAS Quarta 14:00 PR 2/26",
  );
});

test("hora de um dígito ganha o zero", () => {
  // "ELAS Terça 9:00" × "ELAS Terça 09:00" foi uma das divergências reais
  // entre Sponte e Presença.
  assert.equal(
    montarNomeTurma({
      programa: "ELAS", dia: "Terça", horario: "9:00",
      modalidade: "ON", semestre: 2, ano: 2026,
    }),
    "ELAS Terça 09:00 ON 2/26",
  );
});

test("o ano entra com dois dígitos", () => {
  const n = montarNomeTurma({
    programa: "EVOL", dia: "Segunda", horario: "13:40",
    modalidade: "EXT", semestre: 1, ano: 2026,
  });
  assert.equal(n, "EVOL Segunda 13:40 EXT 1/26");
  assert.ok(!n.includes("2026"), "ano de quatro dígitos quebra o casamento");
});

/* ------------------------------------------------------------------ *
 * Ler
 * ------------------------------------------------------------------ */

test("lê os nomes reais da planilha", () => {
  const casos: Array<[string, Partial<ReturnType<typeof lerNomeTurma>>]> = [
    ["EVOL Segunda 13:40 EXT 1/26", { programa: "EVOL", dia: "Segunda", modalidade: "EXT", semestre: 1 }],
    ["ELAS Quarta 14:00 PR 2/26", { programa: "ELAS", dia: "Quarta", modalidade: "PR", semestre: 2 }],
    ["EVOL Segunda 18:00 ON 1/26", { programa: "EVOL", dia: "Segunda", modalidade: "ON", semestre: 1 }],
  ];
  for (const [nome, esperado] of casos) {
    const p = lerNomeTurma(nome);
    assert.ok(p, `não leu: ${nome}`);
    for (const [k, v] of Object.entries(esperado!)) {
      assert.equal((p as any)[k], v, `${nome} → ${k}`);
    }
    assert.equal(p!.ano, 2026);
  }
});

test("ida e volta não perde nada", () => {
  const nome = "MAST Terça 18:30 PR 2/26";
  assert.equal(montarNomeTurma(lerNomeTurma(nome)!), nome);
});

test("aceita o ano com quatro dígitos ao ler", () => {
  // O Presença grava "2/2026"; ler precisa funcionar, montar sempre usa 2.
  const p = lerNomeTurma("ELAS Quarta 14:00 PR 2/2026");
  assert.equal(p?.ano, 2026);
  assert.equal(montarNomeTurma(p!), "ELAS Quarta 14:00 PR 2/26");
});

test("nome fora do padrão devolve null", () => {
  // São os que hoje não casam entre as plataformas.
  for (const n of ["Clube Elas", "Imersão", "Manhã", "Evolution - Terça (14:00) - Único - 2026"]) {
    assert.equal(lerNomeTurma(n), null, `${n} não deveria ser lido como padrão`);
  }
});

/* ------------------------------------------------------------------ *
 * O nome gerado casa entre plataformas
 * ------------------------------------------------------------------ */

test("o nome gerado casa com o que o Presença guarda", () => {
  // O Presença escreve "2/2026"; o casamento é por `chaveTurma`, que iguala
  // os dois jeitos. Se isso quebrar, turma nova volta a não casar.
  const nosso = montarNomeTurma({
    programa: "ELAS", dia: "Quarta", horario: "14:00",
    modalidade: "PR", semestre: 2, ano: 2026,
  });
  assert.equal(chaveTurma(nosso), chaveTurma("ELAS Quarta 14:00 PR 2/2026"));
});

/* ------------------------------------------------------------------ *
 * Modalidade
 * ------------------------------------------------------------------ */

test("formato e local viram o código certo", () => {
  // Conferido contra as 40 turmas: PR×21, ON×10, EXT×2, HB×1.
  assert.equal(codigoDaModalidade("Presencial", "Financial"), "PR");
  assert.equal(codigoDaModalidade("Online", "Outro"), "ON");
  assert.equal(codigoDaModalidade("Presencial", "Outro"), "EXT");
  assert.equal(codigoDaModalidade("Hibrido", "Financial"), "HB");
});

test("online na Financial continua sendo ON", () => {
  // Duas turmas assim estão sem código na planilha. É falha de digitação,
  // não uma quinta modalidade.
  assert.equal(codigoDaModalidade("Online", "Financial"), "ON");
});

test("o código devolve formato e local de volta", () => {
  assert.equal(modalidadePorCodigo("EXT")?.local, "Outro");
  assert.equal(modalidadePorCodigo("ext")?.formato, "Presencial");
  assert.equal(modalidadePorCodigo("ZZ"), null);
});

/* ------------------------------------------------------------------ *
 * Dia da semana
 * ------------------------------------------------------------------ */

test("dia vira o número que o Presença usa", () => {
  // `dias_semana` na tabela `turmas` é vetor de inteiros com domingo = 0.
  assert.equal(diaParaNumero("Domingo"), 0);
  assert.equal(diaParaNumero("Quarta"), 3);
  assert.equal(diaParaNumero("Sábado"), 6);
  assert.equal(numeroParaDia(3), "Quarta");
  assert.equal(numeroParaDia(9), null);
});
