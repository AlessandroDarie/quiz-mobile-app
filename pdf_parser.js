// Parser client-side per PDF in stile ExamTopics (domande a scelta multipla + drag & drop).
// Produce lo stesso formato dati usato dal flusso JSON+immagini esistente, cosi' il resto
// dell'app (rendering, correzione, punteggio) non deve sapere da dove arrivano le domande.

pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const NOISE_LINE_PATTERNS = [
    /^https?:\/\/www\.examtopics\.com/i,
    /^\d{2}\/\d{2}\/\d{2},\s*\d{2}:\d{2}/,
    /Free Actual Q&As, Page \d+ \| ExamTopics/i,
    /^Community vote distribution$/i,
    /^Topic \d+(\s*-\s*Exam [A-Z])?$/i,
    /^Next Questions?/i,
    /^Browse atleast/i,
    /^Viewing (page|questions)/i,
    /^\d+\s*\/\s*\d+$/,
];

function isNoiseLine(text) {
    if (!text || !text.trim()) return true;
    return NOISE_LINE_PATTERNS.some(re => re.test(text.trim()));
}

// Raggruppa gli item di testo di una pagina in righe (stessa y approssimata), ordinate dall'alto in basso.
function groupIntoLines(items, tolerance = 2.5) {
    const lines = [];
    for (const it of items) {
        let line = lines.find(l => Math.abs(l.y - it.y) <= tolerance);
        if (!line) {
            line = { y: it.y, items: [] };
            lines.push(line);
        }
        line.items.push(it);
        line.y = (line.y * (line.items.length - 1) + it.y) / line.items.length;
    }
    lines.sort((a, b) => b.y - a.y);
    lines.forEach(l => l.items.sort((a, b) => a.x - b.x));
    return lines;
}

async function extractPdfPages(pdf, onProgress) {
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const viewport = page.getViewport({ scale: 1 });
        const textContent = await page.getTextContent();
        const items = textContent.items
            .filter(it => it.str && it.str.trim().length > 0)
            .map(it => ({
                str: it.str,
                x: it.transform[4],
                y: it.transform[5],
                w: it.width,
                h: Math.abs(it.transform[3]) || 10
            }));
        pages.push({ pageNum: p, page, viewport, items });
        if (onProgress) onProgress(p, pdf.numPages);
    }
    return pages;
}

function buildDocumentLines(pages) {
    const docLines = [];
    for (const pg of pages) {
        const lines = groupIntoLines(pg.items);
        for (const line of lines) {
            const text = line.items.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
            if (text && !isNoiseLine(text)) {
                docLines.push({ pageNum: pg.pageNum, y: line.y, items: line.items, text });
            }
        }
    }
    return docLines;
}

function splitIntoQuestionBlocks(docLines) {
    const blocks = [];
    let current = null;
    const qRe = /Question #(\d+)/;
    for (const line of docLines) {
        const m = line.text.match(qRe);
        if (m) {
            if (current) blocks.push(current);
            current = { id: parseInt(m[1], 10), lines: [] };
            continue;
        }
        if (current) current.lines.push(line);
    }
    if (current) blocks.push(current);
    return blocks;
}

// --- Parsing domande a scelta multipla -------------------------------------------------

function parseMcBlock(block, rawTexts) {
    const optRe = /^([A-F])\.\s*(.*)$/;
    const caRe = /^Correct Answer:\s*([A-F]{1,6})\b/i;
    let questionLines = [];
    let options = {};
    let correctLetters = null;
    let inOptions = false;

    for (const t of rawTexts) {
        const cam = t.match(caRe);
        if (cam) { correctLetters = cam[1].toUpperCase().split('').join(','); continue; }
        const om = t.match(optRe);
        if (om) {
            inOptions = true;
            let optText = om[2].replace(/\s*Most Voted\s*$/i, '').trim();
            if (options[om[1]]) options[om[1]] += ' ' + optText;
            else options[om[1]] = optText;
            continue;
        }
        if (!inOptions) questionLines.push(t);
    }

    if (Object.keys(options).length < 2 || !correctLetters) return null;

    return {
        id: block.id,
        type: 'crocette',
        question: questionLines.join(' ').replace(/\s+/g, ' ').trim(),
        options,
        answer: correctLetters,
        solution_image: null
    };
}

