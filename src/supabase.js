// Cliente leve do Supabase Auth (GoTrue) e PostgREST para o PraxisBot Tablet.
// Fala direto com o projeto praxisbot-contas sem SDK pesado e sem tocar no backend de licença
// (o tablet não consome cota de dispositivos).
(function (global) {
    'use strict';

    const MARGEM_RENOVACAO_MS = 60 * 1000;
    const PAUSA_APOS_RATE_LIMIT_MS = 60 * 1000;
    const TIMEOUT_HTTP_MS = 20 * 1000;
    const TAMANHO_MINIMO_SENHA = 8;

    function erroClassificado(codigo, mensagem, extras = {}) {
        const erro = new Error(mensagem);
        erro.codigo = codigo;
        Object.assign(erro, extras);
        return erro;
    }

    function ehErroSessaoExpirada(erro) {
        const status = Number(erro?.status) || 0;
        const texto = String(erro?.message || erro || '');
        if (status === 400 || status === 401) return true;
        return /invalid.*refresh|refresh_token|invalid_grant|session_not_found|user_not_found|JWT expired/i.test(texto);
    }

    function ehErroRede(erro) {
        if (Number(erro?.status) > 0) return false;
        const texto = String(erro?.message || erro || '');
        return erro?.name === 'AbortError' || /Failed to fetch|NetworkError|Load failed|aborted|timeout|network/i.test(texto);
    }

    function traduzirErroAuth(erro) {
        const texto = String(erro?.message || erro || '');
        if (/Invalid login credentials/i.test(texto)) return 'E-mail ou senha incorretos.';
        if (/Token has expired|invalid.*token|otp.*(expired|invalid)/i.test(texto)) return 'Código inválido ou vencido. Peça um código novo.';
        if (/rate limit|only request this after|too many/i.test(texto)) return 'Muitos pedidos seguidos. Aguarde um minuto e tente de novo.';
        if (/Password should be|password.*(short|weak|characters)/i.test(texto)) return `A senha precisa ter pelo menos ${TAMANHO_MINIMO_SENHA} caracteres.`;
        if (/Email not confirmed/i.test(texto)) return 'Confirme o e-mail com o código enviado antes de entrar com senha.';
        if (/Failed to fetch|NetworkError|Load failed|aborted|timeout/i.test(texto)) return 'Sem conexão com o servidor de contas. Verifique a internet.';
        return 'Não foi possível concluir agora. Tente de novo em instantes.';
    }

    function emailValido(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
    }

    function extrairUserIdDoJwt(token) {
        const partes = String(token || '').split('.');
        if (partes.length !== 3) return '';
        try {
            const norm = partes[1].replace(/-/g, '+').replace(/_/g, '/');
            const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
            const carga = JSON.parse(atob(padded));
            return typeof carga?.sub === 'string' ? carga.sub : '';
        } catch (_) {
            return '';
        }
    }

    function criarClienteSupabase({ url, chaveAnon, lerSessao, gravarSessao, buscar = (...a) => global.fetch(...a), agora = () => Date.now() }) {
        let sessao = null;
        let renovando = null;
        let sessaoExpirada = false;
        let renovacaoBloqueadaAte = 0;
        let ultimoErroAuth = '';

        async function carregar() {
            sessao = (await lerSessao()) || null;
            return estado();
        }

        function estado() {
            return {
                logado: Boolean(sessao?.refreshToken && sessao?.senhaDefinida),
                email: sessao?.email || '',
                senhaDefinida: Boolean(sessao?.senhaDefinida),
                sessaoExpirada: Boolean(sessaoExpirada),
                ultimoErroAuth
            };
        }

        async function salvar(novaSessao) {
            sessao = novaSessao;
            if (novaSessao?.refreshToken) {
                sessaoExpirada = false;
                renovacaoBloqueadaAte = 0;
                ultimoErroAuth = '';
            }
            await gravarSessao(novaSessao);
        }

        async function buscarComTimeout(endpoint, opcoes = {}) {
            if (typeof global.AbortController !== 'function') return buscar(endpoint, opcoes);
            const controlador = new global.AbortController();
            const timer = setTimeout(() => controlador.abort(), TIMEOUT_HTTP_MS);
            try {
                return await buscar(endpoint, { ...opcoes, signal: controlador.signal });
            } finally {
                clearTimeout(timer);
            }
        }

        async function executarComTrava(fn) {
            if (global.navigator?.locks?.request) {
                return global.navigator.locks.request('praxisbot_tablet_auth_refresh', fn);
            }
            return fn();
        }

        function montarSessao(resposta, emailPadrao = '') {
            const usuario = resposta?.user || {};
            return {
                email: String(usuario.email || emailPadrao).trim().toLowerCase(),
                accessToken: resposta.access_token,
                refreshToken: resposta.refresh_token,
                expiraEm: agora() + (Number(resposta.expires_in) || 3600) * 1000,
                senhaDefinida: usuario.user_metadata?.senha_definida === true || Boolean(sessao?.senhaDefinida)
            };
        }

        async function pedirAuth(caminho, { metodo = 'POST', corpo, token } = {}) {
            const resposta = await buscarComTimeout(`${url}/auth/v1${caminho}`, {
                method: metodo,
                headers: {
                    apikey: chaveAnon,
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {})
                },
                body: corpo === undefined ? undefined : JSON.stringify(corpo)
            });
            const texto = await resposta.text();
            let dados = null;
            try { dados = texto ? JSON.parse(texto) : null; } catch (_) { dados = { message: texto }; }
            if (!resposta.ok) {
                const erro = new Error(dados?.msg || dados?.error_description || dados?.message || `HTTP ${resposta.status}`);
                erro.status = resposta.status;
                erro.code = dados?.error_code || dados?.code || '';
                throw erro;
            }
            return dados;
        }

        async function entrarComSenha(email, senha) {
            if (!emailValido(email)) return { sucesso: false, erro: 'Digite um e-mail válido.' };
            try {
                const resposta = await pedirAuth('/token?grant_type=password', {
                    corpo: { email: String(email).trim().toLowerCase(), password: String(senha || '') }
                });
                const nova = montarSessao(resposta, email);
                nova.senhaDefinida = true;
                await salvar(nova);
                return { sucesso: true, estado: estado() };
            } catch (erro) {
                return { sucesso: false, erro: traduzirErroAuth(erro) };
            }
        }

        async function enviarCodigo(email) {
            if (!emailValido(email)) return { sucesso: false, erro: 'Digite um e-mail válido.' };
            try {
                await pedirAuth('/otp', { corpo: { email: String(email).trim().toLowerCase(), create_user: true } });
                return { sucesso: true };
            } catch (erro) {
                return { sucesso: false, erro: traduzirErroAuth(erro) };
            }
        }

        async function confirmarCodigo(email, codigo) {
            const limpo = String(codigo || '').replace(/\D/g, '');
            if (limpo.length < 6 || limpo.length > 10) return { sucesso: false, erro: 'Digite o código completo que chegou por e-mail.' };
            try {
                const resposta = await pedirAuth('/verify', {
                    corpo: { type: 'email', email: String(email).trim().toLowerCase(), token: limpo }
                });
                const nova = montarSessao(resposta, email);
                await salvar(nova);
                return { sucesso: true, senhaDefinida: nova.senhaDefinida };
            } catch (erro) {
                return { sucesso: false, erro: traduzirErroAuth(erro) };
            }
        }

        async function definirSenha(senha) {
            if (String(senha || '').length < TAMANHO_MINIMO_SENHA) {
                return { sucesso: false, erro: `A senha precisa ter pelo menos ${TAMANHO_MINIMO_SENHA} caracteres.` };
            }
            try {
                if (!sessao?.accessToken) throw new Error('Token has expired or is invalid');
                await pedirAuth('/user', { metodo: 'PUT', token: sessao.accessToken, corpo: { password: String(senha), data: { senha_definida: true } } });
                await salvar({ ...sessao, senhaDefinida: true });
                return { sucesso: true, estado: estado() };
            } catch (erro) {
                return { sucesso: false, erro: traduzirErroAuth(erro) };
            }
        }

        async function obterToken({ forcar = false } = {}) {
            if (!forcar && sessao?.accessToken && !sessaoExpirada && sessao.expiraEm - MARGEM_RENOVACAO_MS > agora()) {
                return sessao.accessToken;
            }
            if (renovando) return renovando;
            renovando = executarComTrava(async () => {
                // Releitura do IndexedDB sob trava evita reuso do mesmo refresh_token entre
                // abas do Chrome e o PWA instalado (que fazia o Supabase revogar a sessão).
                try {
                    const gravada = await lerSessao();
                    if (gravada?.refreshToken) {
                        if (sessao && gravada.refreshToken !== sessao.refreshToken) {
                            sessaoExpirada = false;
                            renovacaoBloqueadaAte = 0;
                            ultimoErroAuth = '';
                        }
                        sessao = gravada;
                    }
                } catch (_) { /* mantém sessão em memória */ }

                if (!sessao?.refreshToken) {
                    sessaoExpirada = true;
                    throw erroClassificado('SESSAO_EXPIRADA', 'Sessão da conta ausente no tablet.');
                }
                if (!forcar && !sessaoExpirada && sessao.accessToken && sessao.expiraEm - MARGEM_RENOVACAO_MS > agora()) {
                    return sessao.accessToken;
                }
                if (!forcar && sessaoExpirada) {
                    throw erroClassificado('SESSAO_EXPIRADA', ultimoErroAuth || 'Sessão da conta expirada no tablet.');
                }
                if (!forcar && agora() < renovacaoBloqueadaAte) {
                    throw erroClassificado('LIMITE_TAXA', ultimoErroAuth || 'Muitas tentativas seguidas no servidor de contas.');
                }
                try {
                    const resposta = await pedirAuth('/token?grant_type=refresh_token', {
                        corpo: { refresh_token: sessao.refreshToken }
                    });
                    const nova = montarSessao(resposta, sessao.email);
                    nova.senhaDefinida = true;
                    await salvar(nova);
                    return nova.accessToken;
                } catch (erro) {
                    const detalhe = String(erro?.message || erro || '').slice(0, 160);
                    ultimoErroAuth = detalhe;
                    if (ehErroSessaoExpirada(erro)) {
                        sessaoExpirada = true;
                        throw erroClassificado('SESSAO_EXPIRADA', detalhe || 'Sessão da conta expirada no tablet.', { status: erro?.status });
                    }
                    if (erro?.status === 429 || /rate limit|too many/i.test(detalhe)) {
                        renovacaoBloqueadaAte = agora() + PAUSA_APOS_RATE_LIMIT_MS;
                        throw erroClassificado('LIMITE_TAXA', detalhe || 'Limite de requisições atingido.', { status: 429 });
                    }
                    if (ehErroRede(erro)) {
                        throw erroClassificado('REDE', detalhe || 'Failed to fetch');
                    }
                    throw erroClassificado('SERVIDOR', detalhe || `HTTP ${erro?.status || 0}`, { status: erro?.status });
                }
            }).finally(() => {
                renovando = null;
            });
            return renovando;
        }

        async function executarRestComToken(caminho, { metodo, corpo, headersExtras, token }) {
            const resposta = await buscarComTimeout(`${url}/rest/v1/${caminho}`, {
                method: metodo,
                headers: {
                    apikey: chaveAnon,
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    ...headersExtras
                },
                body: corpo === undefined ? undefined : JSON.stringify(corpo)
            });
            const texto = await resposta.text();
            let dados = null;
            try { dados = texto ? JSON.parse(texto) : null; } catch (_) { dados = { message: texto }; }
            if (!resposta.ok) {
                const erro = new Error(dados?.message || dados?.error || dados?.code || `HTTP ${resposta.status}`);
                erro.status = resposta.status;
                erro.code = dados?.code || '';
                throw erro;
            }
            return { dados, userId: extrairUserIdDoJwt(token) };
        }

        async function pedirRest(caminho, { metodo = 'GET', corpo, headersExtras = {} } = {}) {
            let token = await obterToken();
            try {
                return await executarRestComToken(caminho, { metodo, corpo, headersExtras, token });
            } catch (erro) {
                if (erro?.status === 401) {
                    // Token pode ter expirado antes do esperado (ex.: relógio do tablet após suspensão):
                    // força uma única renovação e tenta de novo antes de falhar.
                    token = await obterToken({ forcar: true });
                    return executarRestComToken(caminho, { metodo, corpo, headersExtras, token });
                }
                if (ehErroRede(erro)) {
                    throw erroClassificado('REDE', String(erro?.message || 'Failed to fetch'));
                }
                throw erro;
            }
        }

        async function sair() {
            if (sessao?.accessToken) {
                try { await pedirAuth('/logout?scope=local', { token: sessao.accessToken }); } catch (_) { /* offline */ }
            }
            sessaoExpirada = false;
            renovacaoBloqueadaAte = 0;
            ultimoErroAuth = '';
            await salvar(null);
        }

        return {
            carregar,
            estado,
            entrarComSenha,
            enviarCodigo,
            confirmarCodigo,
            definirSenha,
            obterToken,
            pedirRest,
            sair
        };
    }

    const modulo = Object.freeze({ criarClienteSupabase, extrairUserIdDoJwt, traduzirErroAuth, emailValido });
    global.PraxisTabletSupabase = modulo;
    if (typeof module !== 'undefined' && module.exports) module.exports = modulo;
})(globalThis);
