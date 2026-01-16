-- PostgreSQL database grants setup
-- This script sets up permissions and required extensions for both the primary
-- agpwiki database and the isolated agpwiki_test database.

-- Grant database-level permissions to agpwiki_user
GRANT ALL PRIVILEGES ON DATABASE agpwiki TO agpwiki_user;
GRANT ALL PRIVILEGES ON DATABASE agpwiki_test TO agpwiki_user;

-- Configure the primary application database
\c agpwiki;
GRANT ALL ON SCHEMA public TO agpwiki_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO agpwiki_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO agpwiki_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO agpwiki_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO agpwiki_user;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Configure the test database (used by the test harness)
\c agpwiki_test;
GRANT ALL ON SCHEMA public TO agpwiki_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO agpwiki_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO agpwiki_user;
-- Grant permissions on future tables/sequences
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO agpwiki_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO agpwiki_user;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
