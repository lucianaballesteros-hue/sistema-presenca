/**
 * Todo `/api/*` em produção, numa função só.
 *
 * O `vercel.json` reescreve `/api/(.*)` para cá. Antes isto se chamava
 * `api/[...rota].ts`, usando a convenção de rota curinga da plataforma —
 * mas só caminhos de um segmento chegavam, e metade do sistema vive em
 * caminhos aninhados. Com o nome simples e a regra explícita, não há
 * convenção para interpretar errado.
 *
 * Uma função para todas as rotas, e não uma por endpoint, porque elas
 * compartilham tudo: os clientes das três plataformas, os caches do
 * catálogo, a sessão da interface web do Sponte e o porteiro de admin.
 * Espalhá-las em vinte arquivos multiplicaria esse custo de partida por
 * vinte, sem separar nada de verdade.
 *
 * A função não tem lógica própria: ela entrega o pedido ao mesmo `tratar`
 * que o servidor de desenvolvimento usa. É o que garante que o que foi
 * testado na máquina é o que roda aqui.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { tratar } from "../scripts/app.ts";

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await tratar(req, res);
}

export const config = {
  // O checkout encadeia várias chamadas SOAP ao Sponte, que é lento, e
  // ainda pode abrir a interface web para gerar o link de pagamento. O
  // padrão de 10 s cortaria a matrícula no meio — e no Sponte não há como
  // desfazer o que já entrou.
  maxDuration: 300,
};
