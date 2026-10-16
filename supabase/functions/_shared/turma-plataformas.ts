/**
 * A turma do Sponte espelhada no Presença e no LeagueInvest.
 *
 * **O Sponte é a fonte.** A escola cria a turma lá, com curso, plano e
 * matrícula — é de lá que ela aparece no painel. O que este módulo faz é o
 * passo seguinte: garantir que a mesma turma exista nas outras duas, e que
 * ligar e desligar aconteça nas três ao mesmo tempo.
 *
 * Três operações, nesta ordem de confiança:
 *
 *   1. **vincular** — a turma já existe lá, achada pelo nome. Nada é criado.
 *   2. **criar**     — não existe em lugar nenhum; nasce com o nome do Sponte.
 *   3. **ativar/desativar** — liga ou desliga onde ela já existe.
 *
 * O nome é a única chave entre as três plataformas (não há id comum), então
 * a turma criada aqui recebe **exatamente** o nome do Sponte. Divergir é como
 * nasceram as 32 turmas de 2026 que hoje não se encontram.
 *
 * Nada aborta por causa da outra: falhar no LeagueInvest não desfaz o
 * Presença. O resultado é parcial, fica gravado em `turmas_staging` e repetir
 * a operação só tenta o que faltou.
 *
 * Herdado do `Turmas.gs` da planilha, inclusive a cascata sobre os alunos.
 */

import { ativarAluno, desativarAluno } from "./ativacao.ts";
import type { AlunoParaAtivar } from "./ativacao.ts";
import { ClienteLeague } from "./league.ts";
import { ClientePresenca } from "./presenca.ts";
import { DIAS, lerNomeTurma } from "./turma-nome.ts";

export type PlataformaTurma = "presenca" | "league";

/** O que o Sponte sabe da turma. Subconjunto de `TurmaSponte`. */
export interface TurmaOrigem {
  turmaId: number;
  nome: string;
  curso?: string;
  cursoId?: number;
  dataInicio?: string | null;
  dataTermino?: string | null;
  professorRegente?: string | null;
  horario?: string;
  situacao?: string;
}

export interface MapaTurma {
  presencaTurmaId: number | null;
  leagueClassId: string | null;
}

export type AcaoTurma =
  | "vinculada"    // já existia lá; só guardamos o id
  | "criada"
  | "atualizada"
  | "ativada"
  | "desativada"
  | "nada"         // já estava como devia
  | "ambigua"      // vários candidatos: quem decide é uma pessoa
  | "erro";

export interface ResultadoTurmaPlataforma {
  plataforma: PlataformaTurma;
  acao: AcaoTurma;
  ok: boolean;
  mensagem: string;
  /** Candidatos, quando `acao === "ambigua"`. */
  candidatos?: string[];
  /**
   * A operação parou porque falta escolher a liga do LeagueInvest.
   *
   * A tela usa isto para abrir o seletor. Sem o sinal explícito ela teria de
   * adivinhar lendo a mensagem — que muda ao ser reescrita.
   */
  precisaLiga?: boolean;
  /** Para gravar em `turmas_staging`. Vazio quando nada mudou. */
  campos: Record<string, unknown>;
}

export interface ResultadoTurma {
  ok: boolean;
  mapa: MapaTurma;
  resultados: ResultadoTurmaPlataforma[];
  /** O que gravar em `turmas_staging`. */
  campos: Record<string, unknown>;
  /** Problemas que não são falha de plataforma — nome fora do padrão, etc. */
  avisos: string[];
}

export interface ClientesTurma {
  presenca: ClientePresenca;
  /** `null` quando o LeagueInvest não está configurado neste ambiente. */
  league: ClienteLeague | null;
}

/**
 * Quantas aulas a turma tem, por programa.
 *
 * O Sponte não guarda isso e o Presença exige o número para montar a
 * chamada. Os valores vieram da operação da escola; o 20 é o que se usa
 * quando o programa é novo.
 */
const AULAS_POR_PROGRAMA: Record<string, number> = {
  EVOL: 32,
  ELAS: 14,
  MAST: 16,
};
const AULAS_PADRAO = 20;

export function totalDeAulas(nomeTurma: string): number {
  const programa = programaDoNome(nomeTurma);
  return AULAS_POR_PROGRAMA[programa] ?? AULAS_PADRAO;
}

