-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Lottery Draws Table
CREATE TABLE IF NOT EXISTS lottery_draws (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    draw_date DATE NOT NULL UNIQUE,
    lottery_name VARCHAR(100) NOT NULL,
    draw_no VARCHAR(50) NOT NULL,
    pdf_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Prize Categories Table
CREATE TABLE IF NOT EXISTS prize_categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    draw_id UUID REFERENCES lottery_draws(id) ON DELETE CASCADE,
    category_name VARCHAR(100) NOT NULL,
    prize_amount DECIMAL(12, 2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Winning Numbers Table
CREATE TABLE IF NOT EXISTS winning_numbers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category_id UUID REFERENCES prize_categories(id) ON DELETE CASCADE,
    ticket_number VARCHAR(20) NOT NULL,
    series VARCHAR(10),
    number VARCHAR(10),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indices
CREATE INDEX idx_winning_numbers_ticket ON winning_numbers(ticket_number);
CREATE INDEX idx_winning_numbers_full ON winning_numbers(series, number);
CREATE INDEX idx_draw_date ON lottery_draws(draw_date);
