/** The redirect URI the stored Wispr client was registered with; a different one means registering again. */
export const sql = 'ALTER TABLE wispr_auth ADD COLUMN redirect_uri TEXT;';
