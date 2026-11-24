// Criptografia ponta-a-ponta (E2EE) do PraxisBot Tablet via Web Crypto API.
// 100% interoperável byte a byte com src/main/cripto-companheiro.js (Electron/Node):
// - Segredo de 128 bits codificado em Base32 Crockford (26 caracteres).
// - Derivação HKDF-SHA256 com os mesmos sal/info para chave AES-GCM-256 não-exportável.
// - Formato cifrado: "v1.<iv_base64url>.<ciphertext_com_tag_base64url>".
(function (global) {
    'use strict';

    const PREFIXO_QR = 'praxisbot-sync:v1:';
    const ALFABETO_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const TAMANHO_SEGREDO_BYTES = 16;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const SAL_HKDF = encoder.encode('praxisbot-companheiro-salt-v1');
    const INFO_HKDF = encoder.encode('praxisbot-companheiro-aes-256-gcm-v1');

    function bytesParaBase64Url(bytes) {
        const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        let binario = '';
        const bloco = 0x8000;
        for (let i = 0; i < arr.length; i += bloco) {
            binario += String.fromCharCode(...arr.subarray(i, i + bloco));
        }
        return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    function base64UrlParaBytes(texto) {
        const normalizado = String(texto || '').replace(/-/g, '+').replace(/_/g, '/');
        const preenchido = normalizado + '='.repeat((4 - (normalizado.length % 4)) % 4);
        const binario = atob(preenchido);
        const saida = new Uint8Array(binario.length);
        for (let i = 0; i < binario.length; i++) saida[i] = binario.charCodeAt(i);
        return saida;
    }

    function decodificarBase32(texto) {
        const limpo = String(texto || '')
            .trim()
            .toUpperCase()
            .replace(/^PRAXISBOT-SYNC:V1:/, '')
            .replace(/[\s-]+/g, '')
            .replace(/[IL]/g, '1')
            .replace(/O/g, '0');
        if (limpo.length !== 26) throw new Error('Código de pareamento inválido. Confira os 26 caracteres ou leia o QR Code novamente.');
        let bits = 0;
        let acumulador = 0;
        const bytes = [];
        for (const caractere of limpo) {
            const valor = ALFABETO_BASE32.indexOf(caractere);
            if (valor < 0) throw new Error('O código de pareamento contém caractere inválido.');
            acumulador = (acumulador << 5) | valor;
            bits += 5;
            if (bits >= 8) {
                bits -= 8;
                bytes.push((acumulador >>> bits) & 255);
            }
        }
        if (bytes.length !== TAMANHO_SEGREDO_BYTES) throw new Error('Código de pareamento com tamanho inesperado.');
        return new Uint8Array(bytes);
    }

    function formatarCodigoPareamento(texto) {
        const limpo = String(texto || '')
            .toUpperCase()
            .replace(/^PRAXISBOT-SYNC:V1:/, '')
            .replace(/[^0-9A-Z]/g, '')
            .slice(0, 26);
        return (limpo.match(/.{1,4}/g) || []).join('-');
    }

    async function impressaoDigital(segredoBytes) {
        const prefixo = encoder.encode('praxisbot-fp-v1:');
        const combinado = new Uint8Array(prefixo.length + segredoBytes.length);
        combinado.set(prefixo, 0);
        combinado.set(segredoBytes, prefixo.length);
        const resumo = new Uint8Array(await global.crypto.subtle.digest('SHA-256', combinado));
        const hex = Array.from(resumo.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        return `${hex.slice(0, 4)}-${hex.slice(4)}`;
    }

    // Deriva CryptoKey AES-GCM-256 NÃO-EXPORTÁVEL (pode ser salva direto no IndexedDB).
    async function derivarChaveDeCodigo(codigoOuQr) {
        const segredo = decodificarBase32(codigoOuQr);
        const baseKey = await global.crypto.subtle.importKey('raw', segredo, 'HKDF', false, ['deriveKey']);
        const chave = await global.crypto.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt: SAL_HKDF, info: INFO_HKDF },
            baseKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
        const fp = await impressaoDigital(segredo);
        return { chave, impressaoDigital: fp };
    }

    async function cifrarJson(chave, valor, aad = '') {
        const iv = global.crypto.getRandomValues(new Uint8Array(12));
        const opcoes = { name: 'AES-GCM', iv };
        if (aad) opcoes.additionalData = encoder.encode(String(aad));
        const dados = encoder.encode(JSON.stringify(valor));
        const cifrado = await global.crypto.subtle.encrypt(opcoes, chave, dados);
        return `v1.${bytesParaBase64Url(iv)}.${bytesParaBase64Url(new Uint8Array(cifrado))}`;
    }

    async function decifrarJson(chave, pacote, aad = '') {
        const partes = String(pacote || '').split('.');
        if (partes.length !== 3 || partes[0] !== 'v1') throw new Error('Pacote cifrado em formato desconhecido.');
        const iv = base64UrlParaBytes(partes[1]);
        const corpo = base64UrlParaBytes(partes[2]);
        if (iv.length !== 12 || corpo.length < 16) throw new Error('Pacote cifrado incompleto.');
        const opcoes = { name: 'AES-GCM', iv };
        if (aad) opcoes.additionalData = encoder.encode(String(aad));
        const aberto = await global.crypto.subtle.decrypt(opcoes, chave, corpo);
        return JSON.parse(decoder.decode(aberto));
    }

    async function sha256Texto(valor) {
        const texto = typeof valor === 'string' ? valor : JSON.stringify(valor);
        const resumo = new Uint8Array(await global.crypto.subtle.digest('SHA-256', encoder.encode(texto)));
        return Array.from(resumo).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    const modulo = Object.freeze({
        PREFIXO_QR,
        bytesParaBase64Url,
        base64UrlParaBytes,
        decodificarBase32,
        formatarCodigoPareamento,
        impressaoDigital,
        derivarChaveDeCodigo,
        cifrarJson,
        decifrarJson,
        sha256Texto
    });
    global.PraxisTabletCrypto = modulo;
    if (typeof module !== 'undefined' && module.exports) module.exports = modulo;
})(globalThis);