/** O programa da turma: do nome lido, ou a primeira palavra como palpite. */
function programaDoNome(nome: string): string {
  const partes = lerNomeTurma(nome);
  if (partes) return partes.programa.toUpperCase();
  return (nome.trim().split(/\s+/)[0] ?? "").toUpperCase();
}

/**
 * Horário de início em `HH:MM:SS`, lido do nome.
 *
 * O campo `Horario` do Sponte é texto livre ("Seg e Qua 14h às 15h30",
 * "A combinar"): não dá para confiar nele num campo `time`. O nome, quando
 * segue a convenção, traz a hora exata — e quando não segue, é melhor
 * deixar vazio do que gravar um palpite na chamada.
 */
function horarioDoNome(nome: string): string | null {
  const partes = lerNomeTurma(nome);
  return partes ? `${partes.horario}:00` : null;
}

/** Dia da semana da turma, como o Presença guarda (domingo = 0). */
function diasDoNome(nome: string): number[] | null {
  const partes = lerNomeTurma(nome);
  if (!partes) return null;
  const n = DIAS.indexOf(partes.dia);
  return n >= 0 ? [n] : null;
}

function erroPara(
  plataforma: PlataformaTurma,
  e: unknown,
): ResultadoTurmaPlataforma {
  const msg = (e as Error)?.message ?? String(e);
  return {
    plataforma,
    acao: "erro",
    ok: false,
    mensagem: msg,
    campos: { [`${plataforma}_erro`]: msg },
  };
}

/* ------------------------------------------------------------------ *
 * 1. Propagar: garantir que a turma exista nas outras duas
 * ------------------------------------------------------------------ */

/**
 * Faz a turma existir no Presença e no LeagueInvest.
 *
 * Para cada plataforma, nesta ordem:
 *
 *   - id já conhecido      → nada a fazer (o vínculo é definitivo);
 *   - achada pelo nome     → vincula, guardando o id;
 *   - vários candidatos    → **para** e devolve os candidatos;
 *   - nenhum               → cria, com o nome do Sponte.
 *
 * Ambiguidade nunca é resolvida por conta própria. Vincular a turma errada
 * mistura a chamada e o conteúdo de duas turmas — e o estrago só aparece
 * quando alguém repara que o aluno está na lista errada.
 *
 * `criar: false` faz a operação só procurar e vincular, sem criar nada.
 *
 * `ligaId` é a resposta de quem opera quando o programa é novo e não há
 * turma dele no LeagueInvest para indicar a liga — ver `ligaDoPrograma`.
 */
