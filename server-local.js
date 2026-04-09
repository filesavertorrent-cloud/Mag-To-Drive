import 'dotenv/config';
import express from 'express';
import { Server } from 'socket.io';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Drive from './drive.js';
import LocalTorrent from './local-torrent.js';

// Local File System integration for accounts

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Prevent server from crashing on unhandled errors
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception (server stays alive):', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection (server stays alive):', reason);
});

const APP_PASSWORD = process.env.APP_PASSWORD || 'admin123';

// Initialize local torrent engine
const localTorrent = new LocalTorrent();

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

let driveAccounts = [];

function loadAccounts() {
    try {
        if (!fs.existsSync(ACCOUNTS_FILE)) {
            fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify([]));
        }
        const data = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
        driveAccounts = JSON.parse(data);
        
        // Sort accounts alphabetically by name
        driveAccounts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        
        console.log(`\n📁 Local Storage: Loaded ${driveAccounts.length} Google Drive account(s)`);
        driveAccounts.forEach((acc, i) => console.log(`   ${i + 1}. ${acc.name}`));
    } catch (err) {
        console.error('❌ Error reading accounts.json:', err.message);
        driveAccounts = [];
    }
}

function saveAccounts() {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(driveAccounts, null, 2));
}

// Load accounts on startup
loadAccounts();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

app.use(express.json());

// Password verification middleware for API
function authenticateAPI(req, res, next) {
    const password = req.headers['x-admin-password'];
    if (password === APP_PASSWORD) {
        next();
    } else {
        res.status(401).json({ success: false, error: 'Unauthorized' });
    }
}

// Password verification endpoint
app.post('/api/verify-password', (req, res) => {
    const { password } = req.body;
    if (password === APP_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, error: 'Wrong password' });
    }
});

// ── Admin API Endpoints ──
app.get('/api/accounts', authenticateAPI, (req, res) => {
    res.json({ success: true, accounts: driveAccounts });
});

