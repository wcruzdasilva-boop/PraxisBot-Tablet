(function(global) {
    'use strict';

    function texto(valor) {
        return typeof valor === 'string' ? valor.trim().replace(/\s+/g, ' ') : '';
    }

    function assinatura(valor) {
        return texto(valor).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleUpperCase('pt-BR');
    }

    function localizarIndice(cabecalhos, nomes) {
        const normalizados = cabecalhos.map(assinatura);
        return normalizados.findIndex(cabecalho => nomes.some(nome => cabecalho === nome || cabecalho.includes(nome)));
    }

    function criarRotulo(turma) {
        const prefixo = turma.turno ? `[${turma.turno}] ` : '';
        const numero = turma.numero ? `${turma.numero} - ` : '';
        return `${prefixo}${numero}${turma.nome}`.trim();
    }

    // O nome da turma vindo do SIAEP é longo (ex.: "ENSINO REGULAR - ENSINO
    // MEDIO - 2ª SERIE EMP - REGULAR ETT"); extrai só a série/ano para
    // rótulos compactos onde a largura é limitada (ex.: filtro de turma da
    // Consulta de horário).
    function extrairSerie(nome) {
        const correspondencia = texto(nome).match(/(\d+)\s*[ªº]?\s*(SERIE|SÉRIE|ANO)/i);
        if (!correspondencia) return '';
        const numero = correspondencia[1];
        const ehAno = /ANO/i.test(correspondencia[2]);
        return ehAno ? `${numero}º ANO` : `${numero}ª SERIE`;
    }

    function criarRotuloCompacto(turma) {
        const serie = extrairSerie(turma?.nome);
        if (!serie) return criarRotulo(turma);
        const prefixo = turma.turno ? `[${turma.turno}] ` : '';
        const numero = turma.numero ? String(turma.numero) : '';
        return `${prefixo}${numero} -- ${serie}`.trim();
    }

    function mapearEscola(valor) {
        const original = texto(valor);
        const correspondencia = original.match(/(?:ANO:\s*(\d{4})\s*)?ESCOLA:\s*(\d+)\s*-\s*(.+)$/i);
        if (!correspondencia) return null;
        const codigo = texto(correspondencia[2]);
        const nome = texto(correspondencia[3]);
        if (!codigo || !nome) return null;
        return {
            id: `escola-${codigo}`,
            codigo,
            nome,
            ano: texto(correspondencia[1])
        };
    }

    function normalizarEscola(valor) {
        if (!valor || typeof valor !== 'object') return null;
        const codigo = texto(valor.codigo);
        const nome = texto(valor.nome);
        if (!codigo || !nome) return null;
        return {
            id: texto(valor.id) || `escola-${codigo}`,
            codigo,
            nome,
            ano: texto(valor.ano)
        };
    }

    function mapearTabela(cabecalhos, linhas) {
        if (!Array.isArray(cabecalhos) || !Array.isArray(linhas)) return [];
        const indiceNome = localizarIndice(cabecalhos, ['NOME TURMA', 'NOME']);
        const indiceNumero = localizarIndice(cabecalhos, ['NUMERO']);
        const indiceTurno = localizarIndice(cabecalhos, ['TURNO']);
        if ([indiceNome, indiceNumero, indiceTurno].some(indice => indice < 0)) return [];

        const unicas = new Map();
        linhas.forEach(linha => {
            if (!Array.isArray(linha)) return;
            const turma = {
                nome: texto(linha[indiceNome]),
                numero: texto(linha[indiceNumero]),
                turno: texto(linha[indiceTurno])
            };
            if (!turma.nome || !turma.numero || !turma.turno) return;
            turma.rotulo = criarRotulo(turma);
            turma.id = assinatura(`${turma.turno}|${turma.numero}|${turma.nome}`);
            if (!unicas.has(turma.id)) unicas.set(turma.id, turma);
        });
        return [...unicas.values()].sort((a, b) => a.rotulo.localeCompare(b.rotulo, 'pt-BR'));
    }

    function normalizarCatalogo(valor) {
        const escola = normalizarEscola(valor?.escola);
        const turmasBase = Array.isArray(valor?.turmas)
            ? mapearTabela(['Nome', 'Número', 'Turno'], valor.turmas.map(turma => [turma?.nome, turma?.numero, turma?.turno]))
            : [];
        const turmas = turmasBase.map(turma => ({ ...turma, escolaId: escola?.id || texto(valor?.turmas?.find(item => item?.id === turma.id)?.escolaId) }));
        return {
            schemaVersion: 1,
            solicitacaoId: texto(valor?.solicitacaoId),
            status: ['EXECUTANDO', 'SUCESSO', 'ERRO'].includes(valor?.status) ? valor.status : 'SEM_DADOS',
            mensagem: texto(valor?.mensagem),
            atualizadoEm: texto(valor?.atualizadoEm),
            escola,
            turmas
        };
    }

    global.SiaepCatalogModel = Object.freeze({
        assinatura,
        criarRotulo,
        extrairSerie,
        criarRotuloCompacto,
        mapearEscola,
        mapearTabela,
        normalizarCatalogo
    });
})(globalThis);
