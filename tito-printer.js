/**
 * tito-printer.js — Integración con impresora TITO por Web Serial API
 *
 * USO EN OTROS SITIOS
 * ===================
 * 1. Incluir el script:
 *      <script src="tito-printer.js"></script>
 *
 * 2. Imprimir un ticket:
 *      const resultado = await imprimirTicket({
 *        barcode:    '00-7298-0837-5540-9850', // con guiones (o 18 dígitos, se formatea solo)
 *        casino:     'BINGO OASIS',
 *        sala:       'Oasis Pilar',
 *        tipo:       'CPD',                    // o 'SOLO JUGABLE', etc.
 *        terminal:   '9',
 *        fecha:      '12/08/2026',
 *        hora:       '11:30:00',
 *        nro:        '2594',
 *        importe:    '0.10',                   // el texto se genera automáticamente
 *        vigencia:   '7',
 *        maquina:    '2000000000',
 *      });
 *      // resultado.code: 'impreso' | 'sin_papel' | 'ticket_en_bandeja' |
 *      //                 'imprimiendo' | 'impresora_inactiva' | 'timeout' | 'error'
 *      // resultado.mensaje: string descriptivo
 *
 * 3. Consultar estado:
 *      const estado = await obtenerEstado('9'); // terminal ID
 *      // estado.code, estado.f4, estado.f6, estado.mensaje
 *
 * 4. Para recibir logs en tu propio código:
 *      titoOnLog = (direccion, texto) => console.log(direccion, texto);
 *
 * NOTA: Requiere Chrome/Edge/Opera 89+ (Web Serial API).
 *
 * FIRMWARE
 * ========
 * Al conectar se lee el campo de firmware del status (*S|id|FIRMWARE|...).
 *   GUR102200 / GURUSA*     → TCL Gen2 (V1.45): ^Se|^, setup ^C|^+^R|F|...,
 *     ticket ^P|9|1|..., cierre ^P|Z|1|XX|^.
 *   GURARGB* (Gen5 / 5RARGBA22) → TCL: ^Se|^, ^C|^ (sin región Gen2),
 *     plantilla 8 = RECIBO EFECTIVO (4=PREMIO, 5=DEMO, 3=VALE INVALIDO).
 *   Clásico                 → ^S|<terminal>|^ y ^P|<terminal>|1|Sala|...
 * Nunca se prueba 9600 primero: a 38400 eso llega como basura y enciende FAULT.
 *      setBaudRate(38400);
 *      setBaudRate(9600);
 */

const BAUD_CANDIDATES = [38400, 9600];
const BAUD_STORAGE_KEY = 'tito_printer_baudrate';

const PERFIL_GUR = {
    familia: 'GUR',
    status: () => '^Se|^',
    layout: 'v145',
    setupClear: true,
    setupRegion: true,   // región 410x1027 de V1.45 / Gen2
    confirmZ: true,
    printTerminal: '9',  // V1.45 manda ^P|9|1| aunque el status diga 0
    idle: (f4) => f4 === 0x40 || f4 === 0x50,
};

const PERFIL_GUR_GEN5 = {
    familia: 'GUR_GEN5',
    status: () => '^Se|^',
    layout: 'gen5',
    setupClear: true,
    setupRegion: false,
    confirmZ: false,
    printTerminal: 'omit',
    // Título fijo por plantilla. 3/4/5/8 imprimen; A/B/D las ignora.
    // 3=VALE INVALIDO, 4=RECIBO PREMIO, 5=DEMO INVALIDO, 8=RECIBO EFECTIVO.
    plantillas: ['8'],
    idle: (f4) => f4 === 0x40 || f4 === 0x50,
};

const PERFIL_CLASICO = {
    familia: 'CLASICO',
    status: (terminal) => `^S|${terminal || '9'}|^`,
    layout: 'clasico',
    setupClear: false,
    setupRegion: false,
    confirmZ: false,
    printTerminal: 'form',
    idle: (f4, baseline) => f4 === baseline,
};

let port = null;
let writer = null;
let reader = null;
let readingActive = false;
let rxBuffer = [];
let inFrame = false;
let rxSinceLastTx = false;
let onRxFrame = null;
let titoOnLog = null;
let baudActivo = null;
let baudOverride = null;
let firmwareId = null;
let firmwareTerminal = '0';
let perfil = PERFIL_CLASICO;
let setupHecho = false;

function setBaudRate(baud) {
    baudOverride = baud ? parseInt(baud, 10) : null;
}

function perfilDe(fw) {
    const id = fw || '';
    if (/ARGB|GEN5/i.test(id)) return PERFIL_GUR_GEN5;
    if (/^GUR/i.test(id)) return PERFIL_GUR;
    return PERFIL_CLASICO;
}

function aplicarFirmwareDesdeFrame(ascii) {
    const st = parsearStatus(ascii);
    if (!st) return;
    if (st.terminal) firmwareTerminal = st.terminal;
    const nuevo = st.firmware || firmwareId;
    if (nuevo && nuevo !== firmwareId) {
        firmwareId = nuevo;
        perfil = perfilDe(nuevo);
        logConsola('INFO', `Firmware ${firmwareId} → perfil ${perfil.familia} (id ${firmwareTerminal})`);
    }
}