export async function propagarTurma(
  origem: TurmaOrigem,
  conhecido: MapaTurma,
  clientes: ClientesTurma,
  opcoes: { criar?: boolean; ligaId?: string | null } = {},
): Promise<ResultadoTurma> {
  const criar = opcoes.criar !== false;
  const mapa: MapaTurma = { ...conhecido };
  const resultados: ResultadoTurmaPlataforma[] = [];
  const avisos: string[] = [];

  if (!lerNomeTurma(origem.nome)) {
    avisos.push(
      `O nome "${origem.nome}" está fora da convenção ` +
      `(ex.: "ELAS Quarta 14:00 PR 2/26"). A turma é criada com esse nome ` +
      `mesmo — é o que casa com o Sponte —, mas o dia e o horário da ` +
      `chamada ficam em branco, porque não há como lê-los do nome.`,
    );
  }

  /* --- Presença --- */
  if (mapa.presencaTurmaId) {
    resultados.push({
      plataforma: "presenca",
      acao: "nada",
      ok: true,
      mensagem: `Já vinculada à turma ${mapa.presencaTurmaId}.`,
      campos: {},
    });
  } else {
    try {
      const { turma, candidatos } = await clientes.presenca.acharTurma(origem.nome);
      if (turma) {
        mapa.presencaTurmaId = turma.id;
        resultados.push({
          plataforma: "presenca",
          acao: "vinculada",
          ok: true,
          mensagem: `Vinculada a "${turma.turma}" (id ${turma.id}).`,
          campos: { presenca_turma_id: turma.id, presenca_erro: null },
        });
      } else if (candidatos.length) {
        resultados.push({
          plataforma: "presenca",
          acao: "ambigua",
          ok: false,
          mensagem:
            `No Presença há mais de uma turma parecida: ${candidatos.join(" · ")}. ` +
            `Escolha qual é e vincule à mão.`,
          candidatos,
          campos: {},
        });
      } else if (!criar) {
        resultados.push({
          plataforma: "presenca",
          acao: "nada",
          ok: true,
          mensagem: "Não existe no Presença.",
          campos: {},
        });
      } else {
        const nova = await clientes.presenca.criarTurma({
          nome: origem.nome,
          curso: origem.curso ?? "",
          professor: origem.professorRegente,
          horarioInicio: horarioDoNome(origem.nome),
          diasSemana: diasDoNome(origem.nome),
          totalAulas: totalDeAulas(origem.nome),
        });
        mapa.presencaTurmaId = nova.id;
        resultados.push({
          plataforma: "presenca",
          acao: "criada",
          ok: true,
          mensagem: `Criada no Presença (id ${nova.id}).`,
          campos: {
            presenca_turma_id: nova.id,
            presenca_enviado_em: new Date().toISOString(),
            presenca_erro: null,
          },
        });
      }
    } catch (e) {
      resultados.push(erroPara("presenca", e));
    }
  }

  /* --- LeagueInvest --- */
  if (!clientes.league) {
    avisos.push("O LeagueInvest não está configurado neste ambiente.");
  } else if (mapa.leagueClassId) {
    resultados.push({
      plataforma: "league",
      acao: "nada",
      ok: true,
      mensagem: "Já vinculada.",
      campos: {},
    });
  } else {
    try {
      const { classId, nome, candidatos } =
        await clientes.league.acharTurmaPorNome(origem.nome);
      if (classId) {
        mapa.leagueClassId = classId;
        resultados.push({
          plataforma: "league",
          acao: "vinculada",
          ok: true,
          mensagem: `Vinculada a "${nome}".`,
          campos: {
            league_class_id: classId,
            league_id: await ligaDe(clientes.league, classId),
            league_erro: null,
          },
        });
      } else if (candidatos.length) {
        resultados.push({
          plataforma: "league",
          acao: "ambigua",
          ok: false,
          mensagem:
            `No LeagueInvest há mais de uma turma parecida: ${candidatos.join(" · ")}. ` +
            `Escolha qual é e vincule à mão.`,
          candidatos,
          campos: {},
        });
      } else if (!criar) {
        resultados.push({
          plataforma: "league",
          acao: "nada",
          ok: true,
          mensagem: "Não existe no LeagueInvest.",
          campos: {},
        });
      } else {
        // A liga decide qual programa o aluno enxerga; sem ela não se cria.
        const programa = programaDoNome(origem.nome);
        const liga = opcoes.ligaId
          // Liga escolhida à mão vence a dedução: quem escolheu sabe algo
          // que os dados ainda não mostram (programa novo, liga nova).
          ? { id: opcoes.ligaId, nome: "escolhida à mão", turmasVistas: 0 }
          : await clientes.league.ligaDoPrograma(programa);
        if (!liga) {
          resultados.push({
            plataforma: "league",
            acao: "ambigua",
            ok: false,
            mensagem:
              `Não sei em qual liga a turma "${origem.nome}" deve nascer: não há ` +
              `nenhuma turma "${programa}" no LeagueInvest para servir de ` +
              `referência. Escolha a liga à mão.`,
            precisaLiga: true,
            campos: {},
          });
        } else {
          const classId = await clientes.league.criarTurma({
            nome: origem.nome,
            ligaId: liga.id,
            inicio: origem.dataInicio ?? null,
            fim: origem.dataTermino ?? null,
            ativa: false,
          });
          mapa.leagueClassId = classId;
          resultados.push({
            plataforma: "league",
            acao: "criada",
            ok: true,
            mensagem:
              `Criada no LeagueInvest, na liga "${liga.nome}"` +
              (liga.turmasVistas
                ? ` (a mesma das outras ${liga.turmasVistas} turmas ${programa})`
                : "") +
              `. Nasceu desativada.`,
            campos: {
              league_class_id: classId,
              league_id: liga.id,
              league_enviado_em: new Date().toISOString(),
              league_erro: null,
            },
          });
        }
      }
    } catch (e) {
      resultados.push(erroPara("league", e));
    }
  }

  return juntar(mapa, resultados, avisos);
}

