const app = {
    token: localStorage.getItem('adminToken'),
    currentDeleteId: null,
    currentDeleteType: null,
    currentRecords: [],
    confirmCallback: null,

    init() {
        this.initTheme();
        if (this.token) this.showDashboard();
        
        document.getElementById('login-btn').onclick = () => this.login();
        document.getElementById('file-upload').onchange = (e) => this.handleFiles(e.target.files);
        document.getElementById('folder-upload').onchange = (e) => this.handleFiles(e.target.files);
        document.getElementById('theme-toggle').onclick = () => this.toggleTheme();
        document.getElementById('confirm-delete-btn').onclick = () => this.executeDelete();
        
        document.getElementById('confirm-yes-btn').onclick = () => this.handleConfirm(true);
        document.getElementById('confirm-no-btn').onclick = () => this.handleConfirm(false);
    },

    showSpinner(show) {
        document.getElementById('global-spinner').style.display = show ? 'flex' : 'none';
    },

    showConfirm(title, message, callback) {
        document.getElementById('confirm-title').innerText = title;
        document.getElementById('confirm-message').innerText = message;
        this.confirmCallback = callback;
        document.getElementById('confirm-modal').classList.add('active');
    },
    handleConfirm(choice) {
        document.getElementById('confirm-modal').classList.remove('active');
        if (this.confirmCallback) this.confirmCallback(choice);
    },

    // --- THEME ---
    initTheme() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
        this.updateThemeButton(savedTheme);
    },
    toggleTheme() {
        const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
        this.updateThemeButton(next);
    },
    updateThemeButton(theme) {
        const btn = document.getElementById('theme-toggle');
        const text = theme === 'light' ? 'Dark Mode' : 'Light Mode';
        btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg> ${text}`;
    },

    // --- AUTH ---
    async login() {
        this.showSpinner(true);
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const data = await res.json();
            if (res.ok) {
                this.token = data.token;
                localStorage.setItem('adminToken', this.token);
                this.showDashboard();
            } else {
                document.getElementById('login-error').innerText = data.error;
            }
        } finally { this.showSpinner(false); }
    },
    logout() { localStorage.removeItem('adminToken'); location.reload(); },
    showDashboard() {
        document.getElementById('login-screen').classList.remove('active');
        document.getElementById('dashboard-screen').classList.add('active');
    },
    
    // --- NAVIGATION ---
    navigate(viewName) {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        
        document.getElementById(`view-${viewName}`).classList.add('active');
        
        if (viewName === 'sessions') {
            document.querySelectorAll('.nav-btn')[1].classList.add('active');
            this.loadSessions();
        } else if (viewName === 'upload') {
            document.querySelectorAll('.nav-btn')[0].classList.add('active');
        } else if (viewName === 'duplicates') {
            document.querySelectorAll('.nav-btn')[2].classList.add('active');
            this.loadDuplicates();
        }
    },

    // --- IMAGE VALIDATION & UPLOAD ---
    async checkImageQuality(file) {
        return new Promise((resolve) => {
            const img = new Image();
            img.src = URL.createObjectURL(file);
            img.onload = () => {
                URL.revokeObjectURL(img.src);
                if (img.width < 500 || img.height < 500) {
                    resolve({ ok: false, reason: `Image too small (${img.width}x${img.height}). Please upload a clearer screenshot.` });
                } else {
                    resolve({ ok: true });
                }
            };
            img.onerror = () => resolve({ ok: false, reason: 'Invalid image file.' });
        });
    },

async handleFiles(files) {
    if (!files.length) return;
    const fileArray = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (fileArray.length === 0) return this.showToast('No valid images selected.', 'error');
    
    const progressContainer = document.getElementById('upload-progress');
    const progressText = document.getElementById('progress-text');
    const progressPercent = document.getElementById('progress-percent');
    const progressFill = document.getElementById('progress-fill');
    
    progressContainer.style.display = 'block';
    const processedPages = [];
    let totalDuplicates = 0;
    let keepDuplicates = false;
    let duplicatePromptShown = false;

    for (let i = 0; i < fileArray.length; i++) {
        const file = fileArray[i];

        // --- Quality check (only this file) ---
        progressText.innerText = `Checking quality: ${i+1}/${fileArray.length}`;
        const quality = await this.checkImageQuality(file);
        if (!quality.ok) {
            this.showToast(`Skipped ${file.name}: ${quality.reason}`, 'error');
            progressFill.style.width = `${((i + 1) / fileArray.length) * 100}%`;
            progressPercent.innerText = `${Math.round(((i + 1) / fileArray.length) * 100)}%`;
            continue;
        }

        // --- OCR (only this file) ---
        progressText.innerText = `Reading image ${i+1}/${fileArray.length}`;
        let text;
        try {
            const result = await Tesseract.recognize(file, 'eng', {
                logger: m => {
                    if (m.status === 'recognizing text') {
                        const fileProgress = m.progress * 100;
                        const overallProgress = ((i / fileArray.length) * 100) + (fileProgress / fileArray.length);
                        progressFill.style.width = `${overallProgress}%`;
                        progressPercent.innerText = `${Math.round(overallProgress)}%`;
                    }
                }
            });
            text = result.data.text;
        } catch (err) {
            this.showToast(`OCR failed on ${file.name}`, 'error');
            continue;
        }

        // --- Parse (only this file) ---
        const records = this.parseOCR(text);
        if (!records.length) {
            this.showToast(`No data found in ${file.name}`, 'error');
            progressFill.style.width = `${((i + 1) / fileArray.length) * 100}%`;
            progressPercent.innerText = `${Math.round(((i + 1) / fileArray.length) * 100)}%`;
            continue;
        }

        // --- Duplicate check (immediately, per file) ---
        const fileHashes = records.map(r => r.recordHash);
        progressText.innerText = `Checking duplicates for image ${i+1}/${fileArray.length}`;

        try {
            const dupRes = await fetch('/api/check-duplicate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
                body: JSON.stringify({ hashes: fileHashes })
            });
            const dupData = await dupRes.json();

            if (dupData.duplicates.length > 0) {
                totalDuplicates += dupData.duplicates.length;

                // Ask the user ONCE per batch, the first time a duplicate is seen.
                if (!duplicatePromptShown) {
                    duplicatePromptShown = true;
                    keepDuplicates = await new Promise((resolve) => {
                        this.showConfirm(
                            "Duplicate Data Detected",
                            `Found ${dupData.duplicates.length} duplicate(s) in "${file.name}". Do you want to save duplicates in the Duplicates folder? (This choice applies to the whole batch.)`,
                            (choice) => resolve(choice)
                        );
                    });
                }

                records.forEach(r => {
                    r.isDuplicate = dupData.duplicates.some(d => d.record_hash === r.recordHash)
                        ? keepDuplicates
                        : false;
                });
            } else {
                records.forEach(r => { r.isDuplicate = false; });
            }
        } catch (err) {
            // If DB check fails, do not silently drop — keep records as non-duplicate.
            records.forEach(r => { r.isDuplicate = false; });
        }

        processedPages.push({ records });
        progressFill.style.width = `${((i + 1) / fileArray.length) * 100}%`;
        progressPercent.innerText = `${Math.round(((i + 1) / fileArray.length) * 100)}%`;
    }

    if (processedPages.length === 0) {
        progressContainer.style.display = 'none';
        return this.showToast('No valid data extracted from uploaded files.', 'error');
    }

    // --- Save the whole batch at the end ---
    progressText.innerText = `Saving to database...`;
    const batchName = `Session - ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`;

    try {
        await fetch('/api/save-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
            body: JSON.stringify({ batchName, pages: processedPages })
        });
    } catch (err) {
        progressContainer.style.display = 'none';
        return this.showToast('Failed to save batch.', 'error');
    }

    progressContainer.style.display = 'none';
    progressFill.style.width = '0%';
    this.showToast(`Upload Complete! ${totalDuplicates} duplicate(s) detected.`, 'success');
    this.navigate('sessions');
},

    // --- YOUR ORIGINAL WORKING PARSER ---
    parseOCR(rawText) {
    if (!rawText || typeof rawText !== 'string') return [];

    const US_STATES = new Set([
        'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
        'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
        'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
        'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
        'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'
    ]);

    // 1. Flatten physical lines.
    const flatText = rawText
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // 2. Find record boundaries by NAME ANCHOR.
    //    A record begins when we see a capitalized word that comes
    //    immediately after a record-ending token: a DOB, an SSN, or a ZIP.
    //    This exhausts every field of the previous person before starting
    //    the next one, so nothing is dropped.
    const boundaryRegex = new RegExp(
        // Record-end signature: DOB  OR  SSN  OR  ZIP (optionally ZIP+4)
        String.raw`(?:\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b|\b\d{3}[-.]?\d{2}[-.]?\d{4}\b|\b\d{5}(?:-\d{4})?\b)` +
        // Then optionally the state code and/or other punctuation
        String.raw`[\s:;|,\-]*(?:[A-Z]{2}[\s:;|,\-]+)?` +
        // Then the start of a new name: an uppercase word of 2+ letters
        String.raw`(?=[A-Z][A-Za-z'\-]{1,})`,
        'g'
    );

    const boundaries = [];
    let m;
    while ((m = boundaryRegex.exec(flatText)) !== null) {
        // Index just after the anchor, so the new chunk starts at the new name.
        boundaries.push(boundaryRegex.lastIndex);
    }

    // Always include 0 (start) and end-of-string.
    if (boundaries.length === 0) return [];
    const startPoints = [0, ...boundaries.filter(i => i > 0 && i < flatText.length)];
    startPoints.push(flatText.length);

    const chunks = [];
    for (let i = 0; i < startPoints.length - 1; i++) {
        const chunk = flatText.slice(startPoints[i], startPoints[i + 1]).trim();
        if (chunk) chunks.push(chunk);
    }

    // 3. Extract each record from its own chunk.
    const records = [];
    for (const chunk of chunks) {
        const ssnMatch = chunk.match(/\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/);
        const dobMatch = chunk.match(/\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b/);
        const zipMatch = chunk.match(/\b\d{5}(?:-\d{4})?\b/);

        // Strip the numeric anchors so they don't pollute names.
        let body = chunk
            .replace(/\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/g, ' ')
            .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b/g, ' ')
            .replace(/\b\d{5}(?:-\d{4})?\b/g, ' ')
            .replace(/^[^A-Za-z]+/, '')  // drop leading junk
            .trim();

        const parts = body
            .split(/[:;|]+/)
            .map(p => p.trim())
            .filter(Boolean);

        if (parts.length < 2) continue;

        const firstName = (parts[0].match(/[A-Za-z'-]+/g) || []).join(' ').toUpperCase();
        const lastName  = (parts[1] || '').match(/[A-Za-z'-]+/g)?.join(' ').toUpperCase() || '';

        if (!firstName || !lastName) continue;

        const address = parts[2] || 'N/A';

        // State must be the 2-letter token immediately before the ZIP.
        let state = 'N/A';
        let city = 'N/A';
        if (zipMatch) {
            const zipPos = chunk.indexOf(zipMatch[0]);
            const beforeZip = chunk.slice(Math.max(0, zipPos - 40), zipPos).trim();
            const lastTok = beforeZip.match(/([A-Za-z]{2})\s*$/);
            if (lastTok && US_STATES.has(lastTok[1].toUpperCase())) {
                state = lastTok[1].toUpperCase();
            }
        }

        // City is between address and state, stripped of state token.
        const cityParts = parts.slice(3);
        if (cityParts.length) {
            const candidateCity = cityParts.join(' ');
            city = candidateCity.replace(/\b[A-Z]{2}\b\s*$/, '').trim() || 'N/A';
        }

        const ssn = ssnMatch ? ssnMatch[0] : 'N/A';
        const dob = dobMatch ? dobMatch[0] : 'N/A';
        const zip = zipMatch ? zipMatch[0] : 'N/A';

        // Skip only records that have NO name and NO SSN AND NO DOB (pure noise).
        if (ssn === 'N/A' && dob === 'N/A') continue;

        const recordHash =
            `${firstName}-${lastName}-${ssn.replace(/[^0-9]/g, '')}`;

        records.push({
            firstName,
            lastName,
            address,
            city,
            state,
            zip,
            ssn,
            dob,
            recordHash
        });
    }

    return records;
},
    // --- SESSIONS LIST ---
    async loadSessions() {
        this.showSpinner(true);
        try {
            const res = await fetch('/api/sessions', { headers: { 'Authorization': `Bearer ${this.token}` } });
            const sessions = await res.json();
            const list = document.getElementById('sessions-list');
            list.innerHTML = '';
            
            if (sessions.length === 0) {
                list.innerHTML = '<p style="color: var(--text-muted);">No sessions found. Upload some images to get started.</p>';
                return;
            }

            sessions.forEach(s => {
                const div = document.createElement('div');
                div.className = 'history-card';
                div.innerHTML = `
                    <div class="history-info">
                        <h3>${s.batch_name}</h3>
                        <p>${new Date(s.created_at).toLocaleString()} • ${s.record_count} records</p>
                    </div>
                    <div class="history-actions">
                        <button class="btn-danger" onclick="app.confirmDelete(${s.id}, 'session')">Delete</button>
                        <button class="btn-primary" onclick="app.viewResults(${s.id}, '${s.batch_name}', 'session')">View Data</button>
                    </div>
                `;
                list.appendChild(div);
            });
        } finally { this.showSpinner(false); }
    },

    // --- DUPLICATES LIST ---
    async loadDuplicates() {
        this.showSpinner(true);
        try {
            const res = await fetch('/api/duplicates', { headers: { 'Authorization': `Bearer ${this.token}` } });
            const duplicates = await res.json();
            const list = document.getElementById('duplicates-list');
            list.innerHTML = '';
            
            if (duplicates.length === 0) {
                list.innerHTML = '<p style="color: var(--text-muted);">No duplicate folders found.</p>';
                return;
            }

            duplicates.forEach(d => {
                const div = document.createElement('div');
                div.className = 'history-card duplicate';
                div.innerHTML = `
                    <div class="history-info">
                        <h3>${d.batch_name}</h3>
                        <p>${new Date(d.created_at).toLocaleString()} • ${d.record_count} duplicate records</p>
                    </div>
                    <div class="history-actions">
                        <button class="btn-danger" onclick="app.confirmDelete(${d.id}, 'duplicate')">Delete</button>
                        <button class="btn-primary" onclick="app.viewResults(${d.id}, '${d.batch_name}', 'duplicate')">View Data</button>
                    </div>
                `;
                list.appendChild(div);
            });
        } finally { this.showSpinner(false); }
    },

    // --- RESULTS & FILTERING ---
    async viewResults(id, batchName, type) {
        this.navigate('results');
        document.getElementById('results-title').innerText = batchName;
        document.getElementById('sort-filter').value = 'original';
        this.showSpinner(true);
        
        try {
            const endpoint = type === 'duplicate' ? `/api/duplicate/${id}` : `/api/session/${id}`;
            const res = await fetch(endpoint, { headers: { 'Authorization': `Bearer ${this.token}` } });
            let records = await res.json();

            // Separate duplicates from sessions
            if (type === 'session') {
                this.currentRecords = records.filter(r => r.is_duplicate !== true);
            } else {
                this.currentRecords = records.filter(r => r.is_duplicate === true);
            }

            this.renderRecords(this.currentRecords, type);
        } finally { this.showSpinner(false); }
    },

    renderRecords(records, type) {
        const grid = document.getElementById('results-grid');
        grid.innerHTML = '';
        
        if (records.length === 0) {
            grid.innerHTML = '<p style="color: var(--text-muted);">No records to display here.</p>';
            return;
        }
        
        records.forEach((r, index) => {
            const card = document.createElement('div');
            let cardClass = 'data-card';
            if (type === 'duplicate') cardClass += ' duplicate';
            
            card.className = cardClass;
            
            const pageLabel = type === 'duplicate' ? `Page ${r.page_number} Duplicate` : `Page ${r.page_number} Session`;

            card.innerHTML = `
                <div class="card-header">
                    <h3>${index + 1}. ${r.first_name} ${r.last_name}</h3>
                </div>
                <p><strong>Address:</strong> ${r.address}</p>
                <p><strong>Location:</strong> ${r.city}, ${r.state} ${r.zip}</p>
                <p><strong>SSN:</strong> ${r.ssn}</p>
                <p><strong>DOB:</strong> ${r.dob}</p>
                <p style="font-size: 12px; color: var(--text-muted); margin-top: 10px;">${pageLabel}</p>
                <button class="copy-btn" onclick="app.copyText('${r.first_name} ${r.last_name}', '${r.address}, ${r.city}, ${r.state} ${r.zip}', '${r.ssn}', '${r.dob}')">Copy Data</button>
            `;
            grid.appendChild(card);
        });
    },

    applySort() {
        const sortType = document.getElementById('sort-filter').value;
        let sorted = [...this.currentRecords];

        if (sortType === 'oldest') {
            sorted.sort((a, b) => this.calculateAge(b.dob) - this.calculateAge(a.dob));
        } else if (sortType === 'youngest') {
            sorted.sort((a, b) => this.calculateAge(a.dob) - this.calculateAge(b.dob));
        }
        this.renderRecords(sorted);
    },

    calculateAge(dobString) {
        if (dobString === 'N/A' || !dobString) return 0;
        const parts = dobString.split(/[\/\-]/);
        if (parts.length !== 3) return 0;
        
        const birthDate = new Date(parts[2], parts[0] - 1, parts[1]);
        const diff = Date.now() - birthDate.getTime();
        const ageDate = new Date(diff);
        return Math.abs(ageDate.getUTCFullYear() - 1970);
    },

    copyText(name, address, ssn, dob) {
        const text = `Name: ${name}\nAddress: ${address}\nSSN: ${ssn}\nDOB: ${dob}`;
        navigator.clipboard.writeText(text);
        this.showToast('Copied to clipboard!', 'success');
    },

    // --- DELETE FLOW ---
    confirmDelete(id, type) {
        this.currentDeleteId = id;
        this.currentDeleteType = type;
        document.getElementById('delete-modal').classList.add('active');
    },
    closeDeleteModal() {
        this.currentDeleteId = null;
        this.currentDeleteType = null;
        document.getElementById('delete-modal').classList.remove('active');
    },
    async executeDelete() {
        if (!this.currentDeleteId) return;
        this.showSpinner(true);
        try {
            const endpoint = this.currentDeleteType === 'duplicate' ? `/api/duplicate/${this.currentDeleteId}` : `/api/session/${this.currentDeleteId}`;
            const res = await fetch(endpoint, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            if (res.ok) {
                this.closeDeleteModal();
                this.showToast('Deleted successfully.', 'success');
                if (this.currentDeleteType === 'duplicate') this.loadDuplicates();
                else this.loadSessions();
            } else {
                this.showToast('Failed to delete.', 'error');
            }
        } finally { this.showSpinner(false); }
    },

    // --- TOAST NOTIFICATIONS ---
    showToast(message, type = 'info') {
        const toast = document.getElementById('toast');
        toast.innerText = message;
        
        if (type === 'error') toast.style.backgroundColor = 'var(--danger)';
        else if (type === 'success') toast.style.backgroundColor = '#10b981';
        else toast.style.backgroundColor = '#1e293b';
        
        toast.classList.add('show');
        setTimeout(() => { toast.classList.remove('show'); }, 3000);
    }
};

app.init();