function parsearStatus(ascii) {
    if (!ascii || !ascii.startsWith('*S|')) return null;
    const campos = ascii.slice(1, -1).split('|');
    return {
        firmware: campos[2] || '',
        terminal: campos[1] || '',
        f4: (campos[3] || '').charCodeAt(0),
        f6: (campos[5] || '').charCodeAt(0),
    };
}

function esFirmwareGur() {
    return perfil.familia === 'GUR' || perfil.familia === 'GUR_GEN5';
}

function terminalImpresion(datosTerminal) {
    if (perfil.printTerminal === 'omit') return null;
    if (perfil.printTerminal === 'status') return firmwareTerminal || '0';
    if (perfil.printTerminal && perfil.printTerminal !== 'form') return perfil.printTerminal;
    return String(datosTerminal || '9').trim();
}

function comandoStatus(terminal) {
    return perfil.status(terminal);
}

async function setupFirmwareGur() {
    if (!writer || setupHecho) return;
    if (!perfil.setupClear && !perfil.setupRegion) return;
    if (perfil.setupClear) {
        logConsola('TX', '[setup] ^C|^');
        await writer.write(new TextEncoder().encode('^C|^'));
        await new Promise(r => setTimeout(r, 150));
    }
    if (perfil.setupRegion) {
        logConsola('TX', '[setup] ^R|F|DR|^');
        await writer.write(new TextEncoder().encode('^R|F|DR|^'));
        await new Promise(r => setTimeout(r, 150));
        const region = '^R|F|R|410|1027|24|1020|0|3|1|7|1|1|0|0||^';
        logConsola('TX', `[setup] ${region}`);
        await writer.write(new TextEncoder().encode(region));
        await new Promise(r => setTimeout(r, 200));
    }
    setupHecho = true;
}

// ── Consola UI ────────────────────────────────────────────────────────────────

function logConsola(direccion, texto) {
    if (titoOnLog) titoOnLog(direccion, texto);
    const panel = document.getElementById('consolaPanel');
    if (!panel) return;
    const empty = panel.querySelector('.log-empty');
    if (empty) empty.remove();

    const now = new Date();
    const ts = now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0');
    const colors = { TX: '#4fc3f7', RX: '#a5d6a7', INFO: '#ffe082', ERR: '#ef9a9a' };
    const color = colors[direccion] || '#ccc';

    const linea = document.createElement('div');
    linea.innerHTML =
        `<span style="color:#555">[${ts}]</span> ` +
        `<span style="color:${color};font-weight:bold">${direccion.padEnd(4)}</span> ` +
        `<span style="color:#e0e0e0">${texto.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span>`;
    panel.appendChild(linea);
    panel.scrollTop = panel.scrollHeight;
}

function limpiarConsola() {
    const panel = document.getElementById('consolaPanel');
    panel.innerHTML = '<span class="log-empty">Consola limpiada.</span>';
}

function mostrarEstado(mensaje, tipo) {
    const statusBox = document.getElementById('statusBox');
    if (!statusBox) return;
    statusBox.className = `status show ${tipo}`;
    statusBox.innerHTML = mensaje;
}

// ── Protocolo: decodificación de frames ──────────────────────────────────────

// f4 bitmask: bit5(0x20)=imprimiendo  bit2(0x04)=sin papel  (ej: 0x50=listo, 0x54=sin papel, 0x70=imprimiendo, 0x74=imprimiendo+sin papel)
// f6: 0x68=ticket en bandeja, 0x60=bandeja vacía, 0x40=corte automático
function decodificarFrame(ascii) {
    const st = parsearStatus(ascii);
    if (!st) return null;
    const f4 = st.f4;
    const f6 = st.f6;

    const h4 = `0x${f4.toString(16).toUpperCase().padStart(2, '0')}`;
    const h6 = `0x${f6.toString(16).toUpperCase().padStart(2, '0')}`;

    const busy    = (f4 & 0x20) !== 0;
    const noPaper = (f4 & 0x04) !== 0;

    const impresora = noPaper && busy ? `🔴 SIN PAPEL + IMPRIMIENDO (f4=${h4})`
                    : noPaper         ? `🔴 SIN PAPEL (f4=${h4})`
                    : busy            ? `🟡 IMPRIMIENDO (f4=${h4})`
                    :                   `🟢 LISTO (f4=${h4})`;

    const ticket = f6 === 0x68 ? `ticket en bandeja (f6=${h6})`
                 : f6 === 0x60 ? `bandeja vacía (f6=${h6})`
                 : f6 === 0x40 ? `corte automático (f6=${h6})`
                 : `f6=${h6}`;

    return `${impresora} | ${ticket}`;
}

function programarChequeoRespuesta(ms) {
    rxSinceLastTx = false;
    setTimeout(() => {
        if (!rxSinceLastTx) logConsola('INFO', `↳ sin respuesta de la impresora (${ms / 1000}s)`);
    }, ms);
}

// ── Lectura continua del puerto ───────────────────────────────────────────────