// --- Parsing domande drag & drop ---------------------------------------------------------

// Divide un insieme di valori x in due gruppi cercando il salto (gap) piu' ampio.
function splitByLargestGap(values) {
    const uniq = [...new Set(values)].sort((a, b) => a - b);
    if (uniq.length < 2) return uniq.length ? uniq[0] + 1 : 0;
    let bestGap = -1, bestSplit = uniq[0] + 1;
    for (let i = 1; i < uniq.length; i++) {
        const gap = uniq[i] - uniq[i - 1];
        if (gap > bestGap) { bestGap = gap; bestSplit = (uniq[i] + uniq[i - 1]) / 2; }
    }
    return bestSplit;
}

// Raggruppa le righe di una colonna in "box" (un box puo' contenere testo su piu' righe se il
// gap verticale fra le righe e' piccolo, per gestire descrizioni lunghe che vanno a capo).
function groupLinesIntoBoxes(colLines, avgLineHeight) {
    const boxes = [];
    let current = null;
    let prevY = null;
    for (const l of colLines) {
        const gap = prevY === null ? 0 : prevY - l.y;
        if (current && gap < avgLineHeight * 1.6) {
            current.text += ' ' + l.text;
            current.minX = Math.min(current.minX, l.minX);
        } else {
            current = { text: l.text, y: l.y, minX: l.minX };
            boxes.push(current);
        }
        prevY = l.y;
    }
    boxes.forEach(b => { b.text = b.text.replace(/\s+/g, ' ').trim(); });
    return boxes;
}

// Estrae le due colonne (sinistra/destra) di una regione di righe drag&drop, ciascuna come
// lista ordinata di "box" (testo + indentazione minima).
function extractColumns(regionLines) {
    const allItems = [];
    regionLines.forEach(l => l.items.forEach(it => allItems.push(it)));
    if (allItems.length === 0) return { left: [], right: [] };

    const xs = allItems.map(it => it.x);
    const splitX = splitByLargestGap(xs);

    const leftLines = [];
    const rightLines = [];
    for (const l of regionLines) {
        const leftItems = l.items.filter(it => it.x < splitX);
        const rightItems = l.items.filter(it => it.x >= splitX);
        if (leftItems.length) leftLines.push({ y: l.y, text: leftItems.map(i => i.str).join(' ').trim(), minX: Math.min(...leftItems.map(i => i.x)) });
        if (rightItems.length) rightLines.push({ y: l.y, text: rightItems.map(i => i.str).join(' ').trim(), minX: Math.min(...rightItems.map(i => i.x)) });
    }

    const avgH = allItems.reduce((s, it) => s + it.h, 0) / allItems.length || 12;
    return {
        left: groupLinesIntoBoxes(leftLines, avgH),
        right: groupLinesIntoBoxes(rightLines, avgH)
    };
}

// Rileva se la colonna destra ha 2 livelli di indentazione (intestazioni categoria + item annidati)
// oppure e' una lista piatta a un solo livello.
function detectNestedCategories(rightBoxes) {
    if (rightBoxes.length < 3) return null;
    const minXs = rightBoxes.map(b => b.minX);
    const splitX = splitByLargestGap(minXs);
    const shallow = rightBoxes.filter(b => b.minX < splitX);
    const deep = rightBoxes.filter(b => b.minX >= splitX);
    if (shallow.length < 2 || deep.length < 2) return null; // non abbastanza per essere annidato

    const categories = [];
    for (const box of rightBoxes) {
        if (shallow.includes(box)) {
            categories.push({ name: box.text, items: [] });
        } else if (categories.length) {
            categories[categories.length - 1].items.push(box.text);
        }
    }
    return categories;
}

function dragDropQuestionText(questionLines) {
    return questionLines
        .filter(l => !/^\s*$/.test(l.text))
        .map(l => l.text).join(' ').replace(/\s+/g, ' ').trim();
}

// Similarita' approssimata fra due stringhe (0..1) basata sulle parole in comune.
// Serve per l'OCR, dove la stessa frase letta da due immagini diverse puo' avere piccoli
// errori di riconoscimento non identici tra loro.
function wordOverlapSimilarity(a, b) {
    const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    const wa = norm(a), wb = norm(b);
    if (wa.length === 0 || wb.length === 0) return 0;
    const setB = new Set(wb);
    const common = wa.filter(w => setB.has(w)).length;
    return common / Math.max(wa.length, wb.length);
}

