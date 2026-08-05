import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config/env.js';

// O SDK do Supabase é carregado via <script> global no index.html (sem passo
// de build nesse projeto, então não há "npm install" para importar o pacote).
export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
