-- Migration 002: Add margin_call_grace_ticks column to rooms table
-- This controls how many ticks a student has to restore margin before forced liquidation

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS margin_call_grace_ticks integer DEFAULT 30;
