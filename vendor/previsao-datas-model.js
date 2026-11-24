// Datas previstas no preview das filas de Aulas e Frequência (pedido do usuário,
// 2026-09-25). Só informativas: mostram ao professor quando cada aula/coluna deve
// cair, pela mesma regra do motor, a partir do Diário local. A execução continua
// decidindo pelo que o SIAEP mostra na hora.
//
// Aulas (content.js, Aulas.construirCronograma e ETAPA 2 de executarCascataDOM): a
// linha N vai para o N-ésimo horário da turma na disciplina a partir da data inicial,
// pulando os dias da lista de feriados (comparados como "dd/mm"); um dia com dois
// horários consome dois slots. Sem "Substituir", a linha é pulada quando o dia já tem
// aulas registradas suficientes para cobrir a posição dela no dia (ordemNoDia).
//
// Frequência (content.js, Frequencia.obterProximaAulaTarget): a coluna N vai para a
// N-ésima data com aula da disciplina a partir da data-base (várias aulas na mesma
// data formam um grupo). Sem "Substituir", a aula com frequência já lançada é pulada.
(function (global) {
    'use strict';

    const LIMITE_DIAS_BUSCA = 800;

    function pad2(numero) {
        return String(numero).padStart(2, '0');
    }

    function isoDeData(data) {
        return `${data.getFullYear()}-${pad2(data.getMonth() + 1)}-${pad2(data.getDate())}`;
    }

    function dataDeIso(iso) {
        const partes = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!partes) return null;
        const data = new Date(Number(partes[1]), Number(partes[2]) - 1, Number(partes[3]));
        return Number.isFinite(data.getTime()) ? data : null;
    }

    function somarDias(iso, dias) {
        const data = dataDeIso(iso);
        if (!data) return '';
        data.setDate(data.getDate() + dias);
        return isoDeData(data);
    }

    function formatarCurta(iso) {
        const [ano, mes, dia] = String(iso || '').split('-');
        return ano && mes && dia ? `${dia}/${mes}` : '';
    }

    function formatarData(iso) {
        const [ano, mes, dia] = String(iso || '').split('-');
        return ano && mes && dia ? `${dia}/${mes}/${ano}` : '';
    }

    function normalizarTexto(valor) {
        return String(valor || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
    }

    // Mesma leitura do motor: "12/10, 02/11" -> ['12/10', '02/11'].
    function listaFeriados(feriados) {
        return String(feriados || '').split(',').map(item => item.trim()).filter(Boolean);
    }

    // Cópia de Aulas.construirCronograma, sem o estado do motor.
    function cronogramaAulas({ dataInicial, feriados = '', gradeSemanal = [], quantidade = 0 }) {
        const dataAtual = dataDeIso(dataInicial);
        const slotsPorDia = new Map();
        (Array.isArray(gradeSemanal) ? gradeSemanal : []).forEach(slot => {
            const dia = Number(slot?.dia);
            if (!Number.isInteger(dia) || dia < 0 || dia > 6) return;
            if (!slotsPorDia.has(dia)) slotsPorDia.set(dia, []);
            slotsPorDia.get(dia).push({ dia, horarioInicio: String(slot.horarioInicio || '') });
        });
        if (!dataAtual || !slotsPorDia.size || quantidade <= 0) return [];
        slotsPorDia.forEach(lista => lista.sort((a, b) => a.horarioInicio.localeCompare(b.horarioInicio)));
        const listaFeriadosDiaMes = listaFeriados(feriados);

        const cronograma = [];
        let indiceSlotNoDia = 0;
        for (let i = 0; i < quantidade; i++) {
            let tentativas = 0;
            while (true) {
                const diaMes = `${pad2(dataAtual.getDate())}/${pad2(dataAtual.getMonth() + 1)}`;
                const slotsDoDia = slotsPorDia.get(dataAtual.getDay()) || [];
                if (indiceSlotNoDia < slotsDoDia.length && !listaFeriadosDiaMes.includes(diaMes)) break;
                dataAtual.setDate(dataAtual.getDate() + 1);
                indiceSlotNoDia = 0;
                // Todos os dias com aula marcados como feriado: o motor ficaria preso;
                // aqui a previsão só para.
                if (++tentativas > LIMITE_DIAS_BUSCA) return cronograma;
            }
            const slotsDoDia = slotsPorDia.get(dataAtual.getDay());
            cronograma.push({ data: isoDeData(dataAtual), horarioInicio: slotsDoDia[indiceSlotNoDia].horarioInicio, ordemNoDia: indiceSlotNoDia });
            indiceSlotNoDia++;
            if (indiceSlotNoDia >= slotsDoDia.length) {
                dataAtual.setDate(dataAtual.getDate() + 1);
                indiceSlotNoDia = 0;
            }
        }
        return cronograma;
    }

    // aulasRegistradas: aulas da turma na disciplina, do Diário local ({ data ISO, hora, descricao|tema }).
    function marcarAulasRegistradas(cronograma, aulasRegistradas = []) {
        const porData = new Map();
        (Array.isArray(aulasRegistradas) ? aulasRegistradas : [])
            .filter(aula => /^\d{4}-\d{2}-\d{2}$/.test(String(aula?.data || '')))
            .slice()
            .sort((a, b) => String(a.hora || '').localeCompare(String(b.hora || '')))
            .forEach(aula => {
                if (!porData.has(aula.data)) porData.set(aula.data, []);
                porData.get(aula.data).push(String(aula.descricao || aula.tema || '').trim());
            });
        return cronograma.map(slot => {
            const temas = porData.get(slot.data) || [];
            const registrada = slot.ordemNoDia < temas.length;
            return { ...slot, registrada, temaRegistrado: registrada ? temas[slot.ordemNoDia] : '' };
        });
    }

    function previsaoAulasTurma({ dataInicial, feriados, gradeSemanal, aulasRegistradas, quantidade, temas = [] }) {
        if (!Array.isArray(gradeSemanal) || !gradeSemanal.length) return { semHorario: true, itens: [] };
        const itens = marcarAulasRegistradas(cronogramaAulas({ dataInicial, feriados, gradeSemanal, quantidade }), aulasRegistradas)
            .map((item, indice) => ({
                ...item,
                // Mesma comparação do motor (JA_REGISTRADA x JA_REGISTRADA_TEMA_DIVERGENTE).
                divergente: item.registrada && Boolean(item.temaRegistrado) && temas[indice] !== undefined
                    && normalizarTexto(item.temaRegistrado) !== normalizarTexto(temas[indice])
            }));
        return { semHorario: false, itens };
    }

    // Linhas iniciais já registradas que podem sair da fila sem mudar a data de nenhuma
    // outra linha, e a data inicial nova. Com várias turmas a matriz é a mesma e a data
    // inicial também, então só sai o que está registrado em todas elas e a data nova
    // precisa manter, em cada turma, o horário que a próxima linha já teria.
    // porTurma: [{ itens }] de previsaoAulasTurma (turmas sem horário ficam de fora).
    function remocaoAulas(porTurma, totalLinhas) {
        const turmas = (Array.isArray(porTurma) ? porTurma : []).filter(turma => !turma.semHorario && turma.itens.length);
        if (!turmas.length || totalLinhas <= 0) return null;
        const prefixo = turma => {
            let k = 0;
            while (k < Math.min(totalLinhas, turma.itens.length) && turma.itens[k].registrada) k++;
            return k;
        };
        for (let k = Math.min(...turmas.map(prefixo)); k >= 1; k--) {
            // Limite inferior: o dia seguinte à última linha removida. Superior: o dia da
            // próxima linha, que precisa ser o 1º horário do dia (senão o motor começaria
            // no horário anterior do mesmo dia, já registrado).
            const inferior = turmas.map(turma => somarDias(turma.itens[k - 1].data, 1));
            const superior = turmas.map(turma => turma.itens[k] ? turma.itens[k].data : '');
            const maiorInferior = inferior.sort().at(-1);
            const finitos = superior.filter(Boolean).sort();
            const dataBase = finitos.length ? finitos[0] : maiorInferior;
            if (dataBase >= maiorInferior && (!finitos.length || dataBase <= finitos[0])) {
                return { remover: k, dataBase };
            }
        }
        return null;
    }

    // Grupos por data (cópia de obterProximaAulaTarget): aulas da disciplina a partir
    // da data-base, em ordem de data e hora. frequenciaLancada: true/false, ou
    // ausente quando a cópia local não sabe (sincronização antiga).
    function gruposFrequencia({ dataInicial, aulas = [] }) {
        const base = String(dataInicial || '');
        const grupos = new Map();
        (Array.isArray(aulas) ? aulas : [])
            .filter(aula => /^\d{4}-\d{2}-\d{2}$/.test(String(aula?.data || '')) && aula.data >= base)
            .slice()
            .sort((a, b) => `${a.data} ${a.hora || ''}`.localeCompare(`${b.data} ${b.hora || ''}`))
            .forEach(aula => {
                if (!grupos.has(aula.data)) grupos.set(aula.data, []);
                grupos.get(aula.data).push(aula);
            });
        return [...grupos.entries()].map(([data, lista]) => {
            const conhecidas = lista.filter(aula => typeof aula.frequenciaLancada === 'boolean');
            const lancadas = lista.filter(aula => aula.frequenciaLancada === true).length;
            return {
                data,
                total: lista.length,
                lancadas,
                // Coluna pulada inteira só quando todas as aulas da data já têm frequência.
                registrada: conhecidas.length < lista.length ? (lancadas === lista.length ? true : null) : lancadas === lista.length
            };
        });
    }

    function previsaoFrequenciaTurma({ dataInicial, aulas, colunas, hojeIso }) {
        const grupos = gruposFrequencia({ dataInicial, aulas });
        const hoje = hojeIso || isoDeData(new Date());
        return {
            semAulas: !grupos.length,
            grupos,
            colunas: Array.from({ length: Math.max(0, colunas) }, (_, indice) => {
                const grupo = grupos[indice];
                if (!grupo) return { data: '', semAula: true };
                return { ...grupo, futura: grupo.data > hoje };
            })
        };
    }

    // Colunas iniciais com frequência já lançada que saem de cada turma, e a data-base
    // nova (a mesma para todas as turmas da fila). A data nova é a primeira data ainda
    // sem frequência entre as turmas; em cada turma saem só as colunas antes dela,
    // assim nenhuma coluna restante muda de aula.
    // porTurma: [{ grupos, colunas }] de previsaoFrequenciaTurma, na ordem dos blocos.
    function remocaoFrequencia(porTurma) {
        const turmas = Array.isArray(porTurma) ? porTurma : [];
        const prefixos = turmas.map(turma => {
            let k = 0;
            while (k < turma.colunas.length && turma.colunas[k].registrada === true) k++;
            return k;
        });
        if (!prefixos.some(Boolean)) return null;
        const candidatas = turmas
            .map((turma, indice) => turma.grupos[prefixos[indice]]?.data || '')
            .filter(Boolean)
            .sort();
        const dataBase = candidatas.length
            ? candidatas[0]
            : turmas.map((turma, indice) => prefixos[indice] ? somarDias(turma.grupos[prefixos[indice] - 1].data, 1) : '').filter(Boolean).sort().at(-1);
        const removerPorBloco = turmas.map((turma, indice) =>
            turma.grupos.slice(0, prefixos[indice]).filter(grupo => grupo.data < dataBase).length);
        if (!removerPorBloco.some(Boolean)) return null;
        return { removerPorBloco, dataBase };
    }

    // Aplicações no texto da matriz (mesmo formato de queue-model.js).
    function removerLinhasAulas(matrizTexto, quantidade) {
        const linhas = String(matrizTexto || '').replace(/\r\n/g, '\n').split('\n').filter(linha => linha.trim());
        return linhas.slice(Math.max(0, quantidade)).join('\n');
    }

    function removerColunasFrequencia(matrizTexto, removerPorBloco) {
        const blocos = String(matrizTexto || '').replace(/\r\n/g, '\n').split(/\n\s*[#*]\s*\n/).map(bloco => bloco.trim()).filter(Boolean);
        return blocos.map((bloco, indice) => {
            const remover = Math.max(0, Number(removerPorBloco?.[indice]) || 0);
            if (!remover) return bloco;
            return bloco.split('\n').filter(linha => linha.trim()).map(linha => {
                const partes = linha.split('\t');
                return [partes[0], ...partes.slice(1 + remover)].join('\t');
            }).join('\n');
        }).join('\n*\n');
    }

    const modelo = Object.freeze({
        cronogramaAulas,
        marcarAulasRegistradas,
        previsaoAulasTurma,
        remocaoAulas,
        gruposFrequencia,
        previsaoFrequenciaTurma,
        remocaoFrequencia,
        removerLinhasAulas,
        removerColunasFrequencia,
        formatarCurta,
        formatarData,
        somarDias
    });
    global.SiaepPrevisaoDatasModel = modelo;
    if (typeof module !== 'undefined' && module.exports) module.exports = modelo;
})(typeof globalThis !== 'undefined' ? globalThis : this);
