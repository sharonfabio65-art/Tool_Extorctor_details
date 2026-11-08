require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const authenticateToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.sendStatus(401);
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (email !== process.env.ADMIN_EMAIL) return res.status(401).json({ error: 'Invalid email' });
    const validPassword = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);
    if (!validPassword) return res.status(401).json({ error: 'Invalid password' });
    const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ token });
});

app.post('/api/check-duplicate', authenticateToken, async (req, res) => {
    const { hashes } = req.body;
    try {
        const result = await pool.query('SELECT record_hash FROM records WHERE record_hash = ANY($1)', [hashes]);
        res.json({ duplicates: result.rows });
    } catch (err) { res.status(500).json({ error: 'DB Error' }); }
});

app.post('/api/save-batch', authenticateToken, async (req, res) => {
    const { batchName, pages } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        let sessionId = null;
        let duplicateId = null;

        const hasRealData = pages.some(p => p.records.some(r => r.isDuplicate === false));
        if (hasRealData) {
            const sessionResult = await client.query(
                'INSERT INTO sessions (batch_name) VALUES ($1) RETURNING id',
                [batchName]
            );
            sessionId = sessionResult.rows[0].id;
        }

        const hasDuplicates = pages.some(p => p.records.some(r => r.isDuplicate === true));
        if (hasDuplicates) {
            const dupResult = await client.query(
                'INSERT INTO duplicates (batch_name) VALUES ($1) RETURNING id',
                [`${batchName} (Duplicates)`]
            );
            duplicateId = dupResult.rows[0].id;
        }

        // --- BULK INSERT: one query for all records ---
        const values = [];
        const params = [];
        let paramIndex = 1;

        for (let i = 0; i < pages.length; i++) {
            const pageNum = i + 1;
            for (const r of pages[i].records) {
                values.push(
                    `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
                );
                params.push(
                    r.isDuplicate ? null : sessionId,
                    r.isDuplicate ? duplicateId : null,
                    pageNum,
                    r.firstName,
                    r.lastName,
                    r.address,
                    r.city,
                    r.state,
                    r.zip,
                    r.ssn,
                    r.dob,
                    r.recordHash,
                    r.isDuplicate
                );
            }
        }

        if (values.length > 0) {
            const query = `
                INSERT INTO records
                    (session_id, duplicate_id, page_number, first_name, last_name, address, city, state, zip, ssn, dob, record_hash, is_duplicate)
                VALUES ${values.join(', ')}
            `;
            await client.query(query, params);
        }

        await client.query('COMMIT');
        res.json({ success: true, sessionId, duplicateId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("=== SAVE BATCH ERROR ===");
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

app.get('/api/sessions', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.id, s.batch_name, s.created_at, COUNT(r.id) as record_count 
            FROM sessions s 
            LEFT JOIN records r ON s.id = r.session_id 
            GROUP BY s.id ORDER BY s.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'DB Error' }); }
});

app.get('/api/duplicates', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT d.id, d.batch_name, d.created_at, COUNT(r.id) as record_count 
            FROM duplicates d 
            LEFT JOIN records r ON d.id = r.duplicate_id 
            GROUP BY d.id ORDER BY d.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'DB Error' }); }
});

app.get('/api/session/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM records WHERE session_id = $1 ORDER BY page_number ASC, id ASC', [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'DB Error' }); }
});

app.get('/api/duplicate/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM records WHERE duplicate_id = $1 ORDER BY page_number ASC, id ASC', [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'DB Error' }); }
});

app.delete('/api/session/:id', authenticateToken, async (req, res) => {
    try {
        await pool.query('DELETE FROM records WHERE session_id = $1', [req.params.id]);
        await pool.query('DELETE FROM sessions WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'DB Error' }); }
});

app.delete('/api/duplicate/:id', authenticateToken, async (req, res) => {
    try {
        await pool.query('DELETE FROM records WHERE duplicate_id = $1', [req.params.id]);
        await pool.query('DELETE FROM duplicates WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'DB Error' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));