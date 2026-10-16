/**
 * Testes dos critérios de cobrança e do acionamento do time.
 *
 *     node --test supabase/functions/_shared/cobranca.test.ts
 *
 * O que mais importa aqui: o alerta **não** pode disparar por qualquer coisa.
 * Um aviso que aparece sempre deixa de ser lido, e aí o caso real passa batido.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  avaliarAlerta,
  conferirCriterios,
  type ContextoAlerta,
  type DadosParaCobranca,
  type EstadoCobranca,
  HORAS_ATE_ALERTAR,
  resumirCriterios,
} from "./cobranca.ts";

/** Cadastro completo, pronto para cobrar. */
const COMPLETO: DadosParaCobranca = {
  sponteAlunoId: 1002, responsavelId: 540, contratoId: 1135,
  contaReceberId: 1778, email: "aluno@exemplo.com", celular: "49988825335",
  cpf: "04084316016", formaCobrancaId: -28, valorParcela: 129, parcelas: 10,
};

const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const ctx = (over: Partial<ContextoAlerta> = {}): ContextoAlerta => ({
  nomeAluno: "Ismael dos Santos",
  turmaNome: "Clube Elas",
  criadoEm: horasAtras(1),
  criterios: resumirCriterios(COMPLETO),
  estado: null,
  ...over,
});

const estado = (over: Partial<EstadoCobranca> = {}): EstadoCobranca => ({
  situacao: "sem_fatura", faturaId: null, linkPagamento: null,
  dataPagamento: null, valorPago: null, formaCobranca: "Boleto Sponte Pay 2.0",
  vencimento: "12/10/2026", verificadoEm: new Date().toISOString(), ...over,
});

/* ------------------------------------------------------------------ *
 * Critérios
 * ------------------------------------------------------------------ */

test("cadastro completo não tem bloqueio", () => {
  const r = resumirCriterios(COMPLETO);
  assert.equal(r.pronto, true);
  assert.deepEqual(r.bloqueios, []);
});

test("sem responsável financeiro, bloqueia", () => {
  // Foi o que faltou no nosso primeiro cadastro real: o aluno existia, mas
  // ResponsavelFinanceiroID = 0 — não havia a quem cobrar.
  const r = resumirCriterios({ ...COMPLETO, responsavelId: null });
  assert.equal(r.pronto, false);
  assert.equal(r.bloqueios.some((b) => b.id === "responsavel"), true);
});

test("sem contrato, bloqueia", () => {
  assert.equal(resumirCriterios({ ...COMPLETO, contratoId: null }).pronto, false);
});

test("sem parcelas, bloqueia", () => {
  assert.equal(resumirCriterios({ ...COMPLETO, contaReceberId: null }).pronto, false);
});

test("forma de cobrança positiva não é Sponte Pay", () => {
  // Os ids do Sponte Pay são negativos; `1` é o boleto manual.
  const r = resumirCriterios({ ...COMPLETO, formaCobrancaId: 1 });
  assert.equal(r.bloqueios.some((b) => b.id === "forma"), true);
});

test("forma negativa é aceita", () => {
  for (const f of [-27, -28, -29, -30]) {
    assert.equal(resumirCriterios({ ...COMPLETO, formaCobrancaId: f }).pronto, true);
  }
});

test("sem canal de contato atrasa, mas não bloqueia", () => {
  // A fatura pode ser gerada; o link é que não chega a ninguém.
  const r = resumirCriterios({ ...COMPLETO, email: null, celular: null });
  assert.equal(r.pronto, true);
  assert.equal(r.atrasos.some((a) => a.id === "canal"), true);
});

test("um dos dois canais basta", () => {
  assert.equal(resumirCriterios({ ...COMPLETO, email: null }).atrasos.length, 0);
  assert.equal(resumirCriterios({ ...COMPLETO, celular: null }).atrasos.length, 0);
});

test("CPF incompleto atrasa", () => {
  const r = resumirCriterios({ ...COMPLETO, cpf: "123" });
  assert.equal(r.atrasos.some((a) => a.id === "cpf"), true);
});