async function iniciarLectura() {
    readingActive = true;
    rxBuffer = [];
    inFrame = false;
    try {
        while (port && port.readable && readingActive) {
            reader = port.readable.getReader();
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    for (const b of (value ? Array.from(value) : [])) {
                        if (b === 0x2A) { // delimitador '*'
                            if (!inFrame) {
                                rxBuffer = [b];
                                inFrame = true;
                            } else {
                                rxBuffer.push(b);
                                inFrame = false;
                                const ascii = rxBuffer.map(x => (x >= 0x20 && x <= 0x7e) ? String.fromCharCode(x) : '.').join('');
                                const hex   = rxBuffer.map(x => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
                                const decoded = decodificarFrame(ascii);
                                logConsola('RX', `${ascii}${decoded ? '  → ' + decoded : ''}  (${hex})`);
                                rxBuffer = [];
                                rxSinceLastTx = true;
                                aplicarFirmwareDesdeFrame(ascii);
                                if (onRxFrame) onRxFrame(ascii);
                            }
                        } else if (inFrame) {
                            rxBuffer.push(b);
                        } else {
                            const h = b.toString(16).padStart(2, '0').toUpperCase();
                            const a = (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.';
                            logConsola('RX', `[raw] ${h}  |  ${a}`);
                            rxSinceLastTx = true;
                        }
                    }
                }
            } catch (err) {
                if (readingActive) logConsola('ERR', `Lectura: ${err.message}`);
            } finally {
                reader.releaseLock();
                reader = null;
            }
        }
    } catch (e) { /* puerto cerrado */ }
}

// ── Conexión ──────────────────────────────────────────────────────────────────

async function buscarYConectarImpresora(terminalHint) {
    try {
        const ports = await navigator.serial.getPorts();

        if (ports.length > 0) {
            mostrarEstado('🔍 Puerto autorizado encontrado, conectando...', 'info');
            port = ports[0];
        } else {
            mostrarEstado('🔍 Se abrirá un diálogo para seleccionar el puerto serial', 'info');
            port = await navigator.serial.requestPort({});
        }

        const terminal = (terminalHint || document.getElementById('tkTerminal')?.value.trim() || '9');

        const baud = await detectarYAbrirBaudrate(terminal);
        if (!baud) {
            mostrarEstado(`❌ La impresora no respondió (se probó ${BAUD_CANDIDATES.join(' y ')} baud)`, 'error');
            return false;
        }
        baudActivo = baud;
        try { localStorage.setItem(BAUD_STORAGE_KEY, String(baud)); } catch (e) {}
        if (firmwareId) logConsola('INFO', `Listo — ${firmwareId} @ ${baud} baud`);

        const info = port.getInfo();
        const portName = `USB VID: ${info.usbVendorId ? '0x' + info.usbVendorId.toString(16) : 'N/A'}, PID: ${info.usbProductId ? '0x' + info.usbProductId.toString(16) : 'N/A'}`;
        const elName = document.getElementById('portName');
        const elInfo = document.getElementById('portInfo');
        if (elName) elName.textContent = `${portName} @ ${baud} baud`;
        if (elInfo) elInfo.style.display = 'block';

        logConsola('INFO', `Puerto abierto — ${portName} @ ${baud} baud`);
        return true;

    } catch (error) {
        if (error.name === 'NotFoundError') {
            mostrarEstado('❌ No se seleccionó ningún puerto.', 'error');
        } else if (error.name === 'InvalidStateError') {
            mostrarEstado('❌ El puerto ya está en uso.', 'error');
        } else {
            mostrarEstado(`❌ Error al conectar: ${error.message}`, 'error');
        }
        return false;
    }
}

// Determina a qué velocidad responde la impresora y deja el puerto abierto
// (con la lectura continua activa) en esa velocidad. Prueba primero la
// última velocidad que funcionó (cacheada en localStorage) o la fijada con
// setBaudRate(), y si no, recorre BAUD_CANDIDATES. Devuelve el baud usado o
// null si no hubo respuesta en ninguna velocidad.
async function detectarYAbrirBaudrate(terminal) {
    if (baudOverride) {
        const ok = await probarConexionEnBaud(baudOverride, terminal, /*requireResponse*/ false);
        return ok ? baudOverride : null;
    }

    // 38400 primero. Un probe a 9600 con firmware GUR102200 llega como basura y FAULT.
    for (const baud of BAUD_CANDIDATES) {
        logConsola('INFO', `Probando ${baud} baud…`);
        if (await probarConexionEnBaud(baud, terminal, true)) return baud;
    }
    return null;
}

