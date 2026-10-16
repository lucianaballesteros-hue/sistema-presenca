/**
 * Testes da fila da automação.
 *
 *     node --test supabase/functions/_shared/sponte-web.test.ts
 *
 * O que está em jogo: a sessão do Sponte é uma só, e gerar um link são dois
 * postbacks encadeados. Se duas gerações se intercalarem, o filtro de uma
 * sobrescreve o da outra — e o pior desfecho não é falhar, é gerar a cobrança
 * da pessoa errada. Por isso a ordem é testada, não suposta.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SponteWeb } from "./sponte-web.ts";

/** Instância só para a fila: nenhum teste aqui chega à rede. */
const nova = () => new SponteWeb({ login: "x", senha: "y" });

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("operações enfileiradas não se intercalam", async () => {
  const web = nova();
  const eventos: string[] = [];

  // A primeira é lenta de propósito: sem fila, a segunda entraria no meio.
  const a = web.emFila(async () => {
    eventos.push("a:inicio");
    await espera(40);
    eventos.push("a:fim");
  });
  const b = web.emFila(async () => {
    eventos.push("b:inicio");
    await espera(5);
    eventos.push("b:fim");
  });

  await Promise.all([a, b]);
  assert.deepEqual(eventos, ["a:inicio", "a:fim", "b:inicio", "b:fim"]);
});

test("mantém a ordem de chegada", async () => {
  const web = nova();
  const ordem: number[] = [];

  await Promise.all(
    [0, 1, 2, 3, 4].map((i) =>
      web.emFila(async () => {
        // Quanto mais tarde chega, menos demora: sem fila, a ordem inverteria.
        await espera(25 - i * 5);
        ordem.push(i);
      })),
  );

  assert.deepEqual(ordem, [0, 1, 2, 3, 4]);
});

test("uma falha não trava a fila", async () => {
  // O caso que mais importa na prática: o Sponte recusa um cadastro e os
  // alunos seguintes não podem ficar sem link por causa disso.
  const web = nova();
  const feitas: string[] = [];

  const quebra = web.emFila(async () => { throw new Error("o Sponte recusou"); });
  const depois = web.emFila(async () => { feitas.push("seguinte"); return "ok"; });

  await assert.rejects(quebra, /o Sponte recusou/);
  assert.equal(await depois, "ok");
  assert.deepEqual(feitas, ["seguinte"]);
});

test("devolve o valor de quem chamou", async () => {
  const web = nova();
  assert.equal(await web.emFila(async () => 42), 42);
});

test("a fila não bloqueia instâncias diferentes", async () => {
  // Cada instância tem a sua sessão; serializar entre elas só atrasaria.
  const um = nova(), outro = nova();
  const eventos: string[] = [];

  await Promise.all([
    um.emFila(async () => { await espera(30); eventos.push("um"); }),
    outro.emFila(async () => { await espera(5); eventos.push("outro"); }),
  ]);

  assert.deepEqual(eventos, ["outro", "um"]);
});
