let state = {
    allQuestions: [],
    activeQuestions: [],
    errorQuestions: [],
    currentIndex: 0,
    score: 0,
    startTime: null,
    timerInterval: null,
    currentDb: null
};

let imageMap = {};
let currentSelectedMatchItem = null;

window.onload = () => {
    switchView('view-db-select');
};

function switchView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.getElementById(viewId).classList.remove('hidden');
}

function processFiles() {
    const files = document.getElementById('file-input').files;
    let jsonFile = null;
    imageMap = {};

    for (let file of files) {
        if (file.name.endsWith('.json')) {
            jsonFile = file;
        } else if (file.type.startsWith('image/')) {
            imageMap[file.name] = URL.createObjectURL(file);
        }
    }

    if (!jsonFile) {
        alert("Errore critico: Seleziona il file .json del database.");
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
            alert("File JSON corrotto o malformato. Impossibile procedere.");
        }
    };
    reader.readAsText(jsonFile);
}

function startMode(mode, isShuffle = false) {
    let qList = [...state.allQuestions];

    if (mode === 'crocette' || mode === 'dariempire') {
        qList = qList.filter(q => (q.type || 'crocette') === mode);
    }

    if (isShuffle || mode === 'shuffle') {
        qList.sort(() => Math.random() - 0.5);
    }

    let limit = prompt(`Totale domande: ${qList.length}. Quante ne vuoi fare? (Lascia vuoto per tutte, o usa formato '1-30')`);
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

    if(qList.length === 0) { 
        alert("Nessuna domanda selezionata"); 
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
            row.appendChild(document.createTextNode(`${newLetter}: ${text}`));
            ui.opts.appendChild(row);
        });
    

    } else if (qType === 'tap_match') {
        ui.opts.classList.remove('hidden');
        ui.opts.innerHTML = '<div id="match-area"></div>';
        const matchArea = document.getElementById('match-area');
        
        // Crea area sorgente
        const sourceDiv = document.createElement('div');
        sourceDiv.className = 'match-source';
        sourceDiv.id = 'match-source';
        
        // Mischia e crea gli item
        let shuffledItems = [...q.items].sort(() => Math.random() - 0.5);
        shuffledItems.forEach(itemText => {
            let el = document.createElement('div');
            el.className = 'match-item';
            el.innerText = itemText;
            el.onclick = function() {
                document.querySelectorAll('.match-item').forEach(i => i.classList.remove('selected'));
                this.classList.add('selected');
                currentSelectedMatchItem = this;
            };
            sourceDiv.appendChild(el);
        });
        
        matchArea.appendChild(sourceDiv);
        
        // Crea le categorie (i secchi)
        q.categories.forEach(catName => {
            let catDiv = document.createElement('div');
            catDiv.className = 'match-category';
            catDiv.innerHTML = `<h3>${catName}</h3>`;
            
            let bucket = document.createElement('div');
            bucket.className = 'match-bucket';
            bucket.dataset.category = catName;
            
            // Logica di assegnazione al tocco sulla categoria
            catDiv.onclick = function() {
                if (currentSelectedMatchItem) {
                    currentSelectedMatchItem.classList.remove('selected');
                    bucket.appendChild(currentSelectedMatchItem);
                    currentSelectedMatchItem = null;
                } else if (event.target.classList.contains('match-item')) {
                    // Se tocchi un item già assegnato, lo rimette nella sorgente
                    document.getElementById('match-source').appendChild(event.target);
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
        let buckets = document.querySelectorAll('.match-bucket');
        
        // Se ci sono ancora elementi non assegnati
        if (document.getElementById('match-source').children.length > 0) {
            allCorrect = false;
        }

        buckets.forEach(bucket => {
            let catName = bucket.dataset.category;
            Array.from(bucket.children).forEach(itemNode => {
                let itemText = itemNode.innerText;
                if (q.answer[itemText] === catName) {
                    itemNode.style.border = "2px solid var(--success)";
                } else {
                    itemNode.style.border = "2px solid var(--error)";
                    allCorrect = false;
                }
            });
        });

        isCorrect = allCorrect;
        feedbackText = isCorrect ? "Associazioni perfette!" : "Ci sono errori nelle associazioni. Controlla gli elementi rossi.";

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
        <h2 style="font-size: 2rem; color: var(--text-main)">Score: ${state.score} / ${tot}</h2>
        <p>Tempo: ${timeStr}</p>
        <p style="color: ${errors > 0 ? 'var(--error)' : 'var(--success)'}">Errori: ${errors}</p>
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
