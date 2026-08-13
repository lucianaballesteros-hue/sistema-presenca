-- ============================================================
-- Habilita a exclusão permanente (DELETE) de cursos e turmas — só admin
-- ============================================================
-- Contexto: a nova área "Configurações do sistema" (botão ao lado do tema,
-- visível só pra quem tem papel='admin') deixa excluir cursos/turmas/alunos
-- do banco de verdade, com confirmação por texto digitado no front-end.
-- Front-end != segurança de banco — sem uma policy de DELETE, o Postgres
-- nega a exclusão pra todo mundo (foi exatamente o que aconteceu com o
-- INSERT de `cursos`, ver sql/corrigir_rls_cursos.sql).
--
-- O que este script cobre:
--   • cursos — hoje só tem SELECT + INSERT (sql/corrigir_rls_cursos.sql).
--     Faltava DELETE.
--   • turmas — hoje só tem SELECT (professor_ver_turmas). Faltava DELETE
--     (e também INSERT/UPDATE, mas isso é outra conversa — ver observação
--     no fim deste arquivo).
--
-- O que este script NÃO mexe (de propósito):
--   • alunos, presencas, historico já têm policy `FOR ALL` — isso inclui
--     DELETE. reposicoes/reposicao_opcoes já têm `staff_full_access`
--     (`USING true`/`WITH CHECK true`), totalmente aberta. Se o texto
--     completo dessas condições `ALL` já enxerga admin (o pedaço visível
--     era "... OR (EXISTS (SELECT 1 ..." — bem provável que sim), excluir
--     um aluno já deve funcionar sem precisar de nada novo aqui. Teste
--     primeiro; se dessas quatro tabelas alguma barrar a exclusão do
--     aluno com erro de RLS, me manda o texto completo da policy (ver
--     sql/verificar_seguranca.sql) que eu escrevo o ajuste certo.
--
-- Rode uma vez no SQL Editor do painel Supabase. Idempotente.
-- ============================================================

-- CURSOS: só admin apaga.
drop policy if exists "admin_excluir_cursos" on public.cursos;
create policy "admin_excluir_cursos"
  on public.cursos
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.professores p
      where p.user_id = auth.uid() and p.papel = 'admin'
    )
  );

-- TURMAS: só admin apaga.
drop policy if exists "admin_excluir_turmas" on public.turmas;
create policy "admin_excluir_turmas"
  on public.turmas
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.professores p
      where p.user_id = auth.uid() and p.papel = 'admin'
    )
  );

-- ============================================================
-- Observação à parte (não faz parte desta correção): `turmas` continua sem
-- policy de INSERT/UPDATE — ou seja, criar turma nova e editar uma turma
-- existente (nome/curso/professor/cor/horário/ativar-inativar) devem estar
-- falhando com o mesmo erro de RLS que `cursos` tinha. Isso foi identificado
-- separadamente e ainda depende de saber a condição exata de
-- `professor_ver_turmas` (pra decidir se um professor comum pode criar/
-- editar turma de qualquer professor, só a própria, ou se isso deve ficar
-- restrito a admin) — não incluí a correção aqui pra não resolver esse
-- ponto no escuro.
-- ============================================================
