# Intelligence-Org Supabase Database Backup

**Project ID**: kmptsnmabdwgjyctowyz  
**Project Name**: intelligence-org  
**Region**: eu-west-1  
**Status**: ACTIVE_HEALTHY  
**Database Version**: PostgreSQL 17.4.1.043  
**Created**: 2025-06-12T15:33:32.101239Z  
**Backed Up**: 2025-11-25

## Contents

- `migrations.json` - All migration files with versions and names
- `tables-schema.json` - Complete table structures with columns, constraints, foreign keys
- `enums.json` - All custom enum types
- `views.sql` - Database views
- `extensions.json` - Installed and available extensions

## Restore Notes

This backup contains the complete schema structure. To restore:

1. Create a new Supabase project
2. Apply migrations in order (see migrations.json)
3. Or use the DDL files to recreate schema manually

## Extensions Used

- pg_graphql (1.5.11)
- pg_cron (1.6) 
- vector (0.8.0)
- uuid-ossp (1.1)
- pgcrypto (1.3)
- pg_stat_statements (1.11)
- supabase_vault (0.3.1)















