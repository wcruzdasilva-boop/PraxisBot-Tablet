(function(global) {
    'use strict';

    const SCHEMA_VERSION = 1;
    const MAX_FILAS = 100;
    const MAX_MATRIZ = 250000;
    const TIPOS = Object.freeze({
        AULAS: 'Aulas',
        AVALIACOES: 'Avaliações',
        NOTAS: 'Notas',
        FREQUENCIA: 'Frequência'
    });
    const TIPOS_AVALIACAO = Object.freeze([
        'PROVA OBJETIVA',
        'PROVA SUBJETIVA',
        'SEMINARIO',
        'TRABALHO EM GRUPO',
        'DEBATE',
        'RELATORIO',
        'SIMULADO',
        'APRESENTACAO DE PROJETO'
    ]);
    const DISCIPLINAS = Object.freeze([
        'ARTE',
        'BIOLOGIA',
        'EDUCACAO FISICA',
        'FILOSOFIA',
        'FISICA',
        'GEOGRAFIA',
        'HISTORIA',
        'LETRAMENTO EM LINGUA PORTUGUESA',
        'LETRAMENTO EM MATEMATICA',
        'LINGUA INGLESA',
        'LINGUA PORTUGUESA',
        'MATEMATICA',
        'QUIMICA',
        'SOCIOLOGIA',
        'IDENTIDADE E PROTAGONISMO',
        'EDUCACAO DIGITAL',
        'APROFUNDAMENTO IF - SEA - II'
    ]);
    const STATUS_FREQUENCIA = new Set(['P', 'F', 'FJ', 'FA', 'FE', 'FG', 'FT', 'FAT']);
    const SITUACOES_INATIVAS = new Set(['CTI', 'CTE', 'CPG', 'TRA']);
    const MAX_LINHAS_EDICAO = 300;

    function texto(valor) {
        return typeof valor === 'string' ? valor.trim() : '';
    }

    function textoIntegral(valor) {
        return typeof valor === 'string' ? valor.replace(/\r\n/g, '\n') : '';
    }

    function gerarId() {
        if (global.crypto?.randomUUID) return global.crypto.randomUUID();
        return `fila-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function agora() {
        return new Date().toISOString();
    }

    function criar(tipo = 'AULAS') {
        const instante = agora();
        return {
            schemaVersion: SCHEMA_VERSION,
            id: gerarId(),
            nome: '',
            tipo: TIPOS[tipo] ? tipo : 'AULAS',
            status: 'RASCUNHO',
            arquivadoEm: '',
            ultimaExecucaoAutomaticaEm: '',
            criadoEm: instante,
            atualizadoEm: instante,
            configuracao: {
                disciplina: '',
                periodo: '',
                dataInicial: '',
                feriados: '',
                intervaloAulas: 0,
                tiposAvaliacao: [],
                substituirRegistrados: false,
                // App (2026-10-13): "Tentar novamente" (Avaliações e Notas): com o SIAEP fora
                // do ar ao iniciar, a fila aguarda e começa sozinha quando ele voltar.
                tentarNovamente: false,
                arquivarAposExecucao: false,
                limiteAulasPorTurma: 0,
                execucaoAutomaticaAtiva: false,
                intervaloDiasExecucaoAutomatica: 0,
                horarioExecucaoAutomatica: ''
            },
            turmas: [],
            matrizTexto: '',
            observacoes: '',
            totalItens: 0
        };
    }

    function normalizar(fila, opcoes = {}) {
        const base = criar(fila?.tipo);
        const configuracao = fila?.configuracao || {};
        const tipo = TIPOS[fila?.tipo] ? fila.tipo : base.tipo;
        const turmas = Array.isArray(fila?.turmas)
            ? fila.turmas.map(texto).filter(Boolean)
            : textoIntegral(fila?.turmas).split('\n').map(texto).filter(Boolean);
        const tiposAvaliacao = Array.isArray(configuracao.tiposAvaliacao)
            ? configuracao.tiposAvaliacao.map(item => texto(item).toLocaleUpperCase('pt-BR')).filter(Boolean)
            : textoIntegral(configuracao.tiposAvaliacao).split('\n').map(item => texto(item).toLocaleUpperCase('pt-BR')).filter(Boolean);

        return {
            schemaVersion: SCHEMA_VERSION,
            id: opcoes.novoId ? gerarId() : texto(fila?.id) || base.id,
            nome: texto(fila?.nome),
            tipo,
            status: fila?.status === 'PRONTA' ? 'PRONTA' : 'RASCUNHO',
            arquivadoEm: /^\d{4}-\d{2}-\d{2}T/.test(String(fila?.arquivadoEm || '')) ? fila.arquivadoEm : '',
            ultimaExecucaoAutomaticaEm: /^\d{4}-\d{2}-\d{2}T/.test(String(fila?.ultimaExecucaoAutomaticaEm || '')) ? fila.ultimaExecucaoAutomaticaEm : '',
            criadoEm: texto(fila?.criadoEm) || base.criadoEm,
            atualizadoEm: texto(fila?.atualizadoEm) || base.atualizadoEm,
            configuracao: {
                disciplina: texto(configuracao.disciplina),
                periodo: texto(configuracao.periodo),
                dataInicial: texto(configuracao.dataInicial),
                feriados: texto(configuracao.feriados),
                intervaloAulas: Number.isFinite(Number(configuracao.intervaloAulas)) ? Number(configuracao.intervaloAulas) : 0,
                tiposAvaliacao,
                substituirRegistrados: Boolean(configuracao.substituirRegistrados),
                tentarNovamente: Boolean(configuracao.tentarNovamente),
                arquivarAposExecucao: Boolean(configuracao.arquivarAposExecucao),
                limiteAulasPorTurma: Number.isFinite(Number(configuracao.limiteAulasPorTurma)) && Number(configuracao.limiteAulasPorTurma) >= 0
                    ? Math.floor(Number(configuracao.limiteAulasPorTurma))
                    : 0,
                execucaoAutomaticaAtiva: Boolean(configuracao.execucaoAutomaticaAtiva),
                // Por enquanto só 5 cadências fixas (Todos os dias .. a cada 5 dias) --
                // valor fora de 1-5 (incluindo o default 0 = "não escolhido") normaliza
                // para 0, nunca para um intervalo maior não oferecido pela tela.
                intervaloDiasExecucaoAutomatica: Number.isInteger(Number(configuracao.intervaloDiasExecucaoAutomatica)) && Number(configuracao.intervaloDiasExecucaoAutomatica) >= 1 && Number(configuracao.intervaloDiasExecucaoAutomatica) <= 5
                    ? Number(configuracao.intervaloDiasExecucaoAutomatica)
                    : 0,
                horarioExecucaoAutomatica: /^\d{2}:\d{2}$/.test(String(configuracao.horarioExecucaoAutomatica || '')) ? configuracao.horarioExecucaoAutomatica : ''
            },
            turmas: [...new Set(turmas)],
            matrizTexto: textoIntegral(fila?.matrizTexto),
            observacoes: textoIntegral(fila?.observacoes),
            totalItens: Number(fila?.totalItens) || 0
        };
    }

    function dataIsoValida(valor) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
        const [ano, mes, dia] = valor.split('-').map(Number);
        const data = new Date(Date.UTC(ano, mes - 1, dia));
        return data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia;
    }

    function linhasMatriz(textoMatriz) {
        return textoIntegral(textoMatriz).split('\n').map(linha => linha.trim()).filter(Boolean);
    }

    function blocosNotas(textoMatriz) {
        return textoIntegral(textoMatriz)
            .split(/\n\s*[#*]\s*\n/)
            .map(bloco => bloco.trim())
            .filter(Boolean);
    }

    function alunosElegiveis(alunos) {
        return (Array.isArray(alunos) ? alunos : [])
            .filter(aluno => aluno && texto(aluno.matricula) && texto(aluno.nome))
            .filter(aluno => !SITUACOES_INATIVAS.has(texto(aluno.situacao).toLocaleUpperCase('pt-BR')))
            .slice()
            // App (pedido do professor, 2026-10-01): estudantes em ordem alfabética (era pelo
            // número de chamada). A ordem das linhas não muda a gravação: o motor procura
            // cada estudante pela matrícula.
            .sort((a, b) => compararNomes(a.nome, b.nome) || texto(a.matricula).localeCompare(texto(b.matricula), 'pt-BR', { numeric: true }));
    }

    function compararNomes(a, b) {
        return texto(a).localeCompare(texto(b), 'pt-BR', { sensitivity: 'base' });
    }

    function carregarMatriculasSincronizadas(valor, alunosPorTurma = {}) {
        const fila = normalizar(valor);
        if (!['NOTAS', 'FREQUENCIA'].includes(fila.tipo)) {
            throw new Error('Este tipo de fila não utiliza matrícula sincronizada.');
        }
        if (!fila.turmas.length) throw new Error('Selecione ao menos uma turma antes de carregar as matrículas.');
        const blocosOriginais = blocosNotas(fila.matrizTexto);
        let adicionados = 0;
        const blocosSaida = fila.turmas.map((turma, indice) => {
            const linhasOriginais = linhasMatriz(blocosOriginais[indice] || '');
            const matriculasExistentes = new Set(linhasOriginais.map(linha => texto(linha.split('\t')[0])));
            const elegiveis = alunosElegiveis(alunosPorTurma[turma] || []);
            const novasLinhas = elegiveis
                .map(aluno => texto(aluno.matricula))
                .filter(matricula => matricula && !matriculasExistentes.has(matricula));
            adicionados += novasLinhas.length;
            return [...linhasOriginais, ...novasLinhas].join('\n');
        });
        const matrizTexto = blocosSaida.join('\n*\n');
        if (matrizTexto.length > MAX_MATRIZ) {
            throw new Error(`A matriz resultante excede o limite local de ${MAX_MATRIZ.toLocaleString('pt-BR')} caracteres.`);
        }
        return { matrizTexto, adicionados };
    }

    function adicionarLinhaTexto(valor) {
        const fila = normalizar(valor);
        if (fila.tipo === 'AULAS') {
            const atual = textoIntegral(fila.matrizTexto);
            return atual ? `${atual}\n\t` : '\t';
        }
        if (!['NOTAS', 'FREQUENCIA'].includes(fila.tipo)) return fila.matrizTexto;
        const totalBlocos = Math.max(fila.turmas.length, 1);
        const blocos = blocosNotas(fila.matrizTexto);
        const saida = Array.from({ length: totalBlocos }, (_, indice) => textoIntegral(blocos[indice] || ''));
        const alvo = saida.length - 1;
        saida[alvo] = saida[alvo] ? `${saida[alvo]}\n\t` : '\t';
        return saida.join('\n*\n');
    }

    function removerUltimaLinhaTexto(valor) {
        const fila = normalizar(valor);
        if (fila.tipo === 'AULAS') {
            const linhas = textoIntegral(fila.matrizTexto).split('\n');
            if (!linhas.length) return fila.matrizTexto;
            linhas.pop();
            return linhas.join('\n');
        }
        if (!['NOTAS', 'FREQUENCIA'].includes(fila.tipo)) return fila.matrizTexto;
        const blocos = blocosNotas(fila.matrizTexto).map(textoIntegral);
        if (!blocos.length) return fila.matrizTexto;
        const ultimoIndice = blocos.length - 1;
        const linhas = blocos[ultimoIndice].split('\n');
        linhas.pop();
        blocos[ultimoIndice] = linhas.join('\n');
        return blocos.join('\n*\n');
    }

    function adicionarColunaTexto(valor) {
        const fila = normalizar(valor);
        if (!['NOTAS', 'FREQUENCIA'].includes(fila.tipo)) return fila.matrizTexto;
        return textoIntegral(fila.matrizTexto).split('\n').map(linha => {
            const aparada = texto(linha);
            if (!aparada || aparada === '#' || aparada === '*') return linha;
            return `${linha}\t`;
        }).join('\n');
    }

    function removerUltimaColunaTexto(valor) {
        const fila = normalizar(valor);
        if (!['NOTAS', 'FREQUENCIA'].includes(fila.tipo)) return fila.matrizTexto;
        return textoIntegral(fila.matrizTexto).split('\n').map(linha => {
            if (!texto(linha)) return linha;
            const colunas = linha.split('\t');
            if (colunas.length <= 1) return linha;
            colunas.pop();
            return colunas.join('\t');
        }).join('\n');
    }

    function validarComum(fila, erros) {
        if (!fila.nome) erros.push({ campo: 'nome', mensagem: 'Informe um nome para identificar a fila.' });
        if (fila.nome.length > 100) erros.push({ campo: 'nome', mensagem: 'O nome deve ter no máximo 100 caracteres.' });
        if (!TIPOS[fila.tipo]) erros.push({ campo: 'tipo', mensagem: 'Selecione um tipo de operação válido.' });
        if (!fila.configuracao.disciplina) erros.push({ campo: 'disciplina', mensagem: 'Informe a disciplina.' });
        if (fila.tipo !== 'FREQUENCIA' && !fila.configuracao.periodo) erros.push({ campo: 'periodo', mensagem: 'Informe o período.' });
        if (!fila.turmas.length) erros.push({ campo: 'turmas', mensagem: 'Informe ao menos uma turma, uma por linha.' });
        if (fila.matrizTexto.length > MAX_MATRIZ) erros.push({ campo: 'matrizTexto', mensagem: `A matriz excede o limite local de ${MAX_MATRIZ.toLocaleString('pt-BR')} caracteres.` });
        if (fila.configuracao.execucaoAutomaticaAtiva) {
            if (fila.configuracao.intervaloDiasExecucaoAutomatica < 1) {
                erros.push({ campo: 'intervaloDiasExecucaoAutomatica', mensagem: 'Selecione a cada quantos dias a execução automática deve se repetir.' });
            }
            if (!fila.configuracao.horarioExecucaoAutomatica) {
                erros.push({ campo: 'horarioExecucaoAutomatica', mensagem: 'Informe o horário em que a execução automática deve acontecer.' });
            }
        }
    }

    function validarAulas(fila, erros) {
        if (!dataIsoValida(fila.configuracao.dataInicial)) erros.push({ campo: 'dataInicial', mensagem: 'Informe uma data inicial válida.' });
        const linhas = linhasMatriz(fila.matrizTexto);
        if (!linhas.length) erros.push({ campo: 'matrizTexto', mensagem: 'Cole ao menos uma aula no formato Tema [TAB] Descrição.' });
        linhas.forEach((linha, indice) => {
            const colunas = linha.split('\t');
            if (!texto(colunas[0])) erros.push({ campo: 'matrizTexto', mensagem: `A linha ${indice + 1} não possui tema.` });
            if (colunas.length < 2 || !texto(colunas.slice(1).join('\t'))) erros.push({ campo: 'matrizTexto', mensagem: `A linha ${indice + 1} não possui descrição após a tabulação.` });
        });
    }

    function validarAvaliacoes(fila, erros) {
        if (!dataIsoValida(fila.configuracao.dataInicial)) erros.push({ campo: 'dataInicial', mensagem: 'Informe uma data inicial válida.' });
        if (!Number.isInteger(fila.configuracao.intervaloAulas) || fila.configuracao.intervaloAulas < 0) {
            erros.push({ campo: 'intervaloAulas', mensagem: 'O intervalo entre avaliações deve ser um número inteiro igual ou maior que zero.' });
        }
        const tipos = fila.configuracao.tiposAvaliacao;
        if (tipos.length < 1 || tipos.length > 5) erros.push({ campo: 'tiposAvaliacao', mensagem: 'Informe de 1 a 5 tipos de avaliação.' });
        if (new Set(tipos).size !== tipos.length) erros.push({ campo: 'tiposAvaliacao', mensagem: 'Não repita o mesmo tipo de avaliação na fila.' });
        tipos.forEach(tipo => {
            if (!TIPOS_AVALIACAO.includes(tipo)) erros.push({ campo: 'tiposAvaliacao', mensagem: `Tipo de avaliação não reconhecido: ${tipo}.` });
        });
    }

    function validarNotas(fila, erros) {
        const blocos = blocosNotas(fila.matrizTexto);
        if (!blocos.length) erros.push({ campo: 'matrizTexto', mensagem: 'Cole uma matriz de notas.' });
        if (blocos.length && blocos.length !== fila.turmas.length) {
            erros.push({ campo: 'matrizTexto', mensagem: `A matriz possui ${blocos.length} bloco(s), mas a fila possui ${fila.turmas.length} turma(s).` });
        }
        let notasInformadas = 0;
        blocos.forEach((bloco, blocoIndice) => {
            let notasDoBloco = 0;
            linhasMatriz(bloco).forEach((linha, linhaIndice) => {
                const colunas = linha.split('\t');
                if (!texto(colunas[0])) erros.push({ campo: 'matrizTexto', mensagem: `Bloco ${blocoIndice + 1}, linha ${linhaIndice + 1}: matrícula ausente.` });
                colunas.slice(1).forEach(valor => {
                    const limpo = texto(valor);
                    if (!limpo) return;
                    notasInformadas += 1;
                    notasDoBloco += 1;
                    const nota = Number(limpo.replace(',', '.'));
                    if (!Number.isFinite(nota) || nota < 0 || nota > 10) {
                        erros.push({ campo: 'matrizTexto', mensagem: `Nota inválida no bloco ${blocoIndice + 1}, linha ${linhaIndice + 1}: ${limpo}.` });
                    }
                });
            });
            if (!notasDoBloco) erros.push({ campo: 'matrizTexto', mensagem: `O bloco ${blocoIndice + 1} não contém nenhuma nota preenchida.` });
        });
        if (blocos.length && !notasInformadas) erros.push({ campo: 'matrizTexto', mensagem: 'A matriz não contém nenhuma nota preenchida.' });
    }

    function validarFrequencia(fila, erros) {
        if (!dataIsoValida(fila.configuracao.dataInicial)) erros.push({ campo: 'dataInicial', mensagem: 'Informe a data-base válida em A PARTIR DE.' });
        const blocos = blocosNotas(fila.matrizTexto);
        if (!blocos.length) erros.push({ campo: 'matrizTexto', mensagem: 'Cole uma matriz de frequência.' });
        if (blocos.length && blocos.length !== fila.turmas.length) {
            erros.push({ campo: 'matrizTexto', mensagem: `A matriz possui ${blocos.length} bloco(s), mas a fila possui ${fila.turmas.length} turma(s).` });
        }
        let registrosInformados = 0;
        blocos.forEach((bloco, blocoIndice) => {
            let registrosDoBloco = 0;
            linhasMatriz(bloco).forEach((linha, linhaIndice) => {
                const colunas = linha.split('\t');
                if (!texto(colunas[0])) erros.push({ campo: 'matrizTexto', mensagem: `Bloco ${blocoIndice + 1}, linha ${linhaIndice + 1}: matrícula ausente.` });
                colunas.slice(1).forEach(valor => {
                    const status = texto(valor).toLocaleUpperCase('pt-BR');
                    if (status) {
                        registrosInformados += 1;
                        registrosDoBloco += 1;
                    }
                    if (status && !STATUS_FREQUENCIA.has(status)) erros.push({ campo: 'matrizTexto', mensagem: `Bloco ${blocoIndice + 1}, linha ${linhaIndice + 1}: situação não reconhecida (${status}).` });
                });
            });
            if (!registrosDoBloco) erros.push({ campo: 'matrizTexto', mensagem: `O bloco ${blocoIndice + 1} não contém nenhuma frequência preenchida.` });
        });
        if (blocos.length && !registrosInformados) erros.push({ campo: 'matrizTexto', mensagem: 'A matriz não contém nenhuma frequência preenchida.' });
    }

    function validar(valor) {
        const fila = normalizar(valor);
        const erros = [];
        validarComum(fila, erros);
        if (fila.tipo === 'AULAS') validarAulas(fila, erros);
        if (fila.tipo === 'AVALIACOES') validarAvaliacoes(fila, erros);
        if (fila.tipo === 'NOTAS') validarNotas(fila, erros);
        if (fila.tipo === 'FREQUENCIA') validarFrequencia(fila, erros);
        return erros;
    }

    function contarItens(valor) {
        const fila = normalizar(valor);
        if (fila.tipo === 'AULAS') return linhasMatriz(fila.matrizTexto).length * fila.turmas.length;
        if (fila.tipo === 'AVALIACOES') return fila.configuracao.tiposAvaliacao.length * fila.turmas.length;
        if (fila.tipo === 'NOTAS') return blocosNotas(fila.matrizTexto).length;
        if (fila.tipo === 'FREQUENCIA') {
            return blocosNotas(fila.matrizTexto).reduce((total, bloco) => {
                const maior = linhasMatriz(bloco).reduce((maximo, linha) => Math.max(maximo, linha.split('\t').length - 1), 0);
                return total + maior;
            }, 0);
        }
        return 0;
    }

    // Etapa 12 (limites do período de teste): mesma contagem de contarItens,
    // mas devolvida por turma -- necessário porque o teste limita "10 por
    // turma", não só um total agregado. AULAS e AVALIACOES aplicam a mesma
    // quantidade a cada turma (a matriz/tipos de avaliação não variam por
    // turma); NOTAS e FREQUENCIA têm um bloco de matriz por turma, na mesma
    // ordem de fila.turmas (mesmo pareamento já validado em validarNotas/
    // validarFrequencia).
    function contarItensPorTurma(valor) {
        const fila = normalizar(valor);
        const resultado = {};
        if (fila.tipo === 'AULAS') {
            const quantidade = linhasMatriz(fila.matrizTexto).length;
            fila.turmas.forEach(turma => { resultado[turma] = quantidade; });
            return resultado;
        }
        if (fila.tipo === 'AVALIACOES') {
            const quantidade = fila.configuracao.tiposAvaliacao.length;
            fila.turmas.forEach(turma => { resultado[turma] = quantidade; });
            return resultado;
        }
        if (fila.tipo === 'NOTAS') {
            fila.turmas.forEach(turma => { resultado[turma] = 1; });
            return resultado;
        }
        if (fila.tipo === 'FREQUENCIA') {
            const blocos = blocosNotas(fila.matrizTexto);
            fila.turmas.forEach((turma, indice) => {
                const bloco = blocos[indice] || '';
                const maior = linhasMatriz(bloco).reduce((maximo, linha) => Math.max(maximo, linha.split('\t').length - 1), 0);
                resultado[turma] = maior;
            });
            return resultado;
        }
        return resultado;
    }

    function gerarPreview(valor, limite = 300) {
        const fila = normalizar(valor);
        const linhas = [];
        let colunas = [];
        let titulo = `Prévia de ${TIPOS[fila.tipo] || 'fila'}`;

        if (fila.tipo === 'AULAS') {
            colunas = ['Turma', 'Ordem', 'Tema', 'Descrição'];
            fila.turmas.forEach(turma => linhasMatriz(fila.matrizTexto).forEach((linha, indice) => {
                const partes = linha.split('\t');
                linhas.push([turma, String(indice + 1), texto(partes[0]), texto(partes.slice(1).join('\t'))]);
            }));
        } else if (fila.tipo === 'AVALIACOES') {
            colunas = ['Turma', 'Ordem', 'Tipo', 'Intervalo'];
            fila.turmas.forEach(turma => fila.configuracao.tiposAvaliacao.forEach((tipo, indice) => {
                linhas.push([turma, String(indice + 1), tipo, `${fila.configuracao.intervaloAulas} aula(s)`]);
            }));
        } else if (fila.tipo === 'NOTAS') {
            const blocos = blocosNotas(fila.matrizTexto);
            const maiorQuantidade = blocos.reduce((maior, bloco) => Math.max(maior, ...linhasMatriz(bloco).map(linha => linha.split('\t').length - 1)), 0);
            colunas = ['Turma', 'Matrícula', ...Array.from({ length: maiorQuantidade }, (_, indice) => `Nota ${indice + 1}`)];
            blocos.forEach((bloco, blocoIndice) => linhasMatriz(bloco).forEach(linha => {
                const partes = linha.split('\t').map(texto);
                linhas.push([fila.turmas[blocoIndice] || `Bloco ${blocoIndice + 1}`, partes[0] || '', ...partes.slice(1)]);
            }));
        } else if (fila.tipo === 'FREQUENCIA') {
            const blocos = blocosNotas(fila.matrizTexto);
            const registrosPorBloco = blocos.map(bloco => linhasMatriz(bloco).map(linha => linha.split('\t').map(texto)));
            const maiorQuantidade = registrosPorBloco.reduce((maior, registros) => Math.max(maior, ...registros.map(linha => linha.length - 1)), 0);
            colunas = ['Turma', 'Matrícula', ...Array.from({ length: maiorQuantidade }, (_, indice) => `Aula ${indice + 1}`)];
            registrosPorBloco.forEach((registros, blocoIndice) => registros.forEach(registro => linhas.push([fila.turmas[blocoIndice] || `Bloco ${blocoIndice + 1}`, registro[0] || '', ...registro.slice(1)])));
        }

        const totalLinhas = linhas.length;
        return {
            titulo,
            colunas,
            linhas: linhas.slice(0, Math.max(1, limite)),
            totalLinhas,
            truncado: totalLinhas > limite,
            erros: validar(fila),
            observacao: fila.tipo === 'FREQUENCIA'
                ? `A data-base é ${fila.configuracao.dataInicial || 'não informada'}; as datas efetivas dependem das aulas disponíveis no SIAEP.`
                : ''
        };
    }

    function gerarEdicaoMatriz(valor, mapaAlunos = {}) {
        const fila = normalizar(valor);
        if (!['AULAS', 'NOTAS', 'FREQUENCIA'].includes(fila.tipo)) {
            return { tipo: fila.tipo, colunas: [], linhas: [], editavel: false, limiteLinhas: MAX_LINHAS_EDICAO, mensagem: 'Este tipo de fila não possui matriz editável.' };
        }
        if (fila.tipo === 'AULAS') {
            return {
                tipo: fila.tipo,
                colunas: [
                    { id: 'tema', rotulo: 'Tema', editavel: true },
                    { id: 'descricao', rotulo: 'Descrição', editavel: true }
                ],
                linhas: linhasMatriz(fila.matrizTexto).map((linha, indice) => {
                    const partes = linha.split('\t');
                    return {
                        id: `aula-${indice}`,
                        bloco: 0,
                        linha: indice,
                        valores: [texto(partes[0]), texto(partes.slice(1).join('\t'))]
                    };
                }),
                editavel: true,
                limiteLinhas: MAX_LINHAS_EDICAO,
                mensagem: 'Tema e descrição podem ser editados. É possível adicionar ou remover aulas; a matriz continuará sendo aplicada a todas as turmas selecionadas.'
            };
        }
        const blocos = blocosNotas(fila.matrizTexto);
        const linhasPorBloco = blocos.map(bloco => linhasMatriz(bloco).map(linha => linha.split('\t').map(texto)));
        const maiorQuantidade = linhasPorBloco.reduce(
            (maior, linhas) => Math.max(maior, ...linhas.map(linha => Math.max(0, linha.length - 1))),
            0
        );
        const prefixo = fila.tipo === 'NOTAS' ? 'Nota' : 'Aula';
        const colunas = [
            { id: 'turma', rotulo: 'Turma', editavel: false, ocultaNaTabela: true },
            { id: 'matricula', rotulo: 'Estudante', editavel: false },
            ...Array.from({ length: maiorQuantidade }, (_, indice) => ({
                id: `valor-${indice}`,
                rotulo: `${prefixo} ${indice + 1}`,
                editavel: true,
                removivel: true
            }))
        ];
        const linhas = [];
        linhasPorBloco.forEach((registros, blocoIndice) => registros.forEach((registro, linhaIndice) => {
            const turma = fila.turmas[blocoIndice] || `Bloco ${blocoIndice + 1}`;
            const matricula = registro[0] || '';
            const nome = mapaAlunos?.[turma]?.[matricula] || '';
            linhas.push({
                id: `bloco-${blocoIndice}-linha-${linhaIndice}`,
                bloco: blocoIndice,
                linha: linhaIndice,
                matricula,
                valores: [
                    turma,
                    nome || matricula,
                    ...Array.from({ length: maiorQuantidade }, (_, indice) => registro[indice + 1] || '')
                ]
            });
        }));
        // App (pedido do professor, 2026-10-01): com os nomes conhecidos, cada turma aparece
        // em ordem alfabética; quem não tem nome no Diário local fica no fim, na ordem da
        // matriz. Sem nomes (ex.: aplicarEdicaoMatriz), a ordem da matriz é mantida. As
        // linhas guardam o id da posição original, então a edição continua batendo.
        const comNome = linha => Boolean(linha.valores[1] && linha.valores[1] !== linha.matricula);
        if (linhas.some(comNome)) {
            const posicao = new Map(linhas.map((linha, indice) => [linha, indice]));
            linhas.sort((a, b) => (a.bloco - b.bloco)
                || (Number(comNome(b)) - Number(comNome(a)))
                || (comNome(a) && comNome(b) ? compararNomes(a.valores[1], b.valores[1]) : 0)
                || (posicao.get(a) - posicao.get(b)));
        }
        return {
            tipo: fila.tipo,
            colunas,
            linhas,
            editavel: true,
            limiteLinhas: MAX_LINHAS_EDICAO,
            mensagem: 'Turma e estudante são protegidos. Células vazias continuam significando ausência de instrução. É possível adicionar ou remover linhas e colunas.'
        };
    }

    function aplicarEdicaoMatriz(valor, linhasEditadas) {
        const fila = normalizar(valor);
        const grade = gerarEdicaoMatriz(fila);
        if (!grade.editavel) throw new Error(grade.mensagem);
        if (!Array.isArray(linhasEditadas)) throw new Error('A grade editada é inválida.');
        if (linhasEditadas.length > MAX_LINHAS_EDICAO) {
            throw new Error(`A edição assistida aceita no máximo ${MAX_LINHAS_EDICAO} linhas.`);
        }
        let matrizTexto = '';
        if (fila.tipo === 'AULAS') {
            matrizTexto = linhasEditadas.map((entrada, indice) => {
                const valores = Array.isArray(entrada?.valores) ? entrada.valores : (Array.isArray(entrada) ? entrada : []);
                const tema = texto(String(valores[0] ?? ''));
                const descricao = texto(String(valores[1] ?? ''));
                if (!tema && !descricao) throw new Error(`A linha ${indice + 1} não pode ficar inteiramente vazia.`);
                return [tema, descricao].join('\t');
            }).join('\n');
        } else {
            const totalBlocos = Math.max(fila.turmas.length, 1);
            const originalPorId = new Map(grade.linhas.map(linha => [linha.id, linha]));
            const blocosSaida = Array.from({ length: totalBlocos }, () => []);
            const entradasNormalizadas = linhasEditadas.map(entrada => {
                const ehDescritor = Boolean(entrada) && !Array.isArray(entrada);
                const valores = ehDescritor
                    ? (Array.isArray(entrada.valores) ? entrada.valores : [])
                    : (Array.isArray(entrada) ? entrada : []);
                return { ehDescritor, entrada, valores };
            });
            const colunasMinimas = Math.max(0, grade.colunas.length - 2);
            const totalColunasValor = entradasNormalizadas.reduce(
                (maior, item) => Math.max(maior, item.valores.length - 2),
                colunasMinimas
            );
            entradasNormalizadas.forEach(({ ehDescritor, entrada, valores }, indice) => {
                const idReferencia = ehDescritor ? texto(entrada.id || '') : '';
                const original = idReferencia ? originalPorId.get(idReferencia) : grade.linhas[indice];
                const blocoIndice = ehDescritor && Number.isInteger(entrada.bloco)
                    ? entrada.bloco
                    : (original ? original.bloco : 0);
                if (blocoIndice < 0 || blocoIndice >= blocosSaida.length) {
                    throw new Error(`A linha ${indice + 1} referencia uma turma inexistente.`);
                }
                const matriculaProtegida = original
                    ? (original.matricula || '')
                    : texto(String((ehDescritor && entrada.matricula) || ''));
                if (!matriculaProtegida) {
                    throw new Error(`A linha ${indice + 1} do bloco ${blocoIndice + 1} não possui matrícula.`);
                }
                const editaveis = Array.from({ length: totalColunasValor }, (_, indiceColuna) => {
                    const indiceValor = indiceColuna + 2;
                    const fornecido = valores[indiceValor];
                    if (fornecido !== undefined) return texto(String(fornecido));
                    return original ? texto(String(original.valores[indiceColuna + 1] ?? '')) : '';
                });
                while (editaveis.length && !editaveis.at(-1)) editaveis.pop();
                blocosSaida[blocoIndice].push([matriculaProtegida, ...editaveis].join('\t'));
            });
            matrizTexto = blocosSaida.map(linhas => linhas.join('\n')).join('\n*\n');
        }
        if (matrizTexto.length > MAX_MATRIZ) throw new Error(`A matriz editada excede o limite de ${MAX_MATRIZ.toLocaleString('pt-BR')} caracteres.`);
        const preparada = prepararParaSalvar({ ...fila, matrizTexto });
        return { ...preparada, grade: gerarEdicaoMatriz(preparada.fila) };
    }

    function prepararParaSalvar(valor) {
        const fila = normalizar(valor);
        const erros = validar(fila);
        fila.status = erros.length ? 'RASCUNHO' : 'PRONTA';
        fila.atualizadoEm = agora();
        fila.totalItens = contarItens(fila);
        return { fila, erros };
    }

    function importar(conteudo, idsExistentes = []) {
        const raiz = typeof conteudo === 'string' ? JSON.parse(conteudo) : conteudo;
        if (raiz?.schemaVersion !== undefined && Number(raiz.schemaVersion) !== SCHEMA_VERSION) {
            throw new Error(`Versão de esquema não suportada: ${raiz.schemaVersion}.`);
        }
        const origem = Array.isArray(raiz) ? raiz : raiz?.filas;
        if (!Array.isArray(origem)) throw new Error('O arquivo não contém uma coleção de filas válida.');
        if (origem.length > MAX_FILAS) throw new Error(`O arquivo excede o limite de ${MAX_FILAS} filas.`);
        const usados = new Set(idsExistentes);
        return origem.map(item => {
            const conflito = usados.has(texto(item?.id));
            const normalizada = prepararParaSalvar(normalizar(item, { novoId: conflito })).fila;
            if (normalizada.matrizTexto.length > MAX_MATRIZ) {
                throw new Error(`A fila “${normalizada.nome || normalizada.id}” excede o limite de ${MAX_MATRIZ.toLocaleString('pt-BR')} caracteres por matriz.`);
            }
            usados.add(normalizada.id);
            return normalizada;
        });
    }

    global.SiaepQueueModel = Object.freeze({
        SCHEMA_VERSION,
        MAX_FILAS,
        MAX_MATRIZ,
        MAX_LINHAS_EDICAO,
        TIPOS,
        TIPOS_AVALIACAO,
        DISCIPLINAS,
        criar,
        normalizar,
        validar,
        contarItens,
        contarItensPorTurma,
        prepararParaSalvar,
        importar,
        blocosNotas,
        gerarPreview,
        gerarEdicaoMatriz,
        aplicarEdicaoMatriz,
        alunosElegiveis,
        compararNomes,
        carregarMatriculasSincronizadas,
        adicionarLinhaTexto,
        removerUltimaLinhaTexto,
        adicionarColunaTexto,
        removerUltimaColunaTexto
    });
})(globalThis);