test("todo critério traz detalhe legível", () => {
  for (const c of conferirCriterios(COMPLETO)) {
    assert.ok(c.detalhe.length > 0, `${c.id} sem detalhe`);
    assert.ok(c.rotulo.length > 0);
  }
});

/* ------------------------------------------------------------------ *
 * Alerta — o silêncio é o caso normal
 * ------------------------------------------------------------------ */

test("não alerta sobre cadastro recém-feito", () => {
  // Um cadastro ainda em andamento não é motivo para chamar ninguém.
  assert.equal(avaliarAlerta(ctx({ criadoEm: horasAtras(0) })), null);
  assert.equal(avaliarAlerta(ctx({ criadoEm: horasAtras(HORAS_ATE_ALERTAR / 2) })), null);
});

test("alerta quando o prazo passa sem fatura", () => {
  const a = avaliarAlerta(ctx({ criadoEm: horasAtras(HORAS_ATE_ALERTAR + 1) }));
  assert.equal(a?.motivo, "fatura_nao_gerada");
  assert.equal(a?.urgente, false);
  assert.match(a!.acao, /Geração de Link/);
});

test("abaixo de uma hora, o alerta conta em minutos", () => {
  // "há 0h" não diz nada a quem precisa agir.
  const a = avaliarAlerta(ctx({ criadoEm: horasAtras(0.75) }));
  assert.match(a!.descricao, /há 45 min/);
});

test("não alerta quando a fatura foi gerada", () => {
  const a = avaliarAlerta(ctx({
    criadoEm: horasAtras(48),
    estado: estado({ situacao: "fatura_gerada", faturaId: 20081, linkPagamento: "https://pay/x" }),
  }));
  assert.equal(a, null);
});

test("não alerta quando já foi pago", () => {
  const a = avaliarAlerta(ctx({
    criadoEm: horasAtras(100),
    estado: estado({ situacao: "paga", dataPagamento: "08/10/2026" }),
  }));
  assert.equal(a, null);
});

test("bloqueio alerta na hora, sem esperar prazo", () => {
  // Esperar 4h por algo que nunca vai acontecer sozinho só atrasa a correção.
  const a = avaliarAlerta(ctx({
    criadoEm: horasAtras(0.1),
    criterios: resumirCriterios({ ...COMPLETO, responsavelId: null }),
  }));
  assert.equal(a?.motivo, "criterio_bloqueante");
  assert.equal(a?.urgente, true);
  assert.match(a!.descricao, /Responsável financeiro/);
});

test("sem canal de contato alerta na hora", () => {
  const a = avaliarAlerta(ctx({
    criadoEm: horasAtras(0.1),
    criterios: resumirCriterios({ ...COMPLETO, email: null, celular: null }),
  }));
  assert.equal(a?.motivo, "falha_no_envio");
  assert.equal(a?.urgente, true);
});

test("pagamento confirmado silencia até um bloqueio", () => {
  // Pago é pago: não faz sentido pedir correção de cadastro depois disso.
  const a = avaliarAlerta(ctx({
    criterios: resumirCriterios({ ...COMPLETO, responsavelId: null }),
    estado: estado({ situacao: "paga", dataPagamento: "08/10/2026" }),
  }));
  assert.equal(a, null);
});

test("todo alerta diz o que fazer", () => {
  const casos = [
    ctx({ criadoEm: horasAtras(10) }),
    ctx({ criterios: resumirCriterios({ ...COMPLETO, contratoId: null }) }),
    ctx({ criterios: resumirCriterios({ ...COMPLETO, email: null, celular: null }) }),
  ];
  for (const c of casos) {
    const a = avaliarAlerta(c);
    assert.ok(a, "deveria alertar");
    assert.ok(a!.acao.length > 20, `ação vaga: ${a!.acao}`);
    assert.ok(a!.titulo.includes("Ismael"), "o alerta precisa nomear o aluno");
  }
});
