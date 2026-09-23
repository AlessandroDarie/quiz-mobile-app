let state = {
    allQuestions: [],
    activeQuestions: [],
    errorQuestions: [],
    currentIndex: 0,
    score: 0,
    startTime: null,
    timerInterval: null,
    currentDb: null,
    selectedCategory: null
};

let imageMap = {};
let currentSelectedMatchItem = null;

window.onload = () => {
    syncThemeColor();
    switchView('view-db-select');
};

// Tema chiaro/scuro in stile ThisPlay (chiave separata: non tocca le impostazioni di ThisPlay).
function syncThemeColor() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const meta = document.getElementById('theme-color-meta');
    if (meta) meta.setAttribute('content', isDark ? '#18181b' : '#ffffff');
}

function toggleTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const newTheme = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    try { localStorage.setItem('quizTheme', newTheme); } catch (e) {}
    syncThemeColor();
}

// ---- Popup in stile ThisPlay (sostituiscono alert/prompt nativi) ----
// opts: { title, message, hint, input: bool, placeholder, chips: [{label, value}],
//         okText, cancelText, showCancel, error }. Risolve con il testo (prompt),
// true (alert) oppure null se annullato.
function showDialog(opts) {
    return new Promise(resolve => {
        const overlay = document.getElementById('modal-dialog');
        const card = overlay.querySelector('.modal-card');
        const titleEl = document.getElementById('modal-title');
        const msgEl = document.getElementById('modal-message');
        const chipsEl = document.getElementById('modal-chips');
        const input = document.getElementById('modal-input');
        const okBtn = document.getElementById('modal-ok');
        const cancelBtn = document.getElementById('modal-cancel');

        card.classList.toggle('is-error', !!opts.error);
        titleEl.textContent = opts.title || 'Attenzione';
        msgEl.textContent = opts.message || '';
        if (opts.hint) {
            const small = document.createElement('small');
            small.textContent = opts.hint;
            msgEl.appendChild(small);
        }

        input.classList.toggle('hidden', !opts.input);
        input.value = '';
        input.placeholder = opts.placeholder || '';

        chipsEl.innerHTML = '';
        chipsEl.classList.toggle('hidden', !(opts.chips && opts.chips.length));
        (opts.chips || []).forEach(c => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = c.label;
            b.onclick = () => {
                input.value = c.value;
                chipsEl.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
                input.focus();
            };
            chipsEl.appendChild(b);
        });
        input.oninput = () => chipsEl.querySelectorAll('button').forEach(x => x.classList.remove('active'));

        okBtn.textContent = opts.okText || 'OK';
        cancelBtn.textContent = opts.cancelText || 'Annulla';
        cancelBtn.classList.toggle('hidden', !opts.showCancel);

        const close = (value) => {
            overlay.classList.remove('active');
            overlay.setAttribute('aria-hidden', 'true');
            document.removeEventListener('keydown', onKey);
            okBtn.onclick = cancelBtn.onclick = overlay.onclick = null;
            resolve(value);
        };
        const ok = () => close(opts.input ? input.value.trim() : true);
        const cancel = () => close(opts.showCancel ? null : true);
        const onKey = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); ok(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        };

        okBtn.onclick = ok;
        cancelBtn.onclick = cancel;
        overlay.onclick = (e) => { if (e.target === overlay) cancel(); };
        document.addEventListener('keydown', onKey);

        overlay.classList.add('active');
        overlay.setAttribute('aria-hidden', 'false');
        setTimeout(() => (opts.input ? input : okBtn).focus(), 50);
    });
}

function uiAlert(message, title = 'Attenzione', error = false) {
    return showDialog({ title, message, error });
}

function switchView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.getElementById(viewId).classList.remove('hidden');
    window.scrollTo(0, 0);
}

async function processFiles() {
    const files = document.getElementById('file-input').files;
    let jsonFile = null;
    let pdfFile = null;
    imageMap = {};

    for (let file of files) {
        if (file.name.toLowerCase().endsWith('.pdf')) {
            pdfFile = file;
        } else if (file.name.endsWith('.json')) {
            jsonFile = file;
        } else if (file.type.startsWith('image/')) {
            imageMap[file.name] = URL.createObjectURL(file);
        }
    }

    if (pdfFile) {
        await processPdfFile(pdfFile);
        return;
    }

    if (!jsonFile) {
        await uiAlert("Seleziona il file .json del database, oppure un PDF ExamTopics.", "Nessun database", true);
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            state.allQuestions = JSON.parse(e.target.result);
            state.currentDb = { name: jsonFile.name.replace('.json', '') };
            document.getElementById('mode-db-title').innerText = state.currentDb.name;
            switchView('view-mode-select');
        } catch (err) {
            uiAlert("File JSON corrotto o malformato. Impossibile procedere.", "Errore", true);
        }
    };
    reader.readAsText(jsonFile);
}

