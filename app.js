// A constante da duração do corte (60 segundos)
const SEGMENTO_TEMPO = 60;

// Configurações de versão e URLs da CDN
const CORE_VERSION = '0.12.7';
const CORE_BASE_URL = `https://unpkg.com/@ffmpeg/core-mt@${CORE_VERSION}/dist`;
const CORE_JS_URL = `${CORE_BASE_URL}/ffmpeg-core.js`;

// As classes FFmpeg e toBlobURL são globais (vindo do index.html)
if (!window.FFmpeg || !window.toBlobURL) {
    console.error("ERRO FATAL: As classes FFmpeg ou toBlobURL não foram carregadas do index.html. Verifique a importação via <script type=\"module\">");
    // Interrompe a execução se as classes não existirem
    throw new Error("FFmpeg não definido. Falha na importação.");
}

const ffmpeg = new window.FFmpeg();

// Referências dos elementos do HTML
const inputElement = document.getElementById('video-input');
const cutButton = document.getElementById('cut-button');
const progressArea = document.getElementById('progress-area');
const statusMessage = document.getElementById('status-message');
const progressBar = document.getElementById('progress-bar');
const downloadArea = document.getElementById('download-area');
const clipList = document.getElementById('clip-list');
const errorArea = document.getElementById('error-area');
const errorMessage = document.getElementById('error-message');


/**
 * Funções de UI
 */
function updateUI(status, message, progress = 0) {
    statusMessage.textContent = message;
    progressBar.value = progress;
    
    progressArea.classList.add('hidden');
    downloadArea.classList.add('hidden');
    errorArea.classList.add('hidden');
    
    if (status === 'loading' || status === 'ready') {
        progressArea.classList.remove('hidden');
    } else if (status === 'error') {
        errorArea.classList.remove('hidden');
        errorMessage.textContent = message;
    } else if (status === 'done') {
        downloadArea.classList.remove('hidden');
    }
}

/**
 * 1. Inicializa o FFmpeg.wasm (PONTO DE CORREÇÃO FOCAL)
 */
