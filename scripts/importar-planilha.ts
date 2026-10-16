/**
 * Importa a planilha de controle para a fila de cadastros.
 *
 *     node --env-file=.env scripts/importar-planilha.ts "caminho/planilha.xlsx"
 *     node --env-file=.env scripts/importar-planilha.ts "..." --aplicar
 *
 * Sem `--aplicar` nada é gravado: lê, diagnostica e mostra o que faria. O
 * padrão é esse porque a planilha é a fonte de verdade de 500 alunos e vale
 * conferir o resultado antes.
 *
 * Rodar de novo é seguro. A chave é nome + turma (um aluno pode ter duas
 * matrículas, e há casos assim na planilha), e os ids que já existem no banco
 * não são sobrescritos por vazio.
 */

import { Planilha } from "./ler-xlsx.ts";

const ARQUIVO = process.argv[2];
const APLICAR = process.argv.includes("--aplicar");

if (!ARQUIVO) {
  console.error(`
  Uso: node --env-file=.env scripts/importar-planilha.ts <planilha.xlsx> [--aplicar]
`);
  process.exit(1);
}

const URL_ = process.env.SUPABASE_URL!;
const KEY = process.env.SUPABASE_SECRET_KEY!;

const ABA_ALUNOS = "Base Para Cadastro-26";
/** O cabeçalho dos alunos está na linha 2, não na 1. */
const CABECALHO_ALUNOS = 2;

/**
 * As duas abas que descrevem turmas, em ordem de prioridade crescente.
 *
 * `Parâmetros` é onde a equipe edita; `turmas-consolidado` é o que a
 * automação mantém e tem mais ids preenchidos. Lendo as duas e deixando a
 * segunda sobrescrever, aproveita-se o melhor de cada uma — nenhuma sozinha
 * cobre todas as turmas.
 */
const ABAS_TURMAS: Array<{ aba: string; rotulo: string }> = [
  { aba: "Parâmetros", rotulo: "Turma" },
  { aba: "turmas-consolidado", rotulo: "Rótulo (=TURMA na planilha)" },
];

/* ------------------------------------------------------------------ *
 * Limpeza
 * ------------------------------------------------------------------ */

const texto = (v: unknown) => String(v ?? "").trim();

/** Só dígitos. "31 98818 8141" → "31988188141". */
const digitos = (v: unknown) => texto(v).replace(/\D/g, "");

