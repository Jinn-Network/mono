-- Migration: Remove service_type from services table
-- Rationale: The distinction between types is fuzzy - all services are essentially APIs
-- What a service exposes is better described by the interfaces table

DROP INDEX IF EXISTS idx_services_service_type;
ALTER TABLE services DROP COLUMN IF EXISTS service_type;
