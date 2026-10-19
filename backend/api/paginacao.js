// O Supabase/PostgREST devolve no máximo 1000 linhas por requisição. Antes,
// cada página só era pedida depois que a anterior chegava — com alguns
// milhares de presenças, eram várias idas e voltas em fila, e a tela de
// carregamento esperava todas. Agora a primeira página traz também o total
// de linhas, e as demais saem todas de uma vez, em paralelo.
//
// `pagina(de, ate, count)` monta a consulta de um trecho. A ordem precisa ser
// estável (terminar numa coluna única), senão linhas trocam de página entre
// uma requisição e outra.
export const TAMANHO_PAGINA = 1000;

export async function buscarTodasAsPaginas(pagina) {
  const primeira = await pagina(0, TAMANHO_PAGINA - 1, 'exact');
  if (primeira.error) return { data: [], error: primeira.error };

  const resto = [];
  for (let de = TAMANHO_PAGINA; de < (primeira.count ?? 0); de += TAMANHO_PAGINA) {
    resto.push(pagina(de, de + TAMANHO_PAGINA - 1));
  }
  const respostas = await Promise.all(resto);
  return {
    data: [primeira, ...respostas].flatMap(r => r.data || []),
    error: respostas.find(r => r.error)?.error || null,
  };
}
