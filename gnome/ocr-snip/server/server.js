/**
 * ocr-snip — démon OCR local.
 *
 * Écoute uniquement sur 127.0.0.1 et fait tourner PaddleOCR (PP-OCR, portage
 * ONNX) hors du processus gnome-shell : l'extension ne fait qu'un POST.
 *
 *   GET  /health           -> { ok, ready, lang, uptime }
 *   POST /ocr {path, ...}  -> { text, lines, ms }
 *   POST /quit             -> arrêt propre
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import Ocr from '@gutenye/ocr-node';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, 'node_modules/@gutenye/ocr-models/assets');
const MODELS = path.join(HERE, 'models');

const PORT = Number(process.env.OCR_SNIP_PORT || 8791);
const HOST = '127.0.0.1';
const DEFAULT_LANG = process.env.OCR_SNIP_LANG || 'fr';
// Le démon s'arrête tout seul après ce délai sans requête (0 = jamais).
const IDLE_TIMEOUT = Number(process.env.OCR_SNIP_IDLE_TIMEOUT ?? 900) * 1000;
// En dessous de cette hauteur de ligne, on sur-échantillonne : PP-OCR ramène
// chaque ligne à 48 px de haut et perd beaucoup sur les petites polices.
const MIN_HEIGHT = Number(process.env.OCR_SNIP_MIN_HEIGHT || 700);
const MAX_SCALE = 4;

// Trois jeux de modèles. `fr` est le défaut : PP-OCRv5 latin, le seul qui
// restitue correctement Œ, É, À et € ; `latin` est le v3 équivalent gardé en
// repli ; `ch` est le modèle chinois livré avec la lib (utile pour du CJK).
const LANGS = {
    fr: {
        detectionPath: path.join(MODELS, 'PP-OCRv5_mobile_det.onnx'),
        recognitionPath: path.join(MODELS, 'latin_PP-OCRv5_mobile_rec.onnx'),
        dictionaryPath: path.join(MODELS, 'latin_v5_dict.txt'),
    },
    latin: {
        detectionPath: path.join(ASSETS, 'ch_PP-OCRv4_det_infer.onnx'),
        recognitionPath: path.join(MODELS, 'latin_PP-OCRv3_rec_infer.onnx'),
        dictionaryPath: path.join(MODELS, 'latin_dict.txt'),
    },
    ch: {
        detectionPath: path.join(ASSETS, 'ch_PP-OCRv4_det_infer.onnx'),
        recognitionPath: path.join(ASSETS, 'ch_PP-OCRv4_rec_infer.onnx'),
        dictionaryPath: path.join(ASSETS, 'ppocr_keys_v1.txt'),
    },
};

// 3 = ne remonter que les erreurs ; sinon onnxruntime inonde le journal.
const ONNX_OPTIONS = {logSeverityLevel: 3};

const log = (...a) => console.log(new Date().toISOString(), ...a);

// --- Chargement des modèles -------------------------------------------------

/** @type {Map<string, Promise<any>>} un moteur par langue, chargé une seule fois. */
const engines = new Map();

function getEngine(lang) {
    const models = LANGS[lang];
    if (!models)
        throw new HttpError(400, `langue inconnue: ${lang} (attendu: ${Object.keys(LANGS).join(', ')})`);

    if (!engines.has(lang)) {
        log(`chargement du modèle « ${lang} »…`);
        const t0 = Date.now();
        const p = Ocr.create({models, onnxOptions: ONNX_OPTIONS}).then(ocr => {
            log(`modèle « ${lang} » prêt en ${Date.now() - t0} ms`);
            return ocr;
        }).catch(err => {
            engines.delete(lang); // ne pas mettre l'échec en cache
            throw err;
        });
        engines.set(lang, p);
    }
    return engines.get(lang);
}

// --- OCR --------------------------------------------------------------------

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/**
 * Sur-échantillonne l'image si elle est petite, et l'aplatit sur du blanc
 * (les captures d'écran PNG peuvent avoir un canal alpha que le modèle ignore).
 * Renvoie le chemin à donner à l'OCR, et un éventuel fichier temporaire à purger.
 */
