// Controladores da Fase 3 do PraxisBot Tablet:
// - Avaliações (1 a 5 instrumentos, intervalo, tentarNovamente, múltiplas turmas)
// - Notas (grade tátil com teclado numérico 0..10, referência do Diário local, tentarNovamente)
// - Gerador de aulas por IA (Gemini 2.5 Flash — chave guardada apenas neste tablet)
// - Consulta completa do Diário local offline (Aulas, Estudantes, Boletim bimestral e anual)
(function (global) {
    'use strict';

    const CHAVE_IA_LOCAL = 'ia_token_local';

    function iniciarFase3({
        $,
        el,
        db,
        sync,
        domain,
        gemini,
        queueModel,
        catModel,
        reportModel,
        state,
        diarioBase,
        blocoAulas,
        blocoAvalNotas,
        recarregarDoBanco,
        renderizarTudo,
        trocarAba,
        mostrarToast
    }) {
        const agora = domain.hojeIso();

        const f3 = {
            subabaAval: 'avaliacoes',
            avaliacoes: {
                filaId: '',
                disciplina: '',
                periodo: '1º PERIODO',
                dataInicial: agora,
                intervaloAulas: 2,
                nome: '',
                feriados: '',
                turmasSelecionadas: [],
                tiposAvaliacao: ['PROVA OBJETIVA'],
                tentarNovamente: true,
                substituir: false
            },
            notas: {
                filaId: '',
                turmaId: '',
                disciplina: '',
                periodo: '1º PERIODO',
                nome: '',
                tentarNovamente: true,
                colAtiva: 0,
                totalColunas: 1,
                linhas: []
            },
            ia: {
                token: '',
                modo: 'qtd',
                carregando: false,
                resultado: null
            },
            diario: {
                turmaId: '',
                disciplina: '',
                periodo: '1º PERIODO',
                subaba: 'aulas',
                busca: ''
            }
        };

        async function carregarChaveIa() {
            f3.ia.token = String((await db.lerKv(CHAVE_IA_LOCAL, '')) || '');
            atualizarUiChaveIa();
        }

        function atualizarUiChaveIa() {
            const tem = Boolean(f3.ia.token);
            const status = $('cfg-ia-status');
            if (status) status.textContent = tem ? 'Chave Gemini salva neste tablet (nunca sai para a nuvem).' : 'Nenhuma chave salva neste tablet.';
            $('cfg-ia-remove')?.classList.toggle('is-hidden', !tem);
            $('aulas-ia-no-key')?.classList.toggle('is-hidden', tem);
        }

        function sincronizarPadroesComDiario() {
            const dbBase = diarioBase();
            const turmas = domain.obterTurmas(dbBase);
            if (!turmas.length) return;
            if (!f3.avaliacoes.disciplina) {
                const discs = domain.disciplinasDaTurma(dbBase, turmas[0].id, queueModel);
                f3.avaliacoes.disciplina = discs[0] || queueModel.DISCIPLINAS[0];
            }
            if (!f3.avaliacoes.feriados && dbBase.calendario?.length) {
                f3.avaliacoes.feriados = domain.feriadosTextoDoCalendario(dbBase.calendario);
            }
            if (!f3.notas.turmaId) selecionarTurmaNotas(turmas[0].id);
            if (!f3.diario.turmaId) {
                f3.diario.turmaId = turmas[0].id;
                const discs = domain.disciplinasDaTurma(dbBase, turmas[0].id, queueModel);
                f3.diario.disciplina = discs[0] || '';
            }
        }

        // ---- 1. Sub-abas Avaliações / Notas ----
        function selecionarSubaba(subaba) {
            f3.subabaAval = subaba === 'notas' ? 'notas' : 'avaliacoes';
            $('subtab-btn-avaliacoes').classList.toggle('is-active', f3.subabaAval === 'avaliacoes');
            $('subtab-btn-notas').classList.toggle('is-active', f3.subabaAval === 'notas');
            $('panel-avaliacoes').classList.toggle('is-hidden', f3.subabaAval !== 'avaliacoes');
            $('panel-notas').classList.toggle('is-hidden', f3.subabaAval !== 'notas');
            if (f3.subabaAval === 'notas') renderizarNotas();
            else renderizarAvaliacoes();
        }
        $('subtab-btn-avaliacoes').addEventListener('click', () => selecionarSubaba('avaliacoes'));
        $('subtab-btn-notas').addEventListener('click', () => selecionarSubaba('notas'));

        // ---- 2. Avaliações ----
        function sugerirNomeAvaliacoes() {
            const codigos = f3.avaliacoes.turmasSelecionadas
                .map(r => (String(r).match(/\b\d{2}[A-Z0-9-]{2,}\b/i) || [r])[0])
                .slice(0, 2)
                .join('/');
            return `Avaliações ${codigos || 'Turma'} - ${f3.avaliacoes.periodo}`.slice(0, 100);
        }

        function montarFilaAvaliacoes() {
            const existente = state.filas.find(r => r.filaId === f3.avaliacoes.filaId)?.fila;
            const base = existente ? JSON.parse(JSON.stringify(existente)) : queueModel.criar('AVALIACOES');
            base.nome = f3.avaliacoes.nome.trim() || sugerirNomeAvaliacoes();
            base.tipo = 'AVALIACOES';
            base.turmas = [...f3.avaliacoes.turmasSelecionadas];
            base.configuracao.disciplina = f3.avaliacoes.disciplina;
            base.configuracao.periodo = f3.avaliacoes.periodo;
            base.configuracao.dataInicial = f3.avaliacoes.dataInicial;
            base.configuracao.intervaloAulas = Math.max(0, Number.parseInt(f3.avaliacoes.intervaloAulas, 10) || 0);
            base.configuracao.feriados = f3.avaliacoes.feriados;
            base.configuracao.tiposAvaliacao = [...f3.avaliacoes.tiposAvaliacao];
            base.configuracao.tentarNovamente = Boolean(f3.avaliacoes.tentarNovamente);
            base.configuracao.substituirRegistrados = Boolean(f3.avaliacoes.substituir);
            return base;
        }

        function abrirAvaliacoesParaEdicao(registro) {
            const fila = registro.fila;
            f3.avaliacoes = {
                filaId: fila.id,
                disciplina: fila.configuracao?.disciplina || '',
                periodo: fila.configuracao?.periodo || '1º PERIODO',
                dataInicial: fila.configuracao?.dataInicial || domain.hojeIso(),
                intervaloAulas: Number(fila.configuracao?.intervaloAulas) || 0,
                nome: fila.nome || '',
                feriados: fila.configuracao?.feriados || '',
                turmasSelecionadas: [...(fila.turmas || [])],
                tiposAvaliacao: [...(fila.configuracao?.tiposAvaliacao || [])],
                tentarNovamente: Boolean(fila.configuracao?.tentarNovamente),
                substituir: Boolean(fila.configuracao?.substituirRegistrados)
            };
            f3.subabaAval = 'avaliacoes';
            trocarAba('avaliacoes');
        }

        function renderizarAvaliacoes() {
            const dbBase = diarioBase();
            const turmas = domain.obterTurmas(dbBase);
            $('aval-heading').textContent = f3.avaliacoes.filaId ? 'Editando fila de Avaliações' : 'Nova fila de Avaliações';

            const todasDiscs = new Set(queueModel.DISCIPLINAS);
            for (const d of dbBase.disciplinas || []) if (d?.nome) todasDiscs.add(d.nome);
            if (f3.avaliacoes.disciplina) todasDiscs.add(f3.avaliacoes.disciplina);
            const selDisc = $('aval-disciplina');
            selDisc.replaceChildren();
            for (const d of [...todasDiscs].sort((a, b) => a.localeCompare(b, 'pt-BR'))) selDisc.append(el('option', { value: d, text: d }));
            selDisc.value = f3.avaliacoes.disciplina;

            $('aval-periodo').value = f3.avaliacoes.periodo;
            $('aval-data').value = f3.avaliacoes.dataInicial;
            if (document.activeElement !== $('aval-intervalo')) $('aval-intervalo').value = String(f3.avaliacoes.intervaloAulas);
            if (document.activeElement !== $('aval-nome')) $('aval-nome').value = f3.avaliacoes.nome;
            if (document.activeElement !== $('aval-feriados')) $('aval-feriados').value = f3.avaliacoes.feriados;
            $('aval-tentar-novamente').checked = Boolean(f3.avaliacoes.tentarNovamente);
            $('aval-substituir').checked = Boolean(f3.avaliacoes.substituir);

            const boxTurmas = $('aval-turmas-chips');
            boxTurmas.replaceChildren();
            if (!turmas.length) {
                boxTurmas.append(el('span', { class: 'muted-text', text: 'Sincronize o Diário no computador para escolher turmas.' }));
            } else {
                for (const t of turmas) {
                    const sel = f3.avaliacoes.turmasSelecionadas.includes(t.rotulo);
                    boxTurmas.append(el('button', {
                        type: 'button',
                        class: `turma-chip ${sel ? 'is-selected' : ''}`,
                        text: catModel.criarRotuloCompacto(t),
                        onclick: () => {
                            if (sel) f3.avaliacoes.turmasSelecionadas = f3.avaliacoes.turmasSelecionadas.filter(r => r !== t.rotulo);
                            else f3.avaliacoes.turmasSelecionadas.push(t.rotulo);
                            renderizarAvaliacoes();
                        }
                    }));
                }
            }

            const boxTipos = $('aval-tipos-chips');
            boxTipos.replaceChildren();
            for (const tipo of queueModel.TIPOS_AVALIACAO) {
                const pos = f3.avaliacoes.tiposAvaliacao.indexOf(tipo);
                const sel = pos >= 0;
                boxTipos.append(el('button', {
                    type: 'button',
                    class: `turma-chip ${sel ? 'is-selected' : ''}`,
                    text: sel ? `${pos + 1}º · ${tipo}` : tipo,
                    onclick: () => {
                        if (sel) {
                            f3.avaliacoes.tiposAvaliacao.splice(pos, 1);
                        } else {
                            if (f3.avaliacoes.tiposAvaliacao.length >= 5) {
                                mostrarToast('Uma fila aceita no máximo 5 instrumentos avaliativos.', true);
                                return;
                            }
                            f3.avaliacoes.tiposAvaliacao.push(tipo);
                        }
                        renderizarAvaliacoes();
                    }
                }));
            }

            const erros = queueModel.validar(montarFilaAvaliacoes());
            const val = $('aval-validation');
            val.textContent = erros.length
                ? erros[0].mensagem
                : `${f3.avaliacoes.tiposAvaliacao.length} avaliação(ões) para ${f3.avaliacoes.turmasSelecionadas.length} turma(s).`;
            val.className = `validation-hint ${erros.length ? 'is-error' : 'is-ok'}`;
            $('aval-save-run').disabled = erros.length > 0;
        }

        $('aval-disciplina').addEventListener('change', ev => { f3.avaliacoes.disciplina = ev.target.value; renderizarAvaliacoes(); });
        $('aval-periodo').addEventListener('change', ev => { f3.avaliacoes.periodo = ev.target.value; renderizarAvaliacoes(); });
        $('aval-data').addEventListener('change', ev => { f3.avaliacoes.dataInicial = ev.target.value; renderizarAvaliacoes(); });
        $('aval-intervalo').addEventListener('input', ev => { f3.avaliacoes.intervaloAulas = Number.parseInt(ev.target.value, 10) || 0; renderizarAvaliacoes(); });
        $('aval-nome').addEventListener('input', ev => { f3.avaliacoes.nome = ev.target.value; renderizarAvaliacoes(); });
        $('aval-feriados').addEventListener('input', ev => { f3.avaliacoes.feriados = ev.target.value; });
        $('aval-tentar-novamente').addEventListener('change', ev => { f3.avaliacoes.tentarNovamente = ev.target.checked; });
        $('aval-substituir').addEventListener('change', ev => { f3.avaliacoes.substituir = ev.target.checked; });
        $('aval-reset').addEventListener('click', () => {
            f3.avaliacoes.filaId = '';
            f3.avaliacoes.nome = '';
            f3.avaliacoes.turmasSelecionadas = [];
            f3.avaliacoes.tiposAvaliacao = ['PROVA OBJETIVA'];
            f3.avaliacoes.dataInicial = domain.hojeIso();
            renderizarAvaliacoes();
        });

        async function salvarAvaliacoes(executarNoPc) {
            const fila = montarFilaAvaliacoes();
            if (executarNoPc && !window.confirm(`Salvar a fila “${fila.nome}” e solicitar execução automática assim que o computador sincronizar?`)) return;
            const res = await sync.salvarFilaLocal(fila, { executarNoPc });
            if (!res.sucesso) return mostrarToast(res.erro || 'Revise os campos das avaliações.', true);
            f3.avaliacoes.filaId = res.fila.id;
            await recarregarDoBanco();
            renderizarTudo();
            mostrarToast(executarNoPc ? 'Avaliações salvas! O computador executará ao sincronizar.' : 'Fila de avaliações salva e marcada para sincronizar.');
        }
        $('aval-save').addEventListener('click', () => salvarAvaliacoes(false));
        $('aval-save-run').addEventListener('click', () => salvarAvaliacoes(true));

        // ---- 3. Notas ----
        function sugerirNomeNotas(turma, periodo) {
            const cod = turma?.numero || turma?.rotulo || 'Turma';
            return `Notas ${cod} - ${periodo}`.slice(0, 100);
        }

        function selecionarTurmaNotas(turmaId, disciplinaPreferida = '', periodoPreferido = '') {
            const dbBase = diarioBase();
            const turmas = domain.obterTurmas(dbBase);
            const turma = turmas.find(t => t.id === turmaId) || turmas[0] || null;
            f3.notas.turmaId = turma?.id || '';
            const discs = turma ? domain.disciplinasDaTurma(dbBase, turma.id, queueModel) : [...queueModel.DISCIPLINAS];
            f3.notas.disciplina = disciplinaPreferida && discs.includes(disciplinaPreferida) ? disciplinaPreferida : (disciplinaPreferida || discs[0] || '');
            if (periodoPreferido) f3.notas.periodo = periodoPreferido;
            const alunos = turma ? domain.alunosDaTurma(dbBase, turma.id, queueModel) : [];
            const lido = domain.lerMatrizNotas('', alunos, 1);
            f3.notas.totalColunas = lido.totalColunas;
            f3.notas.colAtiva = 0;
            f3.notas.linhas = lido.linhas;
            if (!f3.notas.filaId) f3.notas.nome = sugerirNomeNotas(turma, f3.notas.periodo);
        }

        function abrirNotasParaEdicao(registro) {
            const fila = registro.fila;
            const dbBase = diarioBase();
            const turmas = domain.obterTurmas(dbBase);
            const turma = turmas.find(t => t.rotulo === fila.turmas?.[0]) || turmas[0] || null;
            const alunos = turma ? domain.alunosDaTurma(dbBase, turma.id, queueModel) : [];
            const lido = domain.lerMatrizNotas(fila.matrizTexto, alunos, 1);
            f3.notas = {
                filaId: fila.id,
                turmaId: turma?.id || '',
                disciplina: fila.configuracao?.disciplina || '',
                periodo: fila.configuracao?.periodo || '1º PERIODO',
                nome: fila.nome || '',
                tentarNovamente: Boolean(fila.configuracao?.tentarNovamente),
                colAtiva: 0,
                totalColunas: lido.totalColunas,
                linhas: lido.linhas
            };
            f3.subabaAval = 'notas';
            trocarAba('avaliacoes');
        }

        function montarFilaNotas() {
            const dbBase = diarioBase();
            const turma = domain.obterTurmas(dbBase).find(t => t.id === f3.notas.turmaId);
            const existente = state.filas.find(r => r.filaId === f3.notas.filaId)?.fila;
            const base = existente ? JSON.parse(JSON.stringify(existente)) : queueModel.criar('NOTAS');
            base.nome = f3.notas.nome.trim() || sugerirNomeNotas(turma, f3.notas.periodo);
            base.tipo = 'NOTAS';
            base.turmas = turma ? [turma.rotulo] : (existente?.turmas || []);
            base.configuracao.disciplina = f3.notas.disciplina;
            base.configuracao.periodo = f3.notas.periodo;
            base.configuracao.tentarNovamente = Boolean(f3.notas.tentarNovamente);
            base.matrizTexto = domain.montarMatrizNotas(f3.notas.linhas);
            return base;
        }

        function atualizarContadoresEValidacaoNotas() {
            const resumo = domain.resumirNotas(f3.notas.linhas, f3.notas.colAtiva);
            $('notas-counters').replaceChildren(
                el('span', { class: 'badge badge-safe', text: `Preenchidas: ${resumo.preenchidas}/${resumo.total}` }),
                el('span', { class: 'badge badge-info', text: resumo.media !== null ? `Média da coluna: ${String(resumo.media).replace('.', ',')}` : 'Média: —' }),
                resumo.invalidas > 0 ? el('span', { class: 'badge badge-danger', text: `${resumo.invalidas} inválida(s)` }) : null
            );
            const erros = queueModel.validar(montarFilaNotas());
            const val = $('notas-validation');
            val.textContent = erros.length ? erros[0].mensagem : 'Notas prontas para sincronizar ou executar no computador.';
            val.className = `validation-hint ${erros.length ? 'is-error' : 'is-ok'}`;
            $('notas-save-run').disabled = erros.length > 0;
        }

        function renderizarNotas() {
            const dbBase = diarioBase();
            const turmas = domain.obterTurmas(dbBase);
            $('notas-heading').textContent = f3.notas.filaId ? 'Editando fila de Notas' : 'Nova fila de Notas';

            const selTurma = $('notas-turma');
            selTurma.replaceChildren();
            if (!turmas.length) selTurma.append(el('option', { value: '', text: 'Sincronize o Diário no PC primeiro' }));
            for (const t of turmas) selTurma.append(el('option', { value: t.id, text: catModel.criarRotuloCompacto(t) }));
            selTurma.value = f3.notas.turmaId;

            const discs = f3.notas.turmaId ? domain.disciplinasDaTurma(dbBase, f3.notas.turmaId, queueModel) : [...queueModel.DISCIPLINAS];
            if (f3.notas.disciplina && !discs.includes(f3.notas.disciplina)) discs.unshift(f3.notas.disciplina);
            const selDisc = $('notas-disciplina');
            selDisc.replaceChildren();
            for (const d of discs) selDisc.append(el('option', { value: d, text: d }));
            selDisc.value = f3.notas.disciplina;

            $('notas-periodo').value = f3.notas.periodo;
            if (document.activeElement !== $('notas-nome')) $('notas-nome').value = f3.notas.nome;
            $('notas-tentar-novamente').checked = Boolean(f3.notas.tentarNovamente);

            // Referência das avaliações sincronizadas no Diário para orientar as colunas.
            const avalsRef = domain.avaliacoesDaTurmaDisciplinaPeriodo(blocoAvalNotas(), f3.notas.turmaId, f3.notas.disciplina, f3.notas.periodo);
            const refBar = $('notas-ref-bar');
            if (avalsRef.length) {
                const nomes = avalsRef.map((a, idx) => `${idx + 1}: ${a.instrumento || a.descricao || a.tipo}${a.tipo?.toUpperCase().includes('RECUPERACAO') ? ' (RP)' : ''}`).join(' · ');
                refBar.textContent = `Avaliações no Diário (${f3.notas.periodo}): ${nomes}`;
                refBar.classList.remove('is-hidden');
            } else {
                refBar.classList.add('is-hidden');
            }

            const tabs = $('notas-col-tabs');
            tabs.replaceChildren();
            for (let i = 0; i < f3.notas.totalColunas; i++) {
                const ref = avalsRef[i];
                const rotulo = ref ? `Nota ${i + 1} (${ref.instrumento || ref.tipo})` : `Nota ${i + 1}`;
                tabs.append(el('button', {
                    type: 'button',
                    class: `col-tab ${i === f3.notas.colAtiva ? 'is-active' : ''}`,
                    text: rotulo,
                    onclick: () => { f3.notas.colAtiva = i; renderizarNotas(); }
                }));
            }
            $('notas-del-col').classList.toggle('is-hidden', f3.notas.totalColunas <= 1);

            const list = $('notas-list');
            const empty = $('notas-empty');
            list.replaceChildren();
            if (!f3.notas.linhas.length) {
                empty.textContent = 'Nenhum estudante carregado para esta turma. Sincronize o diretório de alunos no computador.';
                empty.classList.remove('is-hidden');
            } else {
                empty.classList.add('is-hidden');
                f3.notas.linhas.forEach((aluno, indice) => {
                    const valorAtual = aluno.colunas[f3.notas.colAtiva] || '';
                    const check = domain.validarCelulaNota(valorAtual);
                    const input = el('input', {
                        type: 'text',
                        inputmode: 'decimal',
                        class: `grade-input ${check.valida ? '' : 'is-invalid'}`,
                        value: valorAtual,
                        placeholder: '0,0'
                    });
                    input.addEventListener('input', ev => {
                        aluno.colunas[f3.notas.colAtiva] = ev.target.value;
                        const valido = domain.validarCelulaNota(ev.target.value).valida;
                        input.classList.toggle('is-invalid', !valido);
                        atualizarContadoresEValidacaoNotas();
                    });
                    list.append(el('div', { class: 'student-row' }, [
                        el('span', { class: 'student-num', text: String(indice + 1) }),
                        el('div', { class: 'student-info', style: 'flex:1;' }, [
                            el('span', { class: 'student-name', text: aluno.nome }),
                            el('span', { class: 'student-mat', text: `Mat. ${aluno.matricula}` })
                        ]),
                        input
                    ]));
                });
            }
            atualizarContadoresEValidacaoNotas();
        }

        $('notas-turma').addEventListener('change', ev => { selecionarTurmaNotas(ev.target.value); renderizarNotas(); });
        $('notas-disciplina').addEventListener('change', ev => { f3.notas.disciplina = ev.target.value; renderizarNotas(); });
        $('notas-periodo').addEventListener('change', ev => {
            f3.notas.periodo = ev.target.value;
            if (!f3.notas.filaId) {
                const turma = domain.obterTurmas(diarioBase()).find(t => t.id === f3.notas.turmaId);
                f3.notas.nome = sugerirNomeNotas(turma, f3.notas.periodo);
            }
            renderizarNotas();
        });
        $('notas-nome').addEventListener('input', ev => { f3.notas.nome = ev.target.value; atualizarContadoresEValidacaoNotas(); });
        $('notas-tentar-novamente').addEventListener('change', ev => { f3.notas.tentarNovamente = ev.target.checked; });
        $('notas-add-col').addEventListener('click', () => {
            f3.notas.totalColunas++;
            f3.notas.linhas.forEach(a => a.colunas.push(''));
            f3.notas.colAtiva = f3.notas.totalColunas - 1;
            renderizarNotas();
        });
        $('notas-del-col').addEventListener('click', () => {
            if (f3.notas.totalColunas <= 1) return;
            const idx = f3.notas.colAtiva;
            f3.notas.linhas.forEach(a => a.colunas.splice(idx, 1));
            f3.notas.totalColunas--;
            f3.notas.colAtiva = Math.max(0, idx - 1);
            renderizarNotas();
        });
        $('notas-reset').addEventListener('click', () => {
            f3.notas.filaId = '';
            selecionarTurmaNotas(f3.notas.turmaId, f3.notas.disciplina, f3.notas.periodo);
            renderizarNotas();
        });

        async function salvarNotas(executarNoPc) {
            const fila = montarFilaNotas();
            if (executarNoPc && !window.confirm(`Salvar a fila “${fila.nome}” e solicitar execução automática assim que o computador sincronizar?`)) return;
            const res = await sync.salvarFilaLocal(fila, { executarNoPc });
            if (!res.sucesso) return mostrarToast(res.erro || 'Revise as notas informadas.', true);
            f3.notas.filaId = res.fila.id;
            await recarregarDoBanco();
            renderizarTudo();
            mostrarToast(executarNoPc ? 'Notas salvas! O computador executará ao sincronizar.' : 'Fila de notas salva e marcada para sincronizar.');
        }
        $('notas-save').addEventListener('click', () => salvarNotas(false));
        $('notas-save-run').addEventListener('click', () => salvarNotas(true));

        // ---- 4. Gerador de aulas por IA (Gemini — na aba Aulas + chave em Ajustes) ----
        $('cfg-ia-save').addEventListener('click', async () => {
            const chave = String($('cfg-ia-token').value || '').trim();
            if (!chave) return mostrarToast('Digite sua chave da API Gemini.', true);
            f3.ia.token = chave;
            await db.gravarKv(CHAVE_IA_LOCAL, chave);
            $('cfg-ia-token').value = '';
            atualizarUiChaveIa();
            mostrarToast('Chave Gemini salva localmente neste tablet.');
        });
        $('cfg-ia-remove').addEventListener('click', async () => {
            if (!window.confirm('Remover a chave da API Gemini deste tablet?')) return;
            f3.ia.token = '';
            await db.removerKv(CHAVE_IA_LOCAL);
            atualizarUiChaveIa();
            mostrarToast('Chave Gemini removida deste tablet.');
        });

        $('aulas-ia-toggle').addEventListener('click', () => {
            const painel = $('aulas-ia-panel');
            painel.classList.toggle('is-hidden');
            atualizarUiChaveIa();
            if (!$('ia-data-inicio').value) $('ia-data-inicio').value = state.aulas.dataInicial || domain.hojeIso();
        });
        $('aulas-ia-close').addEventListener('click', () => $('aulas-ia-panel').classList.add('is-hidden'));

        $('ia-modo-qtd').addEventListener('click', () => {
            f3.ia.modo = 'qtd';
            $('ia-modo-qtd').classList.add('is-active');
            $('ia-modo-periodo').classList.remove('is-active');
            $('ia-campos-qtd').classList.remove('is-hidden');
            $('ia-campos-periodo').classList.add('is-hidden');
        });
        $('ia-modo-periodo').addEventListener('click', () => {
            f3.ia.modo = 'periodo';
            $('ia-modo-periodo').classList.add('is-active');
            $('ia-modo-qtd').classList.remove('is-active');
            $('ia-campos-periodo').classList.remove('is-hidden');
            $('ia-campos-qtd').classList.add('is-hidden');
        });

        $('ia-gerar-btn').addEventListener('click', async () => {
            if (f3.ia.carregando) return;
            if (!navigator.onLine) return mostrarToast('A geração por IA exige conexão com a internet.', true);
            f3.ia.carregando = true;
            $('ia-gerar-btn').disabled = true;
            $('ia-status').textContent = 'Gerando cronograma de aulas com o Gemini…';
            $('ia-inserir-btn').classList.add('is-hidden');
            $('ia-preview').classList.add('is-hidden');
            try {
                const payload = {
                    token: f3.ia.token,
                    disciplina: state.aulas.disciplina,
                    tema: $('ia-tema').value,
                    prompt: $('ia-diretrizes').value,
                    ...(f3.ia.modo === 'periodo'
                        ? { dataInicio: $('ia-data-inicio').value, dataFim: $('ia-data-fim').value, aulasSemana: Number($('ia-aulas-semana').value) || 2 }
                        : { qtd: Number($('ia-qtd').value) || 4 })
                };
                const geradas = await gemini.gerarAulas(payload);
                f3.ia.resultado = geradas;
                $('ia-status').textContent = `${geradas.length} aula(s) geradas. Revise abaixo e clique em “Inserir aulas na fila”.`;
                const prev = $('ia-preview');
                prev.replaceChildren();
                geradas.forEach((a, i) => {
                    prev.append(el('div', { class: 'ia-preview-item' }, [
                        el('strong', { text: `${i + 1}. ${a.tema}` }),
                        el('p', { text: a.descricao })
                    ]));
                });
                prev.classList.remove('is-hidden');
                $('ia-inserir-btn').classList.remove('is-hidden');
            } catch (erro) {
                $('ia-status').textContent = erro.message || 'Falha ao gerar aulas.';
                mostrarToast(erro.message || 'Falha ao gerar aulas.', true);
            } finally {
                f3.ia.carregando = false;
                $('ia-gerar-btn').disabled = false;
            }
        });

        $('ia-inserir-btn').addEventListener('click', () => {
            if (!Array.isArray(f3.ia.resultado) || !f3.ia.resultado.length) return;
            const temPreenchidas = state.aulas.itens.some(i => i.tema.trim() || i.descricao.trim());
            if (temPreenchidas && !window.confirm('Substituir as aulas já digitadas nesta fila pelas aulas geradas pela IA?')) return;
            state.aulas.itens = f3.ia.resultado.map(item => ({ tema: item.tema, descricao: item.descricao }));
            f3.ia.resultado = null;
            $('aulas-ia-panel').classList.add('is-hidden');
            renderizarTudo();
            mostrarToast(`${state.aulas.itens.length} aula(s) inseridas na fila.`);
        });

        // ---- 5. Consulta completa do Diário local (offline) ----
        function renderizarDiario() {
            const dbBase = diarioBase();
            const turmas = domain.obterTurmas(dbBase);
            const selTurma = $('diario-turma');
            selTurma.replaceChildren();
            if (!turmas.length) {
                selTurma.append(el('option', { value: '', text: 'Sem turmas sincronizadas' }));
                $('diario-metrics').replaceChildren();
                $('diario-content').replaceChildren(el('div', { class: 'empty-box', text: 'Sincronize o Diário no computador para consultar alunos, aulas e boletins offline.' }));
                return;
            }
            for (const t of turmas) selTurma.append(el('option', { value: t.id, text: catModel.criarRotuloCompacto(t) }));
            if (!turmas.some(t => t.id === f3.diario.turmaId)) f3.diario.turmaId = turmas[0].id;
            selTurma.value = f3.diario.turmaId;

            const discs = domain.disciplinasDaTurma(dbBase, f3.diario.turmaId, queueModel);
            const selDisc = $('diario-disciplina');
            selDisc.replaceChildren(el('option', { value: '', text: 'Todas as disciplinas' }));
            for (const d of discs) selDisc.append(el('option', { value: d, text: d }));
            if (f3.diario.disciplina && !discs.includes(f3.diario.disciplina)) f3.diario.disciplina = discs[0] || '';
            selDisc.value = f3.diario.disciplina;
            $('diario-periodo').value = f3.diario.periodo;

            const resumo = domain.resumoDiarioTurma({
                turmaId: f3.diario.turmaId,
                disciplinaNome: f3.diario.disciplina,
                diarioBase: dbBase,
                blocoAulas: blocoAulas(),
                blocoAvalNotas: blocoAvalNotas(),
                queueModel
            });
            $('diario-metrics').replaceChildren(
                el('div', { class: 'metric-box' }, [el('span', { text: 'Estudantes' }), el('strong', { text: String(resumo.totalAlunos) })]),
                el('div', { class: 'metric-box' }, [el('span', { text: 'Aulas registradas' }), el('strong', { text: String(resumo.totalAulas) })]),
                el('div', { class: `metric-box ${resumo.aulasSemFrequencia ? 'is-warn' : ''}` }, [el('span', { text: 'Sem frequência' }), el('strong', { text: String(resumo.aulasSemFrequencia) })]),
                el('div', { class: 'metric-box' }, [el('span', { text: 'Avaliações / Notas' }), el('strong', { text: `${resumo.totalAvaliacoes} / ${resumo.totalNotas}` })])
            );

            document.querySelectorAll('[data-diario-tab]').forEach(btn => {
                btn.classList.toggle('is-active', btn.dataset.diarioTab === f3.diario.subaba);
            });

            const busca = domain.assinatura(f3.diario.busca);
            const content = $('diario-content');
            content.replaceChildren();

            if (f3.diario.subaba === 'aulas') {
                const aulas = domain.aulasDaTurmaDisciplina(blocoAulas(), f3.diario.turmaId, f3.diario.disciplina)
                    .filter(a => !busca || domain.assinatura(`${a.descricao} ${a.componente} ${a.data}`).includes(busca))
                    .sort((a, b) => `${b.data} ${b.hora || ''}`.localeCompare(`${a.data} ${a.hora || ''}`));
                if (!aulas.length) {
                    content.append(el('div', { class: 'empty-box', text: 'Nenhuma aula registrada encontrada para este filtro.' }));
                    return;
                }
                const lista = el('div', { class: 'diary-list' });
                for (const a of aulas.slice(0, 150)) {
                    const badgeFreq = a.frequenciaLancada === true
                        ? el('span', { class: 'badge badge-success', text: 'Frequência OK' })
                        : a.frequenciaLancada === false
                            ? el('span', { class: 'badge badge-warning', text: 'Sem frequência' })
                            : el('span', { class: 'badge badge-neutral', text: 'Frequência n/d' });
                    lista.append(el('div', { class: 'diary-item' }, [
                        el('div', {}, [
                            el('strong', { text: `${domain.formatarDataBr(a.data)}${a.hora ? ` (${a.hora})` : ''} · ${a.componente || ''}` }),
                            el('p', { class: 'muted-text', text: a.descricao || 'Sem descrição' })
                        ]),
                        badgeFreq
                    ]));
                }
                content.append(lista);
                return;
            }

            if (f3.diario.subaba === 'alunos') {
                const alunos = domain.alunosDaTurma(dbBase, f3.diario.turmaId, queueModel)
                    .filter(a => !busca || domain.assinatura(`${a.nome} ${a.matricula}`).includes(busca));
                if (!alunos.length) {
                    content.append(el('div', { class: 'empty-box', text: 'Nenhum estudante encontrado.' }));
                    return;
                }
                const grade = el('div', { class: 'student-grid' });
                alunos.forEach((a, i) => {
                    grade.append(el('div', { class: 'student-row' }, [
                        el('span', { class: 'student-num', text: String(i + 1) }),
                        el('div', { class: 'student-info' }, [
                            el('span', { class: 'student-name', text: a.nome }),
                            el('span', { class: 'student-mat', text: `Mat. ${a.matricula}${a.situacao ? ` · ${a.situacao}` : ''}` })
                        ])
                    ]));
                });
                content.append(grade);
                return;
            }

            if (!f3.diario.disciplina) {
                content.append(el('div', { class: 'empty-box', text: 'Escolha uma disciplina acima para consultar o boletim bimestral ou anual.' }));
                return;
            }

            const alunos = domain.alunosDaTurma(dbBase, f3.diario.turmaId, queueModel);

            if (f3.diario.subaba === 'bimestral') {
                const avaliacoes = domain.avaliacoesDaTurmaDisciplinaPeriodo(blocoAvalNotas(), f3.diario.turmaId, f3.diario.disciplina, f3.diario.periodo);
                const notas = domain.notasDaTurmaDisciplinaPeriodo(blocoAvalNotas(), f3.diario.turmaId, f3.diario.disciplina, f3.diario.periodo);
                if (!avaliacoes.length) {
                    content.append(el('div', { class: 'empty-box', text: `Nenhuma avaliação/nota sincronizada para ${f3.diario.disciplina} (${f3.diario.periodo}). Sincronize Avaliações e Notas no computador.` }));
                    return;
                }
                const rel = reportModel.calcularRelatorioBimestral({ avaliacoes, notas, alunos, periodo: f3.diario.periodo });
                const linhas = rel.linhas.filter(l => !busca || domain.assinatura(`${l.nome} ${l.matricula}`).includes(busca));
                content.append(el('p', { class: 'muted-text', text: rel.aviso }));
                const wrap = el('div', { class: 'table-wrap' });
                const headRow = el('tr', {}, [
                    el('th', { text: 'Estudante' }),
                    ...rel.pares.map(p => el('th', { text: `Av ${p.indice}` })),
                    el('th', { text: 'Média' })
                ]);
                const tbody = el('tbody');
                for (const l of linhas) {
                    const mediaTexto = l.media === null ? '—' : `${String(l.media).replace('.', ',')}${l.completo ? '' : '*'}`;
                    tbody.append(el('tr', {}, [
                        el('td', { text: l.nome }),
                        ...l.pares.map(p => el('td', {
                            class: p.pendente ? 'cell-pending' : (p.origem === 'RP' ? 'cell-rp' : ''),
                            text: p.pendente ? '—' : `${String(p.efetiva).replace('.', ',')}${p.origem === 'RP' ? ' (RP)' : ''}`
                        })),
                        el('td', { class: 'cell-bold', text: mediaTexto })
                    ]));
                }
                wrap.append(el('table', { class: 'diary-table' }, [el('thead', {}, [headRow]), tbody]));
                content.append(wrap);
                return;
            }

            // Boletim anual.
            const periodos = reportModel.PERIODOS.map(periodo => ({
                periodo,
                avaliacoes: domain.avaliacoesDaTurmaDisciplinaPeriodo(blocoAvalNotas(), f3.diario.turmaId, f3.diario.disciplina, periodo),
                notas: domain.notasDaTurmaDisciplinaPeriodo(blocoAvalNotas(), f3.diario.turmaId, f3.diario.disciplina, periodo)
            }));
            if (!periodos.some(p => p.avaliacoes.length)) {
                content.append(el('div', { class: 'empty-box', text: `Nenhuma avaliação/nota sincronizada para ${f3.diario.disciplina}.` }));
                return;
            }
            const anual = reportModel.calcularRelatorioAnual({ periodos, alunos });
            const linhas = anual.linhas.filter(l => !busca || domain.assinatura(`${l.nome} ${l.matricula}`).includes(busca));
            content.append(el('p', { class: 'muted-text', text: anual.aviso }));
            const wrap = el('div', { class: 'table-wrap' });
            const headRow = el('tr', {}, [
                el('th', { text: 'Estudante' }),
                el('th', { text: '1º Per.' }),
                el('th', { text: '2º Per.' }),
                el('th', { text: '3º Per.' }),
                el('th', { text: '4º Per.' }),
                el('th', { text: 'Média anual' })
            ]);
            const tbody = el('tbody');
            for (const l of linhas) {
                const mediaFinal = l.completo
                    ? String(l.mediaAnual).replace('.', ',')
                    : (l.mediaParcial !== null ? `${String(l.mediaParcial).replace('.', ',')}*` : '—');
                tbody.append(el('tr', {}, [
                    el('td', { text: l.nome }),
                    ...l.periodos.map(p => el('td', {
                        class: p.media === null ? 'cell-pending' : '',
                        text: p.media === null ? '—' : `${String(p.media).replace('.', ',')}${p.completa ? '' : '*'}`
                    })),
                    el('td', { class: 'cell-bold', text: mediaFinal })
                ]));
            }
            wrap.append(el('table', { class: 'diary-table' }, [el('thead', {}, [headRow]), tbody]));
            content.append(wrap);
        }

        $('diario-turma').addEventListener('change', ev => {
            f3.diario.turmaId = ev.target.value;
            const discs = domain.disciplinasDaTurma(diarioBase(), f3.diario.turmaId, queueModel);
            if (f3.diario.disciplina && !discs.includes(f3.diario.disciplina)) f3.diario.disciplina = discs[0] || '';
            renderizarDiario();
        });
        $('diario-disciplina').addEventListener('change', ev => { f3.diario.disciplina = ev.target.value; renderizarDiario(); });
        $('diario-periodo').addEventListener('change', ev => { f3.diario.periodo = ev.target.value; renderizarDiario(); });
        $('diario-search').addEventListener('input', ev => { f3.diario.busca = ev.target.value; renderizarDiario(); });
        document.querySelectorAll('[data-diario-tab]').forEach(btn => {
            btn.addEventListener('click', () => {
                f3.diario.subaba = btn.dataset.diarioTab;
                renderizarDiario();
            });
        });

        return {
            carregarChaveIa,
            sincronizarPadroesComDiario,
            renderizarAvaliacoesOuNotas: () => selecionarSubaba(f3.subabaAval),
            renderizarDiario,
            abrirAvaliacoesParaEdicao,
            abrirNotasParaEdicao,
            atualizarUiChaveIa
        };
    }

    global.PraxisTabletFase3 = Object.freeze({ iniciarFase3, CHAVE_IA_LOCAL });
})(globalThis);
