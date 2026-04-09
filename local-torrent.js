import WebTorrent from 'webtorrent';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

class LocalTorrent {
    constructor() {
        this.client = null;
    }

    /**
     * Initialize the WebTorrent client
     */
    init() {
        if (!this.client) {
            this.client = new WebTorrent();
        }

        // Ensure downloads directory exists
        if (!fs.existsSync(DOWNLOADS_DIR)) {
            fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
        }
    }

    /**
     * Add a magnet link and download it locally
     * Returns a promise that resolves with torrent info when download completes
     * @param {string} magnetLink - The magnet URI
     * @param {function} onProgress - Callback with { progress, title, downloadSpeed, uploadSpeed, timeRemaining }
     * @returns {Promise<object>} - Resolves with { name, files: [{ name, path, size }] }
     */
    addMagnet(magnetLink, onProgress) {
        this.init();

        return new Promise((resolve, reject) => {
            // Check if this magnet is already added
            const existing = this.client.get(magnetLink);
            if (existing) {
                this.client.remove(existing.infoHash, { destroyStore: false }, () => {});
            }

            const torrent = this.client.add(magnetLink, { path: DOWNLOADS_DIR }, (torrent) => {
                console.log(`Torrent metadata received: ${torrent.name}`);
            });

            torrent.on('metadata', () => {
                console.log(`Torrent: ${torrent.name} — ${torrent.files.length} file(s)`);
                if (onProgress) {
                    onProgress({
                        progress: 0,
                        title: torrent.name,
                        status: 'downloading',
                        downloadSpeed: 0,
                        timeRemaining: Infinity,
                    });
                }
            });

            // Progress reporting
            const progressInterval = setInterval(() => {
                if (torrent.destroyed) {
                    clearInterval(progressInterval);
                    return;
                }

                const percent = Math.round(torrent.progress * 100);
                const dlSpeed = (torrent.downloadSpeed / (1024 * 1024)).toFixed(2);
                const timeLeft = torrent.timeRemaining;
                let timeStr = '';
                if (timeLeft && timeLeft !== Infinity) {
                    const mins = Math.floor(timeLeft / 60000);
                    const secs = Math.floor((timeLeft % 60000) / 1000);
                    timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                }

                if (onProgress) {
                    onProgress({
                        progress: percent,
                        title: torrent.name || 'Downloading...',
                        status: 'downloading',
                        downloadSpeed: dlSpeed,
                        timeRemaining: timeStr,
                    });
                }
            }, 2000);

            torrent.on('done', () => {
                clearInterval(progressInterval);

                if (onProgress) {
                    onProgress({
                        progress: 100,
                        title: torrent.name,
                        status: 'complete',
                        downloadSpeed: 0,
                        timeRemaining: '0s',
                    });
                }

                // Stop seeding immediately
                torrent.pause();

                const files = torrent.files.map(f => ({
                    name: f.name,
                    path: f.path,
                    fullPath: path.join(DOWNLOADS_DIR, f.path),
                    size: f.length,
                }));

                console.log(`Download complete: ${torrent.name} — ${files.length} file(s)`);

                resolve({
                    name: torrent.name,
                    infoHash: torrent.infoHash,
                    files: files,
                    folderPath: path.join(DOWNLOADS_DIR, torrent.name),
                });
            });

            torrent.on('error', (err) => {
                clearInterval(progressInterval);
                console.error('Torrent error:', err);
                reject(err);
            });

            // Timeout after 10 minutes of no metadata
            setTimeout(() => {
                if (!torrent.name && !torrent.destroyed) {
                    clearInterval(progressInterval);
                    torrent.destroy();
                    reject(new Error('Timed out waiting for torrent metadata (no peers found). Try a different magnet link.'));
                }
            }, 600000);
        });
    }

    /**
     * Get a readable file stream from a local file path
     * @param {string} filePath - Absolute path to the downloaded file
     * @returns {{ stream, contentLength, contentType }}
     */
    getFileStream(filePath) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        const stat = fs.statSync(filePath);
        const ext = path.extname(filePath).toLowerCase();

        // Map common video/audio extensions to MIME types
        const mimeTypes = {
            '.mkv': 'video/x-matroska',
            '.mp4': 'video/mp4',
            '.avi': 'video/x-msvideo',
            '.mov': 'video/quicktime',
            '.wmv': 'video/x-ms-wmv',
            '.flv': 'video/x-flv',
            '.webm': 'video/webm',
            '.mp3': 'audio/mpeg',
            '.flac': 'audio/flac',
            '.aac': 'audio/aac',
            '.srt': 'application/x-subrip',
            '.sub': 'text/plain',
            '.zip': 'application/zip',
            '.rar': 'application/x-rar-compressed',
            '.7z': 'application/x-7z-compressed',
        };

        return {
            stream: fs.createReadStream(filePath),
            contentLength: stat.size,
            contentType: mimeTypes[ext] || 'application/octet-stream',
        };
    }

    /**
     * Delete local files/folder after upload
     * @param {string} folderPath - Path to delete
     */
    cleanup(folderPath) {
        try {
            if (fs.existsSync(folderPath)) {
                fs.rmSync(folderPath, { recursive: true, force: true });
                console.log(`Cleaned up: ${folderPath}`);
            }
        } catch (err) {
            console.error(`Cleanup error: ${err.message}`);
        }
    }

    /**
     * Remove a torrent from the client (stop seeding)
     * @param {string} infoHash
     */
    removeTorrent(infoHash) {
        if (this.client) {
            const torrent = this.client.get(infoHash);
            if (torrent) {
                torrent.destroy({ destroyStore: false });
            }
        }
    }

    /**
     * Destroy the client entirely
     */
    destroy() {
        if (this.client) {
            this.client.destroy();
            this.client = null;
        }
    }
}

export default LocalTorrent;
