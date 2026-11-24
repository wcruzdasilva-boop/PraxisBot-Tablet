// Motor de sincronização offline-first do PraxisBot Tablet.
// - Baixa blocos de contexto do Diário (diario_base, aulas, avaliacoes_notas, status_execucao)
//   somente quando o hash_conteudo mudou no servidor.
// - Concilia filas individualmente por UUID (Last-Write-Wins com revisão e soft delete).
// - Envia solicitações explícitas de execução automática no PC (execucao_solicitada_id).
(function (global) {
    'use strict';

    const CHAVES_CONTEXTO = ['diario_base', 'aulas', 'avaliacoes_notas', 'status_execucao'];

    function tempoMs(iso) {
        const t = Date.parse(String(iso || ''));
        return Number.isFinite(t) ? t : 0;
    }

    function gerarUuid() {
        if (global.crypto?.randomUUID) return global.crypto.randomUUID();
        return `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function traduzirErroSync(erro) {
        const texto = String(erro?.message || erro || '');
        if (/PGRST205|42P01|relation .* does not exist|Could not find the table/i.test(texto)) {
            return 'Tabelas de sincronização ainda não criadas no Supabase. Aplique backend/companheiro/migration.sql.';
        }
        if (/Failed to fetch|NetworkError|Load failed|Sem conexão|aborted|timeout/i.test(texto)) {
            return 'Sem internet — seus registros continuam salvos no tablet e sincronizarão ao reconectar.';
        }
        if (/decifrar|OperationError|authentication tag/i.test(texto)) {
            return 'A chave de sincronização não confere com a do computador. Leia o QR Code novamente em Ajustes.';
        }
        return `Falha ao sincronizar: ${texto.slice(0, 140)}`;
    }

    function criarMotorSync({
        db,
        supabase,
        cryptoWeb,
        queueModel,
        estaOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
        agora = () => Date.now(),
        aoMudar = () => {}
    }) {
        let sincronizando = false;
        let promessaSync = null;
        let pendenteNovoCiclo = false;
        let ultimoErro = '';
        let ultimaSincronizacaoEm = '';
        let chaveAtual = null;
        let impressaoDigital = '';
        let dispositivoId = '';
        let timer = null;

        async function carregarMetadados() {
            const meta = (await db.lerKv('sync_meta', {})) || {};
            dispositivoId = meta.dispositivoId || `tablet-${gerarUuid().slice(0, 8)}`;
            ultimaSincronizacaoEm = meta.ultimaSincronizacaoEm || '';
            if (!meta.dispositivoId) await db.gravarKv('sync_meta', { ...meta, dispositivoId });
            const par = await db.lerKv('pareamento', null);
            if (par?.chave) {
                chaveAtual = par.chave;
                impressaoDigital = par.impressaoDigital || '';
            } else {
                chaveAtual = null;
                impressaoDigital = '';
            }
            return estado();
        }

        async function parearComCodigo(codigoOuQr) {
            const { chave, impressaoDigital: fp } = await cryptoWeb.derivarChaveDeCodigo(codigoOuQr);
            chaveAtual = chave;
            impressaoDigital = fp;
            await db.gravarKv('pareamento', { chave, impressaoDigital: fp, pareadoEm: new Date(agora()).toISOString() });
            ultimoErro = '';
            aoMudar(estado());
            return { sucesso: true, impressaoDigital: fp };
        }

        async function limparPareamento() {
            chaveAtual = null;
            impressaoDigital = '';
            await db.removerKv('pareamento');
            aoMudar(estado());
        }

        function estado() {
            return {
                pareado: Boolean(chaveAtual),
                impressaoDigital,
                sincronizando,
                online: Boolean(estaOnline()),
                ultimaSincronizacaoEm,
                ultimoErro
            };
        }

        async function contarPendentes() {
            const registros = await db.listarFilasRegistros();
            return registros.filter(r => r.pendenteEnvio).length;
        }

        async function salvarFilaLocal(filaEntrada, { executarNoPc = false } = {}) {
            const preparada = queueModel.prepararParaSalvar(filaEntrada);
            const fila = preparada.fila;
            if (executarNoPc && preparada.erros.length) {
                return { sucesso: false, fila, erros: preparada.erros, erro: 'A fila ainda tem pendências antes de poder ser executada no computador.' };
            }
            const anterior = await db.obterFilaRegistro(fila.id);
            const agoraIso = new Date(agora()).toISOString();
            fila.atualizadoEm = agoraIso;
            const registro = {
                filaId: fila.id,
                fila,
                revisao: anterior?.revisao || 0,
                atualizadoEm: agoraIso,
                excluidoEm: null,
                execucaoSolicitadaId: executarNoPc ? gerarUuid() : (anterior?.execucaoSolicitadaId || null),
                execucaoSolicitadaEm: executarNoPc ? agoraIso : (anterior?.execucaoSolicitadaEm || null),
                pendenteEnvio: true
            };
            await db.salvarFilaRegistro(registro);
            aoMudar(estado());
            if (estaOnline() && chaveAtual) sincronizarAgora().catch(() => {});
            return { sucesso: true, fila, erros: preparada.erros, registro };
        }

        async function solicitarExecucaoFila(filaId) {
            const anterior = await db.obterFilaRegistro(filaId);
            if (!anterior || anterior.excluidoEm || !anterior.fila) {
                return { sucesso: false, erro: 'Fila não encontrada.' };
            }
            const preparada = queueModel.prepararParaSalvar(anterior.fila);
            if (preparada.erros.length) {
                return { sucesso: false, erro: `A fila possui ${preparada.erros.length} pendência(s). Corrija antes de executar.` };
            }
            const agoraIso = new Date(agora()).toISOString();
            preparada.fila.atualizadoEm = agoraIso;
            const registro = {
                ...anterior,
                fila: preparada.fila,
                atualizadoEm: agoraIso,
                execucaoSolicitadaId: gerarUuid(),
                execucaoSolicitadaEm: agoraIso,
                pendenteEnvio: true
            };
            await db.salvarFilaRegistro(registro);
            aoMudar(estado());
            if (estaOnline() && chaveAtual) sincronizarAgora().catch(() => {});
            return { sucesso: true, registro };
        }

        async function excluirFilaLocal(filaId) {
            const anterior = await db.obterFilaRegistro(filaId);
            if (!anterior) return { sucesso: false, erro: 'Fila não encontrada.' };
            const agoraIso = new Date(agora()).toISOString();
            await db.salvarFilaRegistro({
                ...anterior,
                atualizadoEm: agoraIso,
                excluidoEm: agoraIso,
                pendenteEnvio: true
            });
            aoMudar(estado());
            if (estaOnline() && chaveAtual) sincronizarAgora().catch(() => {});
            return { sucesso: true };
        }

        async function sincronizarAgora() {
            if (!chaveAtual || !supabase.estado().logado) return { sucesso: false, ignorado: true };
            if (!estaOnline()) {
                ultimoErro = '';
                aoMudar(estado());
                return { sucesso: false, offline: true };
            }
            if (promessaSync) {
                pendenteNovoCiclo = true;
                return promessaSync;
            }
            promessaSync = (async () => {
                sincronizando = true;
                aoMudar(estado());
                let ultimoResultado = { sucesso: true, enviadas: 0, contextosBaixados: 0, falhasDecifra: 0 };
                try {
                    do {
                        pendenteNovoCiclo = false;
                        // 1. Confere metadados do contexto (baixa payload cifrado só dos blocos que mudaram).
                        const locaisCtx = await db.listarContextos();
                        const { dados: metasCtx, userId } = await supabase.pedirRest(
                            'companheiro_contexto?select=chave,revisao,hash_conteudo,atualizado_em'
                        );
                        const chavesParaBaixar = (Array.isArray(metasCtx) ? metasCtx : [])
                            .filter(item => CHAVES_CONTEXTO.includes(item.chave))
                            .filter(item => !locaisCtx[item.chave] || locaisCtx[item.chave].hashConteudo !== item.hash_conteudo)
                            .map(item => item.chave);

                        let falhasDecifra = 0;
                        if (chavesParaBaixar.length) {
                            const filtro = chavesParaBaixar.map(encodeURIComponent).join(',');
                            const { dados: blocos } = await supabase.pedirRest(
                                `companheiro_contexto?select=chave,revisao,hash_conteudo,atualizado_em,payload_cifrado&chave=in.(${filtro})`
                            );
                            for (const bloco of Array.isArray(blocos) ? blocos : []) {
                                try {
                                    const dadosAbertos = await cryptoWeb.decifrarJson(chaveAtual, bloco.payload_cifrado, `contexto:${bloco.chave}`);
                                    await db.gravarContexto(bloco.chave, {
                                        revisao: Number(bloco.revisao) || 1,
                                        hashConteudo: String(bloco.hash_conteudo || ''),
                                        atualizadoEm: String(bloco.atualizado_em || ''),
                                        dados: dadosAbertos
                                    });
                                } catch (_) {
                                    falhasDecifra++;
                                }
                            }
                        }

                        // 2. Puxa filas remotas e concilia com o IndexedDB local.
                        const { dados: linhasRemotas } = await supabase.pedirRest(
                            'companheiro_filas?select=fila_id,revisao,origem_dispositivo,atualizado_em,excluido_em,execucao_solicitada_id,execucao_solicitada_em,payload_cifrado'
                        );
                        const remotasPorId = new Map();
                        for (const linha of Array.isArray(linhasRemotas) ? linhasRemotas : []) {
                            let filaDecifrada = null;
                            if (linha.payload_cifrado) {
                                try {
                                    filaDecifrada = await cryptoWeb.decifrarJson(chaveAtual, linha.payload_cifrado, `fila:${linha.fila_id}`);
                                } catch (_) {
                                    falhasDecifra++;
                                    continue;
                                }
                            }
                            remotasPorId.set(String(linha.fila_id), {
                                filaId: String(linha.fila_id),
                                revisao: Number(linha.revisao) || 1,
                                origemDispositivo: String(linha.origem_dispositivo || ''),
                                atualizadoEm: String(linha.atualizado_em || ''),
                                excluidoEm: linha.excluido_em || null,
                                execucaoSolicitadaId: linha.execucao_solicitada_id || null,
                                execucaoSolicitadaEm: linha.execucao_solicitada_em || null,
                                fila: filaDecifrada
                            });
                        }

                        const locaisLista = await db.listarFilasRegistros();
                        const locaisPorId = new Map(locaisLista.map(r => [r.filaId, r]));
                        const todosIds = new Set([...locaisPorId.keys(), ...remotasPorId.keys()]);
                        const linhasParaSubir = [];
                        const atualizacoesPosUpload = [];

                        for (const id of todosIds) {
                            const local = locaisPorId.get(id) || null;
                            const remota = remotasPorId.get(id) || null;

                            if (local?.pendenteEnvio) {
                                const remotoMaisNovo = Boolean(remota)
                                    && remota.revisao > (local.revisao || 0)
                                    && tempoMs(remota.atualizadoEm) > tempoMs(local.atualizadoEm);
                                if (remotoMaisNovo) {
                                    await db.salvarFilaRegistro({
                                        filaId: id,
                                        fila: remota.fila,
                                        revisao: remota.revisao,
                                        atualizadoEm: remota.atualizadoEm,
                                        excluidoEm: remota.excluidoEm,
                                        execucaoSolicitadaId: remota.execucaoSolicitadaId,
                                        execucaoSolicitadaEm: remota.execucaoSolicitadaEm,
                                        pendenteEnvio: false
                                    });
                                    continue;
                                }
                                const proximaRevisao = Math.max(remota?.revisao || 0, local.revisao || 0) + 1;
                                const payloadObj = local.excluidoEm ? { id, excluidoEm: local.excluidoEm } : local.fila;
                                const payloadCifrado = await cryptoWeb.cifrarJson(chaveAtual, payloadObj, `fila:${id}`);
                                linhasParaSubir.push({
                                    user_id: userId,
                                    fila_id: id,
                                    revisao: proximaRevisao,
                                    origem_dispositivo: dispositivoId,
                                    atualizado_em: local.atualizadoEm,
                                    excluido_em: local.excluidoEm,
                                    execucao_solicitada_id: local.excluidoEm ? null : (local.execucaoSolicitadaId || null),
                                    execucao_solicitada_em: local.excluidoEm ? null : (local.execucaoSolicitadaEm || null),
                                    payload_cifrado: payloadCifrado
                                });
                                atualizacoesPosUpload.push({
                                    ...local,
                                    revisao: proximaRevisao,
                                    pendenteEnvio: false
                                });
                                continue;
                            }

                            if (remota) {
                                const mudou = !local
                                    || remota.revisao !== local.revisao
                                    || remota.atualizadoEm !== local.atualizadoEm
                                    || Boolean(remota.excluidoEm) !== Boolean(local.excluidoEm);
                                if (mudou) {
                                    await db.salvarFilaRegistro({
                                        filaId: id,
                                        fila: remota.fila,
                                        revisao: remota.revisao,
                                        atualizadoEm: remota.atualizadoEm,
                                        excluidoEm: remota.excluidoEm,
                                        execucaoSolicitadaId: remota.execucaoSolicitadaId,
                                        execucaoSolicitadaEm: remota.execucaoSolicitadaEm,
                                        pendenteEnvio: false
                                    });
                                }
                            }
                        }

                        if (linhasParaSubir.length) {
                            await supabase.pedirRest('companheiro_filas?on_conflict=user_id,fila_id', {
                                metodo: 'POST',
                                headersExtras: { Prefer: 'resolution=merge-duplicates,return=minimal' },
                                corpo: linhasParaSubir
                            });
                            for (const reg of atualizacoesPosUpload) await db.salvarFilaRegistro(reg);
                        }

                        ultimaSincronizacaoEm = new Date(agora()).toISOString();
                        const metaAtual = (await db.lerKv('sync_meta', {})) || {};
                        await db.gravarKv('sync_meta', { ...metaAtual, dispositivoId, ultimaSincronizacaoEm });
                        ultimoErro = falhasDecifra > 0
                            ? `${falhasDecifra} registro(s) foram cifrados com outra chave. Pareie novamente com o QR Code do computador.`
                            : '';
                        ultimoResultado = { sucesso: true, enviadas: linhasParaSubir.length, contextosBaixados: chavesParaBaixar.length, falhasDecifra };
                    } while (pendenteNovoCiclo && chaveAtual && supabase.estado().logado && estaOnline());
                    return ultimoResultado;
                } catch (erro) {
                    ultimoErro = traduzirErroSync(erro);
                    return { sucesso: false, erro: ultimoErro };
                } finally {
                    sincronizando = false;
                    promessaSync = null;
                    aoMudar(estado());
                }
            })();
            return promessaSync;
        }

        function iniciarPeriodico(intervaloMs = 25000) {
            if (timer) return;
            timer = setInterval(() => {
                if (estaOnline() && chaveAtual && supabase.estado().logado) {
                    sincronizarAgora().catch(() => {});
                }
            }, intervaloMs);
        }

        function pararPeriodico() {
            if (!timer) return;
            clearInterval(timer);
            timer = null;
        }

        return {
            carregarMetadados,
            parearComCodigo,
            limparPareamento,
            estado,
            contarPendentes,
            salvarFilaLocal,
            solicitarExecucaoFila,
            excluirFilaLocal,
            sincronizarAgora,
            iniciarPeriodico,
            pararPeriodico
        };
    }

    const modulo = Object.freeze({ criarMotorSync, traduzirErroSync, CHAVES_CONTEXTO });
    global.PraxisTabletSync = modulo;
    if (typeof module !== 'undefined' && module.exports) module.exports = modulo;
})(globalThis);