app.post('/api/accounts', authenticateAPI, async (req, res) => {
    try {
        const newAccount = req.body;
        if (!newAccount.name || !newAccount.client_id || !newAccount.client_secret || !newAccount.refresh_token) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }

        newAccount.id = Date.now().toString(); // Generate a simple unique ID
        driveAccounts.push(newAccount);
        driveAccounts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        saveAccounts();
        
        res.json({ success: true, message: 'Account added locally!' });
    } catch (error) {
        console.error('Error adding account:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/accounts/:id', authenticateAPI, async (req, res) => {
    try {
        const id = req.params.id;
        driveAccounts = driveAccounts.filter(acc => acc.id !== id);
        saveAccounts();
        res.json({ success: true, message: 'Account deleted locally!' });
    } catch (error) {
        console.error('Error deleting account:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});


// Serve static files
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.get('/admin', (req, res) => {
    res.sendFile(__dirname + '/public/admin.html');
});

// Clean up torrent filenames before uploading
function cleanFileName(filename) {
    const ext = path.extname(filename);
    let name = filename.slice(0, -ext.length);

    name = name.replace(/^www\.[^\s_-]+[_\-\s]+/i, '');
    name = name.replace(/[_\-]+/g, ' ');
    name = name.replace(/\s{2,}/g, ' ').trim();

    return name + ext;
}

// Extract the movie name from a cleaned filename
function getMovieName(cleanedFilename) {
    const nameWithoutExt = cleanedFilename.replace(path.extname(cleanedFilename), '');

    const match = nameWithoutExt.match(/^(.+?)\s+\d{4}/);
    if (match) return match[1].trim();

    const fallback = nameWithoutExt.match(/^(.+?)\s+(Tamil|Hindi|Telugu|Malayalam|Kannada|English|TRUE|WEB|HDRip|DVDRip|BluRay)/i);
    if (fallback) return fallback[1].trim();

    return nameWithoutExt.trim();
}

io.on('connection', (socket) => {
    console.log('A user connected');
    let authenticated = false;

    // Password check via socket
    socket.on('auth', (password, callback) => {
        if (password === APP_PASSWORD) {
            authenticated = true;
            callback({ success: true });
        } else {
            callback({ success: false });
        }
    });

    // Send available account list (no secrets)
    socket.on('get-accounts', (callback) => {
        const accountList = driveAccounts.map((acc, i) => ({
            index: i,
            name: acc.name,
        }));
        callback(accountList);
    });

    socket.on('start-transfer', async (data) => {
        if (!authenticated) {
            socket.emit('error', 'Not authenticated. Please enter the password.');
            return;
        }

        // Support both old format (string) and new format (object with magnetLink + accountIndex)
        let magnetLink, accountIndex;
        if (typeof data === 'string') {
            magnetLink = data;
            accountIndex = 0;
        } else {
            magnetLink = data.magnetLink;
            accountIndex = data.accountIndex;
        }

        // Validate account index
        if (driveAccounts.length === 0) {
            socket.emit('error', 'No Google Drive accounts configured! Please add an account in the /admin panel.');
            return;
        }

        if (accountIndex < 0 || accountIndex >= driveAccounts.length) {
            accountIndex = 0;
        }

        const selectedAccount = driveAccounts[accountIndex];

        console.log(`Received magnet link: ${magnetLink}`);
        console.log(`Selected Drive account: ${selectedAccount.name}`);

        let torrentResult = null;

        try {
            // ── Stage 1: Add magnet link ──
            socket.emit('stage', { stage: 1, label: 'Adding magnet link...' });
            socket.emit('log', 'Starting local torrent download...');
            socket.emit('log', 'Waiting for torrent metadata (finding peers)...');

            // ── Stage 2: Download locally ──
            socket.emit('stage', { stage: 2, label: 'Downloading locally...' });

            torrentResult = await localTorrent.addMagnet(magnetLink, ({ progress, title, status, downloadSpeed, timeRemaining }) => {
                const speedStr = downloadSpeed ? `${downloadSpeed} MB/s` : '';
                const timeStr = timeRemaining && timeRemaining !== 'Infinity' ? ` — ETA: ${timeRemaining}` : '';
                socket.emit('log', `Local: ${progress}% — ${title} ${speedStr}${timeStr}`);
                socket.emit('progress', { stage: 'seedr', percent: progress });
                console.log(`Local: ${progress}% — ${title}`);
            });

            socket.emit('log', 'Local download complete!');

            // ── Stage 3: Find downloaded files ──
            socket.emit('stage', { stage: 3, label: 'Finding downloaded files...' });
            socket.emit('log', 'Looking for downloaded file(s)...');

            const targetFiles = torrentResult.files;

            if (!targetFiles || targetFiles.length === 0) {
                throw new Error('Could not find any downloaded files.');
            }

            // Determine Drive folder name from the torrent name
            const cleanedTorrentName = cleanFileName(torrentResult.name);
            const movieName = getMovieName(cleanedTorrentName);

            socket.emit('log', `Found ${targetFiles.length} file(s)`);
            socket.emit('log', `Drive folder will be: ${movieName}`);

            // ── Stage 4: Authorize with chosen Google Drive account ──
            socket.emit('stage', { stage: 4, label: `Connecting to "${selectedAccount.name}"...` });
            socket.emit('log', `Authenticating with Drive account: ${selectedAccount.name}`);

            const driveInstance = new Drive();
            await driveInstance.authorizeWithAccount(selectedAccount);
            socket.emit('log', 'Drive authentication successful!');

            // ── Stage 5: Upload to Google Drive ──
            socket.emit('stage', { stage: 5, label: 'Uploading to Google Drive...' });

            socket.emit('log', `Creating Drive folder "${movieName}"...`);
            const driveFolderId = await driveInstance.findOrCreateFolder(movieName);
            socket.emit('log', `Folder ready! Uploading ${targetFiles.length} file(s) to Drive...`);

            let uploadedFileIds = [];

            for (let i = 0; i < targetFiles.length; i++) {
                const targetFile = targetFiles[i];
                const originalName = targetFile.name;
                const fileSize = targetFile.size || 0;
                const fileCleanedName = cleanFileName(originalName);

                socket.emit('log', `Uploading (${i+1}/${targetFiles.length}): ${fileCleanedName} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

                const { stream, contentLength, contentType } = localTorrent.getFileStream(targetFile.fullPath);
                const mimeType = contentType || 'application/octet-stream';
                const uploadSize = contentLength || fileSize;

                const driveFileId = await driveInstance.uploadStream(
                    fileCleanedName, stream, mimeType, uploadSize,
                    (progressEvent) => {
                        if (uploadSize && progressEvent.bytesRead) {
                            const percent = ((progressEvent.bytesRead / uploadSize) * 100).toFixed(1);
                            socket.emit('progress', { stage: 'drive', percent: parseFloat(percent) });
                        }
                    },
                    driveFolderId
                );

                uploadedFileIds.push(driveFileId);
                socket.emit('log', `Upload complete for: ${fileCleanedName}`);
            }

            // ── Stage 5b: Make publicly accessible ──
            socket.emit('log', 'Setting sharing permissions...');
            try {
                if (targetFiles.length === 1 && uploadedFileIds.length === 1) {
                    await driveInstance.makePublic(driveFolderId);
                    const fileShareLink = await driveInstance.makePublic(uploadedFileIds[0]);
                    socket.emit('log', '🔗 File is now public (anyone with the link)');
                    socket.emit('share-link', fileShareLink);
                } else {
                    const folderShareLink = await driveInstance.makePublic(driveFolderId);
                    socket.emit('log', '🔗 Folder is now public (anyone with the link)');
                    socket.emit('share-link', folderShareLink);
                }
            } catch (shareErr) {
                socket.emit('log', `⚠ Sharing warning: ${shareErr.message}`);
            }

            // ── Stage 6: Cleanup local files ──
            socket.emit('stage', { stage: 6, label: 'Cleaning up local files...' });
            socket.emit('log', 'Deleting local downloaded files...');

            try {
                // Remove the torrent from WebTorrent client first
                localTorrent.removeTorrent(torrentResult.infoHash);

                // Delete the folder from disk
                localTorrent.cleanup(torrentResult.folderPath);

                // Also try to clean up the individual file if it was a single-file torrent
                // (single-file torrents sometimes don't create a subfolder)
                for (const f of targetFiles) {
                    if (fs.existsSync(f.fullPath)) {
                        fs.unlinkSync(f.fullPath);
                        console.log(`Deleted: ${f.fullPath}`);
                    }
                }

                socket.emit('log', 'Local files cleaned up!');
            } catch (cleanupErr) {
                socket.emit('log', `⚠ Cleanup warning: ${cleanupErr.message}`);
            }

            socket.emit('success', `✅ ${targetFiles.length} file(s) uploaded to "${selectedAccount.name}" in folder "${movieName}"!`);

        } catch (err) {
            console.error('Transfer error:', err);

            // Cleanup on error too
            if (torrentResult) {
                try {
                    localTorrent.removeTorrent(torrentResult.infoHash);
                    localTorrent.cleanup(torrentResult.folderPath);
                } catch (e) { /* ignore cleanup errors */ }
            }

            const errorMsg = err.response?.data?.error || err.response?.data?.message || err.message;
            socket.emit('error', `Transfer failed: ${errorMsg}`);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

server.listen(port, () => {
    console.log(`\n🚀 Server listening on http://localhost:${port}`);
    console.log(`📥 Mode: LOCAL TORRENT (No Seedr — No Size Limit!)`);
    console.log(`🔒 Password protected: YES`);
    console.log(`📁 Flow: Magnet → Local Download → Google Drive`);
    console.log(`🎛️  Admin Panel: http://localhost:${port}/admin\n`);

    // Open browser locally
    if (!process.env.RENDER && !process.env.NODE_ENV) {
        import('open').then(m => m.default(`http://localhost:${port}`));
    }
});
