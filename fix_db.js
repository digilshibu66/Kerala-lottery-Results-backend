const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function fixDatabase() {
    console.log('Connecting to database to add missing constraints...');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Adding UNIQUE constraint to prize_categories...');
        // First delete any potential duplicates to avoid constraint error
        await client.query(`
            DELETE FROM prize_categories a USING (
                SELECT MIN(ctid) as keep_ctid, draw_id, category_name
                FROM prize_categories
                GROUP BY draw_id, category_name
                HAVING COUNT(*) > 1
            ) b
            WHERE a.draw_id = b.draw_id 
            AND a.category_name = b.category_name 
            AND a.ctid <> b.keep_ctid
        `);
        await client.query('ALTER TABLE prize_categories ADD CONSTRAINT unique_draw_category UNIQUE (draw_id, category_name)');

        console.log('Adding UNIQUE constraint to winning_numbers...');
        // Delete duplicates for winning numbers
        await client.query(`
            DELETE FROM winning_numbers a USING (
                SELECT MIN(ctid) as keep_ctid, category_id, ticket_number
                FROM winning_numbers
                GROUP BY category_id, ticket_number
                HAVING COUNT(*) > 1
            ) b
            WHERE a.category_id = b.category_id 
            AND a.ticket_number = b.ticket_number 
            AND a.ctid <> b.keep_ctid
        `);
        await client.query('ALTER TABLE winning_numbers ADD CONSTRAINT unique_category_ticket UNIQUE (category_id, ticket_number)');

        await client.query('COMMIT');
        console.log('Database constraints added successfully!');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error fixing database:', err.message);
        console.log('Note: If the constraints already exist, this error is normal.');
    } finally {
        client.release();
        process.exit();
    }
}

fixDatabase();
