-- The same server_integrations shape as every OpenStuff app, so the shared @openstuff-dev/server
-- routes run here unchanged. OpenVersion never connects to an OpenVersion, so this column stays empty.
ALTER TABLE server_integrations ADD COLUMN IF NOT EXISTS deploy_token_encrypted text;
