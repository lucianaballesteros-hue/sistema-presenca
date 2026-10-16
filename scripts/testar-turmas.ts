/**
 * Valida o parser de turmas contra a base real do Sponte (somente leitura).
 *     node --env-file=.env scripts/testar-turmas.ts
 */
import { credenciaisDoAmbiente } from "../supabase/functions/_shared/soap.ts";
import { filtrarMatriculaveis, getTurmas } from "../supabase/functions/_shared/turmas.ts";

const cred = credenciaisDoAmbiente({ get: (c: string) => process.env[c] });

const todas = await getTurmas(cred, {}, { timeoutMs: 90_000 });
console.log(`Total parseado: ${todas.length} turmas\n`);

const ruins = todas.filter((t) => !t.turmaId || !t.nome || !t.anoLetivo);
console.log(`Registros com campo essencial faltando: ${ruins.length}`);

const semData = todas.filter((t) => t.dataInicio === null);
console.log(`Sem dataInicio parseável: ${semData.length}`);

const semProf = todas.filter((t) => t.professorRegenteId === null);
console.log(`Sem professor: ${semProf.length}`);

const situacoes = new Map<string, number>();
for (const t of todas) situacoes.set(t.situacao, (situacoes.get(t.situacao) ?? 0) + 1);
console.log(`\nSituações encontradas:`);
for (const [s, n] of [...situacoes].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}×  ${JSON.stringify(s)}`);
}

const anos = new Map<number, number>();
for (const t of todas) anos.set(t.anoLetivo, (anos.get(t.anoLetivo) ?? 0) + 1);
console.log(`\nPor ano letivo:`);
for (const [a, n] of [...anos].sort((x, y) => y[0] - x[0])) {
  console.log(`  ${a}: ${n}`);
}

const mat = filtrarMatriculaveis(todas, { anoLetivo: 2026 });
console.log(`\nMatriculáveis em 2026: ${mat.length}`);
for (const t of mat.slice(0, 5)) {
  console.log(`  [${t.turmaId}] ${t.nome.slice(0, 52).padEnd(52)} ${t.vagasLivres}/${t.maxAlunos} vagas`);
}

// Confere que o filtro no servidor bate com o filtro local.
const via2026 = await getTurmas(cred, { AnoLetivo: 2026 }, { timeoutMs: 90_000 });
const local2026 = todas.filter((t) => t.anoLetivo === 2026);
console.log(`\nFiltro servidor AnoLetivo=2026: ${via2026.length} | filtro local: ${local2026.length}`);
console.log(via2026.length === local2026.length ? "✔ batem" : "✖ divergem");
