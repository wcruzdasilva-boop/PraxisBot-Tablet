// Cliente leve do Supabase Auth (GoTrue) e PostgREST para o PraxisBot Tablet.
// Fala direto com o projeto praxisbot-contas sem SDK pesado e sem tocar no backend de licença
// (o tablet não consome cota de dispositivos).
(function (global) {
    'use strict';

    const MARGEM_RENOVACAO_MS = 60 * 1000;
    const TAMANHO_MINIMO_SENHA = 8;

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

        async function carregar() {
            sessao = (await lerSessao()) || null;
            return estado();
        }

        function estado() {
            return {
                logado: Boolean(sessao?.refreshToken && sessao?.senhaDefinida),
                email: sessao?.email || '',
                senhaDefinida: Boolean(sessao?.senhaDefinida)
            };
        }

        async function salvar(novaSessao) {
            sessao = novaSessao;
            await gravarSessao(novaSessao);
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
            const resposta = await buscar(`${url}/auth/v1${caminho}`, {
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

        async function obterToken() {
            if (!sessao?.refreshToken) return null;
            if (sessao.accessToken && sessao.expiraEm - MARGEM_RENOVACAO_MS > agora()) return sessao.accessToken;
            if (renovando) return renovando;
            renovando = (async () => {
                try {
                    const resposta = await pedirAuth('/token?grant_type=refresh_token', {
                        corpo: { refresh_token: sessao.refreshToken }
                    });
                    const nova = montarSessao(resposta, sessao.email);
                    nova.senhaDefinida = true;
                    await salvar(nova);
                    return nova.accessToken;
                } catch (_) {
                    return null;
                } finally {
                    renovando = null;
                }
            })();
            return renovando;
        }

        async function pedirRest(caminho, { metodo = 'GET', corpo, headersExtras = {} } = {}) {
            const token = await obterToken();
            if (!token) throw new Error('Sem conexão com a conta ou sessão indisponível.');
            const resposta = await buscar(`${url}/rest/v1/${caminho}`, {
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

        async function sair() {
            if (sessao?.accessToken) {
                try { await pedirAuth('/logout?scope=local', { token: sessao.accessToken }); } catch (_) { /* offline */ }
            }
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
