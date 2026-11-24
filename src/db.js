// Armazenamento offline-first do PraxisBot Tablet em IndexedDB.
// Guarda:
// - estado: conta (sessão/refresh token), CryptoKey não-exportável, metadados de sync
// - contexto: blocos decifrados vindos do PC (diario_base, aulas, avaliacoes_notas, status_execucao)
// - filas: filas locais + estado de sincronização (revisao, pendenteEnvio, excluidoEm, execucaoSolicitadaId)
(function (global) {
    'use strict';

    const NOME_BANCO = 'praxisbot_tablet_v1';
    const VERSAO_BANCO = 1;
    let conexao = null;

    function abrir() {
        if (conexao) return Promise.resolve(conexao);
        return new Promise((resolve, reject) => {
            const req = global.indexedDB.open(NOME_BANCO, VERSAO_BANCO);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'chave' });
                if (!db.objectStoreNames.contains('contexto')) db.createObjectStore('contexto', { keyPath: 'chave' });
                if (!db.objectStoreNames.contains('filas')) db.createObjectStore('filas', { keyPath: 'filaId' });
            };
            req.onsuccess = () => {
                conexao = req.result;
                conexao.onversionchange = () => { conexao.close(); conexao = null; };
                resolve(conexao);
            };
            req.onerror = () => reject(req.error || new Error('Não foi possível abrir o banco offline do tablet.'));
        });
    }

    function promessaReq(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('Falha no IndexedDB.'));
        });
    }

    async function lerKv(chave, padrao = null) {
        const db = await abrir();
        const item = await promessaReq(db.transaction('kv', 'readonly').objectStore('kv').get(chave));
        return item ? item.valor : padrao;
    }

    async function gravarKv(chave, valor) {
        const db = await abrir();
        await promessaReq(db.transaction('kv', 'readwrite').objectStore('kv').put({ chave, valor }));
    }

    async function removerKv(chave) {
        const db = await abrir();
        await promessaReq(db.transaction('kv', 'readwrite').objectStore('kv').delete(chave));
    }

    async function lerContexto(chave) {
        const db = await abrir();
        return promessaReq(db.transaction('contexto', 'readonly').objectStore('contexto').get(chave)) || null;
    }

    async function listarContextos() {
        const db = await abrir();
        const itens = await promessaReq(db.transaction('contexto', 'readonly').objectStore('contexto').getAll());
        const mapa = {};
        for (const item of itens || []) mapa[item.chave] = item;
        return mapa;
    }

    async function gravarContexto(chave, registro) {
        const db = await abrir();
        await promessaReq(db.transaction('contexto', 'readwrite').objectStore('contexto').put({ chave, ...registro }));
    }

    async function listarFilasRegistros() {
        const db = await abrir();
        return (await promessaReq(db.transaction('filas', 'readonly').objectStore('filas').getAll())) || [];
    }

    async function obterFilaRegistro(filaId) {
        const db = await abrir();
        return (await promessaReq(db.transaction('filas', 'readonly').objectStore('filas').get(String(filaId)))) || null;
    }

    async function salvarFilaRegistro(registro) {
        const db = await abrir();
        await promessaReq(db.transaction('filas', 'readwrite').objectStore('filas').put(registro));
    }

    async function limparTudo() {
        const db = await abrir();
        const tx = db.transaction(['kv', 'contexto', 'filas'], 'readwrite');
        tx.objectStore('kv').clear();
        tx.objectStore('contexto').clear();
        tx.objectStore('filas').clear();
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('Não foi possível limpar os dados locais.'));
        });
    }

    global.PraxisTabletDB = Object.freeze({
        abrir,
        lerKv,
        gravarKv,
        removerKv,
        lerContexto,
        listarContextos,
        gravarContexto,
        listarFilasRegistros,
        obterFilaRegistro,
        salvarFilaRegistro,
        limparTudo
    });
})(globalThis);
