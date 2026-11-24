(function(global) {
    'use strict';

    const PERIODOS = Object.freeze(['1º PERIODO', '2º PERIODO', '3º PERIODO', '4º PERIODO']);

    function texto(valor) {
        return String(valor ?? '').trim().replace(/\s+/g, ' ');
    }

    function assinatura(valor) {
        if (global.SiaepGradeSyncModel?.assinatura) return global.SiaepGradeSyncModel.assinatura(valor);
        return texto(valor).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleUpperCase('pt-BR');
    }

    function canonizar(valor) {
        return assinatura(valor).replace(/[º°]/g, '').replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function normalizarPeriodo(valor) {
        const numero = canonizar(valor).match(/\b([1-4])\b/)?.[1];
        return numero ? `${numero}º PERIODO` : '';
    }

    function arredondar(valor) {
        return Number.isFinite(valor) ? Math.round((valor + Number.EPSILON) * 100) / 100 : null;
    }

    function valorNota(nota) {
        if (!nota?.possuiNota) return null;
        const numero = Number(nota.valor);
        return Number.isFinite(numero) && numero >= 0 && numero <= 10 ? numero : null;
    }

    function ordenarAlunos(alunos, notas) {
        const mapa = new Map();
        (Array.isArray(alunos) ? alunos : []).forEach(aluno => {
            if (aluno?.id) mapa.set(aluno.id, { ...aluno });
        });
        (Array.isArray(notas) ? notas : []).forEach(nota => {
            if (!nota?.alunoId || mapa.has(nota.alunoId)) return;
            mapa.set(nota.alunoId, {
                id: nota.alunoId,
                matricula: nota.matricula,
                nome: nota.nome,
                ordem: nota.ordem,
                situacao: nota.situacaoMatricula
            });
        });
        return [...mapa.values()].sort((a, b) =>
            (Number(a.ordem) || 99999) - (Number(b.ordem) || 99999)
            || texto(a.nome).localeCompare(texto(b.nome), 'pt-BR')
        );
    }

    function montarPares(avaliacoes, periodo) {
        const doPeriodo = (Array.isArray(avaliacoes) ? avaliacoes : [])
            .filter(item => normalizarPeriodo(item?.periodo) === periodo);
        const principais = doPeriodo
            .filter(item => canonizar(item?.tipo).includes('AVALIACAO DO PERIODO'))
            .sort((a, b) => Number(a.ordem) - Number(b.ordem) || texto(a.id).localeCompare(texto(b.id)));
        const recuperacoes = doPeriodo.filter(item => canonizar(item?.tipo).includes('RECUPERACAO PARALELA'));
        return principais.map((principal, indice) => {
            const chave = texto(principal.avaliacaoPrincipalId || principal.chavePar || principal.id);
            const recuperacao = recuperacoes
                .filter(item => texto(item.avaliacaoPrincipalId || item.chavePar) === chave)
                .sort((a, b) => Number(a.ordem) - Number(b.ordem))[0] || null;
            return {
                id: chave || texto(principal.id),
                indice: indice + 1,
                principal,
                recuperacao,
                rotulo: principal.descricao || principal.instrumento || `Avaliação ${indice + 1}`
            };
        });
    }

    function calcularRelatorioBimestral({ avaliacoes = [], notas = [], alunos = [], periodo = '' } = {}) {
        const periodoNormalizado = normalizarPeriodo(periodo);
        if (!periodoNormalizado) throw new Error('O relatório bimestral exige um período válido.');
        const pares = montarPares(avaliacoes, periodoNormalizado);
        const porAvaliacaoAluno = new Map(
            notas.filter(item => item?.avaliacaoId && item?.alunoId)
                .map(item => [`${item.avaliacaoId}|${item.alunoId}`, item])
        );
        const linhas = ordenarAlunos(alunos, notas).map(aluno => {
            const resultados = pares.map(par => {
                const ap = valorNota(porAvaliacaoAluno.get(`${par.principal.id}|${aluno.id}`));
                const rp = par.recuperacao
                    ? valorNota(porAvaliacaoAluno.get(`${par.recuperacao.id}|${aluno.id}`))
                    : null;
                if (ap === null) {
                    return { parId: par.id, ap, rp, efetiva: null, origem: '', pendente: true, memoria: 'AP ausente' };
                }
                const usarRecuperacao = rp !== null && rp > ap;
                const efetiva = usarRecuperacao ? rp : ap;
                return {
                    parId: par.id,
                    ap,
                    rp,
                    efetiva,
                    origem: usarRecuperacao ? 'RP' : 'AP',
                    pendente: false,
                    memoria: rp === null ? `${ap}` : `máx(${ap}; ${rp}) = ${efetiva}`
                };
            });
            const validas = resultados.map(item => item.efetiva).filter(Number.isFinite);
            // App (2026-10-21, pedido do usuário): a média divide pela quantidade de avaliações
            // do período, não só pelas notas lançadas. Com 8 e 9 lançadas e uma terceira ausente,
            // a média parcial é 17 / 3 = 5,67, e não 17 / 2 = 8,5, que parecia nota já fechada.
            const media = validas.length ? arredondar(validas.reduce((total, valor) => total + valor, 0) / pares.length) : null;
            const completo = pares.length > 0 && resultados.every(item => !item.pendente);
            const ausentes = resultados.filter(item => item.pendente).length;
            return {
                alunoId: aluno.id,
                matricula: texto(aluno.matricula),
                nome: texto(aluno.nome),
                ordem: texto(aluno.ordem),
                situacao: texto(aluno.situacao || aluno.situacaoMatricula),
                pares: resultados,
                media,
                mediaOficial: completo ? media : null,
                completo,
                pendencias: ausentes,
                memoria: validas.length
                    ? `(${validas.join(' + ')}) / ${pares.length} = ${media}${ausentes ? ` (${ausentes} nota(s) ausente(s))` : ''}`
                    : 'Sem notas efetivas'
            };
        });
        return {
            schemaVersion: 1,
            tipo: 'BIMESTRAL',
            periodo: periodoNormalizado,
            pares: pares.map(par => ({
                id: par.id,
                indice: par.indice,
                rotulo: par.rotulo,
                avaliacaoId: par.principal.id,
                recuperacaoId: par.recuperacao?.id || ''
            })),
            linhas,
            completo: pares.length > 0 && linhas.length > 0 && linhas.every(item => item.completo),
            aviso: 'Cálculo local para conferência. A média soma as notas lançadas e divide pela quantidade de avaliações do período; nota ausente fica pendente e não soma nada até ser lançada.'
        };
    }

    function calcularRelatorioAnual({ periodos = [], alunos = [] } = {}) {
        const porPeriodo = new Map();
        PERIODOS.forEach(periodo => {
            const origem = periodos.find(item => normalizarPeriodo(item?.periodo) === periodo) || {};
            porPeriodo.set(periodo, calcularRelatorioBimestral({
                periodo,
                avaliacoes: origem.avaliacoes || [],
                notas: origem.notas || [],
                alunos
            }));
        });
        const todosAlunos = ordenarAlunos(
            alunos,
            periodos.flatMap(item => Array.isArray(item?.notas) ? item.notas : [])
        );
        const linhas = todosAlunos.map(aluno => {
            const resultados = PERIODOS.map(periodo => {
                const linha = porPeriodo.get(periodo).linhas.find(item => item.alunoId === aluno.id);
                return {
                    periodo,
                    media: linha?.media ?? null,
                    completa: Boolean(linha?.completo && Number.isFinite(linha.mediaOficial)),
                    pendencias: linha?.pendencias ?? 0
                };
            });
            const completas = resultados.filter(item => item.completa).map(item => item.media);
            const completo = completas.length === PERIODOS.length;
            const mediaAnual = completo
                ? arredondar(completas.reduce((total, valor) => total + valor, 0) / PERIODOS.length)
                : null;
            const mediaParcial = completas.length
                ? arredondar(completas.reduce((total, valor) => total + valor, 0) / completas.length)
                : null;
            return {
                alunoId: aluno.id,
                matricula: texto(aluno.matricula),
                nome: texto(aluno.nome),
                periodos: resultados,
                mediaAnual,
                mediaParcial,
                completo,
                memoria: completo
                    ? `(${completas.join(' + ')}) / 4 = ${mediaAnual}`
                    : `${PERIODOS.length - completas.length} período(s) ausente(s) ou incompleto(s)`
            };
        });
        return {
            schemaVersion: 1,
            tipo: 'ANUAL',
            periodos: [...PERIODOS],
            linhas,
            completo: linhas.length > 0 && linhas.every(item => item.completo),
            aviso: 'A média anual somente é apresentada quando os quatro períodos estão completos. Resultado local, sem escrita no SIAEP.'
        };
    }

    global.SiaepAcademicReportModel = Object.freeze({
        PERIODOS,
        assinatura,
        canonizar,
        normalizarPeriodo,
        calcularRelatorioBimestral,
        calcularRelatorioAnual
    });
})(globalThis);
