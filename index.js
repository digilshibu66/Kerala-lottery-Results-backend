const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public'))); // Serve PDFs

// Database Connection
if (!process.env.DATABASE_URL) {
    console.error('CRITICAL ERROR: DATABASE_URL is not defined in environment variables.');
    console.error('Please create a .env file in the backend directory with your Supabase connection string.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Supabase
});

// Health Check
app.get('/', (req, res) => {
    res.send('Kerala Lottery API is running. Service Status: Operational.');
});

// Get Recent Draws
app.get('/api/draws', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, draw_date, lottery_name, draw_no, pdf_url FROM lottery_draws ORDER BY draw_date DESC LIMIT 30'
        );

        const data = result.rows.map(draw => ({
            ...draw,
            pdf_url: draw.pdf_url
        }));

        res.json({ success: true, data });
    } catch (err) {
        console.error('Error fetching draws:', err);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// Check Result Endpoint
app.get('/api/check', async (req, res) => {
    const { date, ticket } = req.query;

    if (!date || !ticket) {
        return res.status(400).json({
            success: false,
            message: 'Please provide both draw date and ticket number.'
        });
    }

    // Clean ticket input (remove spaces, uppercase)
    const cleanTicket = ticket.replace(/\s+/g, '').toUpperCase();

    // Extract potential parts: Series (2 letters) + Number (digits)
    // Supports formats: GB6789012, 987654, 8765
    const ticketMatch = cleanTicket.match(/^([A-Z]{0,2})(\d+)$/);
    if (!ticketMatch) {
        return res.status(400).json({ 
            success: false, 
            message: 'Invalid ticket format. Please enter letters (optional) followed by digits.' 
        });
    }

    const inputSeries = ticketMatch[1] || null; // e.g. "GB" or null
    const inputNumber = ticketMatch[2]; // e.g. "6789012" or "987654" or "8765"

    // Validate number length: minimum 4 digits, maximum 9 digits
    if (inputNumber.length < 4 || inputNumber.length > 9) {
        return res.status(400).json({ 
            success: false, 
            message: 'Ticket number must be between 4 and 9 digits.' 
        });
    }

    // Extract last 4 digits for consolation prize checking
    const last4Digits = inputNumber.slice(-4);

    try {
        // 1. Find the draw for the date
        const drawResult = await pool.query(
            'SELECT id, lottery_name, draw_no, pdf_url FROM lottery_draws WHERE draw_date = $1',
            [date]
        );

        if (drawResult.rows.length === 0) {
            return res.json({
                success: true,
                found: false,
                message: 'No results found for this date. Results are usually published after 3:00 PM.'
            });
        }

        const draw = drawResult.rows[0];

        // 2. Fetch all winning numbers for this draw
        const winningQuery = `
            SELECT wn.series, wn.number, wn.ticket_number as full_winning_ticket,
                   pc.category_name, pc.prize_amount
            FROM winning_numbers wn
            JOIN prize_categories pc ON wn.category_id = pc.id
            WHERE pc.draw_id = $1
        `;

        const winners = await pool.query(winningQuery, [draw.id]);

        let bestWin = null;

        // Check each winning number against the input
        for (const win of winners.rows) {
            const winNum = win.number;
            const winSeries = win.series;
            let isMatch = false;

            // MATCHING STRATEGY (3 levels):
            // 1. Full match with series (if user provided series): inputSeries + inputNumber === winSeries + winNum
            // 2. Number-only match: inputNumber === winNum (ignoring series)
            // 3. Last 4 digits match: last4Digits === last 4 of winNum

            // Level 1: Full match with series
            if (inputSeries && winSeries) {
                if (inputSeries === winSeries && inputNumber === winNum) {
                    isMatch = true;
                }
            }

            // Level 2: Number-only match (when user doesn't provide series OR winner has no series)
            if (!isMatch) {
                if (inputNumber === winNum) {
                    // If winner has a series but user didn't provide one, still match on number
                    // This handles cases where user types only digits
                    isMatch = true;
                }
            }

            // Level 3: Last 4 digits match (for consolation prizes)
            if (!isMatch) {
                const winLast4 = winNum.slice(-4);
                if (last4Digits === winLast4) {
                    isMatch = true;
                }
            }

            // If we found a match, check if it's the best prize so far
            if (isMatch) {
                if (!bestWin || parseFloat(win.prize_amount) > parseFloat(bestWin.prize_amount)) {
                    bestWin = win;
                }
            }
        }

        // Return result
        if (bestWin) {
            const fullPdfUrl = draw.pdf_url;

            return res.json({
                success: true,
                found: true,
                result: 'WIN',
                data: {
                    lotteryName: draw.lottery_name,
                    drawNo: draw.draw_no,
                    prizeName: bestWin.category_name,
                    prizeAmount: bestWin.prize_amount,
                    winningTicket: bestWin.full_winning_ticket,
                    pdfUrl: fullPdfUrl
                }
            });
        } else {
            const fullPdfUrl = draw.pdf_url;

            return res.json({
                success: true,
                found: true,
                result: 'NO_WIN',
                data: {
                    lotteryName: draw.lottery_name,
                    drawNo: draw.draw_no,
                    pdfUrl: fullPdfUrl
                }
            });
        }

    } catch (err) {
        console.error('Error checking result:', err);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

const { startScheduler, scrapeLatestDraw, scrapeDraws } = require('./scraper');

// Start the scheduler
startScheduler();

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

// Admin endpoint to manually trigger scrape
app.get('/api/admin/trigger-scrape', async (req, res) => {
    try {
        const { all } = req.query;
        if (all === 'true') {
            console.log('Manual FULL scrape triggered by admin...');
            scrapeDraws(); // Scrapes everything on page not in DB
        } else {
            console.log('Manual LATEST scrape triggered by admin...');
            scrapeLatestDraw();
        }
        res.json({ success: true, message: 'Scraping job started in background.' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
