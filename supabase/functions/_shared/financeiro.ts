/**
 * A situação financeira do aluno, derivada do que sabemos da cobrança.
 *
 * ⚠️ **Isto fala da primeira mensalidade, não do ano todo.** O sistema
 * acompanha uma parcela por aluno (`sponte_numero_parcela`, que é sempre
 * "1"): é a que o aluno paga para a matrícula valer, e é a única que passa
 * pelo link do Sponte Pay gerado aqui. As mensalidades seguintes saem pela
 * régua de cobrança do Sponte e **não** são vistas por este módulo.
 *
 * Por isso nada aqui se chama "em dia" ou "adimplente": um aluno `pago`
 * pode estar devendo a parcela 4. Quem precisa dessa resposta tem de olhar
 * o financeiro do Sponte.
 *
 * O estado mora em duas colunas de `alunos_staging`:
 *
 *   pagamento_status      o que o vigia conseguiu confirmar
 *   pagamento_vencimento  a data que veio da parcela no Sponte
 *
 * e o atraso é a comparação entre a segunda e hoje. Guardar "inadimplente"
 * como coluna seria guardar uma verdade que vence sozinha à meia-noite.
 */

export type SituacaoFinanceira =
  /** Confirmado: a parcela tem data de pagamento no Sponte. */
  | "pago"
  /** Venceu e não foi pago. */
  | "vencido"
  /** Tem link e o vencimento ainda não chegou. */
  | "a_vencer"
  /** Devia ter cobrança, mas o link ainda não saiu. */
  | "sem_link"
  /** Não há cobrança por este sistema — importado da planilha, por exemplo. */
  | "sem_cobranca"
  | "cancelado"
  | "falhou";

export interface EstadoFinanceiro {
  situacao: SituacaoFinanceira;
  /** Como mostrar na tela. */
  rotulo: string;
  /** Dias de atraso. Positivo só quando `vencido`. */
  diasAtraso: number;
  /** Dias até vencer. Positivo só quando `a_vencer`. */
  diasAteVencer: number;
  vencimento: string | null;
  /** Pede atenção de alguém: vencido, falhou, ou link que não saiu. */
  pendente: boolean;
}

export const ROTULOS: Record<SituacaoFinanceira, string> = {
  pago: "1ª mensalidade paga",
  vencido: "Vencida sem pagamento",
  a_vencer: "Aguardando pagamento",
  sem_link: "Link de pagamento não gerado",
  sem_cobranca: "Sem cobrança por aqui",
  cancelado: "Cobrança cancelada",
  falhou: "Falha no pagamento",
};

/** Quais situações, no filtro, pedem alguma providência. */
export const PENDENTES: SituacaoFinanceira[] = ["vencido", "sem_link", "falhou"];

function emDias(de: Date, ate: Date): number {
  const DIA = 86_400_000;
  // Meio-dia nos dois lados: assim o horário de verão não cria meio dia de
  // diferença e um vencimento de hoje não aparece como "1 dia de atraso".
  const a = Date.UTC(de.getFullYear(), de.getMonth(), de.getDate());
  const b = Date.UTC(ate.getFullYear(), ate.getMonth(), ate.getDate());
  return Math.round((b - a) / DIA);
}

/**
 * Lê a situação financeira de um cadastro.
 *
 * `hoje` entra por parâmetro para o teste poder fixar a data — e porque a
 * resposta muda sozinha com o passar dos dias, o que é justamente o motivo
 * de ela não ser guardada no banco.
 */
export function situacaoFinanceira(
  c: { pagamentoStatus?: string | null; pagamentoVencimento?: string | null },
  hoje: Date = new Date(),
): EstadoFinanceiro {
  const venc = c.pagamentoVencimento ?? null;
  const base = { vencimento: venc, diasAtraso: 0, diasAteVencer: 0 };

  const monta = (situacao: SituacaoFinanceira, extra: Partial<EstadoFinanceiro> = {}) => ({
    ...base,
    situacao,
    rotulo: ROTULOS[situacao],
    pendente: PENDENTES.includes(situacao),
    ...extra,
  });

  switch (c.pagamentoStatus) {
    case "pago":
      return monta("pago");
    case "cancelado":
      return monta("cancelado");
    case "falhou":
      return monta("falhou");
    case "nao_aplicavel":
    case null:
    case undefined:
    case "":
      return monta("sem_cobranca");
  }

  // Resta `aguardando` e `link_gerado`: ambos "ainda não pagou". O que
  // separa um do outro é o vencimento, não o nome do estado.
  if (!venc) {
    // Sem data não há como dizer se atrasou. `aguardando` quer dizer que o
    // link ainda não saiu; `link_gerado` sem vencimento é leitura incompleta
    // do Sponte, e tratá-la como atraso acusaria quem está em dia.
    return monta(c.pagamentoStatus === "aguardando" ? "sem_link" : "a_vencer");
  }

  const dias = emDias(new Date(`${venc}T12:00:00`), hoje);
  if (dias > 0) return monta("vencido", { diasAtraso: dias });

  // Vence hoje ainda não é atraso: o aluno tem o dia inteiro para pagar.
  // `Math.abs` e não `-dias` porque `-0` não é `0` num `assert.equal`.
  return monta("a_vencer", { diasAteVencer: Math.abs(dias) });
}

/**
 * Como a situação aparece na lista: texto curto e uma cor.
 *
 * As cores são as três do sistema (verde, âmbar, vermelho) mais o neutro.
 * "Sem cobrança por aqui" fica neutro de propósito — não é problema, é a
 * maioria dos 503 alunos vindos da planilha.
 */
export function corDaSituacao(s: SituacaoFinanceira): "verde" | "ambar" | "vermelho" | "neutro" {
  switch (s) {
    case "pago": return "verde";
    case "vencido": case "falhou": return "vermelho";
    case "sem_link": case "a_vencer": return "ambar";
    default: return "neutro";
  }
}

/** Texto curto para a lista, já com o atraso quando houver. */
export function resumoCurto(e: EstadoFinanceiro): string {
  if (e.situacao === "vencido") {
    return `Vencida há ${e.diasAtraso} dia${e.diasAtraso === 1 ? "" : "s"}`;
  }
  if (e.situacao === "a_vencer" && e.vencimento) {
    if (e.diasAteVencer === 0) return "Vence hoje";
    return `Vence em ${e.diasAteVencer} dia${e.diasAteVencer === 1 ? "" : "s"}`;
  }
  return e.rotulo;
}