/** A liga de uma turma, sem deixar a falha estragar o vínculo recém-feito. */
async function ligaDe(
  league: ClienteLeague,
  classId: string,
): Promise<string | null> {
  try {
    return await league.ligaDaTurma(classId);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 2. Ativar / desativar
 * ------------------------------------------------------------------ */

/**
 * Liga ou desliga a turma nas duas plataformas.
 *
 * Ativar propaga antes: não dá para ligar o que não existe. Desativar
 * **não** propaga — criar turma só para desligá-la em seguida seria absurdo,
 * e o que não existe já está desligado.
 *
 * O que cada plataforma entende por desligada:
 *   - Presença: `turmas.ativa = false` — sai dos filtros e da chamada;
 *   - LeagueInvest: `league_classes.is_active = false` — o conteúdo
 *     desaparece para quem está nela.
 *
 * Isto mexe **na turma**, nunca nos alunos. A cascata sobre eles é
 * `cascataDeAlunos`, chamada à parte e por escolha explícita de quem opera.
 */
export async function definirSituacaoTurma(
  origem: TurmaOrigem,
  conhecido: MapaTurma,
  ativa: boolean,
  clientes: ClientesTurma,
): Promise<ResultadoTurma> {
  let mapa: MapaTurma = { ...conhecido };
  const resultados: ResultadoTurmaPlataforma[] = [];
  const avisos: string[] = [];
  const campos: Record<string, unknown> = {};

  if (ativa) {
    const antes = await propagarTurma(origem, mapa, clientes);
    mapa = antes.mapa;
    avisos.push(...antes.avisos);
    Object.assign(campos, antes.campos);
    // Só o que não deu certo interessa relatar: "criada" e depois "ativada"
    // na mesma lista viraria ruído na tela.
    resultados.push(...antes.resultados.filter((r) => !r.ok));
  }

  const rotulo = ativa ? "ativada" : "desativada";

  if (mapa.presencaTurmaId) {
    try {
      await clientes.presenca.atualizarTurma(mapa.presencaTurmaId, { ativa });
      resultados.push({
        plataforma: "presenca",
        acao: ativa ? "ativada" : "desativada",
        ok: true,
        mensagem: `Turma ${rotulo} no Presença.`,
        campos: { presenca_erro: null },
      });
    } catch (e) {
      resultados.push(erroPara("presenca", e));
    }
  } else if (!ativa) {
    resultados.push({
      plataforma: "presenca",
      acao: "nada",
      ok: true,
      mensagem: "Não existe no Presença — nada a desligar.",
      campos: {},
    });
  }

  if (clientes.league && mapa.leagueClassId) {
    try {
      await clientes.league.atualizarTurma(mapa.leagueClassId, { ativa });
      resultados.push({
        plataforma: "league",
        acao: ativa ? "ativada" : "desativada",
        ok: true,
        mensagem: `Turma ${rotulo} no LeagueInvest.`,
        campos: { league_erro: null },
      });
    } catch (e) {
      resultados.push(erroPara("league", e));
    }
  } else if (!ativa && clientes.league) {
    resultados.push({
      plataforma: "league",
      acao: "nada",
      ok: true,
      mensagem: "Não existe no LeagueInvest — nada a desligar.",
      campos: {},
    });
  }

  const junto = juntar(mapa, resultados, avisos);
  return { ...junto, campos: { ...campos, ...junto.campos } };
}

/* ------------------------------------------------------------------ *
 * 3. Corrigir o que já existe
 * ------------------------------------------------------------------ */

/**
 * Leva para as outras duas o que mudou no Sponte.
 *
 * Renomear a turma no Sponte, sem isto, desfaz o casamento por nome: quem
 * ainda não tem id gravado deixa de ser encontrado. Só mexe no que já está
 * vinculado — propagar é outra operação.
 */
export async function sincronizarTurma(
  origem: TurmaOrigem,
  mapa: MapaTurma,
  clientes: ClientesTurma,
): Promise<ResultadoTurma> {
  const resultados: ResultadoTurmaPlataforma[] = [];

  if (mapa.presencaTurmaId) {
    try {
      await clientes.presenca.atualizarTurma(mapa.presencaTurmaId, {
        nome: origem.nome,
        curso: origem.curso,
        professor: origem.professorRegente,
        horarioInicio: horarioDoNome(origem.nome),
        diasSemana: diasDoNome(origem.nome),
      });
      resultados.push({
        plataforma: "presenca",
        acao: "atualizada",
        ok: true,
        mensagem: "Dados levados ao Presença.",
        campos: { presenca_erro: null },
      });
    } catch (e) {
      resultados.push(erroPara("presenca", e));
    }
  }

  if (clientes.league && mapa.leagueClassId) {
    try {
      await clientes.league.atualizarTurma(mapa.leagueClassId, {
        nome: origem.nome,
        inicio: origem.dataInicio ?? null,
        fim: origem.dataTermino ?? null,
      });
      resultados.push({
        plataforma: "league",
        acao: "atualizada",
        ok: true,
        mensagem: "Dados levados ao LeagueInvest.",
        campos: { league_erro: null },
      });
    } catch (e) {
      resultados.push(erroPara("league", e));
    }
  }

  return juntar(mapa, resultados, []);
}

/* ------------------------------------------------------------------ *
 * Vínculo à mão
 * ------------------------------------------------------------------ */

/**
 * Grava o id que uma pessoa escolheu, depois de a busca ter dado ambígua.
 *
 * Confere que a turma existe antes de gravar: id errado aqui é pior que id
 * nenhum — o sistema para de procurar e passa a matricular na turma errada
 * com toda a confiança.
 */
export async function vincularTurmaAMao(
  escolha: { presencaTurmaId?: number | null; leagueClassId?: string | null },
  clientes: ClientesTurma,
): Promise<{ campos: Record<string, unknown>; mensagens: string[] }> {
  const campos: Record<string, unknown> = {};
  const mensagens: string[] = [];

  if (escolha.presencaTurmaId) {
    const turma = await clientes.presenca.buscarTurma(escolha.presencaTurmaId);
    if (!turma) {
      throw new Error(`A turma ${escolha.presencaTurmaId} não existe no Presença.`);
    }
    campos.presenca_turma_id = turma.id;
    campos.presenca_erro = null;
    mensagens.push(`Presença: vinculada a "${turma.turma}".`);
  }

  if (escolha.leagueClassId) {
    if (!clientes.league) throw new Error("O LeagueInvest não está configurado.");
    // `ligaDaTurma` lança quando a turma não existe — serve de conferência.
    const ligaId = await clientes.league.ligaDaTurma(escolha.leagueClassId);
    campos.league_class_id = escolha.leagueClassId;
    campos.league_id = ligaId;
    campos.league_erro = null;
    mensagens.push("LeagueInvest: vinculada.");
  }

  return { campos, mensagens };
}

/* ------------------------------------------------------------------ *
 * Cascata sobre os alunos
 * ------------------------------------------------------------------ */

/**
 * Até quantos alunos uma cascata automática pode mexer sozinha.
 *
 * O número não é sobre desempenho: é o raio de estrago de um vínculo
 * errado. Se o casamento por nome ligar a turma do Sponte à turma errada
 * do Presença, a cascata desativa alunos que ninguém mandou desativar —
 * e descobrir isso depois custa reativar um por um.
 *
 * Turma da escola tem algumas dezenas de alunos; passar disso é sinal de
 * que o vínculo pegou a turma errada, não de que a turma é grande. Acima
 * do teto a cascata **para e relata**, para uma pessoa olhar e decidir.
 *
 * Vale só para o que roda sozinho. Quem clica no painel já viu de qual
 * turma se trata e a confirmação diz quantos serão afetados.
 */
export const TETO_CASCATA_AUTOMATICA = 15;

export interface ResultadoCascata {
  total: number;
  ok: number;
  falhas: number;
  /** A cascata parou sem agir por passar do teto. */
  barrada?: boolean;
  /** Por que parou, pronto para a tela e para a auditoria. */
  motivo?: string;
  /** Uma linha por aluno, para gravar o id aprendido e mostrar na tela. */
  alunos: Array<{
    id: number;
    nome: string;
    ok: boolean;
    mensagem: string;
    campos: Record<string, unknown>;
  }>;
}

/**
 * Aplica à turma inteira o que foi feito com a turma.
 *
 * Desligar a turma e deixar os alunos ativos deixa o pior dos dois mundos:
 * eles não aparecem na chamada (a turma saiu) mas continuam enxergando o
 * conteúdo no LeagueInvest. Era a cascata do `Turmas.gs`, e ela continua
 * sendo necessária aqui.
 *
 * **Quem entra na cascata é decidido por quem chama**, não aqui. Na planilha
 * ativar a turma forçava "Ativo" em todo mundo, porque lá só existia
 * Ativo/Desativado. Aqui há aluno em rascunho, pendente e rejeitado — gente
 * que não pagou —, e ativar esses por um clique na turma seria dar acesso de
 * graça. A consulta que monta a lista é que carrega essa regra.
 *
 * Um aluno que falha não interrompe os outros: a lista volta inteira, com o
 * que deu e o que não deu, e repetir só tenta o que faltou.
 *
 * Em série, de propósito. São até algumas dezenas de alunos por turma, cada
 * um com várias idas a duas plataformas; disparar tudo de uma vez convida o
 * limite de taxa do PostgREST e transforma lentidão em erro.
 */
export async function cascataDeAlunos(
  alunos: AlunoParaCascata[],
  mapa: MapaTurma,
  ativar: boolean,
  clientes: ClientesTurma,
  motivo?: string,
  opcoes: { teto?: number } = {},
): Promise<ResultadoCascata> {
  const saida: ResultadoCascata = {
    total: alunos.length,
    ok: 0,
    falhas: 0,
    alunos: [],
  };

  // Teto só no caminho automático: quem passa `teto` é o ciclo que roda
  // sozinho. Pelo painel não há teto — ali uma pessoa viu a turma e
  // confirmou quantos seriam afetados.
  if (opcoes.teto !== undefined && alunos.length > opcoes.teto) {
    saida.barrada = true;
    saida.motivo =
      `A cascata automática pararia em ${alunos.length} alunos, acima do ` +
      `limite de ${opcoes.teto}. Turma desse tamanho costuma indicar vínculo ` +
      `apontando para a turma errada, não turma grande. Nada foi alterado — ` +
      `confira o vínculo e, se estiver certo, aplique pelo painel.`;
    return saida;
  }

  for (const a of alunos) {
    const alvo: AlunoParaAtivar = {
      id: a.id,
      nome: a.nome,
      email: a.email,
      turmaNome: a.turmaNome,
      sponteTurmaId: a.sponteTurmaId,
      presencaAlunoId: a.presencaAlunoId,
      leagueUserId: a.leagueUserId,
    };

    try {
      const r = ativar
        ? await ativarAluno(alvo, mapa, clientes)
        : await desativarAluno(alvo, clientes, motivo ?? "turma desativada");

      if (r.ok) saida.ok++;
      else saida.falhas++;

      saida.alunos.push({
        id: a.id,
        nome: a.nome,
        ok: r.ok,
        mensagem: r.resultados
          .map((p) => `${p.plataforma}: ${p.mensagem}`)
          .join(" · "),
        campos: r.campos,
      });
    } catch (e) {
      // `ativarAluno` já perdoa falha de plataforma; chegar aqui é defeito
      // nosso. Mesmo assim não para a fila: o aluno seguinte não tem culpa.
      saida.falhas++;
      saida.alunos.push({
        id: a.id,
        nome: a.nome,
        ok: false,
        mensagem: (e as Error).message,
        campos: {},
      });
    }
  }

  return saida;
}

/** O que a cascata precisa saber de cada aluno. */
export interface AlunoParaCascata {
  id: number;
  nome: string;
  email: string | null;
  turmaNome: string;
  sponteTurmaId: number;
  presencaAlunoId: number | null;
  leagueUserId: string | null;
}

/* ------------------------------------------------------------------ *
 * Juntar
 * ------------------------------------------------------------------ */

function juntar(
  mapa: MapaTurma,
  resultados: ResultadoTurmaPlataforma[],
  avisos: string[],
): ResultadoTurma {
  const campos: Record<string, unknown> = {};
  for (const r of resultados) Object.assign(campos, r.campos);
  return {
    ok: resultados.every((r) => r.ok),
    mapa,
    resultados,
    campos,
    avisos,
  };
}