async function prepare(srcPath) {
    const img = sharp(srcPath);
    const meta = await img.metadata();
    const scale = Math.min(MAX_SCALE, Math.max(1, Math.ceil(MIN_HEIGHT / (meta.height || MIN_HEIGHT))));

    if (scale === 1 && !meta.hasAlpha)
        return {inputPath: srcPath, tmpPath: null, scale, size: [meta.width, meta.height]};

    const tmpPath = path.join(os.tmpdir(), `ocr-snip-prep-${process.pid}-${Date.now()}.png`);
    await img
        .resize({width: (meta.width || 1) * scale, kernel: 'lanczos3'})
        .flatten({background: '#ffffff'})
        .png()
        .toFile(tmpPath);
    return {inputPath: tmpPath, tmpPath, scale, size: [meta.width, meta.height]};
}

async function runOcr({path: filePath, lang = DEFAULT_LANG, keepFile = false}) {
    if (!filePath)
        throw new HttpError(400, 'champ « path » manquant');
    try {
        await fs.access(filePath);
    } catch {
        throw new HttpError(404, `fichier introuvable: ${filePath}`);
    }

    const t0 = Date.now();
    const ocr = await getEngine(lang);
    const {inputPath, tmpPath, scale, size} = await prepare(filePath);

    try {
        const raw = await ocr.detect(inputPath);
        const lines = raw
            .map(l => ({
                text: (l.text || '').trim(),
                confidence: Number((l.mean ?? 0).toFixed(4)),
                // ramené aux coordonnées de l'image d'origine
                box: l.box ? l.box.map(([x, y]) => [Math.round(x / scale), Math.round(y / scale)]) : null,
            }))
            .filter(l => l.text.length > 0);

        return {
            text: lines.map(l => l.text).join('\n'),
            lines,
            lang,
            scale,
            size,
            ms: Date.now() - t0,
        };
    } finally {
        if (tmpPath)
            fs.unlink(tmpPath).catch(() => {});
        if (!keepFile)
            fs.unlink(filePath).catch(() => {});
    }
}

// --- Serveur HTTP -----------------------------------------------------------

const startedAt = Date.now();
let idleTimer = null;

function armIdleTimer(server) {
    if (!IDLE_TIMEOUT)
        return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        log(`inactif depuis ${IDLE_TIMEOUT / 1000} s, arrêt.`);
        server.close(() => process.exit(0));
    }, IDLE_TIMEOUT);
    idleTimer.unref();
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > 4 * 1024 * 1024) {
                reject(new HttpError(413, 'corps de requête trop gros'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw)
                return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(new HttpError(400, 'JSON invalide'));
            }
        });
        req.on('error', reject);
    });
}

function send(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

const server = http.createServer(async (req, res) => {
    armIdleTimer(server);
    const url = new URL(req.url, `http://${HOST}`);

    try {
        if (req.method === 'GET' && url.pathname === '/health') {
            const lang = url.searchParams.get('lang') || DEFAULT_LANG;
            const loaded = engines.has(lang);
            return send(res, 200, {
                ok: true,
                ready: loaded && (await Promise.race([
                    engines.get(lang).then(() => true, () => false),
                    Promise.resolve(true),
                ])),
                lang,
                langs: Object.keys(LANGS),
                uptime: Math.round((Date.now() - startedAt) / 1000),
            });
        }

        if (req.method === 'POST' && url.pathname === '/ocr') {
            const body = await readBody(req);
            const result = await runOcr(body);
            log(`ocr ${result.lines.length} ligne(s) en ${result.ms} ms (×${result.scale})`);
            return send(res, 200, result);
        }

        if (req.method === 'POST' && url.pathname === '/quit') {
            send(res, 200, {ok: true});
            return server.close(() => process.exit(0));
        }

        return send(res, 404, {error: 'route inconnue'});
    } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (status >= 500)
            console.error(err);
        return send(res, status, {error: err.message});
    }
});

server.listen(PORT, HOST, () => {
    log(`ocr-snip à l'écoute sur http://${HOST}:${PORT} (langue par défaut: ${DEFAULT_LANG})`);
    armIdleTimer(server);
    // Précharge en tâche de fond pour que la première capture soit rapide.
    getEngine(DEFAULT_LANG).catch(err => console.error('préchargement échoué:', err.message));
});

for (const sig of ['SIGINT', 'SIGTERM'])
    process.on(sig, () => server.close(() => process.exit(0)));