/** E-mail só se for um: a coluna também recebe outras coisas. */
function email(v: unknown): string | null {
  const s = texto(v).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/**
 * Id numérico. O Excel guarda inteiro como "406.0", e `parseInt` em cima do
 * texto cru devolveria 406 por acidente — melhor converter de verdade e
 * recusar o que não for inteiro positivo.
 */
function idNumerico(v: unknown): number | null {
  const s = texto(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown) => (UUID.test(texto(v)) ? texto(v).toLowerCase() : null);

/* ------------------------------------------------------------------ *
 * Leitura
 * ------------------------------------------------------------------ */

const planilha = new Planilha(ARQUIVO);

interface Turma {
  presencaTurmaId: number | null;
  leagueClassId: string | null;
}

const turmas = new Map<string, Turma>();
for (const { aba, rotulo } of ABAS_TURMAS) {
  if (!planilha.abas.includes(aba)) {
    console.warn(`  aviso: a planilha não tem a aba "${aba}" — seguindo sem ela`);
    continue;
  }
  for (const linha of planilha.registros(aba)) {
    const nome = texto(linha[rotulo]);
    if (!nome) continue;

    const atual = turmas.get(nome) ?? { presencaTurmaId: null, leagueClassId: null };
    // Só sobrescreve com valor preenchido: uma aba sem o id não pode apagar
    // o que a outra trouxe.
    atual.presencaTurmaId = idNumerico(linha["id-presença"]) ?? atual.presencaTurmaId;
    atual.leagueClassId = uuid(linha["id-league"]) ?? atual.leagueClassId;
    turmas.set(nome, atual);
  }
}

const brutos = planilha.registros(ABA_ALUNOS, CABECALHO_ALUNOS).filter((l) => texto(l["Aluno"]));

/* ------------------------------------------------------------------ *
 * Transformação
 * ------------------------------------------------------------------ */

type Pendencia =
  | "pronto"
  | "turma sem id no Presença"
  | "turma sem id no LeagueInvest"
  | "turma sem id em nenhuma plataforma"
  | "sem e-mail para o LeagueInvest";

interface Registro {
  linha: Record<string, unknown>;
  pendencia: Pendencia;
  nome: string;
  turmaNome: string;
}

const registros: Registro[] = [];
const duplicados: string[] = [];
const vistos = new Set<string>();

for (const l of brutos) {
  const nome = texto(l["Aluno"]);
  const turmaNome = texto(l["TURMA"]);

  // A chave única no banco é nome + turma; detectar aqui evita que o lote
  // inteiro seja recusado por causa de duas linhas repetidas.
  const chave = `${nome.toLowerCase()}|${turmaNome.toLowerCase()}`;
  if (vistos.has(chave)) { duplicados.push(`${nome} — ${turmaNome}`); continue; }
  vistos.add(chave);

  const turma = turmas.get(turmaNome) ?? { presencaTurmaId: null, leagueClassId: null };
  const e = email(l["E-mail aluno"]);
  const leagueUserId = uuid(l["id-league"]);

  let pendencia: Pendencia = "pronto";
  if (!turma.presencaTurmaId && !turma.leagueClassId) pendencia = "turma sem id em nenhuma plataforma";
  else if (!turma.presencaTurmaId) pendencia = "turma sem id no Presença";
  else if (!turma.leagueClassId) pendencia = "turma sem id no LeagueInvest";
  // Sem e-mail só atrapalha quem ainda não tem conta: com o id, a matrícula
  // é ajustada sem precisar criar usuário.
  else if (!e && !leagueUserId) pendencia = "sem e-mail para o LeagueInvest";

  registros.push({
    nome, turmaNome, pendencia,
    linha: {
      origem: "planilha",
      status: "importado",
      nome,
      turma_nome: turmaNome || null,
      curso_nome: texto(l["Curso"]) || null,
      email: e,
      celular: digitos(l["Contato aluno"]) || null,
      situacao_planilha: texto(l["Situação"]) || null,
      presenca_aluno_id: idNumerico(l["id-presença"]),
      league_user_id: leagueUserId,
      presenca_turma_id: turma.presencaTurmaId,
      league_class_id: turma.leagueClassId,
      observacao: [texto(l["Obs"]), texto(l["Observações"])].filter(Boolean).join(" · ") || null,
    },
  });
}

/* ------------------------------------------------------------------ *
 * Relatório
 * ------------------------------------------------------------------ */

const conta = (f: (r: Registro) => boolean) => registros.filter(f).length;
const porPendencia = new Map<string, number>();
for (const r of registros) porPendencia.set(r.pendencia, (porPendencia.get(r.pendencia) ?? 0) + 1);

console.log(`\n  ${ARQUIVO}`);
console.log(`  aba "${ABA_ALUNOS}" · ${brutos.length} linhas com nome\n`);
console.log(`  mapa de turmas: ${turmas.size} rótulos ` +
  `(${[...turmas.values()].filter((t) => t.presencaTurmaId && t.leagueClassId).length} com os dois ids)`);
console.log(`  a importar    : ${registros.length}`);
if (duplicados.length) {
  console.log(`  repetidos     : ${duplicados.length} (mesmo nome e turma — fica só a primeira)`);
  duplicados.slice(0, 5).forEach((d) => console.log(`      ${d}`));
}

console.log(`\n  SITUAÇÃO`);
for (const [s, n] of [...new Map(registros.map((r) =>
  [texto(r.linha.situacao_planilha) || "(vazio)", 0])).keys()]
  .map((s) => [s, conta((r) => (texto(r.linha.situacao_planilha) || "(vazio)") === s)] as const)
  .sort((a, b) => b[1] - a[1])) {
  console.log(`     ${String(n).padStart(4)}  ${s}`);
}

console.log(`\n  JÁ VINCULADOS`);
console.log(`     ${String(conta((r) => !!r.linha.presenca_aluno_id)).padStart(4)}  têm id no Presença`);
console.log(`     ${String(conta((r) => !!r.linha.league_user_id)).padStart(4)}  têm id no LeagueInvest`);
console.log(`     ${String(conta((r) => !!r.linha.email)).padStart(4)}  têm e-mail`);

console.log(`\n  PENDÊNCIA PARA ATIVAR`);
for (const [p, n] of [...porPendencia].sort((a, b) => b[1] - a[1])) {
  console.log(`     ${String(n).padStart(4)}  ${p}`);
}

const semMapa = [...new Set(registros
  .filter((r) => r.pendencia === "turma sem id em nenhuma plataforma")
  .map((r) => r.turmaNome))];
if (semMapa.length) {
  console.log(`\n  TURMAS SEM NENHUM ID (precisam de alguém)`);
  semMapa.slice(0, 15).forEach((t) => console.log(`     ${t || "(sem turma)"}`));
  if (semMapa.length > 15) console.log(`     … e mais ${semMapa.length - 15}`);
}

if (!APLICAR) {
  console.log(`\n  Nada foi gravado. Para gravar, repita com --aplicar\n`);
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * Gravação
 * ------------------------------------------------------------------ */

async function rest<T = any>(caminho: string, init: any = {}): Promise<T> {
  const r = await fetch(`${URL_.replace(/\/$/, "")}/rest/v1/${caminho}`, {
    method: init.method ?? "GET",
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(init.prefer ? { Prefer: init.prefer } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${caminho} HTTP ${r.status}: ${t.slice(0, 400)}`);
  return t ? JSON.parse(t) as T : (null as T);
}

const [importacao] = await rest<any[]>("importacoes", {
  method: "POST", prefer: "return=representation",
  body: {
    arquivo: ARQUIVO.split(/[\\/]/).pop(),
    aba: ABA_ALUNOS,
    linhas_lidas: brutos.length,
    avisos: [
      ...duplicados.map((d) => ({ tipo: "repetido", detalhe: d })),
      ...semMapa.map((t) => ({ tipo: "turma_sem_id", detalhe: t })),
    ],
  },
});

console.log(`\n  importação #${importacao.id} registrada`);

/**
 * Quem já veio da planilha antes, por nome + turma.
 *
 * O casamento é feito aqui, e não com `on_conflict` do PostgREST, porque a
 * chave é `lower(trim(...))` — expressão, que o `on_conflict` não alcança.
 * Fazer no código também preserva o id da linha entre execuções, e é o id
 * que liga o aluno à ficha e aos erros já registrados.
 */
const existentes = new Map<string, number>();
for (let de = 0; ; de += 1000) {
  const pagina = await rest<any[]>(
    `alunos_staging?origem=eq.planilha&select=id,nome,turma_nome` +
    `&order=id&offset=${de}&limit=1000`);
  if (!pagina?.length) break;
  for (const l of pagina) {
    existentes.set(`${texto(l.nome).toLowerCase()}|${texto(l.turma_nome).toLowerCase()}`, l.id);
  }
  if (pagina.length < 1000) break;
}

const novos = registros.filter((r) =>
  !existentes.has(`${r.nome.toLowerCase()}|${r.turmaNome.toLowerCase()}`));
const antigos = registros.filter((r) =>
  existentes.has(`${r.nome.toLowerCase()}|${r.turmaNome.toLowerCase()}`));

console.log(`  ${novos.length} novos · ${antigos.length} já estavam na fila`);

// Em lotes: 500 linhas numa requisição só estouraria o limite do PostgREST,
// e um lote menor diz onde parou se algo falhar no meio.
const LOTE = 50;
let criados = 0;

for (let i = 0; i < novos.length; i += LOTE) {
  const fatia = novos.slice(i, i + LOTE)
    .map((r) => ({ ...r.linha, importacao_id: importacao.id }));
  const feitos = await rest<any[]>("alunos_staging", {
    method: "POST", prefer: "return=representation", body: fatia,
  });
  criados += feitos?.length ?? 0;
  process.stdout.write(`\r  criando… ${criados}/${novos.length}`);
}
if (novos.length) process.stdout.write("\n");

let atualizados = 0;
for (const r of antigos) {
  const id = existentes.get(`${r.nome.toLowerCase()}|${r.turmaNome.toLowerCase()}`)!;
  // `nome` e `turma_nome` ficam de fora: são a chave, e reescrevê-los com a
  // mesma coisa só gera ruído no histórico da linha.
  const { nome: _n, turma_nome: _t, ...campos } = r.linha as Record<string, unknown>;
  await rest(`alunos_staging?id=eq.${id}`, {
    method: "PATCH", body: { ...campos, importacao_id: importacao.id },
  });
  atualizados++;
  if (atualizados % 25 === 0) process.stdout.write(`\r  atualizando… ${atualizados}/${antigos.length}`);
}
if (antigos.length) process.stdout.write(`\r  atualizando… ${atualizados}/${antigos.length}\n`);

await rest(`importacoes?id=eq.${importacao.id}`, {
  method: "PATCH",
  body: {
    linhas_criadas: criados,
    linhas_vinculadas: atualizados,
    linhas_ignoradas: brutos.length - criados - atualizados,
  },
});

console.log(`\n  ✔ ${criados} criados, ${atualizados} atualizados (importação #${importacao.id})\n`);
