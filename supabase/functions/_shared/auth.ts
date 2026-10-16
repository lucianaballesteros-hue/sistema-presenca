/**
 * Autorização das Edge Functions que falam com o Sponte.
 *
 * Por que isso existe antes mesmo da primeira função: qualquer rota que chegue
 * ao WSAPIEdu usa o `SPONTE_KEY`, e esse token alcança o ERP inteiro da escola,
 * financeiro incluído (`docs/API-SPONTE.md`, seção 8). Uma função sem gate não
 * é "temporariamente aberta" — é um proxy anônimo para o ERP. O gate nasce
 * junto com a função, não numa etapa seguinte.
 *
 * O fluxo tem dois passos, e ambos são necessários:
 *
 *   1. **Quem é?** O JWT é validado contra o `/auth/v1/user` do próprio
 *      Supabase. Não decodificamos o token localmente: assinatura expirada ou
 *      forjada precisa ser recusada por quem emitiu.
 *   2. **Pode?** O papel vem da tabela `professores`, lido com a service role.
 *      Ler com a credencial do próprio usuário deixaria a decisão de permissão
 *      na mão de quem está sendo verificado.
 */

export interface UsuarioAutorizado {
  userId: string;
  nome: string;
  papel: string;
  email: string;
}

export class AutorizacaoError extends Error {
  readonly status: number;
  constructor(status: number, mensagem: string) {
    super(mensagem);
    this.name = "AutorizacaoError";
    this.status = status;
  }
}

export interface ConfigSupabase {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}

/**
 * Lê a configuração do ambiente da Edge Function.
 *
 * As três variáveis são injetadas automaticamente pelo runtime — não precisam
 * (nem devem) ser cadastradas como secret manualmente.
 */
export function configDoAmbiente(
  env: { get(chave: string): string | undefined },
): ConfigSupabase {
  const url = env.get("SUPABASE_URL");
  const anonKey = env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !anonKey || !serviceRoleKey) {
    throw new Error(
      "Ambiente incompleto: SUPABASE_URL, SUPABASE_ANON_KEY e " +
        "SUPABASE_SERVICE_ROLE_KEY são injetadas pelo runtime das Edge Functions.",
    );
  }
  return { url, anonKey, serviceRoleKey };
}

/** Extrai o JWT do cabeçalho `Authorization: Bearer <token>`. */
export function extrairToken(req: Request): string {
  const cabecalho = req.headers.get("Authorization") ?? "";
  const achado = cabecalho.match(/^Bearer\s+(.+)$/i);
  if (!achado) {
    throw new AutorizacaoError(401, "Requisição sem token de autenticação.");
  }
  return achado[1].trim();
}

/**
 * Valida o JWT e devolve o usuário do Supabase Auth.
 *
 * Um token expirado chega aqui como 401 do `/auth/v1/user` — o mesmo caminho de
 * um token forjado. Do ponto de vista da função as duas situações são iguais, e
 * distingui-las na resposta só ajudaria quem está testando credenciais.
 */
async function validarToken(
  token: string,
  cfg: ConfigSupabase,
  fetchImpl: typeof fetch,
): Promise<{ id: string; email: string }> {
  const resposta = await fetchImpl(`${cfg.url}/auth/v1/user`, {
    headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}` },
  });

  if (!resposta.ok) {
    throw new AutorizacaoError(401, "Sessão inválida ou expirada.");
  }

  const usuario = await resposta.json() as { id?: string; email?: string };
  if (!usuario?.id) {
    throw new AutorizacaoError(401, "Sessão inválida.");
  }
  return { id: usuario.id, email: usuario.email ?? "" };
}

/**
 * Busca o perfil na tabela `professores` pelo `user_id`.
 *
 * Seleciona colunas nomeadas, nunca `*`: a tabela tem uma coluna `senha`, e um
 * `select('*')` a traria junto — que é exatamente o problema que existe hoje em
 * `backend/api/professoresRepo.js`. Lista de permissão, não de exclusão.
 */
async function buscarPerfil(
  userId: string,
  cfg: ConfigSupabase,
  fetchImpl: typeof fetch,
): Promise<{ nome: string; papel: string }> {
  const url = `${cfg.url}/rest/v1/professores` +
    `?user_id=eq.${encodeURIComponent(userId)}&select=nome,papel&limit=1`;

  const resposta = await fetchImpl(url, {
    headers: {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
    },
  });

  if (!resposta.ok) {
    throw new AutorizacaoError(500, "Não foi possível verificar suas permissões.");
  }

  const linhas = await resposta.json() as Array<{ nome?: string; papel?: string }>;
  const perfil = linhas?.[0];

  // Autenticado no Auth mas sem linha em `professores`: conta órfã. Não é erro
  // do usuário, mas também não dá para presumir permissão nenhuma.
  if (!perfil) {
    throw new AutorizacaoError(403, "Usuário sem perfil cadastrado no sistema.");
  }

  return { nome: perfil.nome ?? "", papel: perfil.papel ?? "" };
}

/**
 * Exige um usuário autenticado com um dos papéis informados.
 *
 * O padrão é `["admin"]` — quem gera link de cadastro e lê dados do ERP é a
 * coordenação, não o professor.
 */
export async function exigirPapel(
  req: Request,
  cfg: ConfigSupabase,
  papeisPermitidos: string[] = ["admin"],
  fetchImpl: typeof fetch = fetch,
): Promise<UsuarioAutorizado> {
  const token = extrairToken(req);
  const usuario = await validarToken(token, cfg, fetchImpl);
  const perfil = await buscarPerfil(usuario.id, cfg, fetchImpl);

  if (!papeisPermitidos.includes(perfil.papel)) {
    throw new AutorizacaoError(
      403,
      "Esta operação é restrita à coordenação.",
    );
  }

  return {
    userId: usuario.id,
    nome: perfil.nome,
    papel: perfil.papel,
    email: usuario.email,
  };
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

/**
 * CORS restrito às origens do sistema.
 *
 * `*` seria mais simples e está errado: com `*`, qualquer site aberto no
 * navegador do admin logado poderia chamar esta função com a sessão dele.
 * `ORIGENS_PERMITIDAS` é um secret com a lista separada por vírgula.
 */
export function cabecalhosCors(
  origem: string | null,
  origensPermitidas: string[],
): Record<string, string> {
  const permitida = origem && origensPermitidas.includes(origem) ? origem : "";

  return {
    "Access-Control-Allow-Origin": permitida,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function origensDoAmbiente(
  env: { get(chave: string): string | undefined },
): string[] {
  return (env.get("ORIGENS_PERMITIDAS") ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "");
}

export function respostaJson(
  corpo: unknown,
  status: number,
  cabecalhos: Record<string, string>,
): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...cabecalhos, "Content-Type": "application/json; charset=utf-8" },
  });
}