function findBestMatch(text, candidates, threshold) {
    let best = null, bestScore = 0;
    for (const c of candidates) {
        const score = wordOverlapSimilarity(text, c);
        if (score > bestScore) { bestScore = score; best = c; }
    }
    return bestScore >= threshold ? best : null;
}

// Costruisce items/categories/answer a partire dalle colonne della domanda (qCols) e della
// risposta (aCols). Se fuzzy=true, gli abbinamenti testuali tollerano piccole differenze
// (necessario quando i testi arrivano da OCR invece che da testo PDF reale).
function buildDragDropFromColumns(qCols, aCols, fuzzy) {
    if (qCols.left.length < 2 || aCols.right.length < 2) return null;

    const nested = detectNestedCategories(aCols.right);
    const items = qCols.left.map(b => b.text);
    let categories, answer = {};

    const matchItem = fuzzy
        ? (text) => findBestMatch(text, items, 0.6)
        : (text) => (items.includes(text) ? text : null);

    if (nested) {
        categories = nested.map(c => c.name);
        nested.forEach(c => c.items.forEach(itemText => {
            const matched = matchItem(itemText) || itemText;
            answer[matched] = c.name;
        }));
    } else {
        categories = qCols.right.map(b => b.text);
        const n = Math.min(aCols.right.length, qCols.right.length);
        for (let i = 0; i < n; i++) {
            const term = aCols.right[i].text;
            const def = qCols.right[i].text;
            const matched = matchItem(term);
            if (matched) answer[matched] = def;
        }
        if (Object.keys(answer).length === 0 && aCols.right.length) {
            for (let i = 0; i < n; i++) {
                answer[items[i] || aCols.right[i].text] = qCols.right[i].text;
            }
        }
    }

    if (Object.keys(answer).length === 0) return null;
    return { items, categories, answer };
}

function parseDragDropBlock(block) {
    const lines = block.lines;
    let caIdx = lines.findIndex(l => /^Correct Answer:?$/i.test(l.text.trim()));
    if (caIdx === -1) return null;

    const questionLines = lines.slice(0, caIdx).filter(l => !/^(DRAG DROP|Select and Place:?)-?$/i.test(l.text.trim()));
    const answerLines = lines.slice(caIdx + 1);
    const questionText = dragDropQuestionText(questionLines);

    const qCols = extractColumns(questionLines);
    const aCols = extractColumns(answerLines);
    const core = buildDragDropFromColumns(qCols, aCols, false);
    if (!core) return null;

    return { id: block.id, type: 'tap_match', question: questionText, ...core };
}

// --- Estrazione immagini exhibit ---------------------------------------------------------

function matrixMultiply(m1, m2) {
    return [
        m1[0] * m2[0] + m1[1] * m2[2],
        m1[0] * m2[1] + m1[1] * m2[3],
        m1[2] * m2[0] + m1[3] * m2[2],
        m1[2] * m2[1] + m1[3] * m2[3],
        m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
        m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
    ];
}

// Ritorna TUTTI i rettangoli immagine di una pagina (spazio viewport), piu' grandi prima.
async function findAllImageBBoxes(page, viewport) {
    const opList = await page.getOperatorList();
    const OPS = pdfjsLib.OPS;
    let stack = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const found = [];

    for (let i = 0; i < opList.fnArray.length; i++) {
        const fn = opList.fnArray[i];
        if (fn === OPS.save) {
            stack.push(ctm);
        } else if (fn === OPS.restore) {
            ctm = stack.length ? stack.pop() : ctm;
        } else if (fn === OPS.transform) {
            const m = opList.argsArray[i];
            ctm = matrixMultiply(m, ctm);
        } else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
            const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [
                ctm[0] * x + ctm[2] * y + ctm[4],
                ctm[1] * x + ctm[3] * y + ctm[5]
            ]);
            const xs = corners.map(c => c[0]);
            const ys = corners.map(c => c[1]);
            const rect = viewport.convertToViewportRectangle([
                Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)
            ]);
            const x0 = Math.min(rect[0], rect[2]);
            const x1 = Math.max(rect[0], rect[2]);
            const y0 = Math.min(rect[1], rect[3]);
            const y1 = Math.max(rect[1], rect[3]);
            found.push({ x0, y0, x1, y1, area: (x1 - x0) * (y1 - y0) });
        }
    }
    return found;
}

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);
}

