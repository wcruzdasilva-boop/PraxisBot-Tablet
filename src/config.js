// Configuração pública do projeto Supabase de contas (praxisbot-contas).
// Mesmos valores públicos de src/main/contas-config.js (chave "publishable" é pública
// por definição; o isolamento de dados é garantido por RLS auth.uid() = user_id + E2EE).
(function (global) {
    'use strict';

    global.PraxisTabletConfig = Object.freeze({
        VERSAO: '0.3.3',
        URL_CONTAS: 'https://agptohtjasswuzffzpmh.supabase.co',
        CHAVE_ANON_CONTAS: 'sb_publishable_Rjr9Y8E7rq1hIYDiZDfJZg_opNnQcf8',
        INTERVALO_SYNC_MS: 25 * 1000,
        PERIODOS: ['1º PERIODO', '2º PERIODO', '3º PERIODO', '4º PERIODO']
    });
})(globalThis);
