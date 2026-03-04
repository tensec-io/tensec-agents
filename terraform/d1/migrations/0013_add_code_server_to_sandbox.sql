-- Code-server tunnel URL and password on the sandbox table.
-- URL rotates on every wake/restore; password is stable per session.
ALTER TABLE sandbox ADD COLUMN code_server_url TEXT;
ALTER TABLE sandbox ADD COLUMN code_server_password TEXT;