async function renderCropToBlob(pageInfo, bbox, scale) {
    const renderViewport = pageInfo.page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = renderViewport.width;
    canvas.height = renderViewport.height;
    const ctx = canvas.getContext('2d');
    // Timeout di sicurezza: su alcuni browser page.render() puo' restare in sospeso a
    // tempo indeterminato se la scheda non e' visibile/in primo piano (throttling).
    // Meglio saltare questa immagine che bloccare l'intero import.
    await withTimeout(pageInfo.page.render({ canvasContext: ctx, viewport: renderViewport }).promise, 8000);

    const pad = 4;
    const sx = Math.max(0, bbox.x0 * scale - pad);
    const sy = Math.max(0, bbox.y0 * scale - pad);
    const sw = Math.min(canvas.width - sx, (bbox.x1 - bbox.x0) * scale + pad * 2);
    const sh = Math.min(canvas.height - sy, (bbox.y1 - bbox.y0) * scale + pad * 2);
    if (sw <= 0 || sh <= 0) return null;

    const outCanvas = document.createElement('canvas');
    outCanvas.width = sw;
    outCanvas.height = sh;
    outCanvas.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    // toDataURL è sincrono: evita di dipendere dal callback di toBlob(), che alcuni
    // browser possono ritardare a tempo indeterminato se la scheda non è in primo piano.
    return outCanvas.toDataURL('image/png');
}

async function extractExhibitImage(pages, pageNumbers, scale) {
    let bestOverall = null;
    for (const pn of pageNumbers) {
        const pg = pages.find(p => p.pageNum === pn);
        if (!pg) continue;
        const boxes = await findAllImageBBoxes(pg.page, pg.viewport);
        for (const bbox of boxes) {
            if (!bestOverall || bbox.area > bestOverall.bbox.area) bestOverall = { pageInfo: pg, bbox };
        }
    }
    if (!bestOverall || bestOverall.bbox.area < 400) return null;
    return renderCropToBlob(bestOverall.pageInfo, bestOverall.bbox, scale);
}

// Elenca, in ordine di lettura (pagina poi alto->basso), i riquadri immagine di un blocco
// domanda: per le drag&drop di questi PDF sono tipicamente 2 (vuoto+soluzione) o 3
// (exhibit+vuoto+soluzione).
async function orderedImagesForPages(pages, pageNumbers) {
    const ordered = [];
    for (const pn of pageNumbers) {
        const pg = pages.find(p => p.pageNum === pn);
        if (!pg) continue;
        const boxes = await findAllImageBBoxes(pg.page, pg.viewport);
        boxes.filter(b => b.area >= 1500)
            .sort((a, b) => a.y0 - b.y0)
            .forEach(bbox => ordered.push({ pageInfo: pg, bbox }));
    }
    return ordered;
}

// Fallback per domande drag&drop il cui contenuto (caselle) e' incorporato come immagine
// rasterizzata nel PDF (non testo estraibile): mostriamo le immagini in modalita' auto-verifica,
// usando il tipo "drag_drop" gia' supportato dall'app (mostra tutto, poi rivela la soluzione).
async function buildDragDropFallback(block, questionText, pages, pageNumbers, hasExhibit, images, scale) {
    const ordered = await orderedImagesForPages(pages, pageNumbers);
    if (ordered.length === 0) return null;

    const fnames = [];
    for (let i = 0; i < ordered.length; i++) {
        const blob = await renderCropToBlob(ordered[i].pageInfo, ordered[i].bbox, scale);
        if (!blob) continue;
        const fname = `pdf_q${block.id}_dd${i + 1}.png`;
        images[fname] = blob;
        fnames.push(fname);
    }
    if (fnames.length === 0) return null;

    const q = {
        id: block.id,
        type: 'drag_drop',
        question: questionText,
        solution_image: null
    };

    if (hasExhibit && fnames.length >= 3) {
        q.images = [fnames[0], fnames[1]];
        q.solution_image = fnames[2];
    } else if (fnames.length >= 2) {
        q.images = [fnames[0]];
        q.solution_image = fnames[1];
    } else {
        q.images = [fnames[0]];
    }
    return q;
}

