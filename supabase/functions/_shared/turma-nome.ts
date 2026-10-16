/**
 * A convenção de nome de turma da escola.
 *
 *     ELAS Quarta 14:00 PR 2/26
 *     └──┘ └────┘ └───┘ └┘ └──┘
 *      │     │      │    │   └── semestre/ano
 *      │     │      │    └────── onde e como
 *      │     │      └─────────── horário de início
 *      │     └────────────────── dia da semana
 *      └──────────────────────── programa
 *
 * Isto não é enfeite: **é o que liga as três plataformas**. O Sponte, o
 * Presença e o LeagueInvest guardam a turma separadamente e sem id comum —
 * o nome é a única chave entre eles. Hoje 32 das 49 turmas de 2026 não
 * casam porque foram nomeadas à mão, cada uma de um jeito.
 *
 * Gerando o nome a partir dos campos, turma nova nasce casada nas três.
 *
 * Levantado da aba "Parâmetros" da planilha de controle, em 11/10/2026.
 */

/** Programa. Vem da coluna "Nomeclatura". */
export const PROGRAMAS = [
  "ELAS", "EVOL", "MAST", "TEENS", "SUMMER CAMP", "CLUB ELAS", "CLUBE",
] as const;

/**
 * Onde e como a aula acontece, no código que entra no nome.
 *
 * A combinação foi conferida contra as 40 turmas da planilha: Presencial na
 * Financial dá PR (21 turmas), Online dá ON (10), Presencial fora dá EXT
 * (2), Híbrido dá HB (1).
 *
 * ⚠️ Duas turmas "Online + Financial" estão sem código nenhum no nome. É
 * inconsistência dos dados, não uma quinta categoria — online na Financial
 * continua sendo ON.
 */
export const MODALIDADES = [
  { codigo: "PR", formato: "Presencial", local: "Financial", rotulo: "Presencial na Financial" },
  { codigo: "ON", formato: "Online", local: "Financial", rotulo: "Online" },
  { codigo: "EXT", formato: "Presencial", local: "Outro", rotulo: "Presencial em outro local" },
  { codigo: "HB", formato: "Hibrido", local: "Financial", rotulo: "Híbrido" },
] as const;

export type CodigoModalidade = typeof MODALIDADES[number]["codigo"];

export const DIAS = [
  "Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado",
] as const;

export type DiaSemana = typeof DIAS[number];

export interface PartesNome {
  programa: string;
  dia: DiaSemana;
  /** "14:00" — sempre com dois dígitos na hora. */
  horario: string;
  modalidade: CodigoModalidade;
  /** 1 ou 2. */
  semestre: number;
  /** Ano com quatro dígitos; no nome aparecem os dois últimos. */
  ano: number;
}

/**
 * Monta o nome a partir das partes.
 *
 * O ano entra com dois dígitos porque é assim que a escola escreve — e
 * misturar "2/26" com "2/2026" foi justamente o que quebrou o casamento
 * entre Sponte e Presença (ver `chaveTurma` em `texto.ts`).
 */
export function montarNomeTurma(p: PartesNome): string {
  const [h, m] = p.horario.split(":");
  const hora = `${String(Number(h)).padStart(2, "0")}:${(m ?? "00").padStart(2, "0")}`;
  return `${p.programa} ${p.dia} ${hora} ${p.modalidade} ${p.semestre}/${String(p.ano).slice(-2)}`;
}

/**
 * Lê as partes de um nome já existente, ou `null` se ele não segue a
 * convenção.
 *
 * Serve para editar turma antiga sem obrigar quem edita a redigitar tudo —
 * e para mostrar, na tela, quais turmas estão fora do padrão.
 */
export function lerNomeTurma(nome: string): PartesNome | null {
  const m = /^(.+?)\s+(Domingo|Segunda|Terça|Quarta|Quinta|Sexta|Sábado)\s+(\d{1,2}:\d{2})\s+(PR|ON|EXT|HB)\s+([12])\/(\d{2,4})$/i
    .exec(nome.trim());
  if (!m) return null;

  const ano = Number(m[6]);
  return {
    programa: m[1].trim().toUpperCase(),
    dia: (m[2][0].toUpperCase() + m[2].slice(1).toLowerCase()) as DiaSemana,
    horario: m[3].padStart(5, "0"),
    modalidade: m[4].toUpperCase() as CodigoModalidade,
    semestre: Number(m[5]),
    // "26" é 2026; quatro dígitos passam direto.
    ano: ano < 100 ? 2000 + ano : ano,
  };
}

/** A modalidade pelo código, para traduzir entre as plataformas. */
export function modalidadePorCodigo(codigo: string) {
  return MODALIDADES.find((m) => m.codigo === codigo.toUpperCase()) ?? null;
}

/** O código a partir de formato e local, que é como a planilha guarda. */
export function codigoDaModalidade(formato: string, local: string): CodigoModalidade {
  const f = formato.trim().toLowerCase();
  const l = local.trim().toLowerCase();
  if (f.startsWith("hibrid") || f.startsWith("híbrid")) return "HB";
  if (f.startsWith("online")) return "ON";
  // Presencial fora da escola é o único caso de EXT.
  return l.startsWith("outro") ? "EXT" : "PR";
}

/**
 * O dia da semana como o Presença guarda: número, começando no domingo.
 *
 * A tabela `turmas` usa `dias_semana` como vetor de inteiros, e a chamada
 * depende disso para saber quando a aula acontece.
 */
export function diaParaNumero(dia: DiaSemana): number {
  return DIAS.indexOf(dia);
}

export function numeroParaDia(n: number): DiaSemana | null {
  return DIAS[n] ?? null;
}
