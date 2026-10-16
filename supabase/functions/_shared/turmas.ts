/**
 * Operação `GetTurmas` do WSAPIEdu e a tradução do XML para o nosso modelo.
 *
 * A tradução não é cosmética — ela absorve as peculiaridades da origem para que
 * o resto do sistema não precise conhecê-las (todas verificadas contra a
 * produção em 24/09/2026, ver `docs/API-SPONTE.md`):
 *
 *   - datas chegam em `dd/mm/aaaa`, não ISO;
 *   - `ProfessorRegenteID` é `0` — e não nulo — quando a turma não tem professor;
 *   - `Sigla` vem truncada na origem (`"Avançado ("`), então não é exposta;
 *   - `Horario` é texto livre (`"(Migração)"`), serve para exibir e nada mais.
 */

import {
  chamarSoap,
  type CredenciaisSponte,
  credenciais,
  desescaparXml,
  lerRetornoOperacao,
  type OpcoesChamada,
  RETORNO_SEM_REGISTROS,
} from "./soap.ts";

export interface TurmaSponte {
  turmaId: number;
  nome: string;
  situacao: string;
  turno: string;
  moduloAtual: number;
  cursoId: number;
  curso: string;
  anoLetivo: number;
  /** ISO `aaaa-mm-dd`, ou `null` se a origem não trouxe data válida. */
  dataInicio: string | null;
  dataTermino: string | null;
  maxAlunos: number;
  vagasOcupadas: number;
  /** Derivado. Nunca negativo — a origem já traz turma acima da lotação. */
  vagasLivres: number;
  matrizCurricular: string;
  observacao: string;
  /** Texto livre. Para exibir, nunca para lógica de agendamento. */
  horario: string;
  professorRegente: string | null;
  professorRegenteId: number | null;
}

/* ------------------------------------------------------------------ *
 * Leitura de campos
 * ------------------------------------------------------------------ */

/**
 * Lê um campo do bloco XML de uma turma.
 *
 * Devolve `""` tanto para campo auto-fechado (`<Observacao />`) quanto para
 * campo ausente: para o consumidor as duas situações significam a mesma coisa,
 * e distingui-las só empurraria a checagem para quem chama.
 */
function lerCampo(bloco: string, nome: string): string {
  const vazio = new RegExp(`<${nome}(?:\\s[^>]*)?/>`);
  if (vazio.test(bloco)) return "";

  const achado = bloco.match(
    new RegExp(`<${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</${nome}>`),
  );
  return achado ? desescaparXml(achado[1]).trim() : "";
}

