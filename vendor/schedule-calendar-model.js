(function(global) {
    'use strict';

    function pad2(numero) {
        return String(numero).padStart(2, '0');
    }

    function paraIso(ano, mes, dia) {
        return `${ano}-${pad2(mes)}-${pad2(dia)}`;
    }

    function diasComAula(horarios) {
        const conjunto = new Set();
        (Array.isArray(horarios) ? horarios : []).forEach(item => {
            const dia = Number(item?.diaSemana);
            if (Number.isInteger(dia) && dia >= 0 && dia <= 6) conjunto.add(dia);
        });
        return conjunto;
    }

    // Diferente de `diasComAula` (usada só para pintar a grade mensal da
    // Consulta de Horário, onde "tem aula nesse dia" já basta), esta função
    // preserva um slot por horário -- necessária para turmas com mais de um
    // horário da mesma disciplina no mesmo dia da semana, que `diasComAula`
    // colapsaria em um único dia e esconderia o segundo horário.
    function gradeSemanalOrdenada(horarios) {
        const vistos = new Set();
        const slots = [];
        (Array.isArray(horarios) ? horarios : []).forEach(item => {
            const dia = Number(item?.diaSemana);
            const horarioInicio = String(item?.horarioInicio || '');
            if (!Number.isInteger(dia) || dia < 0 || dia > 6 || !horarioInicio) return;
            const chave = `${dia}|${horarioInicio}`;
            if (vistos.has(chave)) return;
            vistos.add(chave);
            slots.push({ dia, horarioInicio });
        });
        slots.sort((a, b) => (a.dia - b.dia) || a.horarioInicio.localeCompare(b.horarioInicio));
        return slots;
    }

    // `mes` usa a convenção 1-12 (janeiro=1), a mesma dos campos de data
    // 'AAAA-MM-DD' já usados no resto do projeto. A grade sempre começa no
    // domingo e cobre semanas completas, incluindo dias do mês anterior e
    // seguinte necessários para preencher a primeira e a última semana.
    function montarGradeMes(ano, mes, conjuntoDiasComAula, datasFeriado) {
        const diasComAulaSet = conjuntoDiasComAula instanceof Set ? conjuntoDiasComAula : new Set(conjuntoDiasComAula || []);
        const feriadosSet = datasFeriado instanceof Set ? datasFeriado : new Set(datasFeriado || []);
        const diaSemanaInicial = new Date(ano, mes - 1, 1).getDay();
        const ultimoDiaMes = new Date(ano, mes, 0).getDate();
        const totalCelulas = Math.ceil((diaSemanaInicial + ultimoDiaMes) / 7) * 7;
        const inicio = new Date(ano, mes - 1, 1 - diaSemanaInicial);
        const celulas = [];
        for (let i = 0; i < totalCelulas; i++) {
            const atual = new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate() + i);
            const anoCel = atual.getFullYear();
            const mesCel = atual.getMonth() + 1;
            const diaCel = atual.getDate();
            const diaSemana = atual.getDay();
            const data = paraIso(anoCel, mesCel, diaCel);
            celulas.push({
                data,
                dia: diaCel,
                diaSemana,
                noMesAtual: mesCel === mes && anoCel === ano,
                temAula: diasComAulaSet.has(diaSemana),
                feriado: feriadosSet.has(data)
            });
        }
        const semanas = [];
        for (let i = 0; i < celulas.length; i += 7) semanas.push(celulas.slice(i, i + 7));
        return semanas;
    }

    function mesAdjacente(ano, mes, delta) {
        const indice = (mes - 1) + Number(delta || 0);
        const anoNovo = ano + Math.floor(indice / 12);
        const mesNovo = ((indice % 12) + 12) % 12 + 1;
        return { ano: anoNovo, mes: mesNovo };
    }

    global.SiaepScheduleCalendarModel = Object.freeze({
        diasComAula,
        gradeSemanalOrdenada,
        montarGradeMes,
        mesAdjacente
    });
})(globalThis);
