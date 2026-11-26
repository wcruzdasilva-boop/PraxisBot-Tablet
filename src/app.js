// Controlador principal do PraxisBot Tablet (PWA 11" offline-first).
(function () {
    'use strict';

    const cfg = globalThis.PraxisTabletConfig;
    const cryptoWeb = globalThis.PraxisTabletCrypto;
    const db = globalThis.PraxisTabletDB;
    const supabaseLib = globalThis.PraxisTabletSupabase;
    const syncLib = globalThis.PraxisTabletSync;
    const qrScanner = globalThis.PraxisTabletQrScanner;
    const gemini = globalThis.PraxisTabletGemini;
    const domain = globalThis.PraxisTabletDomain;
    const fase3Lib = globalThis.PraxisTabletFase3;
    const queueModel = globalThis.SiaepQueueModel;
    const calModel = globalThis.SiaepScheduleCalendarModel;
    const prevModel = globalThis.SiaepPrevisaoDatasModel;
    const catModel = globalThis.SiaepCatalogModel;
    const reportModel = globalThis.SiaepAcademicReportModel;

    const $ = id => document.getElementById(id);
    const el = (tag, attrs = {}, filhos = []) => {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (k === 'class') node.className = v;
            else if (k === 'text') node.textContent = v;
            else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
            else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : String(v));
        }
        for (const filho of Array.isArray(filhos) ? filhos : [filhos]) {
            if (filho === null || filho === undefined || filho === false) continue;
            node.append(typeof filho === 'string' ? document.createTextNode(filho) : filho);
        }
        return node;
    };

    const supabase = supabaseLib.criarClienteSupabase({
        url: cfg.URL_CONTAS,
        chaveAnon: cfg.CHAVE_ANON_CONTAS,
        lerSessao: () => db.lerKv('conta_sessao', null),
        gravarSessao: s => (s ? db.gravarKv('conta_sessao', s) : db.removerKv('conta_sessao'))
    });

    const sync = syncLib.criarMotorSync({
        db,
        supabase,
        cryptoWeb,
        queueModel,
        aoMudar: () => {
            recarregarDoBanco().then(renderizarTudo).catch(() => {});
        }
    });

    const agoraHoje = domain.hojeIso();
    const [anoInicial, mesInicial] = agoraHoje.split('-').map(Number);

    const state = {
        aba: 'hoje',
        reparando: false,
        scannerAtivo: null,
        contextos: {},
        filas: [],
        pendentesCount: 0,
        calendario: { ano: anoInicial, mes: mesInicial, diaSelecionado: agoraHoje },
        chamada: {
            filaId: '',
            turmaId: '',
            disciplina: '',
            dataInicial: agoraHoje,
            nome: '',
            substituir: false,
            colAtiva: 0,
            totalColunas: 1,
            linhas: []
        },
        aulas: {
            filaId: '',
            disciplina: '',
            periodo: '1º PERIODO',
            dataInicial: agoraHoje,
            nome: '',
            turmasSelecionadas: [],
            feriados: '',
            substituir: false,
            itens: [{ tema: '', descricao: '' }]
        },
        filtroFilas: { tipo: '', arquivadas: false },
        modalCodigoAlvo: null
    };

    let toastTimer = null;
    function mostrarToast(texto, erro = false) {
        const box = $('toast');
        box.textContent = texto;
        box.classList.toggle('is-error', Boolean(erro));
        box.classList.remove('is-hidden');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => box.classList.add('is-hidden'), 3600);
    }

    function diarioBase() { return state.contextos.diario_base?.dados || {}; }
    function blocoAulas() { return state.contextos.aulas?.dados || {}; }
    function blocoAvalNotas() { return state.contextos.avaliacoes_notas?.dados || {}; }
    function statusExecucao() { return state.contextos.status_execucao?.dados || null; }

    let fase3 = null;

    async function recarregarDoBanco() {
        const [contextos, filas, pendentesCount] = await Promise.all([
            db.listarContextos(),
            db.listarFilasRegistros(),
            sync.contarPendentes()
        ]);
        state.contextos = contextos || {};
        state.filas = (filas || []).filter(r => !r.excluidoEm && r.fila)
            .sort((a, b) => Date.parse(b.atualizadoEm || '') - Date.parse(a.atualizadoEm || ''));
        state.pendentesCount = pendentesCount;
        // Preenche padrões iniciais quando o Diário chega pela primeira vez.
        const turmas = domain.obterTurmas(diarioBase());
        if (!state.chamada.turmaId && turmas.length) {
            selecionarTurmaChamada(turmas[0].id);
        }
        if (!state.aulas.feriados && diarioBase().calendario?.length) {
            state.aulas.feriados = domain.feriadosTextoDoCalendario(diarioBase().calendario);
        }
        if (!state.aulas.disciplina && turmas.length) {
            const discs = domain.disciplinasDaTurma(diarioBase(), turmas[0].id, queueModel);
            state.aulas.disciplina = discs[0] || queueModel.DISCIPLINAS[0];
        }
        fase3?.sincronizarPadroesComDiario();
    }

    // ---- Roteamento de telas (Auth -> Pareamento -> App) ----
    function atualizarTelas() {
        const logado = supabase.estado().logado;
        const pareado = sync.estado().pareado;
        $('screen-auth').classList.toggle('is-hidden', logado);
        $('screen-pair').classList.toggle('is-hidden', !logado || (pareado && !state.reparando));
        $('app-shell').classList.toggle('is-hidden', !logado || !pareado || state.reparando);
        if (logado) {
            $('pair-account-label').textContent = `Conta: ${supabase.estado().email}`;
            $('pair-cancel-back').classList.toggle('is-hidden', !state.reparando);
        }
        if (logado && pareado && !state.reparando) renderizarTudo();
    }

    function trocarAba(aba) {
        state.aba = aba;
        document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.toggle('is-active', btn.dataset.tab === aba));
        document.querySelectorAll('.view').forEach(sec => sec.classList.toggle('is-active', sec.id === `view-${aba}`));
        const titulos = {
            hoje: 'Hoje e Horário',
            chamada: 'Chamada (Frequência)',
            aulas: 'Registro de Aulas',
            avaliacoes: 'Avaliações e Notas',
            diario: 'Diário Local (Offline)',
            filas: 'Filas e Status do PC',
            ajustes: 'Ajustes e Sincronização'
        };
        $('topbar-title').textContent = titulos[aba] || 'PraxisBot Tablet';
        renderizarTudo();
    }

    // ---- 1. Autenticação Supabase ----
    function mostrarErroAuth(msg, sucesso = false) {
        const box = $('auth-feedback');
        box.textContent = msg || '';
        box.className = `alert ${sucesso ? 'alert-success' : ''} ${msg ? '' : 'is-hidden'}`;
    }

    $('auth-tab-senha').addEventListener('click', () => {
        $('auth-tab-senha').classList.add('is-active');
        $('auth-tab-codigo').classList.remove('is-active');
        $('auth-form-senha').classList.remove('is-hidden');
        $('auth-form-codigo').classList.add('is-hidden');
        mostrarErroAuth('');
    });
    $('auth-tab-codigo').addEventListener('click', () => {
        $('auth-tab-codigo').classList.add('is-active');
        $('auth-tab-senha').classList.remove('is-active');
        $('auth-form-codigo').classList.remove('is-hidden');
        $('auth-form-senha').classList.add('is-hidden');
        mostrarErroAuth('');
    });

    $('auth-form-senha').addEventListener('submit', async ev => {
        ev.preventDefault();
        mostrarErroAuth('');
        const btn = $('auth-submit-senha');
        btn.disabled = true;
        btn.textContent = 'Entrando…';
        const res = await supabase.entrarComSenha($('auth-email').value, $('auth-password').value);
        btn.disabled = false;
        btn.textContent = 'Entrar';
        if (!res.sucesso) return mostrarErroAuth(res.erro);
        await sync.carregarMetadados();
        atualizarTelas();
        if (sync.estado().pareado) sync.sincronizarAgora().catch(() => {});
    });

    $('auth-send-otp').addEventListener('click', async () => {
        mostrarErroAuth('');
        const btn = $('auth-send-otp');
        btn.disabled = true;
        btn.textContent = 'Enviando…';
        const res = await supabase.enviarCodigo($('auth-otp-email').value);
        btn.disabled = false;
        btn.textContent = 'Enviar código novamente';
        if (!res.sucesso) return mostrarErroAuth(res.erro);
        $('auth-otp-step2').classList.remove('is-hidden');
        mostrarErroAuth('Código enviado! Confira seu e-mail (e a caixa de spam).', true);
    });

    $('auth-verify-otp').addEventListener('click', async () => {
        mostrarErroAuth('');
        const btn = $('auth-verify-otp');
        btn.disabled = true;
        const res = await supabase.confirmarCodigo($('auth-otp-email').value, $('auth-otp-code').value);
        btn.disabled = false;
        if (!res.sucesso) return mostrarErroAuth(res.erro);
        $('auth-otp-step3').classList.remove('is-hidden');
        mostrarErroAuth('Código confirmado! Agora defina sua senha.', true);
    });

    $('auth-save-password').addEventListener('click', async () => {
        mostrarErroAuth('');
        const btn = $('auth-save-password');
        btn.disabled = true;
        const res = await supabase.definirSenha($('auth-new-password').value);
        btn.disabled = false;
        if (!res.sucesso) return mostrarErroAuth(res.erro);
        await sync.carregarMetadados();
        atualizarTelas();
    });

    // ---- 2. Pareamento QR Code / Código ----
    function mostrarErroPareamento(msg) {
        const box = $('pair-feedback');
        box.textContent = msg || '';
        box.classList.toggle('is-hidden', !msg);
    }

    function pararCamera() {
        if (state.scannerAtivo) {
            state.scannerAtivo.parar();
            state.scannerAtivo = null;
        }
        $('pair-scanner-box').classList.add('is-hidden');
    }

    async function concluirPareamento(codigoOuQr) {
        mostrarErroPareamento('');
        try {
            const res = await sync.parearComCodigo(codigoOuQr);
            pararCamera();
            state.reparando = false;
            $('pair-code-input').value = '';
            mostrarToast(`Pareado! Chave ${res.impressaoDigital}. Sincronizando…`);
            atualizarTelas();
            const r = await sync.sincronizarAgora();
            if (!r.sucesso && r.erro) mostrarToast(r.erro, true);
            await recarregarDoBanco();
            renderizarTudo();
        } catch (erro) {
            mostrarErroPareamento(erro.message || 'Código inválido.');
        }
    }

    $('pair-start-camera').addEventListener('click', async () => {
        mostrarErroPareamento('');
        pararCamera();
        try {
            $('pair-scanner-box').classList.remove('is-hidden');
            state.scannerAtivo = await qrScanner.iniciarLeitor({
                videoEl: $('pair-video'),
                aoLer: valor => concluirPareamento(valor)
            });
        } catch (erro) {
            pararCamera();
            mostrarErroPareamento(erro.message || 'Não foi possível abrir a câmera. Digite o código abaixo.');
        }
    });
    $('pair-stop-camera').addEventListener('click', pararCamera);
    $('pair-code-input').addEventListener('input', ev => {
        ev.target.value = cryptoWeb.formatarCodigoPareamento(ev.target.value);
    });
    $('pair-form-code').addEventListener('submit', ev => {
        ev.preventDefault();
        concluirPareamento($('pair-code-input').value);
    });
    $('pair-cancel-back').addEventListener('click', () => {
        pararCamera();
        state.reparando = false;
        atualizarTelas();
    });
    $('pair-logout').addEventListener('click', async () => {
        pararCamera();
        await supabase.sair();
        atualizarTelas();
    });

    // ---- 3. Renderização da barra de status / sincronização ----
    function renderizarStatusSync() {
        const st = sync.estado();
        const escola = diarioBase()?.catalogo?.escola?.nome || diarioBase()?.escolas?.[0]?.nome || '';
        $('topbar-school').textContent = escola ? escola.toUpperCase() : 'PRAXISBOT TABLET';

        const dot = $('sidebar-sync-dot');
        dot.className = `dot ${st.sincronizando ? 'is-syncing' : (st.ultimoErro ? 'is-error' : (st.online ? (state.pendentesCount ? 'is-warning' : 'is-online') : ''))}`;

        let titulo = st.online ? 'Conectado' : 'Offline';
        if (st.sincronizando) titulo = 'Sincronizando…';
        else if (st.sessaoExpirada) titulo = 'Reconectar conta';
        else if (state.pendentesCount) titulo = `${state.pendentesCount} pendência(s) offline`;

        const sub = st.ultimaSincronizacaoEm ? `Sync ${domain.formatarDataHoraBr(st.ultimaSincronizacaoEm)}` : 'Ainda não sincronizado';
        $('sidebar-sync-title').textContent = titulo;
        $('sidebar-sync-sub').textContent = sub;
        $('sidebar-sync-btn').disabled = st.sincronizando || !st.online;
        $('topbar-sync-btn').disabled = st.sincronizando || !st.online;

        const badge = $('topbar-status-badge');
        badge.textContent = titulo;
        badge.className = `badge ${st.sincronizando ? 'badge-info' : (st.ultimoErro ? 'badge-danger' : (state.pendentesCount ? 'badge-warning' : (st.online ? 'badge-safe' : 'badge-neutral')))}`;

        const navBadge = $('nav-pending-badge');
        navBadge.textContent = String(state.pendentesCount);
        navBadge.classList.toggle('is-hidden', state.pendentesCount === 0);

        const erroBox = $('global-sync-error');
        $('global-sync-error-text').textContent = st.ultimoErro || '';
        $('global-sync-reconnect-btn').classList.toggle('is-hidden', !st.sessaoExpirada);
        erroBox.classList.toggle('is-hidden', !st.ultimoErro);
    }

    function abrirModalReconexao() {
        $('relogin-email').value = supabase.estado().email || '';
        $('relogin-password').value = '';
        const fb = $('relogin-feedback');
        fb.textContent = '';
        fb.classList.add('is-hidden');
        $('relogin-modal').classList.remove('is-hidden');
        setTimeout(() => $('relogin-password').focus(), 40);
    }

    function fecharModalReconexao() {
        $('relogin-modal').classList.add('is-hidden');
        $('relogin-password').value = '';
    }

    $('global-sync-reconnect-btn').addEventListener('click', abrirModalReconexao);
    $('relogin-close').addEventListener('click', fecharModalReconexao);
    $('relogin-cancel').addEventListener('click', fecharModalReconexao);
    $('relogin-modal').addEventListener('click', ev => {
        if (ev.target === $('relogin-modal')) fecharModalReconexao();
    });
    $('relogin-form').addEventListener('submit', async ev => {
        ev.preventDefault();
        const fb = $('relogin-feedback');
        fb.textContent = '';
        fb.classList.add('is-hidden');
        const btn = $('relogin-submit');
        btn.disabled = true;
        btn.textContent = 'Entrando…';
        const res = await supabase.entrarComSenha($('relogin-email').value, $('relogin-password').value);
        btn.disabled = false;
        btn.textContent = 'Entrar e sincronizar';
        if (!res.sucesso) {
            fb.textContent = res.erro || 'Não foi possível entrar.';
            fb.classList.remove('is-hidden');
            return;
        }
        fecharModalReconexao();
        mostrarToast('Conta reconectada! Sincronizando…');
        const r = await sync.sincronizarAgora();
        await recarregarDoBanco();
        renderizarTudo();
        if (r.sucesso) mostrarToast('Sincronização concluída!');
        else if (r.erro) mostrarToast(r.erro, true);
    });

    async function acionarSyncManual() {
        if (sync.estado().sessaoExpirada) {
            abrirModalReconexao();
            return;
        }
        const r = await sync.sincronizarAgora();
        if (r.sucesso) mostrarToast('Sincronização concluída.');
        else if (r.sessaoExpirada) {
            mostrarToast('Sessão expirada. Digite sua senha para continuar sincronizando.', true);
            abrirModalReconexao();
        } else if (r.offline) mostrarToast('Sem internet. Alterações seguem salvas no tablet.', true);
        else if (r.erro) mostrarToast(r.erro, true);
    }
    $('sidebar-sync-btn').addEventListener('click', acionarSyncManual);
    $('topbar-sync-btn').addEventListener('click', acionarSyncManual);

    // ---- 4. Aba HOJE & HORÁRIO ----
    function renderizarHoje() {
        const dbBase = diarioBase();
        const { ano, mes, diaSelecionado } = state.calendario;
        $('cal-month-label').textContent = `${domain.MESES_NOMES[mes - 1]} de ${ano}`;

        const diasAulaSet = calModel.diasComAula(dbBase.horarios || []);
        const feriadosSet = domain.datasFeriadoSet(dbBase.calendario || []);
        const semanas = calModel.montarGradeMes(ano, mes, diasAulaSet, feriadosSet);
        const hoje = domain.hojeIso();

        const grid = $('cal-grid');
        grid.replaceChildren();
        for (const semana of semanas) {
            for (const cel of semana) {
                const classes = [
                    'cal-day',
                    !cel.noMesAtual ? 'is-outro' : '',
                    cel.temAula ? 'tem-aula' : '',
                    cel.feriado ? 'is-feriado' : '',
                    cel.data === hoje ? 'is-hoje' : '',
                    cel.data === diaSelecionado ? 'is-selecionado' : ''
                ].filter(Boolean).join(' ');
                grid.append(el('button', {
                    type: 'button',
                    class: classes,
                    text: String(cel.dia),
                    onclick: () => {
                        state.calendario.diaSelecionado = cel.data;
                        const [a, m] = cel.data.split('-').map(Number);
                        state.calendario.ano = a;
                        state.calendario.mes = m;
                        renderizarHoje();
                    }
                }));
            }
        }

        const dataObj = domain.dataDeIso(diaSelecionado);
        const diaNome = dataObj ? domain.DIAS_SEMANA_NOMES[dataObj.getDay()] : '';
        $('hoje-day-title').textContent = `${diaNome}, ${domain.formatarDataBr(diaSelecionado)}`;

        const cartoes = domain.turmasDoDia({
            dataIso: diaSelecionado,
            diarioBase: dbBase,
            blocoAulas: blocoAulas(),
            queueModel,
            catalogModel: catModel
        });
        const container = $('hoje-cards');
        const empty = $('hoje-empty');
        container.replaceChildren();

        const totalTurmas = domain.obterTurmas(dbBase).length;
        if (!totalTurmas) {
            empty.textContent = 'Nenhum Diário sincronizado ainda. No PraxisBot do computador, sincronize o Diário e clique em “Sincronizar agora” em Configurações → Tablet companheiro.';
            empty.classList.remove('is-hidden');
            return;
        }
        if (!cartoes.length) {
            empty.textContent = feriadosSet.has(diaSelecionado)
                ? 'Esta data está marcada como feriado no calendário.'
                : 'Nenhuma aula prevista no horário para este dia. Você pode escolher outro dia no calendário ou usar os botões acima.';
            empty.classList.remove('is-hidden');
            return;
        }
        empty.classList.add('is-hidden');

        for (const item of cartoes) {
            const horariosTexto = item.horarios.map(h => (h.fim ? `${h.inicio}–${h.fim}` : h.inicio)).join(' · ');
            const badge = item.ehFeriado
                ? el('span', { class: 'badge badge-warning', text: 'Feriado' })
                : item.frequenciaCompletaNoDia
                    ? el('span', { class: 'badge badge-success', text: 'Frequência lançada' })
                    : item.aulasRegistradasNoDia > 0
                        ? el('span', { class: 'badge badge-info', text: `${item.aulasRegistradasNoDia} aula(s) no Diário` })
                        : el('span', { class: 'badge badge-neutral', text: `${item.horarios.length} horário(s)` });

            container.append(el('div', { class: 'class-card' }, [
                el('div', { class: 'class-card-top' }, [
                    el('div', {}, [
                        el('h3', { text: item.turmaCompacta }),
                        el('div', { class: 'class-card-disc', text: item.disciplina })
                    ]),
                    badge
                ]),
                el('div', { class: 'class-card-meta' }, [
                    el('span', { text: `🕒 ${horariosTexto || 'Horário no SIAEP'}` }),
                    el('span', { text: `👥 ${item.totalAlunos} estudante(s)` })
                ]),
                el('div', { class: 'class-card-actions' }, [
                    el('button', {
                        type: 'button',
                        class: 'btn btn-primary btn-sm',
                        text: 'Fazer chamada',
                        onclick: () => abrirChamadaPara({ turmaId: item.turmaId, disciplina: item.disciplina, dataIso: diaSelecionado })
                    }),
                    el('button', {
                        type: 'button',
                        class: 'btn btn-secondary btn-sm',
                        text: 'Registrar aula',
                        onclick: () => abrirAulaPara({ turmaRotulo: item.turmaRotulo, disciplina: item.disciplina, dataIso: diaSelecionado })
                    })
                ])
            ]));
        }
    }

    $('cal-prev').addEventListener('click', () => {
        const prox = calModel.mesAdjacente(state.calendario.ano, state.calendario.mes, -1);
        state.calendario.ano = prox.ano;
        state.calendario.mes = prox.mes;
        renderizarHoje();
    });
    $('cal-next').addEventListener('click', () => {
        const prox = calModel.mesAdjacente(state.calendario.ano, state.calendario.mes, 1);
        state.calendario.ano = prox.ano;
        state.calendario.mes = prox.mes;
        renderizarHoje();
    });
    $('cal-today').addEventListener('click', () => {
        const h = domain.hojeIso();
        const [a, m] = h.split('-').map(Number);
        state.calendario = { ano: a, mes: m, diaSelecionado: h };
        renderizarHoje();
    });
    $('hoje-quick-chamada').addEventListener('click', () => trocarAba('chamada'));
    $('hoje-quick-aula').addEventListener('click', () => trocarAba('aulas'));

    // ---- 5. Aba CHAMADA (FREQUÊNCIA) ----
    function sugerirNomeChamada(turma, dataIso) {
        const cod = turma?.numero || turma?.rotulo || 'Turma';
        const curta = domain.formatarCurtaBr(dataIso);
        return `FREQ ${cod}${curta ? ` - ${curta}` : ''}`.slice(0, 100);
    }

    function selecionarTurmaChamada(turmaId, disciplinaPreferida = '', dataPreferida = '') {
        const dbBase = diarioBase();
        const turmas = domain.obterTurmas(dbBase);
        const turma = turmas.find(t => t.id === turmaId) || turmas[0] || null;
        state.chamada.turmaId = turma?.id || '';
        const discs = turma ? domain.disciplinasDaTurma(dbBase, turma.id, queueModel) : [...queueModel.DISCIPLINAS];
        state.chamada.disciplina = disciplinaPreferida && discs.includes(disciplinaPreferida) ? disciplinaPreferida : (disciplinaPreferida || discs[0] || '');
        if (dataPreferida) state.chamada.dataInicial = dataPreferida;
        const alunos = turma ? domain.alunosDaTurma(dbBase, turma.id, queueModel) : [];
        const lido = domain.lerMatrizFrequencia('', alunos, 1);
        state.chamada.totalColunas = lido.totalColunas;
        state.chamada.colAtiva = 0;
        state.chamada.linhas = lido.linhas;
        if (!state.chamada.filaId) state.chamada.nome = sugerirNomeChamada(turma, state.chamada.dataInicial);
    }

    function abrirChamadaPara({ turmaId, disciplina, dataIso }) {
        state.chamada.filaId = '';
        state.chamada.substituir = false;
        selecionarTurmaChamada(turmaId, disciplina, dataIso);
        trocarAba('chamada');
    }

    function abrirFilaChamadaParaEdicao(registro) {
        const fila = registro.fila;
        const dbBase = diarioBase();
        const turmas = domain.obterTurmas(dbBase);
        const alvoRotulo = fila.turmas?.[0] || '';
        const turma = turmas.find(t => t.rotulo === alvoRotulo)
            || turmas.find(t => domain.assinatura(t.rotulo) === domain.assinatura(alvoRotulo))
            || turmas[0] || null;
        const alunos = turma ? domain.alunosDaTurma(dbBase, turma.id, queueModel) : [];
        const lido = domain.lerMatrizFrequencia(fila.matrizTexto, alunos, 1);
        state.chamada = {
            filaId: fila.id,
            turmaId: turma?.id || '',
            disciplina: fila.configuracao?.disciplina || '',
            dataInicial: fila.configuracao?.dataInicial || domain.hojeIso(),
            nome: fila.nome || '',
            substituir: Boolean(fila.configuracao?.substituirRegistrados),
            colAtiva: 0,
            totalColunas: lido.totalColunas,
            linhas: lido.linhas
        };
        trocarAba('chamada');
    }

    function montarObjetoFilaChamada() {
        const dbBase = diarioBase();
        const turma = domain.obterTurmas(dbBase).find(t => t.id === state.chamada.turmaId);
        const existente = state.filas.find(r => r.filaId === state.chamada.filaId)?.fila;
        const base = existente ? JSON.parse(JSON.stringify(existente)) : queueModel.criar('FREQUENCIA');
        base.nome = state.chamada.nome.trim() || sugerirNomeChamada(turma, state.chamada.dataInicial);
        base.tipo = 'FREQUENCIA';
        base.turmas = turma ? [turma.rotulo] : (existente?.turmas || []);
        base.configuracao.disciplina = state.chamada.disciplina;
        base.configuracao.dataInicial = state.chamada.dataInicial;
        base.configuracao.substituirRegistrados = Boolean(state.chamada.substituir);
        base.matrizTexto = domain.montarMatrizFrequencia(state.chamada.linhas);
        return base;
    }

    function renderizarChamada() {
        const dbBase = diarioBase();
        const turmas = domain.obterTurmas(dbBase);
        $('chamada-heading').textContent = state.chamada.filaId ? 'Editando chamada (Frequência)' : 'Nova chamada (Frequência)';

        const selTurma = $('chamada-turma');
        selTurma.replaceChildren();
        if (!turmas.length) selTurma.append(el('option', { value: '', text: 'Sincronize o Diário no PC primeiro' }));
        for (const t of turmas) {
            selTurma.append(el('option', { value: t.id, text: catModel.criarRotuloCompacto(t) }));
        }
        selTurma.value = state.chamada.turmaId;

        const discs = state.chamada.turmaId ? domain.disciplinasDaTurma(dbBase, state.chamada.turmaId, queueModel) : [...queueModel.DISCIPLINAS];
        if (state.chamada.disciplina && !discs.includes(state.chamada.disciplina)) discs.unshift(state.chamada.disciplina);
        const selDisc = $('chamada-disciplina');
        selDisc.replaceChildren();
        for (const d of discs) selDisc.append(el('option', { value: d, text: d }));
        selDisc.value = state.chamada.disciplina;

        $('chamada-data').value = state.chamada.dataInicial;
        if (document.activeElement !== $('chamada-nome')) $('chamada-nome').value = state.chamada.nome;
        $('chamada-substituir').checked = Boolean(state.chamada.substituir);

        // Previsão de datas das colunas usando o mesmo modelo do desktop.
        const aulasTurma = domain.aulasDaTurmaDisciplina(blocoAulas(), state.chamada.turmaId, state.chamada.disciplina);
        const previsao = prevModel.previsaoFrequenciaTurma({
            dataInicial: state.chamada.dataInicial,
            aulas: aulasTurma,
            colunas: state.chamada.totalColunas,
            hojeIso: domain.hojeIso()
        });

        const tabs = $('chamada-col-tabs');
        tabs.replaceChildren();
        for (let i = 0; i < state.chamada.totalColunas; i++) {
            const colPrev = previsao.colunas[i];
            const rotuloData = colPrev?.data ? ` (${prevModel.formatarCurta(colPrev.data)})` : '';
            const jaLancada = colPrev?.registrada === true && !state.chamada.substituir;
            tabs.append(el('button', {
                type: 'button',
                class: `col-tab ${i === state.chamada.colAtiva ? 'is-active' : ''} ${jaLancada ? 'is-registered' : ''}`,
                text: `Aula ${i + 1}${rotuloData}${jaLancada ? ' · já lançada' : ''}`,
                onclick: () => { state.chamada.colAtiva = i; renderizarChamada(); }
            }));
        }
        $('chamada-del-col').classList.toggle('is-hidden', state.chamada.totalColunas <= 1);

        const prevBar = $('chamada-previsao-bar');
        const colAtual = previsao.colunas[state.chamada.colAtiva];
        if (colAtual?.data) {
            const jaLancada = colAtual.registrada === true;
            prevBar.textContent = jaLancada && !state.chamada.substituir
                ? `Data prevista: ${prevModel.formatarData(colAtual.data)} — já consta frequência lançada no Diário local (será pulada pelo motor, a menos que marque "Substituir").`
                : `Data prevista no SIAEP: ${prevModel.formatarData(colAtual.data)}${colAtual.total > 1 ? ` (${colAtual.total} horários agrupados na mesma data)` : ''}.`;
            prevBar.className = `info-strip ${jaLancada && !state.chamada.substituir ? 'is-warn' : ''}`;
            prevBar.classList.remove('is-hidden');
        } else {
            prevBar.classList.add('is-hidden');
        }

        // Contadores ao vivo.
        const contagem = domain.resumirContagemFrequencia(state.chamada.linhas, state.chamada.colAtiva);
        $('chamada-counters').replaceChildren(
            el('span', { class: 'badge badge-success', text: `Presentes: ${contagem.presentes}` }),
            el('span', { class: 'badge badge-danger', text: `Faltas: ${contagem.faltas}` }),
            el('span', { class: 'badge badge-warning', text: `Outras: ${contagem.justificadas}` }),
            el('span', { class: 'badge badge-neutral', text: `Total: ${contagem.total}` })
        );

        // Grade tátil de estudantes.
        const lista = $('chamada-list');
        const empty = $('chamada-empty');
        lista.replaceChildren();
        if (!state.chamada.linhas.length) {
            empty.textContent = 'Nenhum estudante carregado para esta turma. Sincronize o diretório de alunos no PraxisBot do computador.';
            empty.classList.remove('is-hidden');
        } else {
            empty.classList.add('is-hidden');
            state.chamada.linhas.forEach((aluno, indice) => {
                const cod = aluno.colunas[state.chamada.colAtiva] || '';
                const pillClass = cod === 'P' ? 'st-P' : (cod === 'F' ? 'st-F' : (cod ? 'st-OTHER' : 'st-EMPTY'));
                const ciclar = () => {
                    const ordem = ['P', 'F', 'FJ'];
                    const prox = ordem[(ordem.indexOf(cod) + 1) % ordem.length];
                    aluno.colunas[state.chamada.colAtiva] = prox;
                    renderizarChamada();
                };
                lista.append(el('div', { class: `student-row ${cod ? `st-${cod}` : ''}` }, [
                    el('div', { class: 'student-main', onclick: ciclar }, [
                        el('span', { class: 'student-num', text: String(indice + 1) }),
                        el('div', { class: 'student-info' }, [
                            el('span', { class: 'student-name', text: aluno.nome }),
                            el('span', { class: 'student-mat', text: `Mat. ${aluno.matricula}` })
                        ])
                    ]),
                    el('button', { type: 'button', class: `status-pill ${pillClass}`, text: cod || '—', onclick: ciclar }),
                    el('button', {
                        type: 'button',
                        class: 'more-code-btn',
                        text: '•••',
                        'aria-label': `Escolher código para ${aluno.nome}`,
                        onclick: () => abrirModalCodigo(indice)
                    })
                ]));
            });
        }

        const erros = queueModel.validar(montarObjetoFilaChamada());
        const val = $('chamada-validation');
        val.textContent = erros.length ? erros[0].mensagem : 'Chamada pronta para sincronizar ou executar no computador.';
        val.className = `validation-hint ${erros.length ? 'is-error' : 'is-ok'}`;
        $('chamada-save-run').disabled = erros.length > 0;
    }

    function abrirModalCodigo(indiceAluno) {
        const aluno = state.chamada.linhas[indiceAluno];
        if (!aluno) return;
        state.modalCodigoAlvo = indiceAluno;
        $('code-modal-title').textContent = aluno.nome;
        const box = $('code-modal-options');
        box.replaceChildren();
        for (const item of domain.CODIGOS_FREQUENCIA) {
            box.append(el('button', {
                type: 'button',
                class: 'code-option-btn',
                onclick: () => {
                    aluno.colunas[state.chamada.colAtiva] = item.codigo;
                    $('code-modal').classList.add('is-hidden');
                    renderizarChamada();
                }
            }, [
                el('strong', { text: item.codigo }),
                el('span', { text: item.rotulo })
            ]));
        }
        box.append(el('button', {
            type: 'button',
            class: 'code-option-btn',
            onclick: () => {
                aluno.colunas[state.chamada.colAtiva] = '';
                $('code-modal').classList.add('is-hidden');
                renderizarChamada();
            }
        }, [
            el('strong', { text: '—' }),
            el('span', { text: 'Deixar em branco (não alterar)' })
        ]));
        $('code-modal').classList.remove('is-hidden');
    }

    $('code-modal-close').addEventListener('click', () => $('code-modal').classList.add('is-hidden'));
    $('code-modal').addEventListener('click', ev => { if (ev.target === $('code-modal')) $('code-modal').classList.add('is-hidden'); });

    $('chamada-turma').addEventListener('change', ev => { selecionarTurmaChamada(ev.target.value); renderizarChamada(); });
    $('chamada-disciplina').addEventListener('change', ev => { state.chamada.disciplina = ev.target.value; renderizarChamada(); });
    $('chamada-data').addEventListener('change', ev => {
        state.chamada.dataInicial = ev.target.value;
        if (!state.chamada.filaId) {
            const turma = domain.obterTurmas(diarioBase()).find(t => t.id === state.chamada.turmaId);
            state.chamada.nome = sugerirNomeChamada(turma, state.chamada.dataInicial);
        }
        renderizarChamada();
    });
    $('chamada-nome').addEventListener('input', ev => { state.chamada.nome = ev.target.value; });
    $('chamada-substituir').addEventListener('change', ev => { state.chamada.substituir = ev.target.checked; renderizarChamada(); });
    $('chamada-add-col').addEventListener('click', () => {
        state.chamada.totalColunas++;
        state.chamada.linhas.forEach(a => a.colunas.push('P'));
        state.chamada.colAtiva = state.chamada.totalColunas - 1;
        renderizarChamada();
    });
    $('chamada-del-col').addEventListener('click', () => {
        if (state.chamada.totalColunas <= 1) return;
        const idx = state.chamada.colAtiva;
        state.chamada.linhas.forEach(a => a.colunas.splice(idx, 1));
        state.chamada.totalColunas--;
        state.chamada.colAtiva = Math.max(0, idx - 1);
        renderizarChamada();
    });
    $('chamada-all-p').addEventListener('click', () => {
        state.chamada.linhas.forEach(a => { a.colunas[state.chamada.colAtiva] = 'P'; });
        renderizarChamada();
    });
    $('chamada-all-f').addEventListener('click', () => {
        state.chamada.linhas.forEach(a => { a.colunas[state.chamada.colAtiva] = 'F'; });
        renderizarChamada();
    });
    $('chamada-reset').addEventListener('click', () => {
        state.chamada.filaId = '';
        state.chamada.substituir = false;
        selecionarTurmaChamada(state.chamada.turmaId, state.chamada.disciplina, domain.hojeIso());
        renderizarChamada();
    });

    async function salvarChamada(executarNoPc) {
        const fila = montarObjetoFilaChamada();
        if (executarNoPc && !window.confirm(`Salvar a fila “${fila.nome}” e solicitar execução automática assim que o computador sincronizar?`)) return;
        const res = await sync.salvarFilaLocal(fila, { executarNoPc });
        if (!res.sucesso) return mostrarToast(res.erro || 'Revise os campos da chamada.', true);
        state.chamada.filaId = res.fila.id;
        await recarregarDoBanco();
        renderizarTudo();
        mostrarToast(executarNoPc ? 'Chamada salva! O computador executará assim que sincronizar.' : 'Chamada salva e marcada para sincronizar.');
    }
    $('chamada-save').addEventListener('click', () => salvarChamada(false));
    $('chamada-save-run').addEventListener('click', () => salvarChamada(true));

    // ---- 6. Aba AULAS ----
    function sugerirNomeAulas(turmasRotulos, dataIso) {
        const curta = domain.formatarCurtaBr(dataIso);
        const codigos = turmasRotulos.map(r => (String(r).match(/\b\d{2}[A-Z0-9-]{2,}\b/i) || [r])[0]).slice(0, 2).join('/');
        return `Aulas ${codigos || 'Turma'}${curta ? ` - ${curta}` : ''}`.slice(0, 100);
    }

    function abrirAulaPara({ turmaRotulo, disciplina, dataIso }) {
        state.aulas = {
            filaId: '',
            disciplina: disciplina || state.aulas.disciplina || queueModel.DISCIPLINAS[0],
            periodo: state.aulas.periodo || '1º PERIODO',
            dataInicial: dataIso || domain.hojeIso(),
            nome: sugerirNomeAulas(turmaRotulo ? [turmaRotulo] : [], dataIso),
            turmasSelecionadas: turmaRotulo ? [turmaRotulo] : [],
            feriados: domain.feriadosTextoDoCalendario(diarioBase().calendario || []),
            substituir: false,
            itens: [{ tema: '', descricao: '' }]
        };
        trocarAba('aulas');
    }

    function abrirFilaAulasParaEdicao(registro) {
        const fila = registro.fila;
        state.aulas = {
            filaId: fila.id,
            disciplina: fila.configuracao?.disciplina || '',
            periodo: fila.configuracao?.periodo || '1º PERIODO',
            dataInicial: fila.configuracao?.dataInicial || domain.hojeIso(),
            nome: fila.nome || '',
            turmasSelecionadas: [...(fila.turmas || [])],
            feriados: fila.configuracao?.feriados || '',
            substituir: Boolean(fila.configuracao?.substituirRegistrados),
            itens: domain.lerMatrizAulas(fila.matrizTexto)
        };
        trocarAba('aulas');
    }

    function montarObjetoFilaAulas() {
        const existente = state.filas.find(r => r.filaId === state.aulas.filaId)?.fila;
        const base = existente ? JSON.parse(JSON.stringify(existente)) : queueModel.criar('AULAS');
        base.nome = state.aulas.nome.trim() || sugerirNomeAulas(state.aulas.turmasSelecionadas, state.aulas.dataInicial);
        base.tipo = 'AULAS';
        base.turmas = [...state.aulas.turmasSelecionadas];
        base.configuracao.disciplina = state.aulas.disciplina;
        base.configuracao.periodo = state.aulas.periodo;
        base.configuracao.dataInicial = state.aulas.dataInicial;
        base.configuracao.feriados = state.aulas.feriados;
        base.configuracao.substituirRegistrados = Boolean(state.aulas.substituir);
        base.matrizTexto = domain.montarMatrizAulas(state.aulas.itens);
        return base;
    }

    function renderizarAulas() {
        const dbBase = diarioBase();
        const turmas = domain.obterTurmas(dbBase);
        $('aulas-heading').textContent = state.aulas.filaId ? 'Editando fila de Aulas' : 'Nova fila de Aulas';

        const todasDiscs = new Set(queueModel.DISCIPLINAS);
        for (const d of dbBase.disciplinas || []) if (d?.nome) todasDiscs.add(d.nome);
        if (state.aulas.disciplina) todasDiscs.add(state.aulas.disciplina);
        const selDisc = $('aulas-disciplina');
        selDisc.replaceChildren();
        for (const d of [...todasDiscs].sort((a, b) => a.localeCompare(b, 'pt-BR'))) {
            selDisc.append(el('option', { value: d, text: d }));
        }
        selDisc.value = state.aulas.disciplina;
        $('aulas-periodo').value = state.aulas.periodo;
        $('aulas-data').value = state.aulas.dataInicial;
        if (document.activeElement !== $('aulas-nome')) $('aulas-nome').value = state.aulas.nome;
        if (document.activeElement !== $('aulas-feriados')) $('aulas-feriados').value = state.aulas.feriados;
        $('aulas-substituir').checked = Boolean(state.aulas.substituir);

        const chips = $('aulas-turmas-chips');
        chips.replaceChildren();
        if (!turmas.length) {
            chips.append(el('span', { class: 'muted-text', text: 'Sincronize o Diário no computador para escolher turmas.' }));
        } else {
            for (const t of turmas) {
                const selecionada = state.aulas.turmasSelecionadas.includes(t.rotulo);
                chips.append(el('button', {
                    type: 'button',
                    class: `turma-chip ${selecionada ? 'is-selected' : ''}`,
                    text: catModel.criarRotuloCompacto(t),
                    onclick: () => {
                        if (selecionada) state.aulas.turmasSelecionadas = state.aulas.turmasSelecionadas.filter(r => r !== t.rotulo);
                        else state.aulas.turmasSelecionadas.push(t.rotulo);
                        renderizarAulas();
                    }
                }));
            }
        }

        // Previsão de datas para a primeira turma selecionada.
        const primeiraTurma = turmas.find(t => state.aulas.turmasSelecionadas.includes(t.rotulo));
        let previsaoItens = [];
        if (primeiraTurma && state.aulas.dataInicial) {
            const horarios = domain.horariosDaTurmaDisciplina(dbBase, primeiraTurma.id, state.aulas.disciplina);
            const gradeSemanal = calModel.gradeSemanalOrdenada(horarios);
            const aulasReg = domain.aulasDaTurmaDisciplina(blocoAulas(), primeiraTurma.id, state.aulas.disciplina);
            const prev = prevModel.previsaoAulasTurma({
                dataInicial: state.aulas.dataInicial,
                feriados: state.aulas.feriados,
                gradeSemanal,
                aulasRegistradas: aulasReg,
                quantidade: state.aulas.itens.length,
                temas: state.aulas.itens.map(i => i.tema)
            });
            previsaoItens = prev.itens || [];
        }

        const temTag = state.aulas.itens.some(i => domain.detectarTagHtmlSuspeita(i.tema) || domain.detectarTagHtmlSuspeita(i.descricao));
        $('aulas-tag-warning').classList.toggle('is-hidden', !temTag);

        const lista = $('aulas-list');
        lista.replaceChildren();
        state.aulas.itens.forEach((item, indice) => {
            const prev = previsaoItens[indice];
            const jaReg = Boolean(prev?.registrada && !state.aulas.substituir);
            const badgeData = prev?.data
                ? el('span', {
                    class: `badge ${jaReg ? 'badge-danger' : 'badge-info'}`,
                    text: `${prevModel.formatarData(prev.data)}${prev.horarioInicio ? ` (${prev.horarioInicio})` : ''}${jaReg ? ' · já registrada' : ''}`
                })
                : el('span', { class: 'badge badge-neutral', text: `Aula ${indice + 1}` });

            const temaInput = el('input', { type: 'text', value: item.tema, placeholder: 'Título / tema da aula' });
            temaInput.addEventListener('input', ev => {
                item.tema = ev.target.value;
                atualizarValidacaoAulas();
            });
            const descInput = el('textarea', { placeholder: 'Descrição metodológica / conteúdo ministrado' });
            descInput.value = item.descricao;
            descInput.addEventListener('input', ev => {
                item.descricao = ev.target.value;
                atualizarValidacaoAulas();
            });

            lista.append(el('div', { class: `aula-card ${jaReg ? 'is-registered' : ''}` }, [
                el('div', { class: 'aula-card-head' }, [
                    el('div', { class: 'row-actions' }, [
                        el('strong', { text: `Aula ${indice + 1}` }),
                        badgeData
                    ]),
                    state.aulas.itens.length > 1
                        ? el('button', {
                            type: 'button',
                            class: 'btn btn-ghost btn-sm',
                            text: 'Remover',
                            onclick: () => { state.aulas.itens.splice(indice, 1); renderizarAulas(); }
                        })
                        : null
                ]),
                el('div', { class: 'aula-card-fields' }, [
                    el('label', { class: 'field' }, [el('span', { text: 'Tema' }), temaInput]),
                    el('label', { class: 'field' }, [el('span', { text: 'Descrição' }), descInput])
                ])
            ]));
        });

        atualizarValidacaoAulas();
    }

    function atualizarValidacaoAulas() {
        const temTag = state.aulas.itens.some(i => domain.detectarTagHtmlSuspeita(i.tema) || domain.detectarTagHtmlSuspeita(i.descricao));
        $('aulas-tag-warning').classList.toggle('is-hidden', !temTag);
        const erros = queueModel.validar(montarObjetoFilaAulas());
        const val = $('aulas-validation');
        val.textContent = erros.length ? erros[0].mensagem : `${state.aulas.itens.length} aula(s) prontas para ${state.aulas.turmasSelecionadas.length} turma(s).`;
        val.className = `validation-hint ${erros.length ? 'is-error' : 'is-ok'}`;
        $('aulas-save-run').disabled = erros.length > 0;
    }

    $('aulas-disciplina').addEventListener('change', ev => { state.aulas.disciplina = ev.target.value; renderizarAulas(); });
    $('aulas-periodo').addEventListener('change', ev => { state.aulas.periodo = ev.target.value; atualizarValidacaoAulas(); });
    $('aulas-data').addEventListener('change', ev => { state.aulas.dataInicial = ev.target.value; renderizarAulas(); });
    $('aulas-nome').addEventListener('input', ev => { state.aulas.nome = ev.target.value; atualizarValidacaoAulas(); });
    $('aulas-feriados').addEventListener('input', ev => { state.aulas.feriados = ev.target.value; renderizarAulas(); });
    $('aulas-substituir').addEventListener('change', ev => { state.aulas.substituir = ev.target.checked; renderizarAulas(); });
    $('aulas-add-row').addEventListener('click', () => { state.aulas.itens.push({ tema: '', descricao: '' }); renderizarAulas(); });
    $('aulas-reset').addEventListener('click', () => abrirAulaPara({ dataIso: domain.hojeIso() }));

    async function salvarAulas(executarNoPc) {
        const fila = montarObjetoFilaAulas();
        if (executarNoPc && !window.confirm(`Salvar a fila “${fila.nome}” e solicitar execução automática assim que o computador sincronizar?`)) return;
        const res = await sync.salvarFilaLocal(fila, { executarNoPc });
        if (!res.sucesso) return mostrarToast(res.erro || 'Revise os campos da fila de aulas.', true);
        state.aulas.filaId = res.fila.id;
        await recarregarDoBanco();
        renderizarTudo();
        mostrarToast(executarNoPc ? 'Fila de aulas salva! O computador executará assim que sincronizar.' : 'Fila de aulas salva e marcada para sincronizar.');
    }
    $('aulas-save').addEventListener('click', () => salvarAulas(false));
    $('aulas-save-run').addEventListener('click', () => salvarAulas(true));

    // ---- 7. Aba FILAS & STATUS DO COMPUTADOR ----
    function renderizarFilas() {
        const stPc = statusExecucao();
        if (!stPc) {
            $('pc-status-title').textContent = 'Aguardando primeiro contato do computador';
            $('pc-status-badge').textContent = 'Sem dados';
            $('pc-status-badge').className = 'badge badge-neutral';
            $('pc-status-detail').textContent = 'Ative a sincronização em Configurações → Tablet companheiro no PraxisBot do Windows.';
            $('pc-op-progress').classList.add('is-hidden');
        } else {
            const onlineTexto = `Último contato do PC: ${domain.formatarDataHoraBr(stPc.pcOnlineEm)}`;
            if (stPc.licencaStatus === 'expirado') {
                $('pc-status-title').textContent = 'Licença anual expirada no computador';
                $('pc-status-badge').textContent = 'Licença expirada';
                $('pc-status-badge').className = 'badge badge-danger';
                $('pc-status-detail').textContent = `${onlineTexto} · Renove a licença no PraxisBot do computador para executar filas no SIAEP.`;
            } else if (stPc.operacaoAtiva && stPc.operacaoAtual) {
                $('pc-status-title').textContent = 'Executando fila no SIAEP agora';
                $('pc-status-badge').textContent = stPc.operacaoAtual.pausada ? 'Pausada' : 'Em execução';
                $('pc-status-badge').className = 'badge badge-info';
                $('pc-status-detail').textContent = `${onlineTexto} · ${stPc.operacaoAtual.detalhe || stPc.operacaoAtual.rotulo}`;
            } else if (stPc.siaepPronto) {
                $('pc-status-title').textContent = 'Computador pronto para gravar no SIAEP';
                $('pc-status-badge').textContent = 'SIAEP pronto';
                $('pc-status-badge').className = 'badge badge-safe';
                $('pc-status-detail').textContent = `${onlineTexto} · Filas marcadas para execução automática iniciam automaticamente.`;
            } else {
                $('pc-status-title').textContent = 'Computador sincronizado (SIAEP aguardando login)';
                $('pc-status-badge').textContent = 'Aguardando SIAEP';
                $('pc-status-badge').className = 'badge badge-warning';
                $('pc-status-detail').textContent = `${onlineTexto} · As filas chegam normalmente e aguardam você entrar no SIAEP no computador.`;
            }
            const opBox = $('pc-op-progress');
            if (stPc.operacaoAtiva && stPc.operacaoAtual) {
                const atual = stPc.operacaoAtual.atual || 0;
                const total = Math.max(1, stPc.operacaoAtual.total || 1);
                $('pc-op-label').textContent = stPc.operacaoAtual.rotulo || stPc.operacaoAtual.tarefa || 'Operação ativa';
                $('pc-op-count').textContent = `${atual}/${total}`;
                $('pc-op-bar').style.width = `${Math.min(100, Math.round((atual / total) * 100))}%`;
                opBox.classList.remove('is-hidden');
            } else {
                opBox.classList.add('is-hidden');
            }
        }

        const filtradas = state.filas.filter(reg => {
            if (!state.filtroFilas.arquivadas && reg.fila.arquivadoEm) return false;
            if (state.filtroFilas.tipo && reg.fila.tipo !== state.filtroFilas.tipo) return false;
            return true;
        });

        const list = $('filas-list');
        const empty = $('filas-empty');
        list.replaceChildren();
        empty.classList.toggle('is-hidden', filtradas.length > 0);

        for (const reg of filtradas) {
            const fila = reg.fila;
            const st = domain.statusExecucaoDaFila(reg, stPc);
            const podeExecutar = !fila.arquivadoEm && fila.status === 'PRONTA';
            const abrirEdicao = () => {
                if (fila.tipo === 'FREQUENCIA') abrirFilaChamadaParaEdicao(reg);
                else if (fila.tipo === 'AULAS') abrirFilaAulasParaEdicao(reg);
                else if (fila.tipo === 'AVALIACOES') fase3?.abrirAvaliacoesParaEdicao(reg);
                else if (fila.tipo === 'NOTAS') fase3?.abrirNotasParaEdicao(reg);
            };

            list.append(el('div', { class: 'queue-card' }, [
                el('div', { class: 'queue-card-top' }, [
                    el('div', {}, [
                        el('h3', { text: fila.nome || queueModel.TIPOS[fila.tipo] || 'Fila' }),
                        el('div', { class: 'queue-card-meta', text: `${queueModel.TIPOS[fila.tipo] || fila.tipo} · ${fila.configuracao?.disciplina || '—'} · ${fila.totalItens || 0} item(ns)` })
                    ]),
                    el('span', { class: `badge badge-${st.nivel}`, text: st.texto })
                ]),
                el('div', { class: 'queue-card-meta', text: `Turmas: ${(fila.turmas || []).join(' · ') || '—'}` }),
                el('div', { class: 'queue-card-status', text: st.detalhe }),
                el('div', { class: 'row-actions' }, [
                    el('button', {
                        type: 'button',
                        class: 'btn btn-secondary btn-sm',
                        text: 'Editar',
                        onclick: abrirEdicao
                    }),
                    podeExecutar
                        ? el('button', {
                            type: 'button',
                            class: 'btn btn-primary btn-sm',
                            text: 'Executar no PC',
                            onclick: async () => {
                                if (!window.confirm(`Enviar pedido para o computador executar “${fila.nome}” no SIAEP?`)) return;
                                const r = await sync.solicitarExecucaoFila(reg.filaId);
                                if (!r.sucesso) return mostrarToast(r.erro || 'Não foi possível solicitar execução.', true);
                                await recarregarDoBanco();
                                renderizarTudo();
                                mostrarToast('Pedido enviado! O computador iniciará assim que sincronizar.');
                            }
                        })
                        : null,
                    el('button', {
                        type: 'button',
                        class: 'btn btn-danger btn-sm',
                        text: 'Excluir',
                        onclick: async () => {
                            if (!window.confirm(`Excluir a fila “${fila.nome || fila.tipo}” neste tablet e no computador?`)) return;
                            await sync.excluirFilaLocal(reg.filaId);
                            await recarregarDoBanco();
                            renderizarTudo();
                            mostrarToast('Fila excluída.');
                        }
                    })
                ])
            ]));
        }

        // Relatórios recentes vindos do PC (Fase 3: badges detalhados de sucessos, pulados, alertas e falhas).
        const relatorios = stPc?.relatoriosRecentes || [];
        const repList = $('reports-list');
        repList.replaceChildren();
        $('reports-empty').classList.toggle('is-hidden', relatorios.length > 0);
        for (const rep of relatorios.slice(0, 12)) {
            const ok = Number(rep.resumo?.sucessos || rep.resumo?.gravados || 0);
            const pulados = Number(rep.resumo?.pulados || 0);
            const alertas = Number(rep.resumo?.alertas || 0);
            const falhas = Number(rep.resumo?.falhas || rep.resumo?.erros || 0);
            repList.append(el('div', { class: 'report-item' }, [
                el('div', {}, [
                    el('strong', { text: rep.filaNome || rep.tarefa || 'Execução' }),
                    el('div', { class: 'muted-text', text: `${domain.formatarDataHoraBr(rep.finalizadoEm)}${rep.status ? ` · ${rep.status}` : ''}` })
                ]),
                el('div', { class: 'report-badges' }, [
                    el('span', { class: 'badge badge-success', text: `${ok} OK` }),
                    pulados > 0 ? el('span', { class: 'badge badge-neutral', text: `${pulados} pulado(s)` }) : null,
                    alertas > 0 ? el('span', { class: 'badge badge-warning', text: `${alertas} alerta(s)` }) : null,
                    falhas > 0 ? el('span', { class: 'badge badge-danger', text: `${falhas} falha(s)` }) : null
                ])
            ]));
        }
    }

    $('filas-filter-type').addEventListener('change', ev => { state.filtroFilas.tipo = ev.target.value; renderizarFilas(); });
    $('filas-show-archived').addEventListener('change', ev => { state.filtroFilas.arquivadas = ev.target.checked; renderizarFilas(); });

    // ---- 8. Aba AJUSTES ----
    function renderizarAjustes() {
        const st = sync.estado();
        const dbBase = diarioBase();
        const turmas = domain.obterTurmas(dbBase).length;
        const alunos = Array.isArray(dbBase.alunos) ? dbBase.alunos.length : 0;
        const aulas = Array.isArray(blocoAulas().aulas) ? blocoAulas().aulas.length : 0;
        $('cfg-email').textContent = supabase.estado().email || '—';
        $('cfg-fingerprint').textContent = st.impressaoDigital || '—';
        $('cfg-last-sync').textContent = st.ultimaSincronizacaoEm ? domain.formatarDataHoraBr(st.ultimaSincronizacaoEm) : 'Nunca';
        $('cfg-pending-count').textContent = String(state.pendentesCount);
        $('cfg-diary-summary').textContent = `${turmas} turma(s) · ${alunos} aluno(s) · ${aulas} aula(s)`;
        $('cfg-version').textContent = cfg.VERSAO || '—';
        $('cfg-sync-diag').textContent = st.ultimoCodigoErro
            ? `${st.ultimoCodigoErro}${st.ultimoDetalheErro ? ` · ${st.ultimoDetalheErro}` : ''}`
            : (st.online ? 'OK (conectado)' : 'Offline');
        $('cfg-sync-now').disabled = st.sincronizando || !st.online;
    }

    $('cfg-sync-now').addEventListener('click', acionarSyncManual);
    $('cfg-reconnect').addEventListener('click', abrirModalReconexao);
    $('cfg-repair').addEventListener('click', () => {
        state.reparando = true;
        atualizarTelas();
    });
    $('cfg-logout').addEventListener('click', async () => {
        if (!window.confirm('Sair da conta e apagar os dados locais deste tablet?\n\nAs filas já sincronizadas continuam seguras no computador.')) return;
        sync.pararPeriodico();
        await supabase.sair();
        await db.limparTudo();
        await sync.carregarMetadados();
        state.contextos = {};
        state.filas = [];
        state.reparando = false;
        atualizarTelas();
        mostrarToast('Dados removidos deste tablet.');
    });

    function renderizarTudo() {
        renderizarStatusSync();
        if (state.aba === 'hoje') renderizarHoje();
        else if (state.aba === 'chamada') renderizarChamada();
        else if (state.aba === 'aulas') renderizarAulas();
        else if (state.aba === 'avaliacoes') fase3?.renderizarAvaliacoesOuNotas();
        else if (state.aba === 'diario') fase3?.renderizarDiario();
        else if (state.aba === 'filas') renderizarFilas();
        else if (state.aba === 'ajustes') { renderizarAjustes(); fase3?.atualizarUiChaveIa(); }
    }

    fase3 = fase3Lib.iniciarFase3({
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
    });

    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => trocarAba(btn.dataset.tab));
    });

    globalThis.addEventListener('online', () => {
        renderizarStatusSync();
        if (!supabase.estado().sessaoExpirada) sync.sincronizarAgora().catch(() => {});
    });
    globalThis.addEventListener('offline', () => renderizarStatusSync());
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistration?.().then(r => r?.update().catch(() => {})).catch(() => {});
        }
        if (supabase.estado().logado && sync.estado().pareado && navigator.onLine !== false && !supabase.estado().sessaoExpirada) {
            sync.sincronizarAgora().catch(() => {});
        }
    });

    // Service Worker offline-first (só em HTTPS ou localhost), com recarga automática ao atualizar versão.
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
        const jaControlado = Boolean(navigator.serviceWorker.controller);
        let recarregandoPorSw = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!jaControlado || recarregandoPorSw) return;
            recarregandoPorSw = true;
            location.reload();
        });
        navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
            .then(reg => reg.update().catch(() => {}))
            .catch(() => {});
    }

    // Bootstrap inicial.
    (async function iniciar() {
        await supabase.carregar();
        await sync.carregarMetadados();
        await fase3.carregarChaveIa();
        await recarregarDoBanco();
        atualizarTelas();
        sync.iniciarPeriodico(cfg.INTERVALO_SYNC_MS);
        if (supabase.estado().logado && sync.estado().pareado && navigator.onLine !== false) {
            sync.sincronizarAgora().catch(() => {});
        }
    })();
})();