function lerInteiro(bloco: string, nome: string): number {
  const bruto = lerCampo(bloco, nome);
  const n = Number.parseInt(bruto, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Converte `dd/mm/aaaa` para ISO `aaaa-mm-dd`.
 *
 * Valida os intervalos em vez de confiar na `Date`, que aceita "31/02" e
 * silenciosamente devolve 3 de março — transformando dado inválido em dado
 * plausível, que é o pior resultado possível.
 */
export function dataBrParaIso(bruto: string): string | null {
  const m = bruto.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;

  const [, dia, mes, ano] = m;
  const d = Number(dia), mn = Number(mes), a = Number(ano);
  if (mn < 1 || mn > 12 || d < 1 || d > 31 || a < 1900) return null;

  const diasNoMes = new Date(a, mn, 0).getDate();
  if (d > diasNoMes) return null;

  return `${ano}-${mes}-${dia}`;
}

/* ------------------------------------------------------------------ *
 * Parse
 * ------------------------------------------------------------------ */

/** Converte o XML interno de `GetTurmas` na lista de turmas. */
export function parsearTurmas(xmlInterno: string): TurmaSponte[] {
  // 43 = "nenhum registro". Vem acompanhado de um <wsTurma> fantasma, com
  // todos os campos zerados, que não representa turma nenhuma.
  if (lerRetornoOperacao(xmlInterno)?.codigo === RETORNO_SEM_REGISTROS) return [];

  const blocos = xmlInterno.match(/<wsTurma>[\s\S]*?<\/wsTurma>/g) ?? [];

  return blocos
    .map((bloco): TurmaSponte => {
      const maxAlunos = lerInteiro(bloco, "MaxAlunos");
      const vagasOcupadas = lerInteiro(bloco, "VagasOcupadas");
      const professorId = lerInteiro(bloco, "ProfessorRegenteID");
      const professorNome = lerCampo(bloco, "ProfessorRegente");

      return {
        turmaId: lerInteiro(bloco, "TurmaID"),
        nome: lerCampo(bloco, "Nome"),
        situacao: lerCampo(bloco, "Situacao"),
        turno: lerCampo(bloco, "Turno"),
        moduloAtual: lerInteiro(bloco, "ModuloAtual"),
        cursoId: lerInteiro(bloco, "CursoID"),
        curso: lerCampo(bloco, "Curso"),
        anoLetivo: lerInteiro(bloco, "AnoLetivo"),
        dataInicio: dataBrParaIso(lerCampo(bloco, "DataInicio")),
        dataTermino: dataBrParaIso(lerCampo(bloco, "DataTermino")),
        maxAlunos,
        vagasOcupadas,
        vagasLivres: Math.max(0, maxAlunos - vagasOcupadas),
        matrizCurricular: lerCampo(bloco, "MatrizCurricular"),
        observacao: lerCampo(bloco, "Observacao"),
        horario: lerCampo(bloco, "Horario"),
        professorRegente: professorNome === "" ? null : professorNome,
        professorRegenteId: professorId === 0 ? null : professorId,
      };
    })
    // Descarta o registro fantasma de resposta vazia, que chega com TurmaID=0.
    .filter((t) => t.turmaId > 0);
}

/* ------------------------------------------------------------------ *
 * Filtro
 * ------------------------------------------------------------------ */

/**
 * Chaves de `sParametrosBusca` que `GetTurmas` reconhece.
 *
 * Testadas uma a uma contra a produção. `Curso`, `Sigla`, `ProfessorRegenteID`
 * e `SituacaoTurma` **não** são aceitas e devolvem erro 21 — `SituacaoTurma` é
 * a pegadinha, porque é o nome que a API REST 1.0 usa para a mesma ideia.
 */
export type ChaveFiltroTurma =
  | "Nome"
  | "TurmaID"
  | "CursoID"
  | "AnoLetivo"
  | "Turno"
  | "Situacao";

export type FiltroTurmas = Partial<Record<ChaveFiltroTurma, string | number>>;

/**
 * Monta a string de `sParametrosBusca`.
 *
 * Duas decisões vêm do comportamento observado do servidor:
 *
 * - **Filtro vazio vira `Nome=`**, porque string vazia é recusada com erro 21,
 *   enquanto uma chave válida sem valor devolve tudo.
 * - **O separador é `;`**. Usar `&` não dá erro: o servidor aceita e ignora
 *   silenciosamente os filtros seguintes, devolvendo mais registros do que o
 *   pedido. Por isso `;` está fixo aqui e não é configurável.
 */
export function montarFiltroTurmas(filtro: FiltroTurmas = {}): string {
  const partes = Object.entries(filtro)
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "")
    .map(([k, v]) => `${k}=${String(v).trim()}`);

  return partes.length > 0 ? partes.join(";") : "Nome=";
}

/* ------------------------------------------------------------------ *
 * Operação
 * ------------------------------------------------------------------ */

export async function getTurmas(
  cred: CredenciaisSponte,
  filtro: FiltroTurmas = {},
  opcoes: OpcoesChamada = {},
): Promise<TurmaSponte[]> {
  const xml = await chamarSoap(
    "GetTurmas",
    [...credenciais(cred), ["sParametrosBusca", montarFiltroTurmas(filtro)]],
    opcoes,
  );
  return parsearTurmas(xml);
}

/**
 * Turmas que podem receber matrícula por um link de cadastro.
 *
 * ⚠️ O filtro de situação é aplicado **aqui, do nosso lado** — e não no
 * `sParametrosBusca` — porque a chave `Situacao` do WSAPIEdu não aceita o mesmo
 * texto que devolve: ela retorna `"Encerrada"`, mas buscar por `Situacao=Encerrada`
 * responde "nenhum registro". Enquanto a Sponte não informar o domínio correto
 * (`docs/API-SPONTE.md`, seção 10), filtrar localmente é o único caminho
 * confiável.
 *
 * `situacoesAbertas` é deliberadamente uma lista de **exclusão** por negação do
 * que conhecemos: qualquer situação diferente de "Encerrada" conta como aberta,
 * para que uma situação nova na origem não faça turmas sumirem da tela sem
 * ninguém entender por quê.
 */
export function filtrarMatriculaveis(
  turmas: TurmaSponte[],
  opcoes: { anoLetivo?: number; exigirVaga?: boolean } = {},
): TurmaSponte[] {
  const { anoLetivo, exigirVaga = true } = opcoes;

  return turmas.filter((t) => {
    if (t.situacao.trim().toLowerCase() === "encerrada") return false;
    if (anoLetivo !== undefined && t.anoLetivo !== anoLetivo) return false;
    if (exigirVaga && t.maxAlunos > 0 && t.vagasLivres <= 0) return false;
    return true;
  });
}
