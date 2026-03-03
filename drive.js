import fs from 'fs';
import path from 'path';
import process from 'process';
import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

class Drive {
    constructor() {
        this.authHttpClient = null;
        this.drive = null;
    }

    /**
     * Create an OAuth2 client from account credentials with forceRefreshOnFailure
     */
    createAuthClient(account) {
        const oauth2Client = new google.auth.OAuth2(
            account.client_id,
            account.client_secret
        );
        oauth2Client.setCredentials({
            refresh_token: account.refresh_token,
        });
        // Force token refresh on failure — prevents stale access tokens from causing errors
        oauth2Client.forceRefreshOnFailure = true;
        return oauth2Client;
    }

    /**
     * Authorize with a specific account object { client_id, client_secret, refresh_token }
     */
    async authorizeWithAccount(account) {
        try {
            const client = this.createAuthClient(account);

            // Proactively refresh the access token to catch invalid_grant early
            try {
                await client.getAccessToken();
            } catch (tokenErr) {
                const errMsg = tokenErr.message || '';
                if (errMsg.includes('invalid_grant') || errMsg.includes('Token has been expired or revoked')) {
                    throw new Error(
                        `Google Drive auth failed (invalid_grant): The refresh token for account "${account.name || 'Default'}" has expired or been revoked. ` +
                        'Please generate a new refresh token from Google Cloud Console and update the GDRIVE_ACCOUNTS env var in Render. ' +
                        'Also ensure your OAuth app is published to "Production" status so tokens don\'t expire every 7 days.'
                    );
                }
                throw tokenErr;
            }

            this.authHttpClient = client;
            this.drive = google.drive({ version: 'v3', auth: client });
            return client;
        } catch (err) {
            if (err.message.includes('invalid_grant')) {
                throw err; // Already formatted above
            }
            throw new Error(`Google Drive authorization failed: ${err.message}`);
        }
    }

    /**
     * Legacy authorize — loads from env vars or token.json (backward compatible)
     */
    async authorize() {
        let client = await this.loadSavedCredentialsIfExist();
        if (client) {
            // Wrap legacy client with forceRefreshOnFailure
            client.forceRefreshOnFailure = true;

            // Proactively test token
            try {
                await client.getAccessToken();
            } catch (tokenErr) {
                const errMsg = tokenErr.message || '';
                if (errMsg.includes('invalid_grant') || errMsg.includes('Token has been expired or revoked')) {
                    throw new Error(
                        'Google Drive auth failed (invalid_grant): Your refresh token has expired or been revoked. ' +
                        'Please generate a new refresh token and update your environment variables. ' +
                        'Ensure your Google OAuth app is published to "Production" status so tokens don\'t expire every 7 days.'
                    );
                }
                throw tokenErr;
            }

            this.authHttpClient = client;
            this.drive = google.drive({ version: 'v3', auth: client });
            return client;
        }

        // If running in cloud without credentials, throw a helpful error
        if (process.env.RENDER || process.env.NODE_ENV === 'production') {
            throw new Error('Google Drive credentials not configured! Set GDRIVE_ACCOUNTS env var, or set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN environment variables.');
        }

        // Local development: use interactive auth
        console.log("Authorizing...");
        const { authenticate } = await import('@google-cloud/local-auth');
        try {
            client = await authenticate({
                scopes: SCOPES,
                keyfilePath: CREDENTIALS_PATH,
            });
        } catch (error) {
            if (error.code === 'ENOENT' || error.message.includes('Cannot find module')) {
                console.error("Error: credentials.json not found.");
                throw new Error("Missing credentials.json!");
            }
            throw error;
        }

        if (client.credentials) {
            await this.saveCredentials(client);
        }
        this.authHttpClient = client;
        this.drive = google.drive({ version: 'v3', auth: client });
        return client;
    }

    async loadSavedCredentialsIfExist() {
        // First try environment variables (for cloud deployment)
        if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
            return google.auth.fromJSON({
                type: 'authorized_user',
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
            });
        }

        // Fallback to token.json file (for local development)
        try {
            const content = await fs.promises.readFile(TOKEN_PATH);
            const credentials = JSON.parse(content);
            return google.auth.fromJSON(credentials);
        } catch (err) {
            return null;
        }
    }

    async saveCredentials(client) {
        const content = await fs.promises.readFile(CREDENTIALS_PATH);
        const keys = JSON.parse(content);
        const key = keys.installed || keys.web;
        const payload = JSON.stringify({
            type: 'authorized_user',
            client_id: key.client_id,
            client_secret: key.client_secret,
            refresh_token: client.credentials.refresh_token,
        });
        await fs.promises.writeFile(TOKEN_PATH, payload);
    }

    async findOrCreateFolder(folderName) {
        if (!this.drive) {
            await this.authorize();
        }

        const query = `name='${folderName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
        const res = await this.drive.files.list({
            q: query,
            fields: 'files(id, name)',
            spaces: 'drive',
        });

        if (res.data.files && res.data.files.length > 0) {
            console.log(`Found existing folder: ${folderName} (${res.data.files[0].id})`);
            return res.data.files[0].id;
        }

        const folder = await this.drive.files.create({
            requestBody: {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
            },
            fields: 'id',
        });

        console.log(`Created new folder: ${folderName} (${folder.data.id})`);
        return folder.data.id;
    }

    async uploadStream(fileName, fileStream, mimeType, fileSize, onProgress, folderId) {
        if (!this.drive) {
            await this.authorize();
        }

        console.log(`Starting upload for ${fileName}...`);

        try {
            const requestBody = {
                name: fileName,
            };

            if (folderId) {
                requestBody.parents = [folderId];
            }

            const media = {
                mimeType: mimeType,
                body: fileStream,
            };

            const file = await this.drive.files.create({
                requestBody,
                media: media,
                fields: 'id, name',
            }, {
                onUploadProgress: evt => {
                    if (onProgress) {
                        onProgress(evt);
                    }
                }
            });

            return file.data.id;
        } catch (err) {
            console.error("Upload failed in drive.js:", err);
            throw err;
        }
    }

    async makePublic(fileId) {
        if (!this.drive) {
            await this.authorize();
        }

        await this.drive.permissions.create({
            fileId: fileId,
            requestBody: {
                type: 'anyone',
                role: 'reader',
            },
        });

        console.log(`Made public: ${fileId}`);
        return `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;
    }
}

export default Drive;
