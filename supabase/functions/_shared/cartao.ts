/**
 * Os botões de pagamento: cartão, Pix e boleto.
 *
 * O link que o aluno recebe é o da **parcela** (`SpontePay.aspx`), onde ele
 * escolheria a forma. Fazemos essa escolha por ele, no servidor, e o levamos
 * direto ao que interessa:
 *
 * - **Cartão:** escolhe "Cartão Recorrente" e devolve o link do **plano**
 *   (`DetalhePlano.aspx`). O cartão recorrente não grava pela página da
 *   parcela — o Sponte aceita, responde sucesso e descarta. Pela do plano,
 *   grava, e a recorrência cobre todas as parcelas. Ver o bloco "Cartão
 *   recorrente" em `sponte-web.ts`.
 * - **Pix / boleto:** escolhe a forma e devolve o próprio link da parcela,
 *   que já abre no QR Code ou no boleto. Vale para esta parcela; as
 *   seguintes chegam pela régua do Sponte.
 */

import {
  escolherFormaPagamento,
  type FormaEscolhida,
  linkDoPlano,
  type SponteWeb,
} from "./sponte-web.ts";

export type { FormaEscolhida };

export interface FichaParaPagamento {
  id: number;
  status: string | null;
  pagamentoLink: string | null;
  contaReceberId: number | null;
}

/** @deprecated Use `FichaParaPagamento`. */
export type FichaParaCartao = FichaParaPagamento;

export type ResultadoPagamento =
  | { ok: true; forma: FormaEscolhida; link: string; jaEstava: boolean }
  | { ok: false; motivo: string; erro: string };

export const FORMAS: readonly FormaEscolhida[] = ["cartao", "pix", "boleto"];

export async function prepararPagamento(
  f: FichaParaPagamento,
  forma: FormaEscolhida,
  d: {
    web: SponteWeb | null;
    escritaLiberada: boolean;
    registrar: (e: Record<string, unknown>) => void;
  },
): Promise<ResultadoPagamento> {
  const falha = (motivo: string, erro: string): ResultadoPagamento => {
    d.registrar({
      tipo: "sponte", operacao: `pagar com ${forma} (falhou)`, cadastroId: f.id,
      ok: false, erro, detalhe: { motivo, contaReceberId: f.contaReceberId },
    });
    return { ok: false, motivo, erro };
  };

  if (!FORMAS.includes(forma)) return falha("forma_invalida", `forma desconhecida: ${forma}`);
  if (!f.pagamentoLink || !f.contaReceberId) {
    return falha("sem_link", "a matrícula ainda não tem link de pagamento");
  }
  // Sem escrita liberada, escolher a forma mudaria a cobrança no ERP de
  // verdade — exatamente o que a simulação promete não fazer.
  if (!d.escritaLiberada) {
    return falha("simulado", "escrita no Sponte desligada: nada a preparar");
  }
  if (forma === "cartao" && !d.web) {
    return falha("sem_acesso_web", "credenciais da interface do Sponte não configuradas");
  }

  const t0 = Date.now();
  const escolha = await escolherFormaPagamento(f.pagamentoLink, forma);
  if (escolha.ok === false) return falha(escolha.estado, escolha.motivo);

  let link = f.pagamentoLink;
  if (forma === "cartao") {
    const doPlano = await linkDoPlano(d.web!, f.contaReceberId);
    if (!doPlano) {
      return falha("sem_link_plano",
        "o plano está em recorrência, mas o Sponte não gerou o link do plano");
    }
    link = doPlano;
  }

  d.registrar({
    tipo: "sponte", operacao: `pagar com ${forma}`, cadastroId: f.id, ok: true,
    duracaoMs: Date.now() - t0,
    detalhe: { contaReceberId: f.contaReceberId, jaEstava: escolha.jaEstava },
  });
  return { ok: true, forma, link, jaEstava: escolha.jaEstava };
}

/** Atalho do cartão — o caso que abriu este arquivo. */
export function prepararPagamentoCartao(
  f: FichaParaPagamento,
  d: Parameters<typeof prepararPagamento>[2],
): Promise<ResultadoPagamento> {
  return prepararPagamento(f, "cartao", d);
}