// --- Ricostruzione drag&drop via OCR (quando il contenuto e' un'immagine, non testo) -----

// Converte le parole riconosciute da Tesseract (coordinate immagine, y verso il basso) nello
// stesso formato "righe" usato per il testo PDF reale (y invertita: valori piu' alti = piu'
// in alto), cosi' da poter riusare groupIntoLines/extractColumns senza modifiche. Scarta il
// testo "Answer Area" (intestazione fissa presente in ogni screenshot ExamTopics) e i frammenti
// di 1 carattere (quasi sempre rumore dai bordi delle caselle).
function ocrWordsToLines(words) {
    const items = words
        .filter(w => w.text && w.text.trim() && w.confidence >= 40)
        .map(w => ({
            str: w.text,
            x: w.bbox.x0,
            y: -w.bbox.y0,
            h: Math.max(1, w.bbox.y1 - w.bbox.y0)
        }));
    const lines = groupIntoLines(items, 10);
    return lines.filter(l => {
        const t = l.items.map(i => i.str).join(' ').trim();
        return !/^answer\s+area$/i.test(t) && t.replace(/[^A-Za-z0-9]/g, '').length > 1;
    });
}

async function ocrRecognize(ocrWorker, dataUrl) {
    const { data } = await withTimeout(ocrWorker.recognize(dataUrl), 25000);
    return data.words || [];
}

function isTrustworthyCore(items, categories, answer, minCoverage) {
    if (!items || !categories || !answer) return false;
    if (items.length < 3 || categories.length < 1) return false;
    const answeredCount = Object.keys(answer).length;
    if (answeredCount < 2) return false;
    if (answeredCount < items.length * minCoverage) return false;
    if (categories.some(c => !c || c.replace(/\s/g, '').length < 2)) return false;
    if (items.some(i => !i || i.replace(/\s/g, '').length < 2)) return false;
    // Se ci sono piu' categorie disponibili, la risposta deve usarne davvero piu' di una:
    // altrimenti e' quasi certamente un errore di lettura (es. intestazioni mancanti).
    if (categories.length >= 2) {
        const usedCategories = new Set(Object.values(answer));
        if (usedCategories.size < 2) return false;
    }
    return true;
}

// Nota: lo stile "categorie annidate corte" (es. FTP/TFTP, Anycast/Multicast) e' stato provato
// anche con assegnazione per posizione verticale (intestazioni lette dall'immagine vuota, item
// dalla soluzione abbinati all'intestazione piu' vicina sopra), ma nei test ha prodotto
// risultati incoerenti tra un tentativo e l'altro — OCR non deterministico su intestazioni a
// basso contrasto. Rimosso per non rischiare risposte sbagliate mostrate come corrette: queste
// domande restano in modalita' auto-verifica a immagine.

// Stile "lista piatta" (item a sinistra, definizioni gia' scritte a destra anche da vuoto):
// stessa regola di decodifica gia' usata per il testo PDF reale, con confronto approssimato.
function tryFlatListOCR(qCols, aCols) {
    return buildDragDropFromColumns(qCols, aCols, true);
}

