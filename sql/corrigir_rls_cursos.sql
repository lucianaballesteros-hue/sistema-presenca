-- ============================================================
-- Corrige a Row Level Security (RLS) da tabela `cursos`
-- ============================================================
-- Diagnóstico: `cursos` foi criada depois da auditoria de RLS registrada em
-- ARQUITETURA.md (seção 15.5), que cobriu turmas/alunos/presencas/
-- historico/professores — `cursos` nunca recebeu nenhuma policy. Com RLS
-- ligado e zero policies, o Postgres nega tudo por padrão (inclusive
-- SELECT), o que explica os dois sintomas observados no app:
--
--   • o <select> de "Curso" em Nova/Editar turma carregava vazio
--     (state.CURSOS = [], porque carregarCursos() não recebia nenhuma
--     linha) — só aparecia UM curso porque
--     frontend/features/dashboard/cursoModals.js injeta o curso atual da
--     turma como fallback quando ele não está na lista carregada;
--   • criar um curso novo falhava com "new row violates row-level
--     security policy for table cursos" (erro visto no modal "Criar novo
--     curso"), e a sincronização automática (sincronizarCursosComTurmas,
--     que roda uma vez por login) falhava do mesmo jeito, silenciosamente.
--
-- Rode este script uma vez no SQL Editor do painel Supabase (Project →
-- SQL Editor → New query). É seguro rodar mais de uma vez (idempotente).
-- Para conferir o resultado antes/depois, use sql/verificar_seguranca.sql.
-- ============================================================

alter table public.cursos enable row level security;

-- Qualquer professor ou admin autenticado pode ver todos os cursos —
-- curso é um dado compartilhado (não pertence a um professor específico),
-- igual turmas/alunos já funcionam pra quem tem acesso a eles.
drop policy if exists "professor_ver_cursos" on public.cursos;
create policy "professor_ver_cursos"
  on public.cursos
  for select
  to authenticated
  using (true);

-- Qualquer professor ou admin autenticado pode cadastrar um curso novo —
-- mesmo alcance que o botão "+" já tem na interface hoje (Nova/Editar
-- turma), sem checagem de papel='admin' no frontend.
drop policy if exists "professor_criar_cursos" on public.cursos;
create policy "professor_criar_cursos"
  on public.cursos
  for insert
  to authenticated
  with check (true);

-- Nenhuma policy de UPDATE/DELETE: o app não tem (ainda) como editar ou
-- excluir um curso já criado — só listar (select) e criar (insert). Se um
-- dia existir essa tela, adicione as policies correspondentes aqui.