async function loadFFmpeg() {
    updateUI('loading', 'Aguarde, carregando o motor de corte...');
    
    ffmpeg.on('log', ({ message }) => {
        // Loga as mensagens do FFmpeg no console para debug
        console.log(`[FFmpeg LOG] ${message}`);
    });
    
    ffmpeg.on('progress', ({ progress }) => {
        const percent = Math.floor(progress * 100);
        updateUI('loading', `Processando corte: ${percent}%`, percent);
    });

    try {
        // Cria as URLs de Blob para o Worker e o WASM Core, essenciais para o carregamento no Web Worker
        const coreURL = await window.toBlobURL(CORE_JS_URL, 'text/javascript');
        const wasmURL = await window.toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm');
        const workerURL = await window.toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.worker.js`, 'text/javascript');
        
        console.log("Iniciando ffmpeg.load() com as URLs de Blob...");

        await ffmpeg.load({
            coreURL: coreURL,
            wasmURL: wasmURL,
            workerURL: workerURL,
        });
        
        // Se a linha acima não falhou, o carregamento foi um sucesso.
        cutButton.disabled = false;
        updateUI('ready', 'Pronto! Selecione o vídeo (3MB é perfeito) e clique em "Iniciar Corte".', 100);
        console.log("FFmpeg carregado com sucesso. Botão habilitado.");
        
    } catch (e) {
        console.error("ERRO CRÍTICO NA INICIALIZAÇÃO DO FFmpeg:", e);
        cutButton.disabled = true; 
        updateUI('error', 
            `Falha ao carregar o motor de corte (FFmpeg). Motivo: ${e.message}.
            ⚠️ **VERIFIQUE O CONSOLE (F12):** Se aparecer "SharedArrayBuffer", o erro é nas metatags de segurança.
            A ferramenta não poderá ser usada.`
        );
    }
}

/**
 * Função auxiliar para obter a duração do vídeo via API nativa do navegador
 */
function getVideoDuration(file) {
    return new Promise((resolve, reject) => {
        const videoElement = document.createElement('video');
        videoElement.preload = 'metadata';
        
        videoElement.onloadedmetadata = function() {
            window.URL.revokeObjectURL(videoElement.src);
            resolve(videoElement.duration);
        };
        
        videoElement.onerror = function() {
            reject(new Error("Não foi possível ler a duração do vídeo."));
        };

        videoElement.src = URL.createObjectURL(file);
    });
}


/**
 * 3. A Função de Corte Principal
 */
async function cutVideo() {
    const file = inputElement.files[0];
    if (!file) return;

    try {
        clipList.innerHTML = '';
        updateUI('loading', 'Lendo a duração do vídeo...');
        cutButton.disabled = true;
        
        const duration = await getVideoDuration(file);
        
        // --- 1. Calcular os comandos de corte ---
        const numClipes = Math.ceil(duration / SEGMENTO_TEMPO);
        const segmentTimes = [];
        
        for (let i = 0; i < numClipes - 1; i++) {
            // Arredonda para o segundo mais próximo
            segmentTimes.push(Math.round((i + 1) * SEGMENTO_TEMPO)); 
        }
        
        const segmentListString = segmentTimes.join(',');
        const outputFilename = 'clipe_%03d.mp4'; 
        
        // Comando FFmpeg: -c copy é a chave para a velocidade (corta em Keyframes)
        const command = [
            '-i', 'input.mp4',
            '-c', 'copy', 
            '-map', '0', 
            '-f', 'segment',
            '-segment_times', segmentListString,
            '-reset_timestamps', '1',
            outputFilename
        ];
        
        console.log("Comando a ser executado:", command.join(' '));


        // --- 2. Escrever o arquivo na memória do FFmpeg (FS) ---
        updateUI('loading', `Carregando vídeo de ${file.name}...`);
        const data = new Uint8Array(await file.arrayBuffer());
        await ffmpeg.writeFile('input.mp4', data);


        // --- 3. Executar o corte ---
        updateUI('loading', `Iniciando corte de ${numClipes} clipes...`);
        await ffmpeg.exec(command);
        
        
        // --- 4. Ler e disponibilizar os arquivos de saída ---
        updateUI('loading', 'Criando links de download...');
        for (let i = 0; i < numClipes; i++) {
            const clipName = `clipe_${String(i + 1).padStart(3, '0')}.mp4`;
            
            // Verifica se o arquivo foi criado antes de tentar ler
            try {
                const clipData = await ffmpeg.readFile(clipName);
                
                const blob = new Blob([clipData], { type: 'video/mp4' });
                const url = URL.createObjectURL(blob);
                
                const link = document.createElement('a');
                link.href = url;
                link.download = `cortado_${SEGMENTO_TEMPO}s_${clipName}`;
                link.textContent = `⬇️ Baixar ${clipName}`;
                link.classList.add('download-link');
                clipList.appendChild(link);
            } catch (readError) {
                console.warn(`Aviso: Arquivo ${clipName} não encontrado. Pode ter sido um clipe muito curto.`, readError);
            }
        }
        
        updateUI('done');
        
    } catch (e) {
        console.error("ERRO durante o processo de corte:", e);
        updateUI('error', `Erro ao processar o vídeo. Detalhe: ${e.message}`);
    } finally {
        cutButton.disabled = false;
        // Tenta limpar o arquivo de entrada da memória virtual
        await ffmpeg.deleteFile('input.mp4').catch(e => console.warn("Falha ao limpar a memória: ", e));
    }
}

// 4. Listeners (Eventos)
inputElement.addEventListener('change', () => {
    // Habilita o botão somente se houver um arquivo e o FFmpeg estiver pronto
    cutButton.disabled = !inputElement.files.length;
    downloadArea.classList.add('hidden');
    errorArea.classList.add('hidden');
});

cutButton.addEventListener('click', cutVideo);

// 5. Inicia o carregamento
loadFFmpeg();

          
