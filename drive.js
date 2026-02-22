import fs from 'fs';
import path from 'path';
import process from 'process';
import { authenticate } from '@google-cloud/local-auth';
import { google } from 'googleapis';

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

class Drive {
    constructor() {
        this.authHttpClient = null;
        this.drive = null;
    }

    async loadSavedCredentialsIfExist() {
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

    async authorize() {
        let client = await this.loadSavedCredentialsIfExist();
        if (client) {
            this.authHttpClient = client;
            this.drive = google.drive({ version: 'v3', auth: client });
            return client;
        }

        console.log("Authorizing...");
        try {
            client = await authenticate({
                scopes: SCOPES,
                keyfilePath: CREDENTIALS_PATH,
            });
        } catch (error) {
            if (error.code === 'ENOENT' || error.message.includes('Cannot find module')) {
                console.error("Error: credentials.json not found. Please place it in the root directory.");
                throw new Error("Missing credentials.json! Please download it from Google Cloud Console and place it in the project folder.");
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

    async findOrCreateFolder(folderName) {
        if (!this.drive) {
            await this.authorize();
        }

        // Search for existing folder with this name
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

        // Create new folder
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

            // If a folder ID is provided, place the file inside it
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
}

export default new Drive();