async function processPdfFile(pdfFile) {
    const statusEl = document.getElementById('import-status');
    const btn = document.querySelector('#view-db-select .mode-btn');
    statusEl.classList.remove('hidden');
    btn.disabled = true;

    const setStatus = (label, cur, tot) => {
        statusEl.innerText = tot ? `${label} (${cur}/${tot})` : label;
    };

    try {
        const result = await parsePdfDatabase(pdfFile, setStatus);

        imageMap = {};
        Object.entries(result.images).forEach(([fname, dataUrl]) => {
            imageMap[fname] = dataUrl;
        });

        state.allQuestions = result.questions;
        state.currentDb = { name: pdfFile.name.replace(/\.pdf$/i, '') };
        document.getElementById('mode-db-title').innerText = state.currentDb.name;

        if (result.questions.length === 0) {
            await uiAlert("Nessuna domanda riconosciuta in questo PDF. Il formato potrebbe non essere supportato.", "PDF non riconosciuto", true);
        } else {
            let msg = `Importate ${result.questions.length} domande.`;
            if (result.ocrUpgraded > 0) msg += ` ${result.ocrUpgraded} drag&drop rese interattive tramite OCR.`;
            if (result.skipped > 0) msg += ` ${result.skipped} non riconosciute e saltate.`;
            if (result.ocrUpgraded > 0 || result.skipped > 0) await uiAlert(msg, 'Import completato');
        }

        switchView('view-mode-select');
    } catch (err) {
        console.error(err);
        await uiAlert("Errore durante la lettura del PDF: " + err.message, "Errore", true);
    } finally {
        statusEl.classList.add('hidden');
        btn.disabled = false;
    }
}

function selectCategory(cat) {
    state.selectedCategory = cat;
    switchView('view-order-select');
}

async function confirmMode(isShuffle) {
    let mode = state.selectedCategory;
    let qList = [...state.allQuestions];

    // Applica il filtro della categoria se non è "all"
    if (mode === 'tap_match') {
        // "Drag & Drop" copre sia le domande interattive (tap_match) sia quelle
        // importate da PDF in modalità auto-verifica (drag_drop, solo immagini).
        qList = qList.filter(q => q.type === 'tap_match' || q.type === 'drag_drop');
    } else if (mode !== 'all') {
        qList = qList.filter(q => (q.type || 'crocette') === mode);
    }

    if (qList.length === 0) { 
        await uiAlert("Nessuna domanda presente in questa categoria.", "Categoria vuota"); 
        switchView('view-mode-select');
        return; 
    }

    // Applica l'ordinamento
    if (isShuffle) {
        qList.sort(() => Math.random() - 0.5);
    }

    // Selezione del range
    const total = qList.length;
    const chips = [10, 25, 50, 100].filter(n => n < total).map(n => ({ label: String(n), value: String(n) }));
    chips.push({ label: 'Tutte', value: '' });
    let limit = await showDialog({
        title: `${total} domande`,
        message: 'Quante ne vuoi fare?',
        hint: "Lascia vuoto per tutte, oppure un intervallo es. 1-30",
        input: true,
        placeholder: `Tutte (${total})`,
        chips,
        okText: 'Inizia',
        showCancel: true
    });
    
    // Se l'utente preme "Annulla" sul prompt, interrompi
    if (limit === null) return; 

    if (limit) {
        if (limit.includes('-')) {
            let parts = limit.split('-');
            let start = Math.max(0, parseInt(parts[0]) - 1);
            let end = parseInt(parts[1]);
            qList = qList.slice(start, end);
        } else {
            let n = parseInt(limit);
            if (!isNaN(n)) qList = qList.slice(0, n);
        }
    }

    if (qList.length === 0) { 
        await uiAlert("Range non valido o nessuna domanda selezionata.", "Range non valido", true); 
        return; 
    }
    
    startQuizCore(qList);
}

