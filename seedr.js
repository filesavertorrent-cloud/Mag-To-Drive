import axios from 'axios';
import FormData from 'form-data';

class Seedr {
    constructor(email, password) {
        this.email = email;
        this.password = password;
        this.token = null;
        this.refreshToken = null;
    }

    /**
     * Login to Seedr using OAuth (works with free accounts)
     */
    async login() {
        const data = new FormData();
        data.append('grant_type', 'password');
        data.append('client_id', 'seedr_chrome');
        data.append('type', 'login');
        data.append('username', this.email);
        data.append('password', this.password);

        const res = await axios({
            method: 'post',
            url: 'https://www.seedr.cc/oauth_test/token.php',
            headers: data.getHeaders(),
            data: data,
        });

        if (res.data.error) {
            throw new Error(`Seedr login failed: ${res.data.error_description || res.data.error}`);
        }

        this.token = res.data.access_token;
        this.refreshToken = res.data.refresh_token;
        console.log('Seedr login successful!');
        return this.token;
    }

    /**
     * Ensure we have a valid token
     */
    async ensureAuth() {
        if (!this.token) {
            await this.login();
        }
    }

    /**
     * Make an API call to Seedr's resource endpoint
     */
    async apiCall(func, extraFields = {}) {
        await this.ensureAuth();

        const data = new FormData();
        data.append('access_token', this.token);
        data.append('func', func);

        for (const [key, value] of Object.entries(extraFields)) {
            data.append(key, value);
        }

        const res = await axios({
            method: 'post',
            url: 'https://www.seedr.cc/oauth_test/resource.php',
            headers: data.getHeaders(),
            data: data,
        });

        // If token expired, re-login and retry
        if (res.data.error === 'expired_token') {
            await this.login();
            return this.apiCall(func, extraFields);
        }

        return res.data;
    }

    /**
     * Add a magnet link to Seedr for downloading
     */
    async addMagnet(magnetLink) {
        return this.apiCall('add_torrent', {
            torrent_magnet: magnetLink,
        });
    }

    /**
     * Get contents of a folder (root if no ID provided)
     */
    async getFolderContents(folderId = '') {
        await this.ensureAuth();

        const url = folderId
            ? `https://www.seedr.cc/api/folder/${folderId}?access_token=${this.token}`
            : `https://www.seedr.cc/api/folder?access_token=${this.token}`;

        const res = await axios.get(url);
        return res.data;
    }

    /**
     * Get file download URL (fetch_file returns a URL)
     */
    async getFileUrl(fileId) {
        const result = await this.apiCall('fetch_file', {
            folder_file_id: fileId,
        });
        return result.url || result;
    }

    /**
     * Download a file as a readable stream using its download URL
     */
    async downloadFileStream(fileId) {
        const fileData = await this.getFileUrl(fileId);
        const downloadUrl = typeof fileData === 'string' ? fileData : fileData.url || fileData;

        if (!downloadUrl || typeof downloadUrl !== 'string') {
            throw new Error('Could not get download URL from Seedr');
        }

        const res = await axios({
            method: 'get',
            url: downloadUrl,
            responseType: 'stream',
            maxRedirects: 10,
        });

        const contentLength = res.headers['content-length']
            ? parseInt(res.headers['content-length'], 10)
            : null;

        return {
            stream: res.data,
            contentLength,
            contentType: res.headers['content-type'] || 'application/octet-stream',
        };
    }

    /**
     * Delete a file from Seedr
     */
    async deleteFile(fileId) {
        return this.apiCall('delete', {
            delete_arr: JSON.stringify([{ type: 'file', id: fileId }]),
        });
    }

    /**
     * Delete a folder from Seedr
     */
    async deleteFolder(folderId) {
        return this.apiCall('delete', {
            delete_arr: JSON.stringify([{ type: 'folder', id: folderId }]),
        });
    }

    /**
     * Wait for a torrent to finish downloading on Seedr
     * Polls folder contents to check if transfer is done
     */
    async waitForDownload(onProgress, pollInterval = 4000) {
        return new Promise((resolve, reject) => {
            const check = async () => {
                try {
                    const root = await this.getFolderContents();

                    // Check if there are active transfers
                    if (root.torrents && root.torrents.length > 0) {
                        const torrent = root.torrents[0];
                        const progress = torrent.progress || 0;

                        if (onProgress) {
                            onProgress({
                                progress,
                                title: torrent.name || torrent.title || 'Downloading...',
                                status: 'downloading',
                                size: torrent.size || 0,
                            });
                        }

                        setTimeout(check, pollInterval);
                    } else {
                        // No active transfers — download is complete
                        if (onProgress) {
                            onProgress({ progress: 100, title: 'Complete', status: 'complete' });
                        }
                        resolve(root);
                    }
                } catch (err) {
                    reject(err);
                }
            };

            // Initial delay to let Seedr start the transfer
            setTimeout(check, 3000);
        });
    }
}

export default Seedr;