// Abre el puerto y confirma respuesta.
// Familia GUR (GUR102200 / GURUSA003): solo contestan ^S|^ — ^S|9|^ se ignora.
// Firmware clásico TITO: ^S|<terminal>|^.
// Se prueba ^S|^ primero a 38400 para no fallar GUR102200 y caer a 9600 (FAULT).
async function probarConexionEnBaud(baud, terminal, requireResponse = true) {
    try {
        await port.open({ baudRate: baud, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
    } catch (e) {
        logConsola('ERR', `No se pudo abrir el puerto a ${baud} baud: ${e.message}`);
        return false;
    }

    writer = port.writable.getWriter();
    iniciarLectura();
    await new Promise(r => setTimeout(r, 150));

    // GUR contesta ^Se|^ / ^S|^; el clásico ignora esos y contesta ^S|terminal|^.
    const comandosProbe = ['^Se|^', '^S|^', `^S|${terminal || '9'}|^`];
    let respuesta = null;
    const prev = onRxFrame;
    onRxFrame = (f) => { respuesta = f; };

    try {
        for (const cmd of comandosProbe) {
            if (respuesta) break;
            logConsola('TX', `[probe] ${cmd}`);
            await writer.write(new TextEncoder().encode(cmd));
            const t0 = Date.now();
            while (!respuesta && Date.now() - t0 < 800) await new Promise(r => setTimeout(r, 30));
        }
    } finally {
        onRxFrame = prev;
    }

    if (respuesta) {
        aplicarFirmwareDesdeFrame(respuesta);
        await setupFirmwareGur();
        return true;
    }
    if (!requireResponse) return true;

    // Sin respuesta a esta velocidad: liberar y cerrar para poder reintentar con otra
    readingActive = false;
    if (reader) { try { await reader.cancel(); } catch (e) {} reader = null; }
    if (writer) { try { writer.releaseLock(); } catch (e) {} writer = null; }
    try { await port.close(); } catch (e) {}
    await new Promise(r => setTimeout(r, 80));
    return false;
}

async function desconectar() {
    try {
        readingActive = false;
        if (reader) { try { await reader.cancel(); } catch (e) {} reader = null; }
        if (writer) { writer.releaseLock(); writer = null; }
        if (port)   { await port.close(); port = null; }
        baudActivo = null;
        firmwareId = null;
        firmwareTerminal = '0';
        perfil = PERFIL_CLASICO;
        setupHecho = false;
        logConsola('INFO', 'Puerto cerrado.');
        const elInfo = document.getElementById('portInfo');
        if (elInfo) elInfo.style.display = 'none';
    } catch (error) {
        console.error('Error al desconectar:', error);
    }
}

// ── Estado de la impresora ────────────────────────────────────────────────────

// Envía ^S|terminal|^ y devuelve { f4, f6 } del primer frame recibido
async function obtenerEstadoInicial(terminalParam) {
    const terminal = terminalParam || document.getElementById('tkTerminal')?.value.trim() || '9';
    let lastFrame = null;
    const prev = onRxFrame;
    onRxFrame = (f) => { lastFrame = f; };
    try {
        logConsola('INFO', 'Chequeo inicial…');
        if (esFirmwareGur()) {
            await writer.write(new TextEncoder().encode('^C|^'));
            await new Promise(r => setTimeout(r, 150));
        }
        await writer.write(new TextEncoder().encode(comandoStatus(terminal)));
        const t0 = Date.now();
        while (!lastFrame && Date.now() - t0 < 2000) await new Promise(r => setTimeout(r, 30));
    } finally {
        onRxFrame = prev;
    }
    if (!lastFrame) return null;
    aplicarFirmwareDesdeFrame(lastFrame);
    const st = parsearStatus(lastFrame);
    return st ? { f4: st.f4, f6: st.f6 } : null;
}

// Polling hasta que f4 vuelva al baseline; devuelve { code, mensaje }
async function esperarFinImpresion(baselineF4, timeoutMs = 30000, terminalParam, abortMs = 4000) {
    if (baselineF4 === null) {
        logConsola('ERR', 'Sin estado inicial — no se puede detectar fin de impresión');
        return { code: 'error', mensaje: 'Sin estado inicial' };
    }
    logConsola('INFO', `Baseline f4=0x${baselineF4.toString(16).toUpperCase().padStart(2, '00')} — esperando transición…`);
    const inicio = Date.now();
    let wasBusy = false;
    let lastFrame = null;
    const prev = onRxFrame;
    onRxFrame = (f) => { lastFrame = f; };
    const terminal = terminalParam || document.getElementById('tkTerminal')?.value.trim() || '9';
    try {
        await new Promise(r => setTimeout(r, 150));
        while (Date.now() - inicio < timeoutMs) {
            if (!port || !writer) break;
            lastFrame = null;
            await writer.write(new TextEncoder().encode(comandoStatus(terminal)));
            const t0 = Date.now();
            while (!lastFrame && Date.now() - t0 < 1000) await new Promise(r => setTimeout(r, 30));
            if (!lastFrame) { logConsola('ERR', 'Poll sin respuesta — abortando'); break; }
            const st = parsearStatus(lastFrame);
            if (!st) { logConsola('ERR', 'Poll con frame inválido — abortando'); break; }
            const f4 = st.f4;
            const f6 = st.f6;
            if ((f4 & 0x04) !== 0) {
                logConsola('ERR', '🔴 Sin papel — recargue para que se reimprima automáticamente');
                mostrarEstado('🔴 Sin papel — recargue el papel para reimprimir', 'error');
                return { code: 'sin_papel', mensaje: 'Sin papel — recargue para reimprimir' };
            }
            const idle = perfil.idle(f4, baselineF4);
            const busy = !idle;
            if (busy) wasBusy = true;
            if (!wasBusy && Date.now() - inicio > abortMs) {
                logConsola('INFO', 'La impresora no inició impresión (f4 no se movió)');
                return { code: 'impresora_inactiva', mensaje: 'La impresora no inició impresión' };
            }
            if (wasBusy && idle) {
                if (perfil.confirmZ) {
                    await writer.write(new TextEncoder().encode('^P|Z|1|XX|^'));
                    logConsola('TX', '^P|Z|1|XX|^');
                }
                const msg = f6 === 0x68 ? '✅ Impresión completada — retire el ticket' : '✅ Impresión completada';
                logConsola('INFO', msg);
                mostrarEstado(msg, 'success');
                return { code: 'impreso', mensaje: msg };
            }
            await new Promise(r => setTimeout(r, 300));
        }
        if (!wasBusy) {
            logConsola('INFO', 'La impresora no cambió de estado (f4 no se movió del baseline)');
            return { code: 'impresora_inactiva', mensaje: 'La impresora no inició impresión' };
        } else {
            logConsola('ERR', 'Timeout esperando fin de impresión');
            return { code: 'timeout', mensaje: 'Timeout esperando fin de impresión' };
        }
    } finally {
        onRxFrame = prev;
    }
}

// ── Envío de comandos ─────────────────────────────────────────────────────────

async function enviarTexto(texto, etiqueta) {
    try {
        if (!port || !writer) { const ok = await buscarYConectarImpresora(); if (!ok) return; }
        logConsola('TX', `[${etiqueta}] ${texto}`);
        programarChequeoRespuesta(3000);
        await writer.write(new TextEncoder().encode(texto));
    } catch (e) {
        logConsola('ERR', `${etiqueta}: ${e.message}`);
        await desconectar();
    }
}

async function enviarComando(bytes, etiqueta) {
    try {
        if (!port || !writer) { const ok = await buscarYConectarImpresora(); if (!ok) return; }
        const data = new Uint8Array(bytes);
        const hex = Array.from(data).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
        logConsola('TX', `[${etiqueta}] ${hex}`);
        programarChequeoRespuesta(3000);
        await writer.write(data);
    } catch (e) {
        logConsola('ERR', `${etiqueta}: ${e.message}`);
        await desconectar();
    }
}

// ── Construcción del comando de ticket ───────────────────────────────────────

function formatGen5Importe(importe) {
    const n = parseFloat(String(importe).replace(',', '.'));
    const val = Number.isFinite(n) ? n : 0;
    return `$${val.toFixed(2)}`;
}

function _buildComandoGen5(datos, plantilla) {
    const barcode    = String(datos.barcode || '').trim();
    const casino     = String(datos.casino || '').trim();
    const sala       = String(datos.sala || '').trim();
    const tipo       = String(datos.tipo || '').trim();
    const fecha      = String(datos.fecha || '').trim();
    const hora       = String(datos.hora || '').trim();
    const nro        = String(datos.nro || '').trim();
    const importe    = String(datos.importe || '').trim();
    const importeTxt = importeATexto(importe) || String(datos.importeTxt || '').trim();
    const vigencia   = String(datos.vigencia || '').trim();
    const maquina    = String(datos.maquina || '').trim();
    const digits = barcode.replace(/\D/g, '');
    const dashed = barcode.includes('-') ? barcode : (digits.length === 18
        ? `${digits.slice(0,2)}-${digits.slice(2,6)}-${digits.slice(6,10)}-${digits.slice(10,14)}-${digits.slice(14,18)}`
        : barcode);
    const vigenciaNum = parseInt(vigencia, 10);
    const nDias = Number.isFinite(vigenciaNum) ? vigenciaNum : 7;
    const diaTxt = nDias === 1 ? 'DIA' : 'DIAS';
    const exp = `${nDias} ${nDias === 1 ? 'day' : 'days'}`;
    const amt = formatGen5Importe(importe);
    const txt = importeTxt.startsWith('ARS') ? importeTxt : `ARS # ${importeTxt} # ARS`;
    const t = String(plantilla);
    // Payload que sí imprimió en 4/5/8/3. Solo cambia el id de plantilla.
    if (t === '3') {
        return `^P|3|1|${casino}|${sala}|${tipo}|VALIDACION|${amt}|${txt}|${tipo}|${fecha}|${hora}|TICKET # ${nro}||${dashed}|VALIDO POR ${nDias} ${diaTxt}|${exp}|MACHINE# ${maquina}|${digits}|^`;
    }
    return `^P|${t}|1|${dashed}|${casino}|${sala}|${tipo}|VALIDACION|${amt}|${txt}|${tipo}|${fecha}|${hora}|TICKET # ${nro}||${dashed}|VALIDO POR ${nDias} ${diaTxt}|${exp}|MACHINE# ${maquina}|${digits}|^`;
}

function _buildComando(datos, plantilla) {
    const barcode    = String(datos.barcode || '').trim();
    const casino     = String(datos.casino || '').trim();
    const sala       = String(datos.sala || '').trim();
    const tipo       = String(datos.tipo || '').trim();
    const terminal   = String(datos.terminal || '9').trim();
    const fecha      = String(datos.fecha || '').trim();
    const hora       = String(datos.hora || '').trim();
    const nro        = String(datos.nro || '').trim();
    const importe    = String(datos.importe || '').trim();
    const importeTxt = importeATexto(importe) || String(datos.importeTxt || '').trim();
    const vigencia   = String(datos.vigencia || '').trim();
    const maquina    = String(datos.maquina || '').trim();
    const digits = barcode.replace(/\D/g, '');
    const dashed = barcode.includes('-') ? barcode : (digits.length === 18
        ? `${digits.slice(0,2)}-${digits.slice(2,6)}-${digits.slice(6,10)}-${digits.slice(10,14)}-${digits.slice(14,18)}`
        : barcode);
    const vigenciaNum = parseInt(vigencia, 10);
    const diaTxt = vigenciaNum === 1 ? 'DIA' : 'DIAS';
    if (perfil.layout === 'gen5') {
        const id = plantilla || (perfil.plantillas && perfil.plantillas[0]) || '8';
        return _buildComandoGen5(datos, id);
    }
    if (perfil.layout === 'v145') {
        const txt = importeTxt.startsWith('ARS') ? importeTxt : `ARS # ${importeTxt} # ARS`;
        const addr = terminalImpresion(terminal);
        return `^P|${addr}|1|${dashed}|${casino}|${sala}|${tipo}||VALIDACION|${dashed}|${fecha}|${hora}|TICKET # ${nro}|${txt}||ARS${importe}|VALIDO POR ${vigencia} ${diaTxt}|MACHINE# ${maquina}|${digits}|^`;
    }
    return `^P|${terminal}|1|${dashed}| ${casino} |Sala|${sala}|${tipo}|VALIDACION|${dashed}|${fecha}|${hora}|TICKET # ${nro}|ARS # ${importeTxt} # ARS||ARS${importe}|VALIDO POR ${vigencia} DIAS|MACHINE# ${maquina}|${digits}|^`;
}

async function enviarTicketPerfil(datos, estado, terminal) {
    const plantillas = (perfil.layout === 'gen5' && perfil.plantillas) ? perfil.plantillas : [null];
    let ultimo = { code: 'impresora_inactiva', mensaje: 'La impresora no inició impresión' };
    for (let i = 0; i < plantillas.length; i++) {
        const cmd = _buildComando(datos, plantillas[i]);
        const etiqueta = plantillas[i] ? `plantilla ${plantillas[i]}` : '';
        logConsola('TX', etiqueta ? `[${etiqueta}] ${cmd}` : cmd);
        await writer.write(new TextEncoder().encode(cmd));
        logConsola('INFO', `${cmd.length} bytes enviados`);
        ultimo = await esperarFinImpresion(estado.f4, 30000, terminal, perfil.layout === 'gen5' ? 2500 : 4000);
        if (ultimo.code !== 'impresora_inactiva') return ultimo;
        if (i < plantillas.length - 1) logConsola('INFO', `Plantilla ${plantillas[i]} ignorada — pruebo ${plantillas[i + 1]}`);
    }
    return ultimo;
}

function buildTicketCommand() {
    return _buildComando({
        barcode:    document.getElementById('tkBarcode').value.trim(),
        casino:     document.getElementById('tkCasino').value.trim(),
        sala:       document.getElementById('tkSala').value.trim(),
        tipo:       document.getElementById('tkTipo').value.trim(),
        terminal:   document.getElementById('tkTerminal').value.trim(),
        fecha:      document.getElementById('tkFecha').value.trim(),
        hora:       document.getElementById('tkHora').value.trim(),
        nro:        document.getElementById('tkNro').value.trim(),
        importe:    document.getElementById('tkImporte').value.trim(),
        importeTxt: document.getElementById('tkImporteTxt')?.value.trim(),
        vigencia:   document.getElementById('tkVigencia').value.trim(),
        maquina:    document.getElementById('tkMaquina').value.trim(),
    });
}

// ── Flujo principal de impresión ──────────────────────────────────────────────

async function enviarTicketCompleto() {
    const sendBtn = document.getElementById('sendBtn');
    try {
        sendBtn.disabled = true;
        sendBtn.innerHTML = '🔍 Verificando estado<span class="loading"></span>';

        const terminalForm = document.getElementById('tkTerminal')?.value.trim() || '9';

        if (!port || !writer) {
            const conectado = await buscarYConectarImpresora(terminalForm);
            if (!conectado) return;
            await new Promise(r => setTimeout(r, 300));
        }

        const estado = await obtenerEstadoInicial(terminalForm);
        if (!estado) {
            mostrarEstado('❌ Sin respuesta de la impresora', 'error');
            return;
        }
        if ((estado.f4 & 0x04) !== 0) {
            mostrarEstado('🔴 Sin papel — recargue antes de imprimir', 'error');
            logConsola('ERR', 'Sin papel — impresión cancelada');
            return;
        }
        if ((estado.f4 & 0x20) !== 0) {
            mostrarEstado('🟡 Hay una impresión en proceso — espere', 'error');
            logConsola('ERR', 'Impresión en proceso');
            return;
        }
        if (estado.f6 === 0x68) {
            mostrarEstado('🎫 Retire el ticket de la bandeja antes de imprimir', 'error');
            logConsola('ERR', 'Ticket sin retirar en bandeja');
            return;
        }

        sendBtn.innerHTML = '🖨️ Imprimiendo<span class="loading"></span>';
        mostrarEstado('🖨️ Imprimiendo…', 'info');
        const datos = {
            barcode:    document.getElementById('tkBarcode').value.trim(),
            casino:     document.getElementById('tkCasino').value.trim(),
            sala:       document.getElementById('tkSala').value.trim(),
            tipo:       document.getElementById('tkTipo').value.trim(),
            terminal:   terminalForm,
            fecha:      document.getElementById('tkFecha').value.trim(),
            hora:       document.getElementById('tkHora').value.trim(),
            nro:        document.getElementById('tkNro').value.trim(),
            importe:    document.getElementById('tkImporte').value.trim(),
            importeTxt: document.getElementById('tkImporteTxt')?.value.trim(),
            vigencia:   document.getElementById('tkVigencia').value.trim(),
            maquina:    document.getElementById('tkMaquina').value.trim(),
        };
        const r = await enviarTicketPerfil(datos, estado, terminalForm);
        if (r.code === 'impresora_inactiva') mostrarEstado('❌ La impresora no inició impresión', 'error');

    } catch (error) {
        console.error('Error al enviar:', error);
        await desconectar();
        mostrarEstado(`❌ Error: ${error.message}`, 'error');
    } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Enviar Ticket de Prueba';
    }
}

// ── Comandos de diagnóstico ───────────────────────────────────────────────────

const cmd_estado = () => {
    const terminal = document.getElementById('tkTerminal')?.value.trim() || '9';
    return enviarTexto(comandoStatus(terminal), 'Estado');
};

async function cmd_papel() {
    if (!port || !writer) { const ok = await buscarYConectarImpresora(); if (!ok) return; }
    const terminal = document.getElementById('tkTerminal')?.value.trim() || '9';
    let lastFrame = null;
    const prev = onRxFrame;
    onRxFrame = (f) => { lastFrame = f; };
    try {
        await writer.write(new TextEncoder().encode(comandoStatus(terminal)));
        const t0 = Date.now();
        while (!lastFrame && Date.now() - t0 < 2000) await new Promise(r => setTimeout(r, 30));
    } finally { onRxFrame = prev; }
    if (!lastFrame) { logConsola('ERR', 'Sin respuesta'); return; }
    const st = parsearStatus(lastFrame);
    const f4 = st ? st.f4 : 0;
    logConsola('INFO', (f4 & 0x04) !== 0 ? `🔴 SIN PAPEL (f4=0x${f4.toString(16).toUpperCase().padStart(2,'0')})` : `⚠️ Sin señal de error de papel en reposo (f4=0x${f4.toString(16).toUpperCase().padStart(2,'00')}) — solo detectable durante impresión`);
}

async function cmd_ticketEnBandeja() {
    if (!port || !writer) { const ok = await buscarYConectarImpresora(); if (!ok) return; }
    const terminal = document.getElementById('tkTerminal')?.value.trim() || '9';
    let lastFrame = null;
    const prev = onRxFrame;
    onRxFrame = (f) => { lastFrame = f; };
    try {
        await writer.write(new TextEncoder().encode(comandoStatus(terminal)));
        const t0 = Date.now();
        while (!lastFrame && Date.now() - t0 < 2000) await new Promise(r => setTimeout(r, 30));
    } finally { onRxFrame = prev; }
    if (!lastFrame) { logConsola('ERR', 'Sin respuesta'); return; }
    const st = parsearStatus(lastFrame);
    logConsola('INFO', st && st.f6 === 0x68 ? '🎫 Ticket en bandeja — no retirado' : '✅ Bandeja vacía');
}

async function cmd_esperarRetiro() {
    if (!port || !writer) { const ok = await buscarYConectarImpresora(); if (!ok) return; }
    const terminal = document.getElementById('tkTerminal')?.value.trim() || '9';
    logConsola('INFO', 'Esperando retiro del ticket…');
    let lastFrame = null;
    const prev = onRxFrame;
    onRxFrame = (f) => { lastFrame = f; };
    const deadline = Date.now() + 60000;
    try {
        while (Date.now() < deadline) {
            lastFrame = null;
            await writer.write(new TextEncoder().encode(comandoStatus(terminal)));
            const t0 = Date.now();
            while (!lastFrame && Date.now() - t0 < 1000) await new Promise(r => setTimeout(r, 30));
            if (!lastFrame) { logConsola('ERR', 'Sin respuesta'); break; }
            const st = parsearStatus(lastFrame);
            if (st && st.f6 === 0x60) { logConsola('INFO', '✅ Ticket retirado'); return; }
            await new Promise(r => setTimeout(r, 500));
        }
        logConsola('INFO', 'Timeout — ticket no retirado en 60s');
    } finally { onRxFrame = prev; }
}

// ── Helpers de formulario ────────────────────────────────────────────────────

function onBarcodeInput(input) {
    const d = input.value.replace(/\D/g, '');
    if (d.length === 18)
        input.value = `${d.slice(0,2)}-${d.slice(2,6)}-${d.slice(6,10)}-${d.slice(10,14)}-${d.slice(14,18)}`;
}

const _U = ['','UN','DOS','TRES','CUATRO','CINCO','SEIS','SIETE','OCHO','NUEVE',
            'DIEZ','ONCE','DOCE','TRECE','CATORCE','QUINCE',
            'DIECISEIS','DIECISIETE','DIECIOCHO','DIECINUEVE'];
const _V = ['VEINTE','VEINTIUN','VEINTIDOS','VEINTITRES','VEINTICUATRO',
            'VEINTICINCO','VEINTISEIS','VEINTISIETE','VEINTIOCHO','VEINTINUEVE'];
const _D = ['','','VEINTE','TREINTA','CUARENTA','CINCUENTA','SESENTA','SETENTA','OCHENTA','NOVENTA'];
const _C = ['','CIENTO','DOSCIENTOS','TRESCIENTOS','CUATROCIENTOS','QUINIENTOS',
            'SEISCIENTOS','SETECIENTOS','OCHOCIENTOS','NOVECIENTOS'];

function _n(n) {
    if (n === 0) return 'CERO';
    if (n < 20)  return _U[n];
    if (n < 30)  return _V[n - 20];
    if (n < 100) { const u = n % 10; return u ? `${_D[Math.floor(n/10)]} Y ${_U[u]}` : _D[Math.floor(n/10)]; }
    if (n === 100) return 'CIEN';
    if (n < 1000)    { const r = n%100;  const c = Math.floor(n/100);    return r ? `${c===1?'CIENTO':_C[c]} ${_n(r)}` : (c===1?'CIENTO':_C[c]); }
    if (n < 2000)    { const r = n%1000;                                  return r ? `MIL ${_n(r)}` : 'MIL'; }
    if (n < 1000000) { const r = n%1000; const m = Math.floor(n/1000);   return r ? `${_n(m)} MIL ${_n(r)}` : `${_n(m)} MIL`; }
    return n.toString();
}

function importeATexto(str) {
    const v = parseFloat(str);
    if (isNaN(v) || v < 0) return '';
    const p = Math.floor(v);
    const c = Math.round((v - p) * 100);
    let t = p === 0 ? 'CERO PESOS' : p === 1 ? 'UN PESO' : `${_n(p)} PESOS`;
    if (c > 0) t += ` CON ${c === 1 ? 'UN CENTAVO' : `${_n(c)} CENTAVOS`}`;
    return t;
}

function onImporteInput(input) {
    const f = document.getElementById('tkImporteTxt');
    if (f) f.value = importeATexto(input.value);
}

function _initFormulario() {
    const imp = document.getElementById('tkImporte');
    if (imp) onImporteInput(imp);
}

// ── API PÚblica ────────────────────────────────────────────────────────
// Uso: const r = await imprimirTicket({ barcode, casino, sala, tipo, terminal,
//                                       fecha, hora, nro, importe, vigencia, maquina })
// Retorna: { code, mensaje }
//   code: 'impreso' | 'sin_papel' | 'ticket_en_bandeja' |
//          'imprimiendo' | 'impresora_inactiva' | 'timeout' | 'error'

async function obtenerEstado(terminal) {
    try {
        if (!port || !writer) {
            const ok = await buscarYConectarImpresora(terminal);
            if (!ok) return { code: 'impresora_inactiva', mensaje: 'No se pudo conectar' };
        }
        const estado = await obtenerEstadoInicial(terminal);
        if (!estado) return { code: 'impresora_inactiva', mensaje: 'Sin respuesta' };
        const f4Hex = `0x${estado.f4.toString(16).toUpperCase().padStart(2,'0')}`;
        const f6Hex = `0x${estado.f6.toString(16).toUpperCase().padStart(2,'0')}`;
        const code = (estado.f4 & 0x04) ? 'sin_papel'
                   : (estado.f4 & 0x20) ? 'imprimiendo'
                   : estado.f6 === 0x68  ? 'ticket_en_bandeja'
                   :                       'listo';
        return { code, f4: estado.f4, f6: estado.f6, firmware: firmwareId, mensaje: `fw=${firmwareId || '?'} f4=${f4Hex} f6=${f6Hex}` };
    } catch (e) {
        return { code: 'error', mensaje: e.message };
    }
}

async function imprimirTicket(datos) {
    try {
        const terminal = String(datos.terminal || '9').trim();
        if (!port || !writer) {
            const ok = await buscarYConectarImpresora(terminal);
            if (!ok) return { code: 'impresora_inactiva', mensaje: 'No se pudo conectar a la impresora' };
            await new Promise(r => setTimeout(r, 300));
        }
        const estado = await obtenerEstadoInicial(terminal);
        if (!estado) return { code: 'impresora_inactiva', mensaje: 'La impresora no respondió' };
        if ((estado.f4 & 0x04) !== 0) return { code: 'sin_papel',          mensaje: 'Sin papel — recargue para reimprimir' };
        if ((estado.f4 & 0x20) !== 0) return { code: 'imprimiendo',        mensaje: 'Hay una impresión en proceso' };
        if (estado.f6 === 0x68)        return { code: 'ticket_en_bandeja', mensaje: 'Retire el ticket de la bandeja' };
        return await enviarTicketPerfil(datos, estado, terminal);
    } catch (e) {
        return { code: 'error', mensaje: e.message };
    }
}

// ── Inicialización ────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
    if (!('serial' in navigator)) {
        document.getElementById('warningBox').classList.add('show');
        document.getElementById('sendBtn').disabled = true;
        mostrarEstado('Tu navegador no soporta Web Serial API. Usa Chrome, Edge u Opera.', 'error');
        return;
    }
    _initFormulario();
    navigator.serial.addEventListener('disconnect', (event) => {
        if (event.target === port) {
            mostrarEstado('⚠️ La impresora se desconectó', 'error');
            desconectar();
        }
    });
});