function startQuizCore(questionsArr) {
    state.activeQuestions = questionsArr;
    state.currentIndex = 0;
    state.score = 0;
    state.errorQuestions = [];

    state.startTime = Date.now();
    clearInterval(state.timerInterval);
    state.timerInterval = setInterval(updateTimer, 1000);

    switchView('view-quiz');
    renderQuestion();
}

function updateTimer() {
    let diff = Math.floor((Date.now() - state.startTime) / 1000);
    let m = Math.floor(diff / 60);
    let s = diff % 60;
    document.getElementById('timer').innerText = `${m}m ${s}s`;
}

function renderQuestion() {
    const q = state.activeQuestions[state.currentIndex];
    const ui = {
        img: document.getElementById('image-container'),
        opts: document.getElementById('options-container'),
        inputBox: document.getElementById('input-container'),
        input: document.getElementById('text-answer'),
        feedback: document.getElementById('feedback'),
        submitBtn: document.getElementById('submit-btn'),
        nextBtn: document.getElementById('next-btn')
    };

    ui.img.innerHTML = ''; ui.opts.innerHTML = '';
    ui.opts.classList.add('hidden'); ui.inputBox.classList.add('hidden');
    ui.feedback.classList.add('hidden'); ui.nextBtn.classList.add('hidden');
    ui.submitBtn.classList.remove('hidden');
    ui.submitBtn.innerText = "Submit";
    ui.submitBtn.onclick = checkAnswer;
    ui.input.value = '';

    document.getElementById('current-q').innerText = state.currentIndex + 1;
    document.getElementById('total-q').innerText = state.activeQuestions.length;
    document.getElementById('score').innerText = state.score;
    document.getElementById('progress-fill').style.width = `${(state.currentIndex / state.activeQuestions.length) * 100}%`;
    document.getElementById('question-text').innerText = `${q.id || ''}. ${q.question}`;

    let imgs = q.images || q.image;
    if (imgs) {
        if (!Array.isArray(imgs)) imgs = [imgs];
        imgs.forEach(imgName => {
            let el = document.createElement('img');
            el.src = imageMap[imgName] || '';
            el.alt = "Immagine mancante o non caricata correttamente";
            if (imageMap[imgName]) {
                ui.img.appendChild(el);
            }
        });
    }

    document.getElementById('view-quiz').classList.toggle('has-image', ui.img.children.length > 0);

    let qType = q.type || 'crocette';

    if (qType === 'drag_drop') {
        ui.submitBtn.innerText = "Show Solution / Check";
    } else if (qType === 'crocette') {
        ui.opts.classList.remove('hidden');
        let entries = Object.entries(q.options);
        entries.sort(() => Math.random() - 0.5);

        let letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

        entries.forEach((entry, idx) => {
            let oldKey = entry[0];
            let text = entry[1];
            let newLetter = letters[idx];

            let row = document.createElement('label');
            row.className = 'option-row';

            let cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = newLetter;
            cb.dataset.oldkey = oldKey;

            row.appendChild(cb);
            const txt = document.createElement('span');
            txt.textContent = `${newLetter}: ${text}`;
            row.appendChild(txt);
            const key = document.createElement('span');
            key.className = 'key-hint';
            key.textContent = newLetter;
            row.appendChild(key);
            ui.opts.appendChild(row);
        });
    

    } else if (qType === 'tap_match') {
        ui.opts.classList.remove('hidden');
        ui.opts.innerHTML = '<div id="match-area"></div>';
        const matchArea = document.getElementById('match-area');
        
        const sourceDiv = document.createElement('div');
        sourceDiv.className = 'match-source';
        sourceDiv.id = 'match-source';
        
        // Bersaglio 1: Rimettere l'elemento nell'area sorgente
        sourceDiv.onclick = function() {
            if (currentSelectedMatchItem) {
                currentSelectedMatchItem.classList.remove('selected');
                sourceDiv.appendChild(currentSelectedMatchItem);
                currentSelectedMatchItem = null;
            }
        };

        let shuffledItems = [...q.items].sort(() => Math.random() - 0.5);
        shuffledItems.forEach(itemText => {
            let el = document.createElement('div');
            el.className = 'match-item';
            el.innerText = itemText;
            
            // Logica di selezione isolata per l'elemento stesso
            el.onclick = function(e) {
                e.stopPropagation(); // Evita che il click si propaghi al contenitore sottostante
                
                // Deseleziona se tocchi l'elemento già attivo
                if (currentSelectedMatchItem === this) {
                    this.classList.remove('selected');
                    currentSelectedMatchItem = null;
                    return;
                }
                
                document.querySelectorAll('.match-item').forEach(i => i.classList.remove('selected'));
                this.classList.add('selected');
                currentSelectedMatchItem = this;
            };
            sourceDiv.appendChild(el);
        });
        
        matchArea.appendChild(sourceDiv);
        
        q.categories.forEach(catName => {
            let catDiv = document.createElement('div');
            catDiv.className = 'match-category';
            // pointer-events: none sul titolo evita conflitti di click
            catDiv.innerHTML = `<h3>${catName}</h3>`;
            
            let bucket = document.createElement('div');
            bucket.className = 'match-bucket';
            bucket.dataset.category = catName;
            
            // Bersaglio 2: Spostare l'elemento in una categoria
            catDiv.onclick = function() {
                if (currentSelectedMatchItem) {
                    currentSelectedMatchItem.classList.remove('selected');
                    bucket.appendChild(currentSelectedMatchItem);
                    currentSelectedMatchItem = null;
                }
            };
            
            catDiv.appendChild(bucket);
            matchArea.appendChild(catDiv);
        });
    } else {
        ui.inputBox.classList.remove('hidden');
    }
}

