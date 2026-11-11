/**
 * As guardas dos botões de pagamento — o que é recusado antes de tocar o
 * Sponte. Nenhum teste aqui chega à rede: escolher a forma é escrita real
 * no ERP e irreversível para o aluno.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FORMAS, prepararPagamento } from "./cartao.ts";

const FICHA = { id: 1, status: "enviado", pagamentoLink: "https://x/SpontePay.aspx?id=1", contaReceberId: 1858 };
const registros: Record<string, unknown>[] = [];
const deps = (extra = {}) => ({
  web: null, escritaLiberada: true, registrar: (e: Record<string, unknown>) => registros.push(e), ...extra,
});

test("as três formas da tela", () => {
  assert.deepEqual([...FORMAS], ["cartao", "pix", "boleto"]);
});

test("forma desconhecida é recusada", async () => {
  const r = await prepararPagamento(FICHA, "dinheiro" as never, deps());
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.motivo, "forma_invalida");
});

test("sem link de pagamento não há o que escolher", async () => {
  for (const forma of FORMAS) {
    const r = await prepararPagamento({ ...FICHA, pagamentoLink: null }, forma, deps());
    assert.equal(r.ok === false && r.motivo, "sem_link", forma);
  }
});

test("simulação não escolhe nada no Sponte", async () => {
  for (const forma of FORMAS) {
    const r = await prepararPagamento(FICHA, forma, deps({ escritaLiberada: false }));
    assert.equal(r.ok === false && r.motivo, "simulado", forma);
  }
});

test("cartão sem acesso ao ERP para antes de escolher", async () => {
  // Escolher a recorrência e depois não conseguir o link do plano deixaria
  // o aluno sem Pix, sem boleto e sem cartão.
  const r = await prepararPagamento(FICHA, "cartao", deps({ web: null }));
  assert.equal(r.ok === false && r.motivo, "sem_acesso_web");
});

test("toda recusa fica registrada", () => {
  assert.ok(registros.length > 0);
  assert.ok(registros.every((e) => e.ok === false && String(e.operacao).startsWith("pagar com")));
});
