/**
 * Explora o que o Sponte tem de valores e políticas comerciais.
 *
 *     node --env-file=.env scripts/explorar-comercial.ts
 *
 * Somente leitura: GetCursos, GetPlanosCursos, GetBolsas, GetFormasCobrancas.
 * Nenhum dado de aluno é consultado — só o catálogo comercial da escola.
 */

import { chamarSoap, credenciais, credenciaisDoAmbiente, desescaparXml } from "../supabase/functions/_shared/soap.ts";

const cred = credenciaisDoAmbiente({ get: (c: string) => process.env[c] });
const opc = { ignorarRetornoOperacao: true, timeoutMs: 90_000 };

const titulo = (t: string) => console.log(`\n${"─".repeat(68)}\n${t}\n${"─".repeat(68)}`);

function campo(bloco: string, nome: string): string {
  if (new RegExp(`<${nome}(?:\\s[^>]*)?/>`).test(bloco)) return "";
  const m = bloco.match(new RegExp(`<${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</${nome}>`));
  return m ? desescaparXml(m[1]).trim() : "";
}
const blocos = (xml: string, tag: string) =>
  xml.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g")) ?? [];
const brl = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "—";
};
const codigo = (xml: string) => campo(xml, "RetornoOperacao").match(/^(\d+)/)?.[1] ?? "?";

/* 1. Cursos ---------------------------------------------------------- */

titulo("1. Cursos cadastrados");

const xmlCursos = await chamarSoap(
  "GetCursos",
  [...credenciais(cred), ["sParametrosBusca", "Nome="]],
  opc,
);

const cursos = blocos(xmlCursos, "wsCurso").map((b) => ({
  id: Number(campo(b, "CursoID")),
  nome: campo(b, "Nome"),
  situacao: campo(b, "Situacao"),
  tipo: campo(b, "TipoCurso"),
  modulos: campo(b, "NumeroModulos"),
})).filter((c) => c.id > 0);

console.log(`  ${cursos.length} curso(s)\n`);
for (const c of cursos) {
  console.log(`   [${String(c.id).padStart(3)}] ${c.nome.slice(0, 40).padEnd(40)} ${c.situacao.padEnd(10)} ${c.modulos} módulo(s)`);
}

/* 2. Planos por curso ------------------------------------------------ */

titulo("2. Planos de curso — VALORES");

for (const c of cursos) {
  const xml = await chamarSoap(
    "GetPlanosCursos",
    [...credenciais(cred), ["nCursoID", c.id], ["sParametrosBusca", ""]],
    opc,
  );

  const planos = blocos(xml, "wsPlanoCurso");
  const cod = codigo(xml);

  if (cod !== "01" || !planos.length) {
    console.log(`\n  [${c.id}] ${c.nome}\n     → ${campo(xml, "RetornoOperacao") || "sem planos"}`);
    continue;
  }

  console.log(`\n  [${c.id}] ${c.nome}  —  ${planos.length} plano(s)`);

  for (const p of planos) {
    const padrao = campo(p, "Padrao") === "1" ? " ★ padrão" : "";
    console.log(`\n     ${campo(p, "DescricaoPlano") || "(sem descrição)"}${padrao}`);
    console.log(`       matrícula   ${brl(campo(p, "ValorParcelaMatricula")).padStart(12)}  × ${campo(p, "NumeroParcelasMatricula") || 0}`);
    console.log(`       mensalidade ${brl(campo(p, "ValorParcelaMensalidade")).padStart(12)}  × ${campo(p, "NumeroParcelasMensalidade") || 0}`);
    const prim = campo(p, "ValorPrimeiraParcelaMensalidade");
    if (Number(prim) > 0 && prim !== campo(p, "ValorParcelaMensalidade")) {
      console.log(`         1ª parcela diferente: ${brl(prim)}`);
    }
    console.log(`       material    ${brl(campo(p, "ValorParcelaMaterial")).padStart(12)}  × ${campo(p, "NumeroParcelasMaterial") || 0}`);
    const outros = campo(p, "ValorParcelaOutros");
    if (Number(outros) > 0) {
      console.log(`       outros      ${brl(outros).padStart(12)}  × ${campo(p, "NumeroParcelasOutros") || 0}`);
    }
    const bolsa = campo(p, "DescricaoBolsaMensalidade");
    if (bolsa) console.log(`       bolsa vinculada: ${bolsa} (id ${campo(p, "BolsaIDMensalidade")})`);

    const mens = Number(campo(p, "ValorParcelaMensalidade")) * Number(campo(p, "NumeroParcelasMensalidade") || 0);
    const mat = Number(campo(p, "ValorParcelaMatricula")) * Number(campo(p, "NumeroParcelasMatricula") || 0);
    const mtl = Number(campo(p, "ValorParcelaMaterial")) * Number(campo(p, "NumeroParcelasMaterial") || 0);
    const total = mens + mat + mtl + Number(outros) * Number(campo(p, "NumeroParcelasOutros") || 0);
    if (total > 0) console.log(`       TOTAL DO CONTRATO: ${brl(String(total))}`);
  }
}

/* 3. Bolsas ---------------------------------------------------------- */

titulo("3. Bolsas e descontos");

const xmlBolsas = await chamarSoap("GetBolsas", [...credenciais(cred), ["sTipoDesconto", ""]], opc);
const bolsas = blocos(xmlBolsas, "wsBolsa");

if (codigo(xmlBolsas) !== "01") {
  console.log(`  → ${campo(xmlBolsas, "RetornoOperacao")}`);
} else {
  console.log(`  ${bolsas.length} bolsa(s)\n`);
  for (const b of bolsas) {
    console.log(`   [${campo(b, "BolsaID")}] ${campo(b, "Descricao")}  (tipo: ${campo(b, "TipoDesconto") || "—"})`);
    for (const d of blocos(b, "wsDescontos")) {
      console.log(`         ${campo(d, "Dias").padStart(3)} dia(s) → ${campo(d, "Desconto")}`);
    }
  }
}

/* 4. Formas de cobrança ---------------------------------------------- */

titulo("4. Formas de cobrança");

const xmlFormas = await chamarSoap("GetFormasCobrancas", [...credenciais(cred)], opc);
if (codigo(xmlFormas) !== "01") {
  console.log(`  → ${campo(xmlFormas, "RetornoOperacao")}`);
} else {
  const formas = blocos(xmlFormas, "wsFormaCobranca");
  console.log(`  ${formas.length} forma(s)\n`);
  for (const f of formas) {
    console.log(`   [${campo(f, "FormaCobrancaID")}] ${campo(f, "Descricao")}`);
  }
}
