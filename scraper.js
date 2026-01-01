const axios = require('axios');
const cheerio = require('cheerio');
const { Pool } = require('pg');
const pdf = require('pdf-parse');
const cron = require('node-cron');
const https = require('https');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const BASE_URL = 'https://statelottery.kerala.gov.in';
const RESULT_URL = `${BASE_URL}/index.php/lottery-result-view`;

// Headers to mimic a real browser to avoid 403/503 errors
const AXIOS_CONFIG = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
    },
    timeout: 30000, // 30 seconds timeout
    httpsAgent: new https.Agent({
        rejectUnauthorized: false
    })
};

async function scrapeDraws(targetDate = null) {
    console.log(`[${new Date().toISOString()}] Starting scraper task... Target Date: ${targetDate || 'All available'}`);

    try {
        // Fetch Lottery Website HTML
        console.log(`Fetching ${RESULT_URL}...`);
        const { data: html } = await axios.get(RESULT_URL, AXIOS_CONFIG);
        const $ = cheerio.load(html);

        const rowsToProcess = [];

        // 1. Find all eligible rows
        $('table tr').each((i, row) => {
            const cols = $(row).find('td');
            if (cols.length >= 3) {
                const lotteryName = $(cols[0]).text().trim();
                const drawDateRaw = $(cols[1]).text().trim();
                const linkElement = $(cols[2]).find('a');
                const link = linkElement.attr('href');

                const parts = drawDateRaw.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);

                if (parts && link) {
                    const drawDateISO = `${parts[3]}-${parts[2].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;

                    // Filter by target date if provided
                    if (targetDate && drawDateISO !== targetDate) return;

                    rowsToProcess.push({
                        name: lotteryName,
                        date: drawDateISO,
                        url: link.startsWith('http') ? link : `${BASE_URL}/${link}`
                    });
                }
            }
        });

        console.log(`Found ${rowsToProcess.length} possible results on page. Checking database...`);

        // 2. Process each row
        for (const draw of rowsToProcess) {
            // Check if already in DB
            const exists = await pool.query('SELECT id FROM lottery_draws WHERE draw_date = $1', [draw.date]);
            if (exists.rows.length > 0) {
                if (targetDate) console.log(`Skipping ${draw.date}: Already exists.`);
                continue;
            }

            console.log(`\n--- Scraping: ${draw.name} (${draw.date}) ---`);

            try {
                // Download PDF
                const pdfResponse = await axios.get(draw.url, { ...AXIOS_CONFIG, responseType: 'arraybuffer' });

                // SAVE PDF LOCALLY
                const pdfDir = path.join(__dirname, 'public', 'pdfs');
                if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });

                const filename = `${draw.name.replace(/[^a-z0-9]/gi, '_')}_${draw.date}.pdf`;
                const localPath = path.join(pdfDir, filename);
                fs.writeFileSync(localPath, pdfResponse.data);

                const localUrl = `/public/pdfs/${filename}`;
                const pdfData = await pdf(pdfResponse.data);
                const results = parseLotteryPdfText(pdfData.text);

                // Insert into DB
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    const drawNo = extractDrawNo(draw.name);
                    const drawRes = await client.query(
                        'INSERT INTO lottery_draws (draw_date, lottery_name, draw_no, pdf_url) VALUES ($1, $2, $3, $4) RETURNING id',
                        [draw.date, draw.name, drawNo, localUrl]
                    );
                    const drawId = drawRes.rows[0].id;

                    for (const prize of results) {
                        const catRes = await client.query(
                            'INSERT INTO prize_categories (draw_id, category_name, prize_amount) VALUES ($1, $2, $3) RETURNING id',
                            [drawId, prize.category, prize.amount]
                        );
                        const catId = catRes.rows[0].id;

                        for (const ticket of prize.tickets) {
                            const { series, number } = parseTicketString(ticket);
                            await client.query(
                                'INSERT INTO winning_numbers (category_id, ticket_number, series, number) VALUES ($1, $2, $3, $4)',
                                [catId, ticket, series, number]
                            );
                        }
                    }
                    await client.query('COMMIT');
                    console.log(`Successfully saved ${draw.date} to database!`);
                } catch (dbErr) {
                    await client.query('ROLLBACK');
                    console.error(`DB Error for ${draw.date}:`, dbErr.message);
                } finally {
                    client.release();
                }
            } catch (scrapeErr) {
                console.error(`Scrape Error for ${draw.date}:`, scrapeErr.message);
            }
        }

        console.log('\nScraper job finished.');

    } catch (err) {
        console.error('Scraper page fetch error:', err.message);
    }
}

// Renamed for clarity but kept export same for compatibility
const scrapeLatestDraw = () => {
    // Determine IST today
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(now.getTime() + istOffset);
    const dateStr = istDate.toISOString().split('T')[0];
    return scrapeDraws(dateStr);
};

// Helper: Extract Draw Number (e.g. "KR-123")
function extractDrawNo(name) {
    const match = name.match(/([A-Z]+-\d+)/);
    return match ? match[1] : name.split(' ')[0];
}

// Helper: Parse Ticket (e.g. "AA 123456" or "1234")
function parseTicketString(ticket) {
    const clean = ticket.trim().replace(/\s+/g, ''); // Remove spaces for analysis
    // formatting back for DB
    // Regex for Series+Number: 2 letters followed by numbers
    const match = ticket.match(/^([A-Z]{2})\s*(\d+)$/);
    if (match) {
        return { series: match[1], number: match[2] };
    }
    // Just Number
    return { series: null, number: clean };
}

// KEY LOGIC: Much more robust Text Parser for Kerala Lottery PDFs
function parseLotteryPdfText(text) {
    const results = [];

    // Define prize categories to look for in order
    const prizeDefinitions = [
        { key: '1st Prize', amountRegex: /1st Prize.*?Rs\s*[:]\s*([\d,]+)/i, hasSeries: true },
        { key: 'Consolation', searchKeys: ['Cons Prize', 'Consolation Prize'], amountRegex: /(?:Cons Prize|Consolation Prize).*?Rs\s*[:]\s*([\d,]+)/i, hasSeries: true },
        { key: '2nd Prize', amountRegex: /2nd Prize.*?Rs\s*[:]\s*([\d,]+)/i, hasSeries: true },
        { key: '3rd Prize', amountRegex: /3rd Prize.*?Rs\s*[:]\s*([\d,]+)/i, hasSeries: true },
        { key: '4th Prize', amountRegex: /4th Prize.*?Rs\s*[:]\s*([\d,]+)/i, hasSeries: false },
        { key: '5th Prize', amountRegex: /5th Prize.*?Rs\s*[:]\s*([\d,]+)/i, hasSeries: false },
        { key: '6th Prize', amountRegex: /6th Prize.*?Rs\s*[:]\s*([\d,]+)/i, hasSeries: false },
        { key: '7th Prize', amountRegex: /7th Prize.*?Rs\s*[:]\s*([\d,]+)/i, hasSeries: false },
        { key: '8th Prize', amountRegex: /8th Prize.*?Rs\s*[:]\s*([\d,]+)/i, hasSeries: false },
        { key: '9th Prize', amountRegex: /9th Prize.*?Rs\s*[:]\s*([\d,]+)/i, hasSeries: false },
        { key: '10th Prize', amountRegex: /10th Prize.*?Rs\s*[:]\s*([\d,]+)/i, hasSeries: false }
    ];

    // Split the text into sections based on the start of each prize
    // We'll look for strings like "Xth Prize" or "Cons Prize"
    const sections = [];
    let currentPos = 0;

    const findNextMarker = (pos) => {
        let bestMatch = null;
        for (const def of prizeDefinitions) {
            const keys = def.searchKeys || [def.key];
            for (const k of keys) {
                const idx = text.indexOf(k, pos);
                if (idx !== -1 && (bestMatch === null || idx < bestMatch.idx)) {
                    bestMatch = { idx, key: k, def };
                }
            }
        }
        // Also look for footer
        const footerIdx = text.indexOf('The prize winners are advised', pos);
        if (footerIdx !== -1 && (bestMatch === null || footerIdx < bestMatch.idx)) {
            bestMatch = { idx: footerIdx, key: 'FOOTER', def: null };
        }
        return bestMatch;
    };

    let marker = findNextMarker(0);
    while (marker) {
        const nextMarker = findNextMarker(marker.idx + marker.key.length);
        const endIdx = nextMarker ? nextMarker.idx : text.length;
        const blockText = text.substring(marker.idx, endIdx);

        if (marker.def) {
            const amountMatch = blockText.match(marker.def.amountRegex);
            const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : 0;

            if (amount > 0) {
                const tickets = extractTicketsFromBlock(blockText, marker.def.hasSeries);
                if (tickets.length > 0) {
                    results.push({
                        category: marker.def.key,
                        amount: amount,
                        tickets: tickets
                    });
                }
            }
        }
        marker = nextMarker;
    }

    return results;
}

function extractTicketsFromBlock(block, hasSeries) {
    const tickets = [];

    // Remove the header line (usually contains the prize name and amount)
    const lines = block.split('\n');
    const content = lines.slice(1).join('\n');

    if (hasSeries) {
        // Look for [2 letters][6 digits] e.g., DF 869610 or DF869610
        // We use global search to find all instances
        const regex = /([A-Z]{2})\s*(\d{6})/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
            tickets.push(`${match[1]} ${match[2]}`);
        }
    } else {
        // Look for 4 digit numbers
        // Often they are run together like 038304630500
        // We look for any sequence of digits and split it into 4s if multiple of 4
        const digitBlocks = content.match(/\d+/g) || [];
        for (const block of digitBlocks) {
            // Some blocks might contain other numbers (like "Page 1"), so we filter
            // Usually lottery numbers are in groups of 4 or run together
            if (block.length >= 4) {
                for (let i = 0; i <= block.length - 4; i += 4) {
                    const num = block.substring(i, i + 4);
                    // Minimal validation: must be exactly 4 digits from the substring
                    if (/^\d{4}$/.test(num)) {
                        tickets.push(num);
                    }
                }
            }
        }
    }

    // Deduplicate just in case
    return [...new Set(tickets)];
}


// Scheduler Function
function startScheduler() {
    console.log('Initializing Scheduler...');

    // Schedule to run at 3:30 PM and 4:00 PM IST
    // 3:30 PM IST -> "30 15 * * *"
    // 4:00 PM IST -> "0 16 * * *"

    cron.schedule('30 15 * * *', () => {
        console.log('Running scheduled 3:30 PM IST scrape...');
        scrapeLatestDraw();
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });

    cron.schedule('0 16 * * *', () => {
        console.log('Running scheduled 4:00 PM IST scrape...');
        scrapeLatestDraw();
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });

    console.log('Scheduler is running. Jobs scheduled for 3:30 PM and 4:00 PM IST daily.');
}

// Allow manual run if called directly
if (require.main === module) {
    scrapeLatestDraw();
}

module.exports = { startScheduler, scrapeLatestDraw, scrapeDraws };
