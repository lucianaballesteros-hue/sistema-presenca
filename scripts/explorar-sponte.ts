/**
 * Exploração da resposta real de GetTurmas.
 *
 *     node --env-file=.env scripts/explorar-sponte.ts
 *
 * Somente leitura. Complementa `validar-sponte.ts`: agora que sabemos que o
 * filtro funciona, o objetivo é mapear (a) o código de RetornoOperacao em caso
 * de sucesso, (b) os campos reais de wsTurma, (c) quais chaves de filtro o
 * servidor aceita.
 */

import { chamarSoap, credenciaisDoAmbiente } from "../supabase/functions/_shared/soap.ts";

const cred = credenciaisDoAmbiente({ get: (c: string) => process.env[c] });

function titulo(t: string): void {
  console.log(`\n${"─".repeat(64)}\n${t}\n${"─".repeat(64)}`);
}

async function getTurmas(filtro: string): Promise<string> {
  return await chamarSoap(
    "GetTurmas",
    [
      ["nCodigoCliente", cred.codigoCliente],
      ["sToken", cred.token],
      ["sParametrosBusca", filtro],
    ],
    { ignorarRetornoOperacao: true, timeoutMs: 90_000 },
  );
}

/* 1. Como é uma resposta de SUCESSO? -------------------------------- */

titulo("1. Primeira <wsTurma> de uma resposta bem-sucedida (Nome=)");

const todas = await getTurmas("Nome=");
const primeira = todas.match(/<wsTurma>[\s\S]*?<\/wsTurma>/);
console.log(primeira ? primeira[0].replace(/></g, ">\n<") : "(nenhuma wsTurma)");

titulo("2. Valores distintos de RetornoOperacao nessa resposta");

const retornos = new Map<string, number>();
for (const [, v] of todas.matchAll(/<RetornoOperacao[^>]*>([\s\S]*?)<\/RetornoOperacao>/gi)) {
  const t = v.trim();
  retornos.set(t, (retornos.get(t) ?? 0) + 1);
}
for (const [v, n] of retornos) console.log(`  ${String(n).padStart(4)}×  ${JSON.stringify(v)}`);
console.log(`\nTotal de <wsTurma>: ${(todas.match(/<wsTurma>/g) ?? []).length}`);

/* 3. Quais campos existem de verdade? ------------------------------- */

titulo("3. Campos presentes em wsTurma (união de todas as turmas)");

const campos = new Map<string, number>();
for (const bloco of todas.match(/<wsTurma>[\s\S]*?<\/wsTurma>/g) ?? []) {
  for (const [, nome] of bloco.matchAll(/<([A-Za-z_][\w.-]*)(?:\s[^>]*)?\/?>/g)) {
    if (nome === "wsTurma") continue;
    campos.set(nome, (campos.get(nome) ?? 0) + 1);
  }
}
for (const [nome, n] of [...campos].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}/174  <${nome}>`);
}

/* 4. Quais chaves de filtro o servidor aceita? ---------------------- */

titulo("4. Chaves de filtro — aceita ou recusa?");

const chaves = [
  "Nome", "TurmaID", "Situacao", "CursoID", "Curso", "AnoLetivo",
  "Turno", "ProfessorRegenteID", "SituacaoTurma", "Sigla", "Inexistente",
];

for (const chave of chaves) {
  const r = await getTurmas(`${chave}=`);
  const erro = r.match(/<RetornoOperacao[^>]*>([\s\S]*?)<\/RetornoOperacao>/i);
  const n = (r.match(/<wsTurma>/g) ?? []).length;
  const msg = erro ? erro[1].trim() : "(sem RetornoOperacao)";
  const veredito = n > 1 ? `✔ aceita (${n} turmas)` : `✖ ${msg}`;
  console.log(`  ${chave.padEnd(20)} ${veredito}`);
}

/* 5. Combinação de filtros ------------------------------------------ */

titulo("5. Separador de múltiplos filtros");

for (const filtro of ["Nome=;Situacao=", "Nome=&Situacao=", "Nome=|Situacao="]) {
  const r = await getTurmas(filtro);
  const n = (r.match(/<wsTurma>/g) ?? []).length;
  const erro = r.match(/<RetornoOperacao[^>]*>([\s\S]*?)<\/RetornoOperacao>/i);
  console.log(`  ${JSON.stringify(filtro).padEnd(24)} → ${n > 1 ? `✔ ${n} turmas` : `✖ ${erro?.[1].trim()}`}`);
}
