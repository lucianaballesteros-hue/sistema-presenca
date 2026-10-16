/**
 * Diagnóstico da conexão com o WSAPIEdu (Sponte).
 *
 *     node --env-file=.env scripts/validar-sponte.ts
 *
 * Usa `GetTurmas`, que é **somente leitura** — nada é criado ou alterado no
 * ERP. Serve para três coisas, nesta ordem:
 *
 *   1. confirmar que SPONTE_KEY + SPONTE_CODIGO_CLIENTE funcionam;
 *   2. descobrir o formato real da resposta (o WSDL só mostra `xmlxml`);
 *   3. descobrir o formato de `sParametrosBusca`, que não é documentado.
 *
 * Nunca imprime as credenciais. A resposta de GetTurmas não contém dado
 * pessoal de aluno — só turma, horário, professor e vagas.
 */

import { chamarSoap, credenciaisDoAmbiente, SponteError } from "../supabase/functions/_shared/soap.ts";

const env = { get: (chave: string) => process.env[chave] };

function titulo(texto: string): void {
  console.log(`\n${"─".repeat(64)}\n${texto}\n${"─".repeat(64)}`);
}

/** Corta a resposta para caber no terminal sem perder o começo da estrutura. */
function amostra(xml: string, limite = 1500): string {
  return xml.length > limite ? `${xml.slice(0, limite)}\n… (+${xml.length - limite} caracteres)` : xml;
}

const cred = credenciaisDoAmbiente(env);
console.log(`Código de cliente: ${cred.codigoCliente}`);
console.log(`Token: ${"•".repeat(cred.token.length)} (${cred.token.length} caracteres)`);

/* ------------------------------------------------------------------ *
 * 1. A chamada funciona?
 * ------------------------------------------------------------------ */

titulo("1. GetTurmas com sParametrosBusca vazio");

let primeiraResposta = "";
try {
  // ignorarRetornoOperacao: queremos VER o valor cru, não deixar a checagem
  // lançar antes de conseguirmos lê-lo.
  primeiraResposta = await chamarSoap(
    "GetTurmas",
    [
      ["nCodigoCliente", cred.codigoCliente],
      ["sToken", cred.token],
      ["sParametrosBusca", ""],
    ],
    { ignorarRetornoOperacao: true, timeoutMs: 60_000 },
  );

  console.log(`✔ Respondeu. ${primeiraResposta.length} caracteres de XML interno.\n`);
  console.log(amostra(primeiraResposta));
} catch (erro) {
  if (erro instanceof SponteError) {
    console.log(`✖ ${erro.tipo}: ${erro.message}`);
    if (erro.detalhe) console.log(`\nDetalhe:\n${amostra(erro.detalhe, 1200)}`);
  } else {
    console.log("✖ Erro inesperado:", erro);
  }
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 2. O que veio dentro?
 * ------------------------------------------------------------------ */

titulo("2. Estrutura da resposta");

const retorno = primeiraResposta.match(/<RetornoOperacao[^>]*>([\s\S]*?)<\/RetornoOperacao>/i);
console.log(`RetornoOperacao: ${retorno ? JSON.stringify(retorno[1].trim()) : "(campo ausente)"}`);

// Conta os elementos mais frequentes — revela o nome do nó de repetição sem
// precisar adivinhar (wsTurma? Turma? Table?).
const contagem = new Map<string, number>();
for (const [, nome] of primeiraResposta.matchAll(/<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>/g)) {
  contagem.set(nome, (contagem.get(nome) ?? 0) + 1);
}
const frequentes = [...contagem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log("\nElementos mais frequentes:");
for (const [nome, n] of frequentes) console.log(`  ${String(n).padStart(5)}×  <${nome}>`);

/* ------------------------------------------------------------------ *
 * 3. Como filtrar?
 * ------------------------------------------------------------------ */

titulo("3. Formato de sParametrosBusca");

// A hipótese registrada em docs/API-SPONTE.md é "Campo=valor;Campo2=valor2".
// Se estiver certa, um filtro restritivo devolve menos dados que o vazio.
// Se o tamanho não mudar, o filtro foi ignorado — e a hipótese está errada.
const tentativas = [
  "",
  "TurmaID=0",
  "Situacao=1",
  "SituacaoTurma=1",
  "Nome=",
];

for (const filtro of tentativas) {
  try {
    const r = await chamarSoap(
      "GetTurmas",
      [
        ["nCodigoCliente", cred.codigoCliente],
        ["sToken", cred.token],
        ["sParametrosBusca", filtro],
      ],
      { ignorarRetornoOperacao: true, timeoutMs: 60_000 },
    );
    const n = (r.match(/<TurmaID>/g) ?? []).length;
    const rel = r.length === primeiraResposta.length ? "= vazio" : "≠ vazio";
    console.log(`  ${JSON.stringify(filtro).padEnd(20)} → ${String(n).padStart(4)} turmas, ${String(r.length).padStart(7)} chars (${rel})`);
  } catch (erro) {
    const msg = erro instanceof SponteError ? `${erro.tipo}: ${erro.message}` : String(erro);
    console.log(`  ${JSON.stringify(filtro).padEnd(20)} → ✖ ${msg}`);
  }
}

console.log("\nLeitura: se todos derem o mesmo tamanho, sParametrosBusca está");
console.log("sendo ignorado e o formato da hipótese está errado.\n");