function checkAnswer() {
    const q = state.activeQuestions[state.currentIndex];
    let qType = q.type || 'crocette';
    let isCorrect = false;
    let feedbackText = "";

    document.getElementById('submit-btn').classList.add('hidden');

    if (qType === 'drag_drop') {
        isCorrect = true;
        feedbackText = "Self-Check mode.";
        
    } else if (qType === 'tap_match') {
        let allCorrect = true;
        const answer = q.answer || {};
        const source = document.getElementById('match-source');
        const matchArea = document.getElementById('match-area');
        const fixNote = (itemNode, text) => {
            const n = document.createElement('small');
            n.className = 'match-fix';
            n.textContent = text;
            itemNode.appendChild(n);
        };

        // Elementi lasciati nella zona di partenza: errore solo se dovevano andare in una categoria
        Array.from(source.children).forEach(itemNode => {
            const itemText = itemNode.innerText;
            if (answer[itemText]) {
                allCorrect = false;
                itemNode.classList.add('wrong');
                fixNote(itemNode, `→ ${answer[itemText]}`);
            }
        });

        document.querySelectorAll('.match-bucket').forEach(bucket => {
            const catName = bucket.dataset.category;
            Array.from(bucket.children).forEach(itemNode => {
                const itemText = itemNode.innerText;
                if (answer[itemText] === catName) {
                    itemNode.classList.add('correct');
                } else {
                    itemNode.classList.add('wrong');
                    fixNote(itemNode, answer[itemText] ? `→ ${answer[itemText]}` : '→ da non associare');
                    allCorrect = false;
                }
            });
        });

        // Dopo il controllo le associazioni non si possono più spostare
        matchArea.classList.add('locked');
        if (source.children.length === 0) source.classList.add('hidden');

        if (!allCorrect) {
            const sol = document.createElement('div');
            sol.className = 'match-solution';
            let html = '<span class="label">Soluzione corretta</span><div class="match-solution-grid">';
            q.categories.forEach(cat => {
                const items = Object.keys(answer).filter(k => answer[k] === cat);
                html += `<div class="match-solution-cat"><h4></h4><ul>${items.map(() => '<li></li>').join('')}</ul></div>`;
            });
            html += '</div>';
            sol.innerHTML = html;
            // Testi inseriti con textContent (niente HTML dai dati del quiz)
            sol.querySelectorAll('.match-solution-cat').forEach((el, i) => {
                const cat = q.categories[i];
                el.querySelector('h4').textContent = cat;
                const items = Object.keys(answer).filter(k => answer[k] === cat);
                el.querySelectorAll('li').forEach((li, j) => { li.textContent = items[j]; });
                if (items.length === 0) el.querySelector('ul').outerHTML = '<p class="match-solution-empty">Nessun elemento</p>';
            });
            matchArea.after(sol);
        }

        isCorrect = allCorrect;
        feedbackText = isCorrect ? "Associazioni perfette!" : "Associazioni sbagliate — vedi la soluzione qui sopra.";

    } else if (qType === 'crocette') {
        let selectedOldKeys = [];
        let checkboxes = document.querySelectorAll('.option-row input[type="checkbox"]');

        checkboxes.forEach(cb => {
            cb.disabled = true;
            if(cb.checked) selectedOldKeys.push(cb.dataset.oldkey);
        });

        let correctKeys = q.answer.replace(/\s/g, '').split(',');

        isCorrect = selectedOldKeys.length === correctKeys.length && selectedOldKeys.every(val => correctKeys.includes(val));

        document.querySelectorAll('.option-row').forEach(row => {
            let cb = row.querySelector('input');
            if (correctKeys.includes(cb.dataset.oldkey)) {
                row.classList.add('correct');
            } else if (cb.checked) {
                row.classList.add('wrong');
            }
        });

        feedbackText = isCorrect ? "Corretto!" : `Sbagliato.`;

    } else {
        let inputVal = document.getElementById('text-answer').value.trim().toLowerCase();
        let correctVal = (q.answer || '').toLowerCase();
        document.getElementById('text-answer').disabled = true;

        isCorrect = (inputVal === correctVal);
        feedbackText = isCorrect ? "Corretto!" : `Sbagliato.`;
    }

    let fbDiv = document.getElementById('feedback');
    fbDiv.innerText = feedbackText;
    fbDiv.className = isCorrect ? 'success' : 'error';
    fbDiv.classList.remove('hidden');

    if (isCorrect) {
        state.score++;
    } else {
        state.errorQuestions.push(q);
    }

    if(q.solution_image && imageMap[q.solution_image]) {
        let el = document.createElement('img');
        el.src = imageMap[q.solution_image];
        document.getElementById('image-container').appendChild(el);
    }

    let nxtBtn = document.getElementById('next-btn');
    nxtBtn.classList.remove('hidden');
    nxtBtn.onclick = () => {
        state.currentIndex++;
        if (state.currentIndex < state.activeQuestions.length) {
            renderQuestion();
        } else {
            showEndScreen();
        }
    };
}

