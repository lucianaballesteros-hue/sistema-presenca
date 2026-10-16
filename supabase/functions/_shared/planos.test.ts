/**
 * Testes de planos e bolsas.
 *
 *     node --test supabase/functions/_shared/planos.test.ts
 *
 * As amostras vêm da base real da escola (25/09/2026). Os valores conferem com
 * o que scripts/explorar-comercial.ts imprimiu.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  aplicarBolsa,
  arredondar,
  type Bolsa,
  formatarBRL,
  parsearBolsas,
  parsearPlanos,
  planoPreferido,
  type PlanoCurso,
} from "./planos.ts";

/** Plano real: Clube Elas — R$ 129,00 × 10 = R$ 1.290,00. */
const PLANO_CLUBE = `<wsPlanoCurso>
<RetornoOperacao>01 - Operação Realizada com Sucesso.</RetornoOperacao>
<PlanoCursoID>21</PlanoCursoID>
<CursoID>18</CursoID>
<DescricaoPlano>Clube Elas</DescricaoPlano>
<Situacao>1</Situacao>
<Padrao>1</Padrao>
<ValorPrimeiraParcelaMensalidade>129.00</ValorPrimeiraParcelaMensalidade>
<ValorParcelaMensalidade>129.00</ValorParcelaMensalidade>
<NumeroParcelasMensalidade>10</NumeroParcelasMensalidade>
<ValorParcelaMatricula>0</ValorParcelaMatricula>
<NumeroParcelasMatricula>0</NumeroParcelasMatricula>
<ValorParcelaMaterial>0</ValorParcelaMaterial>
<NumeroParcelasMaterial>0</NumeroParcelasMaterial>
<ValorParcelaOutros>0</ValorParcelaOutros>
<NumeroParcelasOutros>0</NumeroParcelasOutros>
<BolsaIDMensalidade>0</BolsaIDMensalidade>
<DescricaoBolsaMensalidade />
</wsPlanoCurso>`;

/** Bolsas reais: 5%, 7% e 10%, todas com Dias=0. */
const BOLSAS_REAIS = `
<wsBolsa><RetornoOperacao>01 - Operação Realizada com Sucesso.</RetornoOperacao>
  <BolsaID>2</BolsaID><Descricao>Bolsa 5%</Descricao><TipoDesconto>%</TipoDesconto>
  <Descontos><wsDescontos><Dias>0</Dias><Desconto>5</Desconto></wsDescontos></Descontos>
</wsBolsa>
<wsBolsa><RetornoOperacao>01 - Operação Realizada com Sucesso.</RetornoOperacao>
  <BolsaID>4</BolsaID><Descricao>Bolsa 10%</Descricao><TipoDesconto>%</TipoDesconto>
  <Descontos><wsDescontos><Dias>0</Dias><Desconto>10</Desconto></wsDescontos></Descontos>
</wsBolsa>`;

const SEM_REGISTROS =
  `<wsPlanoCurso><RetornoOperacao>43 - Nenhum registro foi encontrado para os parâmetros de busca informados.</RetornoOperacao><PlanoCursoID>0</PlanoCursoID></wsPlanoCurso>`;

/* ------------------------------------------------------------------ *
 * Planos
 * ------------------------------------------------------------------ */

test("parsearPlanos lê o plano real do Clube Elas", () => {
  const [p] = parsearPlanos(PLANO_CLUBE);
  assert.equal(p.planoCursoId, 21);
  assert.equal(p.cursoId, 18);
  assert.equal(p.descricao, "Clube Elas");
  assert.equal(p.padrao, true);
  assert.equal(p.ativo, true);
  assert.equal(p.mensalidade.valorParcela, 129);
  assert.equal(p.mensalidade.parcelas, 10);
});

test("parsearPlanos calcula o total do contrato", () => {
  // 129,00 × 10, sem matrícula nem material — bate com a base real.
  assert.equal(parsearPlanos(PLANO_CLUBE)[0].total, 1290);
});

test("parsearPlanos soma as quatro rubricas", () => {
  const xml = PLANO_CLUBE
    .replace("<ValorParcelaMatricula>0<", "<ValorParcelaMatricula>200<")
    .replace("<NumeroParcelasMatricula>0<", "<NumeroParcelasMatricula>1<")
    .replace("<ValorParcelaMaterial>0<", "<ValorParcelaMaterial>150<")
    .replace("<NumeroParcelasMaterial>0<", "<NumeroParcelasMaterial>2<");
  // 1290 + 200 + 300
  assert.equal(parsearPlanos(xml)[0].total, 1790);
});

test("parsearPlanos ignora primeira parcela igual às demais", () => {
  // Só é "entrada" quando difere; senão poluiria a tela com informação vazia.
  assert.equal(parsearPlanos(PLANO_CLUBE)[0].primeiraMensalidade, null);
});

test("parsearPlanos detecta entrada diferente", () => {
  const xml = PLANO_CLUBE.replace(
    "<ValorPrimeiraParcelaMensalidade>129.00<",
    "<ValorPrimeiraParcelaMensalidade>300.00<",
  );
  assert.equal(parsearPlanos(xml)[0].primeiraMensalidade, 300);
});

test("parsearPlanos trata bolsa zerada como ausente", () => {
  const [p] = parsearPlanos(PLANO_CLUBE);
  assert.equal(p.bolsaId, null);
  assert.equal(p.bolsaDescricao, null);
});

