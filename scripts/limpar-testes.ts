/**
 * Lista os registros de teste criados no Sponte.
 *
 *     node --env-file=.env scripts/limpar-testes.ts
 *
 * ⚠️ **Não apaga nada** — e não poderia: o WSAPIEdu não tem nenhuma operação de
 * exclusão entre as suas 138. Este script só encontra o que foi criado com o
 * prefixo de teste e imprime a lista, para alguém remover pela interface do
 * Sponte (Cadastros → Alunos → filtrar por nome → Excluir).
 *
 * Rode sempre que terminar uma rodada de testes com SPONTE_ESCRITA=1.
 */
import { chamarSoap, credenciais, credenciaisDoAmbiente, desescaparXml } from "../supabase/functions/_shared/soap.ts";
import { PREFIXO_TESTE } from "../supabase/functions/_shared/matricula.ts";

const cred = credenciaisDoAmbiente({ get: (c: string) => process.env[c] });
const opc = { ignorarRetornoOperacao: true, timeoutMs: 180_000 };

const xml = await chamarSoap("GetAlunos4",
  [...credenciais(cred), ["sParametrosBusca", `Nome=${PREFIXO_TESTE}`]], opc);

const blocos = xml.match(/<wsAluno>[\s\S]*?<\/wsAluno>/g) ?? [];
const campo = (b: string, n: string) =>
  desescaparXml(b.match(new RegExp(`<${n}>([\s\S]*?)</${n}>`))?.[1] ?? "").trim();

const achados = blocos.filter((b) => campo(b, "Nome").includes(PREFIXO_TESTE));

if (!achados.length) {
  console.log(`\n  Nenhum registro de teste encontrado. Base limpa.\n`);
} else {
  console.log(`\n  ${achados.length} REGISTRO(S) DE TESTE no Sponte (código ${cred.codigoCliente}):\n`);
  for (const b of achados) {
    console.log(`   AlunoID ${campo(b, "AlunoID").padStart(6)}  ${campo(b, "Nome")}`);
    console.log(`           CPF ${campo(b, "CPF") || "—"} · cadastrado em ${campo(b, "DataCadastro") || "—"} · ${campo(b, "Situacao")}`);
  }
  console.log(`\n  COMO APAGAR (não há API para isso):`);
  console.log(`   1. Sponte → Cadastros → Alunos`);
  console.log(`   2. Filtrar por nome: ${PREFIXO_TESTE}`);
  console.log(`   3. Para cada um: Contratos do Aluno → encerrar/excluir o contrato`);
  console.log(`   4. Financeiro → remover os títulos em aberto`);
  console.log(`   5. Então Excluir o aluno\n`);
  console.log(`  A ordem importa: o Sponte recusa excluir aluno com contrato ou título.\n`);
}
