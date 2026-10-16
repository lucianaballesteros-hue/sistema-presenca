/**
 * Quem pode usar o painel.
 *
 * ⚠️ **A RLS não protege esta aplicação.** O servidor fala com o Supabase
 * usando a service role, que ignora toda política. Quem alcança a URL do
 * painel conversa com o servidor, não com o banco — então a decisão de
 * atender ou não é tomada aqui, e só aqui.
 *
 * O login reaproveita o Supabase Auth que o sistema de presença já usa: os
 * mesmos 10 usuários, a mesma senha. O papel vem da tabela `professores`, e
 * **só `admin` entra** — os professores não precisam ver CPF e telefone de
 * 500 pessoas para dar aula.
 */

export interface Identidade {
  userId: string;
  email: string | null;
  nome: string | null;
  papel: string | null;
  admin: boolean;
}

export interface ConfigAuth {
  url: string;
  /** Chave pública: só valida o token, não dá poder nenhum. */
  publishableKey: string;
  /** Service role, para consultar o papel. Nunca sai do servidor. */
  serviceKey: string;
}

/**
 * Lembra quem é cada token por alguns minutos.
 *
 * Sem isto, cada requisição do painel custaria duas idas ao Supabase — uma
 * para validar o token e outra para ler o papel. Cinco minutos é curto o
 * bastante para que tirar alguém de admin tenha efeito rápido, e longo o
 * bastante para a tela não ficar lenta.
 */
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { quando: number; identidade: Identidade }>();

export class Autenticacao {
  #cfg: ConfigAuth;

  constructor(cfg: ConfigAuth) {
    this.#cfg = { ...cfg, url: cfg.url.replace(/\/$/, "") };
  }

  /** Lê o token do cabeçalho `Authorization: Bearer …`. */
  static tokenDe(cabecalho: string | undefined): string | null {
    const m = /^Bearer\s+(.+)$/i.exec(cabecalho ?? "");
    return m ? m[1].trim() : null;
  }

  /**
   * Quem é o dono deste token, ou `null` se ele não vale.
   *
   * A validação é feita pelo próprio Supabase (`/auth/v1/user`) em vez de
   * conferirmos a assinatura por aqui: assim um token revogado para de
   * funcionar de imediato, e não há cópia da lógica de JWT para manter.
   */
  async identificar(token: string | null): Promise<Identidade | null> {
    if (!token) return null;

    const lembrado = cache.get(token);
    if (lembrado && Date.now() - lembrado.quando < CACHE_MS) return lembrado.identidade;

    let userId: string, email: string | null;
    try {
      const r = await fetch(`${this.#cfg.url}/auth/v1/user`, {
        headers: { apikey: this.#cfg.publishableKey, Authorization: `Bearer ${token}` },
      });
      if (!r.ok) { cache.delete(token); return null; }
      const u = await r.json() as { id?: string; email?: string };
      if (!u.id) return null;
      userId = u.id;
      email = u.email ?? null;
    } catch {
      // Supabase fora do ar: recusa em vez de liberar. Painel indisponível é
      // melhor que painel aberto.
      return null;
    }

    const papel = await this.#papel(userId);
    const identidade: Identidade = {
      userId, email,
      nome: papel?.nome ?? null,
      papel: papel?.papel ?? null,
      admin: papel?.admin === true,
    };

    cache.set(token, { quando: Date.now(), identidade });
    return identidade;
  }

  async #papel(userId: string): Promise<{ admin: boolean; nome: string; papel: string } | null> {
    try {
      const r = await fetch(`${this.#cfg.url}/rest/v1/rpc/e_admin_por_id`, {
        method: "POST",
        headers: {
          apikey: this.#cfg.serviceKey,
          Authorization: `Bearer ${this.#cfg.serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p_user_id: userId }),
      });
      if (!r.ok) return null;
      const linhas = await r.json() as Array<{ admin: boolean; nome: string; papel: string }>;
      return linhas?.[0] ?? null;
    } catch {
      return null;
    }
  }

  /** Esquece um token — usado no logout. */
  static esquecer(token: string | null): void {
    if (token) cache.delete(token);
  }
}

/**
 * Rotas que o aluno usa, sem login.
 *
 * Tudo que **não** casar aqui exige admin. A lista é de permissão explícita
 * de propósito: esquecer de proteger uma rota nova é um acidente provável,
 * e o custo dele é expor 500 cadastros.
 */
const PUBLICAS: Array<{ metodo: string; padrao: RegExp }> = [
  // O formulário do aluno, pelo token do link.
  { metodo: "GET", padrao: /^\/api\/cadastro\/[^/]+$/ },
  { metodo: "POST", padrao: /^\/api\/cadastro\/[^/]+$/ },
  { metodo: "POST", padrao: /^\/api\/rascunho\/[^/]+$/ },
  // O checkout e o acompanhamento do link, que acontecem depois do envio.
  //
  // ⚠️ Estas duas aceitam qualquer id de cadastro. São idempotentes e não
  // revelam dado pessoal, mas alguém poderia disparar o checkout de uma
  // ficha alheia. O conserto certo é um token por cadastro, devolvido no
  // envio — está anotado para quando o formulário for ao ar.
  { metodo: "POST", padrao: /^\/api\/checkout\/\d+$/ },
  { metodo: "GET", padrao: /^\/api\/checkout\/\d+$/ },
  // O aviso de "ambiente de teste" que o formulário mostra no rodapé.
  { metodo: "GET", padrao: /^\/api\/estado$/ },
  // A tela de login precisa desta antes de existir login. Devolve só a URL
  // e a chave pública — as duas já viajariam ao navegador de qualquer forma.
  { metodo: "GET", padrao: /^\/api\/config-auth$/ },
  // Os ciclos periódicos, chamados pelo cron da plataforma. Não têm sessão
  // de admin para apresentar — e por isso têm porteiro próprio, mais
  // rígido: `cronAutorizado`, logo abaixo. Ficam fora do porteiro de admin,
  // nunca sem porteiro nenhum.
  //
  // GET porque é assim que o cron da Vercel chama; POST para disparar à mão.
  { metodo: "GET", padrao: /^\/api\/ciclos$/ },
  { metodo: "POST", padrao: /^\/api\/ciclos$/ },
];

/**
 * O pedido veio mesmo do agendador?
 *
 * A Vercel chama o cron com `Authorization: Bearer $CRON_SECRET`. Sem o
 * segredo configurado, isto responde **não** — a alternativa seria um
 * endereço aberto que desativa turmas e alunos, e é melhor o cron não
 * rodar do que rodar para qualquer um.
 *
 * Comparação de tamanho constante: comparar com `===` vaza, pelo tempo de
 * resposta, quantos caracteres do segredo o atacante já acertou.
 */
export function cronAutorizado(
  cabecalho: string | undefined,
  segredo: string | undefined,
): boolean {
  if (!segredo) return false;
  const enviado = Autenticacao.tokenDe(cabecalho);
  if (!enviado || enviado.length !== segredo.length) return false;

  let diferenca = 0;
  for (let i = 0; i < segredo.length; i++) {
    diferenca |= enviado.charCodeAt(i) ^ segredo.charCodeAt(i);
  }
  return diferenca === 0;
}

export function rotaPublica(metodo: string, rota: string): boolean {
  return PUBLICAS.some((p) => p.metodo === metodo && p.padrao.test(rota));
}