function showEndScreen() {
    clearInterval(state.timerInterval);
    switchView('view-results');

    let timeStr = document.getElementById('timer').innerText;
    let errors = state.errorQuestions.length;
    let tot = state.activeQuestions.length;

    let statsHtml = `
        <span class="label">Punteggio</span>
        <div class="results-score">${state.score}<span> / ${tot}</span></div>
        <div class="results-grid">
            <div><span class="label">Tempo</span><b>${timeStr}</b></div>
            <div class="${errors > 0 ? 'bad' : 'good'}"><span class="label">Errori</span><b>${errors}</b></div>
        </div>
    `;
    document.getElementById('results-stats').innerHTML = statsHtml;

    let retryErrBtn = document.getElementById('retry-errors-btn');
    if (errors > 0) {
        retryErrBtn.classList.remove('hidden');
    } else {
        retryErrBtn.classList.add('hidden');
    }
}

function retryErrors() {
    startQuizCore([...state.errorQuestions]);
}

function retryShuffle() {
    let qList = [...state.activeQuestions];
    qList.sort(() => Math.random() - 0.5);
    startQuizCore(qList);
}

function quitQuiz() {
    clearInterval(state.timerInterval);
    switchView('view-db-select');
}

// ---- Uso da desktop: immagini ingrandibili e scorciatoie da tastiera ----
document.addEventListener('click', (e) => {
    const img = e.target.closest('#image-container img');
    if (!img) return;
    const lb = document.getElementById('lightbox');
    lb.querySelector('img').src = img.src;
    lb.classList.add('active');
});

document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const lb = document.getElementById('lightbox');
    if (lb.classList.contains('active')) {
        if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); lb.classList.remove('active'); }
        return;
    }
    // I popup gestiscono da soli la tastiera
    if (document.getElementById('modal-dialog').classList.contains('active')) return;
    if (document.getElementById('view-quiz').classList.contains('hidden')) return;

    const submitBtn = document.getElementById('submit-btn');
    const nextBtn = document.getElementById('next-btn');
    const typing = document.activeElement && document.activeElement.id === 'text-answer';

    if (e.key === 'Enter') {
        e.preventDefault();
        if (!submitBtn.classList.contains('hidden')) submitBtn.click();
        else if (!nextBtn.classList.contains('hidden')) nextBtn.click();
        return;
    }
    if (e.key === 'Escape' && !typing) { e.preventDefault(); quitQuiz(); return; }
    if (typing || e.key.length !== 1) return;

    const letter = e.key.toUpperCase();
    const cb = document.querySelector(`.option-row input[type="checkbox"][value="${letter}"]`);
    if (cb && !cb.disabled) { e.preventDefault(); cb.checked = !cb.checked; }
});
