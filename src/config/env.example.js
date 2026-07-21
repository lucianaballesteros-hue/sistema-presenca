// Modelo de configuração. Copie este arquivo para "env.js" (mesma pasta) e
// preencha com os dados do seu projeto Supabase (Project Settings → API).
//
// "env.js" fica fora do controle de versão (veja .gitignore) — não porque a
// chave "anon" seja secreta (ela é pública por natureza: qualquer app Supabase
// a expõe no navegador), mas para não misturar configuração de ambiente com
// código-fonte e para permitir trocar/rotacionar a chave sem gerar diff no
// histórico do repositório. A segurança real dos dados é responsabilidade das
// políticas de Row Level Security (RLS) configuradas no projeto Supabase.

export const SUPABASE_URL = 'https://SEU-PROJETO.supabase.co';
export const SUPABASE_ANON_KEY = 'sua-chave-anon-publica-aqui';
