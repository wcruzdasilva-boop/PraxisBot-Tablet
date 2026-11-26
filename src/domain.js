// Regras puras de domínio do PraxisBot Tablet (100% testáveis em Node sem DOM).
// Conecta o contexto do Diário vindo do PC (diario_base, aulas, status_execucao)
// às telas de Hoje/Horário, Chamada (Frequência), Aulas e Filas.
(function (global) {
    'use strict';

    const DIAS_SEMANA_NOMES = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
    const MESES_NOMES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    const CODIGOS_FREQUENCIA = [
        { codigo: 'P', rotulo: 'Presente', curto: 'P' },
        { codigo: 'F', rotulo: 'Falta', curto: 'F' },
        { codigo: 'FJ', rotulo: 'Falta justificada', curto: 'FJ' },
        { codigo: 'FA', rotulo: 'Falta abonada', curto: 'FA' },
        { codigo: 'FE', rotulo: 'Falta esportiva', curto: 'FE' },
        { codigo: 'FG', rotulo: 'Falta gestante', curto: 'FG' },
        { codigo: 'FT', rotulo: 'Falta transferido', curto: 'FT' },
        { codigo: 'FAT', rotulo: 'Falta atividade', curto: 'FAT' }
    ];

    const pad2 = n => String(n).padStart(2, '0');

    function hojeIso(data = new Date()) {
        return `${data.getFullYear()}-${pad2(data.getMonth() + 1)}-${pad2(data.getDate())}`;
    }

    function dataDeIso(iso) {
        const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return null;
        return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    }

    function formatarDataBr(iso) {
        const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
        return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
    }

    function formatarCurtaBr(iso) {
        const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
        return m ? `${m[3]}/${m[2]}` : '';
    }

    function formatarDataHoraBr(iso) {
        const t = Date.parse(String(iso || ''));
        if (!Number.isFinite(t)) return '—';
        const d = new Date(t);
        return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} às ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }

    function assinatura(texto) {
        return String(texto || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
    }

    function feriadosTextoDoCalendario(calendario = []) {
        const vistos = new Set();
        const lista = [];
        for (const item of Array.isArray(calendario) ? calendario : []) {
            const curta = formatarCurtaBr(item?.data);
            if (!curta || vistos.has(curta)) continue;
            vistos.add(curta);
            lista.push(curta);
        }
        return lista.join(', ');
    }

    function datasFeriadoSet(calendario = []) {
        const set = new Set();
        for (const item of Array.isArray(calendario) ? calendario : []) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(String(item?.data || ''))) set.add(item.data);
        }
        return set;
    }

    function obterTurmas(diarioBase = {}) {
        const base = Array.isArray(diarioBase?.turmas) && diarioBase.turmas.length
            ? diarioBase.turmas
            : (Array.isArray(diarioBase?.catalogo?.turmas) ? diarioBase.catalogo.turmas : []);
        return base.slice().sort((a, b) => String(a.rotulo || a.nome || '').localeCompare(String(b.rotulo || b.nome || ''), 'pt-BR'));
    }

    function mapaDisciplinas(diarioBase = {}) {
        const mapa = new Map();
        for (const d of Array.isArray(diarioBase?.disciplinas) ? diarioBase.disciplinas : []) {
            if (d?.id) mapa.set(d.id, d);
        }
        return mapa;
    }

    function disciplinasDaTurma(diarioBase = {}, turmaId = '', queueModel = global.SiaepQueueModel) {
        const discs = mapaDisciplinas(diarioBase);
        const ids = new Set();
        for (const v of Array.isArray(diarioBase?.turmaDisciplinas) ? diarioBase.turmaDisciplinas : []) {
            if (v.turmaId === turmaId && v.disciplinaId) ids.add(v.disciplinaId);
        }
        for (const h of Array.isArray(diarioBase?.horarios) ? diarioBase.horarios : []) {
            if (h.turmaId === turmaId && h.disciplinaId) ids.add(h.disciplinaId);
        }
        const encontradas = [...ids]
            .map(id => discs.get(id)?.nome || id.replace(/^disciplina-/, ''))
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b, 'pt-BR'));
        if (encontradas.length) return encontradas;
        return Array.isArray(queueModel?.DISCIPLINAS) ? [...queueModel.DISCIPLINAS] : [];
    }

    function alunosDaTurma(diarioBase = {}, turmaId = '', queueModel = global.SiaepQueueModel) {
        const brutos = (Array.isArray(diarioBase?.alunos) ? diarioBase.alunos : []).filter(a => a.turmaId === turmaId);
        return queueModel?.alunosElegiveis ? queueModel.alunosElegiveis(brutos) : brutos;
    }

    function horariosDaTurmaDisciplina(diarioBase = {}, turmaId = '', disciplinaNome = '') {
        const alvoAss = assinatura(disciplinaNome);
        const discs = mapaDisciplinas(diarioBase);
        return (Array.isArray(diarioBase?.horarios) ? diarioBase.horarios : []).filter(h => {
            if (h.turmaId !== turmaId) return false;
            if (!alvoAss) return true;
            const nome = discs.get(h.disciplinaId)?.nome || h.disciplinaId.replace(/^disciplina-/, '');
            return assinatura(nome) === alvoAss;
        });
    }

    function aulasDaTurmaDisciplina(blocoAulas = {}, turmaId = '', disciplinaNome = '') {
        const alvoAss = assinatura(disciplinaNome);
        const filtradas = (Array.isArray(blocoAulas?.aulas) ? blocoAulas.aulas : []).filter(a => {
            if (a.turmaId !== turmaId) return false;
            if (!alvoAss) return true;
            return assinatura(a.componente || a.disciplinaId?.replace(/^disciplina-/, '')) === alvoAss;
        });
        return global.SiaepPrevisaoDatasModel?.consolidarAulas
            ? global.SiaepPrevisaoDatasModel.consolidarAulas(filtradas)
            : filtradas;
    }

    // Monta os cartões de aulas de um dia específico para a aba "Hoje & Horário".
    function turmasDoDia({ dataIso, diarioBase = {}, blocoAulas = {}, queueModel = global.SiaepQueueModel, catalogModel = global.SiaepCatalogModel }) {
        const data = dataDeIso(dataIso);
        if (!data) return [];
        const diaSemana = data.getDay();
        const feriados = datasFeriadoSet(diarioBase?.calendario);
        const ehFeriado = feriados.has(dataIso);
        const turmasPorId = new Map(obterTurmas(diarioBase).map(t => [t.id, t]));
        const discs = mapaDisciplinas(diarioBase);
        const horariosDia = (Array.isArray(diarioBase?.horarios) ? diarioBase.horarios : [])
            .filter(h => Number(h.diaSemana) === diaSemana)
            .sort((a, b) => String(a.horarioInicio || '').localeCompare(String(b.horarioInicio || '')));

        // Agrupa vários horários da mesma turma+disciplina no mesmo dia num único cartão prático.
        const grupos = new Map();
        for (const h of horariosDia) {
            const turma = turmasPorId.get(h.turmaId);
            if (!turma) continue;
            const disciplina = discs.get(h.disciplinaId)?.nome || h.disciplinaId.replace(/^disciplina-/, '');
            const chave = `${turma.id}|${assinatura(disciplina)}`;
            if (!grupos.has(chave)) {
                const alunos = alunosDaTurma(diarioBase, turma.id, queueModel);
                const aulasNoDia = aulasDaTurmaDisciplina(blocoAulas, turma.id, disciplina).filter(a => a.data === dataIso);
                const totalAulasDia = aulasNoDia.length;
                const frequenciasLancadas = aulasNoDia.filter(a => a.frequenciaLancada === true).length;
                grupos.set(chave, {
                    chave,
                    turmaId: turma.id,
                    turmaRotulo: turma.rotulo,
                    turmaCompacta: catalogModel?.criarRotuloCompacto ? catalogModel.criarRotuloCompacto(turma) : turma.rotulo,
                    disciplina,
                    horarios: [],
                    totalAlunos: alunos.length,
                    ehFeriado,
                    aulasRegistradasNoDia: totalAulasDia,
                    frequenciaCompletaNoDia: totalAulasDia > 0 && frequenciasLancadas === totalAulasDia
                });
            }
            grupos.get(chave).horarios.push({
                inicio: h.horarioInicio || '',
                fim: h.horarioFim || '',
                ordem: h.ordem || ''
            });
        }
        return [...grupos.values()];
    }

    // Alerta preventivo da regra do ASP.NET do SIAEP (CLAUDE.md): "<" seguido de letra dá HTTP 500.
    function detectarTagHtmlSuspeita(texto) {
        return /<[A-Za-z]/.test(String(texto || ''));
    }

    // Conversão Frequência (grade tátil <-> matrizTexto do motor).
    function montarMatrizFrequencia(linhas = []) {
        return (Array.isArray(linhas) ? linhas : [])
            .filter(item => String(item?.matricula || '').trim())
            .map(item => {
                const cols = Array.isArray(item.colunas) ? item.colunas.map(c => String(c || '').trim().toUpperCase()) : [];
                return [String(item.matricula).trim(), ...cols].join('\t');
            })
            .join('\n');
    }

    function lerMatrizFrequencia(matrizTexto = '', alunos = [], totalColunasPadrao = 1) {
        const bloco = String(matrizTexto || '').replace(/\r\n/g, '\n').split(/\n\s*[#*]\s*\n/)[0] || '';
        const mapaPorMatricula = new Map();
        let maiorCols = 0;
        for (const linha of bloco.split('\n').map(l => l.trim()).filter(Boolean)) {
            const partes = linha.split('\t').map(p => p.trim());
            const mat = partes[0];
            if (!mat) continue;
            const cols = partes.slice(1).map(c => c.toUpperCase());
            maiorCols = Math.max(maiorCols, cols.length);
            mapaPorMatricula.set(mat, cols);
        }
        const totalColunas = Math.max(1, maiorCols || totalColunasPadrao);
        const linhas = [];
        const vistas = new Set();
        for (const aluno of Array.isArray(alunos) ? alunos : []) {
            const mat = String(aluno.matricula || '').trim();
            if (!mat || vistas.has(mat)) continue;
            vistas.add(mat);
            const existentes = mapaPorMatricula.get(mat);
            const colunas = Array.from({ length: totalColunas }, (_, i) => (existentes ? (existentes[i] || '') : 'P'));
            linhas.push({ matricula: mat, nome: aluno.nome || mat, colunas });
        }
        // Preserva matrículas presentes na matriz mesmo se ainda não estiverem no Diário local.
        for (const [mat, cols] of mapaPorMatricula.entries()) {
            if (vistas.has(mat)) continue;
            const colunas = Array.from({ length: totalColunas }, (_, i) => cols[i] || '');
            linhas.push({ matricula: mat, nome: mat, colunas });
        }
        return { totalColunas, linhas };
    }

    function resumirContagemFrequencia(linhas = [], indiceColuna = 0) {
        let presentes = 0;
        let faltas = 0;
        let justificadas = 0;
        let vazios = 0;
        for (const item of Array.isArray(linhas) ? linhas : []) {
            const cod = String(item?.colunas?.[indiceColuna] || '').toUpperCase();
            if (!cod) vazios++;
            else if (cod === 'P') presentes++;
            else if (cod === 'F') faltas++;
            else justificadas++;
        }
        return { presentes, faltas, justificadas, vazios, total: presentes + faltas + justificadas + vazios };
    }

    // Conversão Aulas (cartões táteis <-> matrizTexto do motor).
    function montarMatrizAulas(aulas = []) {
        return (Array.isArray(aulas) ? aulas : [])
            .map(item => ({
                tema: String(item?.tema || '').replace(/[\r\n\t]+/g, ' ').trim(),
                descricao: String(item?.descricao || '').replace(/[\r\n\t]+/g, ' ').trim()
            }))
            .filter(item => item.tema || item.descricao)
            .map(item => `${item.tema}\t${item.descricao}`)
            .join('\n');
    }

    function lerMatrizAulas(matrizTexto = '') {
        const linhas = String(matrizTexto || '').replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
        if (!linhas.length) return [{ tema: '', descricao: '' }];
        return linhas.map(linha => {
            const partes = linha.split('\t');
            return {
                tema: String(partes[0] || '').trim(),
                descricao: String(partes.slice(1).join(' ') || '').trim()
            };
        });
    }

    // ---- Fase 3: Notas (grade numérica tátil <-> matrizTexto do motor) ----

    function validarCelulaNota(valor) {
        const limpo = String(valor ?? '').trim();
        if (!limpo) return { valida: true, vazia: true, numero: null };
        const numero = Number(limpo.replace(',', '.'));
        if (!Number.isFinite(numero) || numero < 0 || numero > 10) {
            return { valida: false, vazia: false, numero: null };
        }
        return { valida: true, vazia: false, numero };
    }

    function montarMatrizNotas(linhas = []) {
        return (Array.isArray(linhas) ? linhas : [])
            .filter(item => String(item?.matricula || '').trim())
            .map(item => {
                const cols = (Array.isArray(item.colunas) ? item.colunas : []).map(c => String(c ?? '').trim());
                while (cols.length && !cols[cols.length - 1]) cols.pop();
                return [String(item.matricula).trim(), ...cols].join('\t');
            })
            .join('\n');
    }

    function lerMatrizNotas(matrizTexto = '', alunos = [], totalColunasPadrao = 1) {
        const bloco = String(matrizTexto || '').replace(/\r\n/g, '\n').split(/\n\s*[#*]\s*\n/)[0] || '';
        const mapa = new Map();
        let maiorCols = 0;
        for (const linha of bloco.split('\n').map(l => l.trim()).filter(Boolean)) {
            const partes = linha.split('\t').map(p => p.trim());
            const mat = partes[0];
            if (!mat) continue;
            const cols = partes.slice(1);
            maiorCols = Math.max(maiorCols, cols.length);
            mapa.set(mat, cols);
        }
        const totalColunas = Math.max(1, maiorCols || totalColunasPadrao);
        const linhas = [];
        const vistas = new Set();
        for (const aluno of Array.isArray(alunos) ? alunos : []) {
            const mat = String(aluno.matricula || '').trim();
            if (!mat || vistas.has(mat)) continue;
            vistas.add(mat);
            const existentes = mapa.get(mat) || [];
            const colunas = Array.from({ length: totalColunas }, (_, i) => existentes[i] || '');
            linhas.push({ matricula: mat, nome: aluno.nome || mat, colunas });
        }
        for (const [mat, cols] of mapa.entries()) {
            if (vistas.has(mat)) continue;
            const colunas = Array.from({ length: totalColunas }, (_, i) => cols[i] || '');
            linhas.push({ matricula: mat, nome: mat, colunas });
        }
        return { totalColunas, linhas };
    }

    function resumirNotas(linhas = [], indiceColuna = 0) {
        let preenchidas = 0;
        let invalidas = 0;
        let soma = 0;
        for (const item of Array.isArray(linhas) ? linhas : []) {
            const check = validarCelulaNota(item?.colunas?.[indiceColuna]);
            if (check.vazia) continue;
            if (!check.valida) invalidas++;
            else {
                preenchidas++;
                soma += check.numero;
            }
        }
        const media = preenchidas ? Math.round(((soma / preenchidas) + Number.EPSILON) * 100) / 100 : null;
        return { preenchidas, invalidas, media, total: Array.isArray(linhas) ? linhas.length : 0 };
    }

    // ---- Fase 3: Consulta do Diário local (offline) ----

    function avaliacoesDaTurmaDisciplinaPeriodo(blocoAvalNotas = {}, turmaId = '', disciplinaNome = '', periodo = '') {
        const discAss = assinatura(disciplinaNome);
        const perAss = assinatura(periodo);
        return (Array.isArray(blocoAvalNotas?.avaliacoes) ? blocoAvalNotas.avaliacoes : [])
            .filter(item => {
                if (turmaId && item.turmaId !== turmaId) return false;
                if (discAss && assinatura(item.componente || item.disciplinaId?.replace(/^disciplina-/, '')) !== discAss) return false;
                if (perAss && assinatura(item.periodo) !== perAss) return false;
                return true;
            })
            .slice()
            .sort((a, b) => (Number(a.ordem) || 0) - (Number(b.ordem) || 0) || String(a.data || '').localeCompare(String(b.data || '')));
    }

    function notasDaTurmaDisciplinaPeriodo(blocoAvalNotas = {}, turmaId = '', disciplinaNome = '', periodo = '') {
        const avals = avaliacoesDaTurmaDisciplinaPeriodo(blocoAvalNotas, turmaId, disciplinaNome, periodo);
        const ids = new Set(avals.map(a => a.id));
        return (Array.isArray(blocoAvalNotas?.notas) ? blocoAvalNotas.notas : []).filter(n => ids.has(n.avaliacaoId));
    }

    function resumoDiarioTurma({ turmaId = '', disciplinaNome = '', diarioBase = {}, blocoAulas = {}, blocoAvalNotas = {}, queueModel = global.SiaepQueueModel }) {
        const alunos = turmaId ? alunosDaTurma(diarioBase, turmaId, queueModel) : [];
        const aulas = turmaId ? aulasDaTurmaDisciplina(blocoAulas, turmaId, disciplinaNome) : [];
        const hoje = hojeIso();
        const aulasSemFrequencia = aulas.filter(a => a.data <= hoje && a.frequenciaLancada === false).length;
        const avaliacoes = turmaId ? avaliacoesDaTurmaDisciplinaPeriodo(blocoAvalNotas, turmaId, disciplinaNome, '') : [];
        const notas = turmaId ? notasDaTurmaDisciplinaPeriodo(blocoAvalNotas, turmaId, disciplinaNome, '') : [];
        return {
            totalAlunos: alunos.length,
            totalAulas: aulas.length,
            aulasSemFrequencia,
            totalAvaliacoes: avaliacoes.length,
            totalNotas: notas.filter(n => n.possuiNota).length
        };
    }

    // Calcula o selo visual da fila considerando sincronização local + retorno real do PC.
    function statusExecucaoDaFila(registro, statusExecucao = null) {
        if (!registro) return { nivel: 'neutral', texto: '—', detalhe: '' };
        const fila = registro.fila || {};
        if (fila.arquivadoEm) return { nivel: 'neutral', texto: 'Arquivada', detalhe: `Arquivada em ${formatarDataHoraBr(fila.arquivadoEm)}` };
        if (registro.pendenteEnvio) {
            return {
                nivel: 'warning',
                texto: registro.execucaoSolicitadaId ? 'Aguardando envio para executar' : 'Pendente offline',
                detalhe: 'Será enviada ao computador assim que o tablet tiver internet.'
            };
        }
        const execComp = statusExecucao?.execucoesCompanheiro || {};
        const pendentePc = (execComp.pendentes || []).find(p => p.filaId === registro.filaId || (registro.execucaoSolicitadaId && p.solicitacaoId === registro.execucaoSolicitadaId));
        if (pendentePc) {
            const rotulos = {
                INICIANDO: 'Iniciando no SIAEP…',
                AGUARDANDO_OPERACAO: 'Na fila do PC',
                AGUARDANDO_LOGIN: 'Aguardando login no PC',
                AGUARDANDO_SIAEP: 'Aguardando SIAEP no PC'
            };
            return {
                nivel: pendentePc.status === 'AGUARDANDO_LOGIN' ? 'warning' : 'info',
                texto: rotulos[pendentePc.status] || 'Aguardando no PC',
                detalhe: pendentePc.motivo || 'O computador vai iniciar assim que o SIAEP estiver pronto.'
            };
        }
        const recentePc = (execComp.recentes || []).find(r => (registro.execucaoSolicitadaId && r.solicitacaoId === registro.execucaoSolicitadaId) || r.filaId === registro.filaId);
        if (recentePc) {
            if (recentePc.status === 'INICIADA') {
                return { nivel: 'info', texto: 'Em execução no PC', detalhe: `Iniciada em ${formatarDataHoraBr(recentePc.iniciadaEm)}` };
            }
            if (recentePc.status === 'CONCLUIDA') {
                const ok = Number(recentePc.resumo?.sucessos || 0);
                return { nivel: 'success', texto: 'Gravada no SIAEP', detalhe: `${ok ? `${ok} registro(s) confirmado(s) · ` : ''}${formatarDataHoraBr(recentePc.finalizadaEm)}` };
            }
            if (recentePc.status === 'CONCLUIDA_COM_PENDENCIAS') {
                return { nivel: 'warning', texto: 'Gravada com pendências', detalhe: `Confira o relatório em Atividades no PC (${formatarDataHoraBr(recentePc.finalizadaEm)}).` };
            }
            if (recentePc.status === 'RECUSADA' || recentePc.status === 'FALHA' || recentePc.status === 'EXPIRADA') {
                return { nivel: 'danger', texto: recentePc.status === 'EXPIRADA' ? 'Pedido expirado' : 'Não iniciada no PC', detalhe: recentePc.motivo || 'Confira o computador.' };
            }
        }
        return {
            nivel: fila.status === 'PRONTA' ? 'safe' : 'neutral',
            texto: fila.status === 'PRONTA' ? 'Sincronizada (pronta no PC)' : 'Rascunho sincronizado',
            detalhe: `Atualizada em ${formatarDataHoraBr(registro.atualizadoEm)}`
        };
    }

    const modulo = Object.freeze({
        DIAS_SEMANA_NOMES,
        MESES_NOMES,
        CODIGOS_FREQUENCIA,
        hojeIso,
        dataDeIso,
        formatarDataBr,
        formatarCurtaBr,
        formatarDataHoraBr,
        assinatura,
        feriadosTextoDoCalendario,
        datasFeriadoSet,
        obterTurmas,
        disciplinasDaTurma,
        alunosDaTurma,
        horariosDaTurmaDisciplina,
        aulasDaTurmaDisciplina,
        turmasDoDia,
        detectarTagHtmlSuspeita,
        montarMatrizFrequencia,
        lerMatrizFrequencia,
        resumirContagemFrequencia,
        montarMatrizAulas,
        lerMatrizAulas,
        validarCelulaNota,
        montarMatrizNotas,
        lerMatrizNotas,
        resumirNotas,
        avaliacoesDaTurmaDisciplinaPeriodo,
        notasDaTurmaDisciplinaPeriodo,
        resumoDiarioTurma,
        statusExecucaoDaFila
    });
    global.PraxisTabletDomain = modulo;
    if (typeof module !== 'undefined' && module.exports) module.exports = modulo;
})(globalThis);
