/**
 * Normalização e comparação de nomes.
 *
 * Portado do Apps Script da planilha (`Alunos.gs`), onde essas funções já
 * decidiam, na prática, quem era "o mesmo aluno" entre três bases. Mantive o
 * comportamento: o time já conhece os casos que elas acertam e os que elas
 * deixam para conferência manual.
 *
 * Por que não comparar string com string: as três plataformas guardam o mesmo
 * nome de formas diferentes. "ELAS Quarta 14:00 PR 2/26" no Sponte é
 * "ELAS Quarta 14:00 PR 2/2026" no Presença; "Cecconelo" num lado é
 * "Cecconello" no outro. Igualdade exata erraria em quase toda turma.
 */

/** Minúsculas, sem acento, sem pontuação, espaços colapsados. */
export function normalizaChave(texto: unknown): string {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** seg → segunda, qua → quarta… só como token inteiro. */
const DIAS: Record<string, string> = {
  seg: "segunda", ter: "terca", qua: "quarta", qui: "quinta",
  sex: "sexta", sab: "sabado", dom: "domingo",
};

/**
 * Chave de turma: `normalizaChave` mais três acertos de escrita.
 *
 * As três saíram de comparar as 49 turmas do Sponte com as 46 do Presença e
 * do LeagueInvest — são as divergências que aparecem de verdade:
 *
 * - **ano**: "2/26" × "2/2026"
 * - **hora**: "9:00" × "09:00"
 * - **dia abreviado**: "MAST Qua 18:30" × "MAST Quarta 18:30"
 *
 * Nada aqui aproxima turmas realmente diferentes: dia, hora e semestre
 * continuam distinguindo uma da outra.
 */
export function chaveTurma(texto: unknown): string {
  const comHoraPadronizada = String(texto ?? "")
    .replace(/\b(\d):(\d{2})\b/g, (_, h, m) => `0${h}:${m}`);

  return normalizaChave(comHoraPadronizada)
    .replace(/\b20(\d{2})\b/g, "$1")
    .split(" ")
    .map((t) => DIAS[t] ?? t)
    .join(" ");
}

/**
 * Similaridade de Dice por bigramas, de 0 a 1.
 *
 * Tolera troca, falta ou sobra de poucas letras — typos de digitação — sem
 * aceitar nomes que apenas começam igual.
 */
export function similaridade(a: unknown, b: unknown): number {
  const x = normalizaChave(a);
  const y = normalizaChave(b);
  if (!x || !y) return 0;
  if (x === y) return 1;

  const bigramas = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.substr(i, 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };

  const ma = bigramas(x), mb = bigramas(y);
  let intersecao = 0, totalA = 0, totalB = 0;
  for (const [g, n] of ma) { totalA += n; if (mb.has(g)) intersecao += Math.min(n, mb.get(g)!); }
  for (const [, n] of mb) totalB += n;

  return (2 * intersecao) / (totalA + totalB);
}

/**
 * Todos os tokens do nome curto aparecem no longo?
 *
 * Resolve o caso de nome abreviado contra nome completo — "Andre Geo" dentro
 * de "Andre de Lima Geo Filho". Exige dois tokens ou mais: com um só,
 * qualquer "Maria" casaria com qualquer outra.
 */
export function tokensContidos(curto: unknown, longo: unknown): boolean {
  const a = normalizaChave(curto).split(" ").filter(Boolean);
  const b = new Set(normalizaChave(longo).split(" ").filter(Boolean));
  return a.length >= 2 && a.every((t) => b.has(t));
}

/** Nota de parecença entre dois nomes, já com a regra de tokens aplicada. */
/** Os números do nome, em ordem — hora, semestre, ano. */
function numerosDe(chave: string): string {
  return chave.split(" ").filter((t) => /^\d+$/.test(t)).sort().join(",");
}

/**
 * Teto para nomes cujos números não batem.
 *
 * Abaixo do corte de 0,9 usado na escolha, e de propósito: num nome de turma
 * o número **é** a identidade. "ELAS Terça 09:00" e "ELAS Terça 19:00"
 * compartilham quase todas as letras e marcavam 0,900 na similaridade pura —
 * casariam, e mandariam o aluno para a turma da manhã em vez da noite.
 */
const TETO_NUMERO_DIFERENTE = 0.5;

export function parecenca(a: unknown, b: unknown): number {
  // Compara sobre a forma já padronizada, não sobre o texto cru: senão
  // "Qua" × "Quarta" seria penalizado como se fossem palavras diferentes.
  const x = chaveTurma(a), y = chaveTurma(b);
  if (x === y) return 1;

  const s = similaridade(x, y);
  const bruto = tokensContidos(x, y) || tokensContidos(y, x) ? Math.max(s, 0.9) : s;

  // Em nome de pessoa os dois lados costumam não ter número nenhum, e aí a
  // comparação segue igual ao que era.
  return numerosDe(x) === numerosDe(y) ? bruto : Math.min(bruto, TETO_NUMERO_DIFERENTE);
}

export interface Candidato<T> {
  item: T;
  nota: number;
}

/**
 * Melhor correspondência de `alvo` dentro de `lista`, ou `null`.
 *
 * Só devolve quando há **um** candidato forte: dois nomes igualmente parecidos
 * viram ambiguidade, e vincular o aluno errado é pior que não vincular — um
 * engano desses mistura o histórico de presença de duas pessoas.
 */
export function melhorCorrespondencia<T>(
  lista: T[],
  alvo: string,
  nomeDe: (x: T) => unknown,
  minimo = 0.9,
): { escolhido: T | null; ambiguos: Candidato<T>[] } {
  const candidatos = lista
    .map((item) => ({ item, nota: parecenca(nomeDe(item), alvo) }))
    .filter((c) => c.nota >= minimo)
    .sort((a, b) => b.nota - a.nota);

  if (!candidatos.length) return { escolhido: null, ambiguos: [] };

  const exatos = candidatos.filter((c) => c.nota >= 0.999);
  if (exatos.length === 1) return { escolhido: exatos[0].item, ambiguos: [] };
  if (exatos.length > 1) return { escolhido: null, ambiguos: exatos.slice(0, 3) };

  return candidatos.length === 1
    ? { escolhido: candidatos[0].item, ambiguos: [] }
    : { escolhido: null, ambiguos: candidatos.slice(0, 3) };
}