async function parseDragDropViaOCR(block, questionText, pages, pageNumbers, hasExhibit, ocrWorker, scale) {
    const ordered = await orderedImagesForPages(pages, pageNumbers);
    // Le ultime due immagini in ordine di lettura sono sempre "vuota" e "soluzione"
    // (la prima, se presente insieme a un terzo riquadro, e' l'exhibit di riferimento).
    if (ordered.length < 2) return null;
    const blankEntry = ordered[ordered.length - 2];
    const solvedEntry = ordered[ordered.length - 1];

    const blankUrl = await renderCropToBlob(blankEntry.pageInfo, blankEntry.bbox, scale);
    const solvedUrl = await renderCropToBlob(solvedEntry.pageInfo, solvedEntry.bbox, scale);
    if (!blankUrl || !solvedUrl) return null;

    const blankWords = await ocrRecognize(ocrWorker, blankUrl);
    const solvedWords = await ocrRecognize(ocrWorker, solvedUrl);

    const qCols = extractColumns(ocrWordsToLines(blankWords));
    const aCols = extractColumns(ocrWordsToLines(solvedWords));
    if (qCols.left.length < 2) return null;

    // Nota: lo stile "categorie annidate corte" (es. FTP/TFTP) e' stato provato con
    // assegnazione per posizione verticale, ma nei test ha prodotto risultati incoerenti tra
    // un tentativo e l'altro (OCR non deterministico su intestazioni a basso contrasto) —
    // disattivato per non rischiare risposte sbagliate mostrate come corrette. Resta solo lo
    // stile "lista piatta", che riusa la stessa regola gia' validata sul testo PDF reale.
    const core = tryFlatListOCR(qCols, aCols);
    if (!isTrustworthyCore(core && core.items, core && core.categories, core && core.answer, 0.7)) return null;

    return { id: block.id, type: 'tap_match', question: questionText, ...core };
}

// --- Entry point -------------------------------------------------------------------------

async function parsePdfDatabase(file, onProgress) {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

    if (onProgress) onProgress('Lettura testo PDF...', 0, pdf.numPages);
    const pages = await extractPdfPages(pdf, (p, tot) => onProgress && onProgress('Lettura testo PDF...', p, tot));

    const docLines = buildDocumentLines(pages);
    const blocks = splitIntoQuestionBlocks(docLines);

    const questions = [];
    const images = {};
    let skipped = 0;
    let ocrUpgraded = 0;
    let ocrWorker = null;

    try {
        for (let bi = 0; bi < blocks.length; bi++) {
            const block = blocks[bi];
            if (onProgress) onProgress('Analisi domande...', bi + 1, blocks.length);

            const rawTexts = block.lines.map(l => l.text);
            const isDragDrop = rawTexts.some(t => /DRAG DROP/i.test(t));
            const hasExhibit = rawTexts.some(t => /refer to the exhibit/i.test(t));
            const pageNumbers = [...new Set(block.lines.map(l => l.pageNum))];

            let q = null;
            try {
                q = isDragDrop ? parseDragDropBlock(block) : parseMcBlock(block, rawTexts);
            } catch (e) {
                q = null;
            }

            if (q && hasExhibit) {
                try {
                    const blob = await extractExhibitImage(pages, pageNumbers, 2.5);
                    if (blob) {
                        const fname = `pdf_q${q.id}_exhibit.png`;
                        images[fname] = blob;
                        if (q.type === 'tap_match') q.image = fname;
                        else q.images = [fname];
                    }
                } catch (e) { /* nessuna immagine, non bloccante */ }
            }

            let qText = null;
            if (!q && isDragDrop) {
                let caIdx = block.lines.findIndex(l => /^Correct Answer:?$/i.test(l.text.trim()));
                const questionLines = caIdx === -1 ? block.lines : block.lines.slice(0, caIdx);
                qText = dragDropQuestionText(questionLines.filter(l => !/^(DRAG DROP|Select and Place:?)-?$/i.test(l.text.trim())));

                // Tentativo 2: OCR + ricostruzione geometrica (il contenuto e' un'immagine).
                // Solo se supera la validazione diventa una domanda interattiva vera.
                try {
                    if (!ocrWorker) ocrWorker = await Tesseract.createWorker('eng');
                    if (onProgress) onProgress(`Lettura OCR domanda #${block.id}...`, bi + 1, blocks.length);
                    const ocrResult = await parseDragDropViaOCR(block, qText, pages, pageNumbers, hasExhibit, ocrWorker, 3);
                    if (ocrResult) { q = ocrResult; ocrUpgraded++; }
                } catch (e) { /* OCR fallita o inattendibile, si passa al fallback a immagine */ }
            }

            if (!q && isDragDrop) {
                try {
                    q = await buildDragDropFallback(block, qText, pages, pageNumbers, hasExhibit, images, 2.5);
                } catch (e) { q = null; }
            }

            if (!q) { skipped++; continue; }

            questions.push(q);
        }
    } finally {
        if (ocrWorker) { try { await ocrWorker.terminate(); } catch (e) {} }
    }

    return { questions, images, total: blocks.length, skipped, ocrUpgraded };
}