test("parsearPlanos devolve lista vazia no código 43", () => {
  // Os 14 cursos inativos da escola respondem exatamente assim.
  assert.deepEqual(parsearPlanos(SEM_REGISTROS), []);
});

test("parsearPlanos aceita valor com vírgula decimal", () => {
  const xml = PLANO_CLUBE.replace(
    "<ValorParcelaMensalidade>129.00<",
    "<ValorParcelaMensalidade>1.234,56<",
  );
  assert.equal(parsearPlanos(xml)[0].mensalidade.valorParcela, 1234.56);
});

/* ------------------------------------------------------------------ *
 * Escolha do plano
 * ------------------------------------------------------------------ */

function plano(over: Partial<PlanoCurso> = {}): PlanoCurso {
  const vazia = { valorParcela: 0, parcelas: 0, total: 0 };
  return {
    planoCursoId: 1, cursoId: 1, descricao: "P", padrao: false, ativo: true,
    mensalidade: { valorParcela: 100, parcelas: 10, total: 1000 },
    primeiraMensalidade: null, matricula: vazia, material: vazia, outros: vazia,
    total: 1000, bolsaId: null, bolsaDescricao: null,
    ...over,
  };
}

test("planoPreferido escolhe o marcado como padrão", () => {
  const r = planoPreferido([plano({ planoCursoId: 1 }), plano({ planoCursoId: 2, padrao: true })], 2026);
  assert.equal(r?.planoCursoId, 2);
});

test("planoPreferido prefere o plano do ano corrente ao padrão de outro ano", () => {
  // Caso real: Financial Evolution tem como padrão um plano chamado "2027".
  // Sem este critério, a tela do aluno mostraria o preço do ano que vem.
  const r = planoPreferido([
    plano({ planoCursoId: 1, descricao: "2027", padrao: true }),
    plano({ planoCursoId: 2, descricao: "2026 Elas 3%" }),
  ], 2026);
  assert.equal(r?.planoCursoId, 2);
});

test("planoPreferido cai no padrão quando nenhum cita o ano", () => {
  const r = planoPreferido([
    plano({ planoCursoId: 1, descricao: "Clube Elas" }),
    plano({ planoCursoId: 2, descricao: "Outro", padrao: true }),
  ], 2026);
  assert.equal(r?.planoCursoId, 2);
});

test("planoPreferido ignora plano inativo", () => {
  const r = planoPreferido([plano({ planoCursoId: 1, ativo: false, padrao: true })], 2026);
  assert.equal(r, null);
});

test("planoPreferido devolve null sem planos", () => {
  assert.equal(planoPreferido([], 2026), null);
});

/* ------------------------------------------------------------------ *
 * Bolsas
 * ------------------------------------------------------------------ */

test("parsearBolsas lê as bolsas reais", () => {
  const b = parsearBolsas(BOLSAS_REAIS);
  assert.equal(b.length, 2);
  assert.deepEqual(b[0], { bolsaId: 2, descricao: "Bolsa 5%", tipoDesconto: "%", desconto: 5, dias: 0 });
  assert.equal(b[1].desconto, 10);
});

/* ------------------------------------------------------------------ *
 * Cálculo
 * ------------------------------------------------------------------ */

const bolsa = (over: Partial<Bolsa> = {}): Bolsa =>
  ({ bolsaId: 1, descricao: "B", tipoDesconto: "%", desconto: 10, dias: 0, ...over });

test("aplicarBolsa sem bolsa devolve o valor cheio", () => {
  const r = aplicarBolsa(parsearPlanos(PLANO_CLUBE)[0], null);
  assert.equal(r.valorParcela, 129);
  assert.equal(r.total, 1290);
  assert.equal(r.descontoAplicado, 0);
});

test("aplicarBolsa desconta percentual sobre a mensalidade", () => {
  const r = aplicarBolsa(parsearPlanos(PLANO_CLUBE)[0], bolsa({ desconto: 10 }));
  assert.equal(r.valorParcela, 116.1);      // 129 − 10%
  assert.equal(r.descontoAplicado, 129);    // 12,90 × 10
  assert.equal(r.total, 1161);
  assert.equal(r.valorParcelaCheia, 129);
});

test("aplicarBolsa arredonda para centavos", () => {
  // 129 − 7% = 119,97 exato; o risco é o arrasto de ponto flutuante.
  const r = aplicarBolsa(parsearPlanos(PLANO_CLUBE)[0], bolsa({ desconto: 7 }));
  assert.equal(r.valorParcela, 119.97);
  assert.equal(Number.isInteger(r.valorParcela * 100), true);
});

test("aplicarBolsa trata desconto em valor absoluto", () => {
  const r = aplicarBolsa(parsearPlanos(PLANO_CLUBE)[0], bolsa({ tipoDesconto: "R$", desconto: 29 }));
  assert.equal(r.valorParcela, 100);
});

test("aplicarBolsa nunca deixa a parcela negativa", () => {
  const r = aplicarBolsa(parsearPlanos(PLANO_CLUBE)[0], bolsa({ tipoDesconto: "R$", desconto: 500 }));
  assert.equal(r.valorParcela, 0);
});

test("arredondar corrige o arrasto de ponto flutuante", () => {
  assert.equal(arredondar(0.1 + 0.2), 0.3);
  assert.equal(arredondar(129 * 0.93), 119.97);
});

test("formatarBRL usa o padrão brasileiro", () => {
  //   é o espaço não separável que o Intl insere depois de "R$".
  assert.equal(formatarBRL(1290).replace(/ /g, " "), "R$ 1.290,00");
});
