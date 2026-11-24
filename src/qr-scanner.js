// Leitor de QR Code nativo para tablets Android (Chrome BarcodeDetector + câmera traseira).
// Quando a API nativa ou a câmera não estão disponíveis, informa claramente para o
// professor digitar o código de pareamento de 26 caracteres exibido no computador.
(function (global) {
    'use strict';

    function suportado() {
        return Boolean(global.navigator?.mediaDevices?.getUserMedia && typeof global.BarcodeDetector === 'function');
    }

    async function iniciarLeitor({ videoEl, aoLer, aoErro = () => {} }) {
        if (!suportado()) {
            throw new Error('Leitura de QR pela câmera indisponível neste navegador. Digite o código de pareamento abaixo.');
        }
        const stream = await global.navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        });
        videoEl.srcObject = stream;
        videoEl.setAttribute('playsinline', 'true');
        await videoEl.play();

        const detector = new global.BarcodeDetector({ formats: ['qr_code'] });
        let ativo = true;
        let rafId = null;
        let ultimoTick = 0;

        const parar = () => {
            ativo = false;
            if (rafId) cancelAnimationFrame(rafId);
            rafId = null;
            stream.getTracks().forEach(track => { try { track.stop(); } catch (_) { /* já parado */ } });
            videoEl.srcObject = null;
        };

        const varrer = async agoraMs => {
            if (!ativo) return;
            if (agoraMs - ultimoTick >= 220 && videoEl.readyState >= 2) {
                ultimoTick = agoraMs;
                try {
                    const codigos = await detector.detect(videoEl);
                    const valido = (codigos || []).find(item => /^praxisbot-sync:v1:/i.test(String(item?.rawValue || '').trim()));
                    if (valido) {
                        parar();
                        aoLer(String(valido.rawValue).trim());
                        return;
                    }
                } catch (erro) {
                    aoErro(erro);
                }
            }
            if (ativo) rafId = requestAnimationFrame(varrer);
        };

        rafId = requestAnimationFrame(varrer);
        return { parar };
    }

    global.PraxisTabletQrScanner = Object.freeze({ suportado, iniciarLeitor });
})(globalThis);
