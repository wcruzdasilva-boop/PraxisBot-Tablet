// Gerador de planos de aula por IA (Gemini) para o PraxisBot Tablet.
// Reaproveita o mesmo contrato de prompt e retentativas de src/nucleo/background.js.
// A chave da API Gemini fica guardada apenas neste tablet (nunca é sincronizada na nuvem).
(function (global) {
    'use strict';

    const MODELO_PADRAO = 'gemini-2.5-flash';
    const MAX_TENTATIVAS = 3;

    function montarPrompt(payload = {}) {
        const usaPeriodoLetivo = Boolean(payload.dataInicio && payload.dataFim);
        if (usaPeriodoLetivo) {
            return `
Atue como um educador especialista na disciplina de ${payload.disciplina || 'não informada'}.
Tema Central / Competência: ${payload.tema}
Diretrizes: ${payload.prompt || ''}
Período Letivo: de ${payload.dataInicio} até ${payload.dataFim}
Frequência de Encontros: ${payload.aulasSemana || 1} aula(s) por semana.

INSTRUÇÕES CRÍTICAS DE ENGENHARIA:
1. Calcule matematicamente a quantidade de semanas entre as datas fornecidas e multiplique pela frequência semanal para descobrir o total exato de aulas necessárias no período.
2. Gere um cronograma sequencial e contínuo dividindo o Tema Central nessa quantidade de aulas.
3. Você deve retornar EXCLUSIVAMENTE um array JSON válido. Nenhuma introdução, formatação ou conclusão textual fora das chaves do JSON.
4. A estrutura do JSON deve seguir o modelo estrito de array de objetos com duas chaves:
[
  {"tema": "[Título Sintético da Aula 1]", "descricao": "[Detalhamento metodológico da aula 1]"},
  {"tema": "[Título Sintético da Aula 2]", "descricao": "[Detalhamento metodológico da aula 2]"}
]`;
        }
        return `
Atue como um educador e elaborador de currículo escolar.
Disciplina: ${payload.disciplina || 'não informada'}
Tema Central ou Competência: ${payload.tema}
Diretrizes Metodológicas: ${payload.prompt || ''}
Quantidade exata de aulas a gerar: ${Math.max(1, Number(payload.qtd) || 4)}

INSTRUÇÃO CRÍTICA DE SISTEMA: Você deve retornar EXCLUSIVAMENTE um array JSON válido.
Nenhum texto adicional, sem formatação markdown (sem \`\`\`json), sem introdução ou conclusão.
O array deve conter objetos com exatamente duas chaves: "tema" e "descricao".
Exemplo de estrutura exigida:
[
  {"tema": "Título da Aula 1", "descricao": "Descrição detalhada do conteúdo metodológico da aula 1"},
  {"tema": "Título da Aula 2", "descricao": "Descrição detalhada do conteúdo metodológico da aula 2"}
]`;
    }

    function extrairAulasDaResposta(dados) {
        const textoBruto = String(dados?.candidates?.[0]?.content?.parts?.[0]?.text || '')
            .replace(/```json/gi, '')
            .replace(/```/g, '')
            .trim();
        if (!textoBruto) throw new Error('A IA não retornou conteúdo.');
        const lista = JSON.parse(textoBruto);
        if (!Array.isArray(lista) || !lista.length) throw new Error('A IA retornou uma lista vazia.');
        const normalizadas = lista
            .map(item => ({
                tema: String(item?.tema || '').replace(/[\r\n\t]+/g, ' ').trim(),
                descricao: String(item?.descricao || '').replace(/[\r\n\t]+/g, ' ').trim()
            }))
            .filter(item => item.tema || item.descricao);
        if (!normalizadas.length) throw new Error('Nenhuma aula válida encontrada na resposta da IA.');
        return normalizadas;
    }

    async function gerarAulas({
        token,
        disciplina = '',
        tema = '',
        prompt = '',
        dataInicio = '',
        dataFim = '',
        aulasSemana = 2,
        qtd = 0,
        buscar = (...a) => global.fetch(...a),
        esperar = ms => new Promise(resolve => setTimeout(resolve, ms))
    }) {
        const chave = String(token || '').trim();
        if (!chave) throw new Error('Informe sua chave da API Gemini antes de gerar aulas.');
        if (!String(tema || '').trim()) throw new Error('Informe o tema central para a IA gerar as aulas.');

        const usaPeriodo = Boolean(dataInicio && dataFim);
        const promptEstruturado = montarPrompt({ disciplina, tema, prompt, dataInicio, dataFim, aulasSemana, qtd });
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_PADRAO}:generateContent?key=${encodeURIComponent(chave)}`;
        const corpo = {
            contents: [{ parts: [{ text: promptEstruturado }] }],
            generationConfig: {
                temperature: usaPeriodo ? 0.5 : 0.7,
                responseMimeType: 'application/json'
            }
        };

        let resposta;
        for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
            try {
                const tent = await buscar(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(corpo)
                });
                if (!tent.ok) {
                    const erroHttp = new Error(tent.status === 400 || tent.status === 403
                        ? 'Chave da API Gemini recusada. Confira a chave configurada.'
                        : `A API Gemini respondeu HTTP ${tent.status}.`);
                    erroHttp.status = tent.status;
                    throw erroHttp;
                }
                resposta = tent;
                break;
            } catch (erroTentativa) {
                const transitorio = !Number.isInteger(erroTentativa.status) || erroTentativa.status === 429 || erroTentativa.status >= 500;
                if (!transitorio || tentativa === MAX_TENTATIVAS) throw erroTentativa;
                await esperar(1000 * tentativa);
            }
        }
        return extrairAulasDaResposta(await resposta.json());
    }

    const modulo = Object.freeze({ MODELO_PADRAO, montarPrompt, extrairAulasDaResposta, gerarAulas });
    global.PraxisTabletGemini = modulo;
    if (typeof module !== 'undefined' && module.exports) module.exports = modulo;
})(globalThis);
